/* ============================================================
   TRACKING.JS — Visión por computadora y reconocimiento de gestos
   ============================================================
   Usa la cámara TRASERA del dispositivo (facingMode:'environment'), no
   la frontal/selfie. Por eso las coordenadas NO se espejan: la mano
   derecha real del usuario cae a la derecha en pantalla, igual que en
   cualquier app de cámara trasera normal.

   Responsabilidad de este archivo (y SOLO esto):
     1) Encender la cámara y alimentar MediaPipe Hands.
     2) Convertir los 21 landmarks de cada mano en un estado de
        gestos limpio y fácil de consumir: posición de la palma,
        fuerza de "pinza" (0..1), si está agarrando o no (con
        histéresis para evitar parpadeos) y un detector de golpe
        rápido hacia abajo (usado como gesto de "cortar").
     3) Exponer todo eso en `window.HandTracking` para que
        game.js pueda leerlo cada frame sin saber nada de
        MediaPipe.

   No hay aquí ninguna referencia a Three.js, a la escena del
   restaurante ni a mecánicas de juego — eso vive en game.js.
   ============================================================ */

const HandTracking = (() => {

  const videoEl = document.getElementById('video');

  let mpHands = null;
  let mpCamera = null;
  let isReady = false;
  let statusCallback = null;

  // ---------- utilidades numéricas ----------
  function clamp(x, a, b) { return Math.max(a, Math.min(b, x)); }
  function lerp(a, b, t) { return a + (b - a) * t; }

  // Landmarks clave de MediaPipe Hands que usamos:
  //  0 = muñeca, 4 = punta del pulgar, 8 = punta del índice
  //  5,9,13,17 = base de los otros cuatro dedos (para el centro de palma)
  const PALM_IDX = [0, 1, 5, 9, 13, 17];

  // Umbrales de la pinza (distancia normalizada pulgar-índice).
  // Histéresis (ON > OFF) para que el gesto no "tiemble" cerca del límite.
  const PINCH_ON = 0.62;
  const PINCH_OFF = 0.42;
  const PINCH_NEAR = 0.11; // distancia (normalizada) considerada "dedos juntos"
  const PINCH_FAR = 0.02;  // distancia mínima físicamente posible entre puntas

  // Umbral de velocidad vertical de la palma para detectar un "golpe de picar".
  // Se expresa en unidades normalizadas de imagen por frame, suavizado.
  const CHOP_VELOCITY_THRESHOLD = 0.028;

  function makeHandState(label) {
    return {
      label,                 // 'left' | 'right'
      detected: false,       // ¿la mano está visible este frame?
      landmarks: null,       // 21 puntos {x,y,z} normalizados, tal cual los ve la cámara trasera (sin espejo)
      palm: { x: 0.5, y: 0.5, z: 0 },
      pinchDist: 1,
      pinch: 0,              // 0..1 suavizado, qué tan cerrada está la pinza
      isPinching: false,     // true mientras se mantiene el agarre
      pinchStarted: false,   // true SOLO en el frame donde empezó el agarre
      pinchEnded: false,     // true SOLO en el frame donde se soltó
      chopSpike: false,      // true en el frame de un golpe rápido hacia abajo
      rollAngle: 0,          // ángulo (rad) del eje muñeca->nudillos en el plano de la imagen,
                              // usado para detectar el gesto de "girar la perilla" de la estufa
      rollValid: false,      // true si rollAngle se pudo calcular este frame (mano detectada)
      _wasPinching: false,
      _velY: 0,
      _prevPalmY: null
    };
  }

  // Diferencia angular con signo, segura ante el salto -PI/PI (rango resultante: -PI..PI).
  function angleDiff(a, b) {
    let d = a - b;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    return d;
  }

  const hands = {
    left: makeHandState('left'),
    right: makeHandState('right')
  };

  function palmCenter(lm) {
    let sx = 0, sy = 0, sz = 0;
    for (const i of PALM_IDX) { sx += lm[i].x; sy += lm[i].y; sz += lm[i].z; }
    const n = PALM_IDX.length;
    return { x: sx / n, y: sy / n, z: sz / n };
  }

  function updateHandFromLandmarks(h, rawLandmarks) {
    // Cámara TRASERA (no selfie): la imagen ya llega "natural", sin espejo.
    // Aquí NO se invierte X — al revés que con una cámara frontal, esto hace
    // que tu mano derecha real quede a la derecha en la pantalla.
    const lm = rawLandmarks.map(p => ({ x: p.x, y: p.y, z: p.z }));
    h.landmarks = lm;
    h.detected = true;
    h.palm = palmCenter(lm);

    const thumb = lm[4], index = lm[8];
    const dx = thumb.x - index.x, dy = thumb.y - index.y;
    h.pinchDist = Math.hypot(dx, dy);

    // Ángulo de "giro de muñeca" (como girar una perilla): vector entre la
    // base del índice (5) y la base del meñique (17), proyectado en el plano
    // de la imagen. Al rotar el antebrazo frente a la cámara, este vector
    // gira junto con la mano — es una señal mucho más estable e intencional
    // que la sola posición de la palma para detectar "giró a la derecha /
    // a la izquierda", evitando activaciones accidentales de la estufa.
    const idxBase = lm[5], pinkyBase = lm[17];
    h.rollAngle = Math.atan2(pinkyBase.y - idxBase.y, pinkyBase.x - idxBase.x);
    h.rollValid = true;

    const raw = clamp((PINCH_NEAR - h.pinchDist) / (PINCH_NEAR - PINCH_FAR), 0, 1);
    h.pinch = lerp(h.pinch, raw, 0.35);

    h._wasPinching = h.isPinching;
    if (!h.isPinching && h.pinch > PINCH_ON) h.isPinching = true;
    if (h.isPinching && h.pinch < PINCH_OFF) h.isPinching = false;
    h.pinchStarted = h.isPinching && !h._wasPinching;
    h.pinchEnded = !h.isPinching && h._wasPinching;

    // Detector de "golpe de picar": velocidad vertical de la palma.
    if (h._prevPalmY != null) {
      const vy = h.palm.y - h._prevPalmY; // positivo = moviéndose hacia abajo
      h._velY = lerp(h._velY, vy, 0.6);
      h.chopSpike = h._velY > CHOP_VELOCITY_THRESHOLD;
    } else {
      h.chopSpike = false;
    }
    h._prevPalmY = h.palm.y;
  }

  function decayHand(h) {
    // La mano salió de cuadro: no la "soltamos" de golpe, sino que
    // dejamos que la pinza decaiga suavemente para evitar sueltos falsos
    // por un parpadeo de un solo frame en la detección.
    h.detected = false;
    h.landmarks = null;
    h._wasPinching = h.isPinching;
    h.pinch = lerp(h.pinch, 0, 0.25);
    if (h.isPinching && h.pinch < PINCH_OFF) h.isPinching = false;
    h.pinchStarted = false;
    h.pinchEnded = !h.isPinching && h._wasPinching;
    h.chopSpike = false;
    h.rollValid = false;
    h._prevPalmY = null;
  }

  function onResults(results) {
    const seen = { left: false, right: false };

    if (results.multiHandLandmarks && results.multiHandLandmarks.length) {
      const handedness = results.multiHandedness || [];
      for (let i = 0; i < results.multiHandLandmarks.length && i < 2; i++) {
        let label = i === 0 ? 'left' : 'right';
        if (handedness[i] && handedness[i].label) {
          // MediaPipe calcula "Left"/"Right" asumiendo una cámara frontal
          // espejada (selfie). Con la cámara TRASERA (imagen sin espejo)
          // esa etiqueta queda invertida respecto a la mano real, así que
          // se intercambia aquí para que corresponda a la mano anatómica.
          label = handedness[i].label === 'Left' ? 'right' : 'left';
        }
        updateHandFromLandmarks(hands[label], results.multiHandLandmarks[i]);
        seen[label] = true;
      }
    }
    if (!seen.left) decayHand(hands.left);
    if (!seen.right) decayHand(hands.right);

    if (statusCallback) statusCallback(hands);
  }

  async function start() {
    mpHands = new Hands({
      locateFile: (f) => `https://cdn.jsdelivr.net/npm/@mediapipe/hands@0.4/${f}`
    });
    mpHands.setOptions({
      maxNumHands: 2,
      modelComplexity: 1,
      minDetectionConfidence: 0.6,
      minTrackingConfidence: 0.6
    });
    mpHands.onResults(onResults);

    mpCamera = new Camera(videoEl, {
      onFrame: async () => { await mpHands.send({ image: videoEl }); },
      // Cámara TRASERA del dispositivo móvil (no la frontal/selfie).
      // 'environment' es una preferencia "ideal": si el dispositivo no
      // tiene cámara trasera (p. ej. un portátil), el navegador cae de
      // vuelta a la única cámara disponible en vez de fallar.
      facingMode: 'environment',
      width: 640,
      height: 480
    });

    await mpCamera.start();
    isReady = true;
  }

  return {
    hands,
    start,
    angleDiff,
    get ready() { return isReady; },
    onStatus(cb) { statusCallback = cb; }
  };
})();

window.HandTracking = HandTracking;
