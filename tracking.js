/* ============================================================
   TRACKING.JS — Cámara, visión por computadora y gestos de mano
   ============================================================
   Usa la cámara TRASERA del dispositivo (facingMode:'environment'), no
   la frontal/selfie. Por eso las coordenadas NO se espejan: la mano
   derecha real del usuario cae a la derecha en pantalla, igual que en
   cualquier app de cámara trasera normal.

   Responsabilidad de este archivo (y SOLO esto):
     1) Pedir el permiso de la cámara trasera y clasificar con claridad
        qué falló (permiso denegado, sin cámara, cámara ocupada, página
        sin https, sin internet para cargar el modelo…) — ver
        `HandTracking.requestCamera()` y `onState()`.
     2) Alimentar MediaPipe Hands con un bucle propio (un cuadro a la vez,
        con tope de frecuencia ajustable) para que el reconocimiento de
        manos nunca se acumule ni compita con el dibujado 3D.
     3) Convertir los 21 landmarks de cada mano en un estado de gestos
        limpio: posición de la palma, punto de pinza, fuerza de pinza
        (0..1), si está agarrando (con histéresis), golpe rápido hacia
        abajo (picar) y giro de muñeca (perilla).
     4) Estabilizar la señal:
          · Filtro One-Euro por landmark: casi sin temblor con la mano
            quieta y casi sin retraso cuando se mueve rápido.
          · La pinza se mide RELATIVA al tamaño de la mano (no en
            unidades absolutas de imagen), así que agarra igual de
            bien con la mano cerca o lejos de la cámara.
          · `tick(dt)`: interpolación por cuadro de render (60 FPS) de
            los landmarks (`disp`), porque la cámara/IA entrega ~20-30
            muestras por segundo y sin esto las manos se verían a
            saltos.

   No hay aquí ninguna referencia a Three.js, a la escena del
   restaurante ni a mecánicas de juego — eso vive en game.js.
   ============================================================ */

const HandTracking = (() => {

  const videoEl = document.getElementById('video');

  let mpHands = null;
  let stream = null;
  let state = 'idle';       // idle | requesting | camera-ready | loading | running | error
  let lastError = null;
  let statusCallback = null;
  const stateListeners = [];
  let preparing = null;     // promesa de prepare() en curso (evita pedir la cámara dos veces)

  // Frecuencia máxima con la que se le manda un cuadro a MediaPipe. Perf.js la
  // baja si el celular no alcanza 60 FPS de dibujado (la IA compite con el 3D
  // por el mismo hilo/GPU), y como las manos se interpolan en `tick`, bajarla
  // casi no se nota a simple vista.
  let targetHz = 30;
  let inferMs = 0;          // media móvil del costo de cada inferencia (diagnóstico)
  let inferHz = 0;          // frecuencia real de resultados (diagnóstico)
  let _lastResultAt = 0;

  // ---------- utilidades numéricas ----------
  function clamp(x, a, b) { return Math.max(a, Math.min(b, x)); }
  function lerp(a, b, t) { return a + (b - a) * t; }

  // ══════════════════════════════════════════════════════════
  // ERRORES DE CÁMARA: cada causa con un mensaje que el usuario entiende
  // ══════════════════════════════════════════════════════════
  function makeError(code, message) {
    const e = new Error(message);
    e.code = code;
    e.userMessage = message;
    return e;
  }

  function classifyCameraError(err) {
    if (err && err.code && err.userMessage) return err; // ya clasificado
    const name = (err && err.name) || '';
    switch (name) {
      case 'NotAllowedError':
      case 'PermissionDeniedError':
      case 'SecurityError':
        return makeError('denied',
          'Negaste el permiso de la cámara. Toca el candado (o el ícono de ajustes) junto a la dirección de la página → Permisos → Cámara → Permitir, y luego pulsa «Reintentar».');
      case 'NotFoundError':
      case 'DevicesNotFoundError':
      case 'OverconstrainedError':
        return makeError('nocamera', 'No se encontró ninguna cámara disponible en este dispositivo.');
      case 'NotReadableError':
      case 'TrackStartError':
      case 'AbortError':
        return makeError('busy', 'La cámara está siendo usada por otra aplicación. Ciérrala y pulsa «Reintentar».');
      default:
        return makeError('unknown', 'No se pudo abrir la cámara: ' + ((err && err.message) || err || 'error desconocido'));
    }
  }

  function setState(next, err) {
    state = next;
    lastError = err || null;
    for (const cb of stateListeners) { try { cb(state, lastError); } catch (_) { /* un listener roto no debe tumbar al resto */ } }
  }

  async function openStream() {
    // Preferencia (no obligación) por la cámara trasera: si el dispositivo
    // solo tiene una (p. ej. un portátil), el navegador usa esa en vez de fallar.
    const attempts = [
      { video: { facingMode: { ideal: 'environment' }, width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 30, max: 30 } }, audio: false },
      { video: true, audio: false }
    ];
    let lastErr = null;
    for (const constraints of attempts) {
      try {
        return await navigator.mediaDevices.getUserMedia(constraints);
      } catch (e) {
        lastErr = e;
        // Si el problema es de permiso o la cámara está ocupada, reintentar con
        // otras restricciones no ayuda: se corta aquí y se informa tal cual.
        if (e && ['NotAllowedError', 'PermissionDeniedError', 'SecurityError', 'NotReadableError', 'TrackStartError'].includes(e.name)) break;
      }
    }
    throw lastErr;
  }

  // Pide permiso y enciende la cámara trasera. Seguro de llamar varias veces.
  async function requestCamera() {
    if (stream && stream.active) return;
    setState('requesting');
    try {
      if (!window.isSecureContext) {
        throw makeError('insecure', 'La cámara solo funciona en una página segura. Abre esta aplicación con una dirección que empiece por https://');
      }
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        throw makeError('unsupported', 'Este navegador no permite usar la cámara. Prueba con una versión actualizada de Chrome o Safari.');
      }
      stream = await openStream();
      videoEl.srcObject = stream;
      await new Promise(resolve => {
        if (videoEl.readyState >= 1) return resolve();
        videoEl.addEventListener('loadedmetadata', resolve, { once: true });
        setTimeout(resolve, 4000);
      });
      try { await videoEl.play(); } catch (_) { /* autoplay ya está activo; algunos navegadores igual rechazan la promesa */ }
      const track = stream.getVideoTracks()[0];
      if (track) {
        track.addEventListener('ended', () => {
          stopPump();
          setState('error', makeError('lost', 'Se perdió la conexión con la cámara. Pulsa «Reintentar».'));
        });
      }
      setState('camera-ready');
    } catch (err) {
      stream = null;
      const e = classifyCameraError(err);
      setState('error', e);
      throw e;
    }
  }

  // ══════════════════════════════════════════════════════════
  // FILTRO ONE-EURO (Casiez et al., CHI 2012)
  // ══════════════════════════════════════════════════════════
  // Cutoff bajo cuando la señal casi no se mueve (mata el temblor del modelo)
  // y cutoff alto cuando se mueve rápido (casi sin retraso). Las coordenadas de
  // MediaPipe van de 0 a 1, así que las velocidades son "fracciones de imagen
  // por segundo": ~0.1 con la mano casi quieta, 1-3 en un movimiento rápido.
  class OneEuro {
    constructor(minCutoff, beta, dCutoff = 1.0) {
      this.minCutoff = minCutoff; this.beta = beta; this.dCutoff = dCutoff;
      this.xPrev = null; this.dxHat = 0; this.xHat = 0;
    }
    static alpha(cutoff, dt) { const tau = 1 / (2 * Math.PI * cutoff); return 1 / (1 + tau / dt); }
    filter(x, dt) {
      if (this.xPrev === null) { this.xPrev = x; this.xHat = x; this.dxHat = 0; return x; }
      const dx = (x - this.xPrev) / dt;
      const aD = OneEuro.alpha(this.dCutoff, dt);
      this.dxHat = aD * dx + (1 - aD) * this.dxHat;
      const cutoff = this.minCutoff + this.beta * Math.abs(this.dxHat);
      const a = OneEuro.alpha(cutoff, dt);
      this.xHat = a * x + (1 - a) * this.xHat;
      this.xPrev = x;
      return this.xHat;
    }
    reset() { this.xPrev = null; }
  }

  // Parámetros: x/y con poco cutoff base (la imagen es la señal más ruidosa
  // con la mano quieta) y beta alto; z (profundidad relativa) es bastante más
  // ruidosa, así que se filtra más fuerte.
  const F_XY = { minCutoff: 1.6, beta: 9 };
  const F_Z  = { minCutoff: 0.9, beta: 4 };

  // Landmarks de MediaPipe Hands usados:
  //  0 = muñeca, 4 = punta del pulgar, 8 = punta del índice
  //  5,9,13,17 = base de los otros cuatro dedos (para el centro de palma)
  const PALM_IDX = [0, 1, 5, 9, 13, 17];

  // Pinza medida RELATIVA al tamaño de la mano: distancia pulgar-índice dividida
  // por la distancia muñeca-nudillo medio. Así no depende de qué tan cerca esté
  // la mano de la cámara. 0.10 ≈ yemas tocándose, 0.50 ≈ mano abierta cómoda.
  const PINCH_RATIO_NEAR = 0.10;
  const PINCH_RATIO_FAR = 0.50;
  const PINCH_ON = 0.66;   // pinch (0..1) que activa el agarre   (≈ ratio 0.236)
  const PINCH_OFF = 0.40;  // pinch que lo suelta; amplia histéresis = no se suelta solo (≈ ratio 0.34)

  // Golpe de picar: velocidad vertical de la palma, en alturas-de-imagen por
  // SEGUNDO (antes era "por cuadro", y cambiaba de significado si la cámara
  // bajaba de 30 a 20 cuadros por segundo).
  const CHOP_VELOCITY_THRESHOLD = 0.85;

  // Tiempo que la mano se sigue dibujando después de perderse un instante.
  const VISIBLE_GRACE_MS = 220;

  function makeHandState(label) {
    return {
      label,                 // 'left' | 'right'
      detected: false,       // ¿la mano está visible este frame de IA?
      visible: false,        // detected, o perdida hace menos de VISIBLE_GRACE_MS (para dibujar sin parpadeo)
      landmarks: null,       // 21 puntos {x,y,z} normalizados y FILTRADOS (a ritmo de inferencia)
      disp: null,            // 21 puntos interpolados cada cuadro de render (para dibujar/agarrar)
      palm: { x: 0.5, y: 0.5, z: 0 },
      dpalm: { x: 0.5, y: 0.5, z: 0 },
      pinchPoint: { x: 0.5, y: 0.5, z: 0 },  // punto medio entre yema del pulgar e índice
      dpinch: { x: 0.5, y: 0.5, z: 0 },
      pinchDist: 1,
      pinchRatio: 1,
      pinch: 0,              // 0..1 suavizado, qué tan cerrada está la pinza
      isPinching: false,     // true mientras se mantiene el agarre
      pinchStarted: false,   // true SOLO en el frame donde empezó el agarre
      pinchEnded: false,     // true SOLO en el frame donde se soltó
      chopSpike: false,      // true en el frame de un golpe rápido hacia abajo
      rollAngle: 0,          // ángulo (rad) del eje nudillos en el plano de la imagen (perilla de la estufa)
      rollValid: false,
      _wasPinching: false,
      _velY: 0,
      _prevRawPalmY: null,
      _prevT: 0,
      _lastSeen: 0,
      _dispValid: false,
      _filters: null
    };
  }

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

  function aspect() {
    return (videoEl.videoWidth && videoEl.videoHeight) ? videoEl.videoWidth / videoEl.videoHeight : 4 / 3;
  }

  // Distancia en un espacio isotrópico (x y z de MediaPipe usan la escala del
  // ANCHO de la imagen, y usa la escala del ALTO; se llevan las dos a "alturas").
  function iso(a, b, ar) {
    return Math.hypot((a.x - b.x) * ar, a.y - b.y, (a.z - b.z) * ar);
  }

  function ensureFilters(h) {
    if (h._filters) return h._filters;
    h._filters = [];
    for (let i = 0; i < 21; i++) {
      h._filters.push({
        x: new OneEuro(F_XY.minCutoff, F_XY.beta),
        y: new OneEuro(F_XY.minCutoff, F_XY.beta),
        z: new OneEuro(F_Z.minCutoff, F_Z.beta)
      });
    }
    return h._filters;
  }

  function updateHandFromLandmarks(h, rawLandmarks, now) {
    // Cámara TRASERA (no selfie): la imagen ya llega "natural", sin espejo.
    const filters = ensureFilters(h);
    let dt = h._prevT ? (now - h._prevT) / 1000 : 1 / 30;
    dt = clamp(dt, 1 / 120, 0.12);
    // Si la mano estuvo perdida un buen rato, los valores previos ya no sirven.
    if (!h.detected && now - h._lastSeen > 300) { for (const f of filters) { f.x.reset(); f.y.reset(); f.z.reset(); } dt = 1 / 30; }
    h._prevT = now;
    h._lastSeen = now;

    const lm = rawLandmarks.map((p, i) => ({
      x: filters[i].x.filter(p.x, dt),
      y: filters[i].y.filter(p.y, dt),
      z: filters[i].z.filter(p.z, dt)
    }));
    h.landmarks = lm;
    h.detected = true;

    // Centro de la palma y punto de pinza (sobre landmarks ya filtrados)
    let sx = 0, sy = 0, sz = 0;
    for (const i of PALM_IDX) { sx += lm[i].x; sy += lm[i].y; sz += lm[i].z; }
    const n = PALM_IDX.length;
    h.palm = { x: sx / n, y: sy / n, z: sz / n };

    const thumb = lm[4], index = lm[8];
    h.pinchPoint = { x: (thumb.x + index.x) / 2, y: (thumb.y + index.y) / 2, z: (thumb.z + index.z) / 2 };

    const ar = aspect();
    h.pinchDist = iso(thumb, index, ar);
    const handSize = Math.max(iso(lm[0], lm[9], ar), 0.9 * iso(lm[5], lm[17], ar), 0.02);
    h.pinchRatio = h.pinchDist / handSize;

    // Ángulo de "giro de muñeca" (como girar una perilla): vector entre la base
    // del índice (5) y la del meñique (17), en el plano de la imagen.
    h.rollAngle = Math.atan2(lm[17].y - lm[5].y, (lm[17].x - lm[5].x) * ar);
    h.rollValid = true;

    const raw = clamp((PINCH_RATIO_FAR - h.pinchRatio) / (PINCH_RATIO_FAR - PINCH_RATIO_NEAR), 0, 1);
    h.pinch = lerp(h.pinch, raw, 0.6);

    h._wasPinching = h.isPinching;
    if (!h.isPinching && h.pinch > PINCH_ON) h.isPinching = true;
    if (h.isPinching && h.pinch < PINCH_OFF) h.isPinching = false;
    h.pinchStarted = h.isPinching && !h._wasPinching;
    h.pinchEnded = !h.isPinching && h._wasPinching;

    // Detector de "golpe de picar": se usa la palma SIN filtrar, porque el
    // filtro suaviza justo los picos rápidos que se quieren detectar.
    let ry = 0;
    for (const i of PALM_IDX) ry += rawLandmarks[i].y;
    ry /= n;
    if (h._prevRawPalmY != null) {
      const vy = (ry - h._prevRawPalmY) / dt; // positivo = moviéndose hacia abajo
      h._velY = lerp(h._velY, vy, 0.6);
      h.chopSpike = h._velY > CHOP_VELOCITY_THRESHOLD;
    } else {
      h.chopSpike = false;
    }
    h._prevRawPalmY = ry;
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
    h._prevRawPalmY = null;
  }

  function onResults(results) {
    const now = performance.now();
    if (_lastResultAt) {
      const gap = now - _lastResultAt;
      inferHz = lerp(inferHz || 1000 / gap, 1000 / gap, 0.1);
    }
    _lastResultAt = now;

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
        if (seen[label]) label = label === 'left' ? 'right' : 'left'; // dos manos con la misma etiqueta: la segunda va al otro lado
        updateHandFromLandmarks(hands[label], results.multiHandLandmarks[i], now);
        seen[label] = true;
      }
    }
    if (!seen.left) decayHand(hands.left);
    if (!seen.right) decayHand(hands.right);

    if (statusCallback) statusCallback(hands);
  }

  // ══════════════════════════════════════════════════════════
  // INTERPOLACIÓN POR CUADRO DE RENDER (llamar desde el bucle principal)
  // ══════════════════════════════════════════════════════════
  // La IA entrega ~20-30 muestras por segundo pero el 3D se dibuja a 60.
  // Sin esto la mano se movería "a escalones". Cada cuadro, los puntos de
  // dibujo (`disp`) persiguen a los landmarks filtrados con un seguidor
  // exponencial independiente de la tasa de cuadros.
  const DISP_FOLLOW = 38; // 1/s  (constante de tiempo ≈ 26 ms)
  function tick(dt) {
    const now = performance.now();
    const a = 1 - Math.exp(-DISP_FOLLOW * clamp(dt, 0.001, 0.1));
    for (const key of ['left', 'right']) {
      const h = hands[key];
      if (h.detected && h.landmarks) {
        if (!h._dispValid || !h.disp) {
          h.disp = h.landmarks.map(p => ({ x: p.x, y: p.y, z: p.z }));
          h._dispValid = true;
        } else {
          for (let i = 0; i < 21; i++) {
            const d = h.disp[i], t = h.landmarks[i];
            d.x += (t.x - d.x) * a; d.y += (t.y - d.y) * a; d.z += (t.z - d.z) * a;
          }
        }
        let sx = 0, sy = 0, sz = 0;
        for (const i of PALM_IDX) { sx += h.disp[i].x; sy += h.disp[i].y; sz += h.disp[i].z; }
        const n = PALM_IDX.length;
        h.dpalm.x = sx / n; h.dpalm.y = sy / n; h.dpalm.z = sz / n;
        const t4 = h.disp[4], t8 = h.disp[8];
        h.dpinch.x = (t4.x + t8.x) / 2; h.dpinch.y = (t4.y + t8.y) / 2; h.dpinch.z = (t4.z + t8.z) / 2;
        h.visible = true;
      } else {
        h.visible = h._dispValid && (now - h._lastSeen) < VISIBLE_GRACE_MS;
        if (!h.visible) h._dispValid = false;
      }
    }
  }

  // ══════════════════════════════════════════════════════════
  // MEDIAPIPE: carga del modelo y bucle de cuadros
  // ══════════════════════════════════════════════════════════
  async function ensureHands() {
    if (mpHands) return;
    if (typeof Hands === 'undefined') {
      throw makeError('lib', 'No se pudo cargar el reconocimiento de manos. Revisa tu conexión a internet y recarga la página.');
    }
    const h = new Hands({ locateFile: (f) => `https://cdn.jsdelivr.net/npm/@mediapipe/hands@0.4/${f}` });
    h.setOptions({
      maxNumHands: 2,
      // 0 = modelo "lite": el juego solo necesita la yema del pulgar/índice
      // (pinza) y la velocidad de la palma (picar); el modelo completo es
      // bastante más lento en un celular y no aporta nada a esas señales.
      modelComplexity: 0,
      minDetectionConfidence: 0.55,
      minTrackingConfidence: 0.5
    });
    h.onResults(onResults);
    try { await h.initialize(); }
    catch (e) { throw makeError('lib', 'No se pudo cargar el modelo de reconocimiento de manos. Revisa tu conexión a internet y recarga la página.'); }
    mpHands = h;
  }

  let pumping = false, busy = false, lastSent = 0, lastVideoTime = -1;

  function scheduleNext() {
    if (!pumping) return;
    if (videoEl.requestVideoFrameCallback) videoEl.requestVideoFrameCallback(pumpTick);
    else requestAnimationFrame(pumpTick);
  }

  async function pumpTick() {
    if (!pumping) return;
    const now = performance.now();
    if (!busy && videoEl.readyState >= 2 && videoEl.currentTime !== lastVideoTime && now - lastSent >= 1000 / targetHz - 3) {
      busy = true; lastSent = now; lastVideoTime = videoEl.currentTime;
      try {
        await mpHands.send({ image: videoEl });
        inferMs = lerp(inferMs || (performance.now() - now), performance.now() - now, 0.1);
      } catch (_) { /* un cuadro perdido no debe detener el bucle */ }
      busy = false;
    }
    scheduleNext();
  }

  function startPump() {
    if (pumping) return;
    pumping = true; busy = false; lastVideoTime = -1;
    scheduleNext();
  }
  function stopPump() { pumping = false; }

  // Pide la cámara y deja listo el modelo de manos SIN empezar a procesar
  // cuadros (así se puede precargar mientras el usuario lee la pantalla de inicio).
  function prepare() {
    if (preparing) return preparing;
    preparing = (async () => {
      await requestCamera();
      setState('loading');
      try { await ensureHands(); }
      catch (e) { setState('error', e); throw e; }
      setState('camera-ready');
    })().finally(() => { preparing = null; });
    return preparing;
  }

  async function start() {
    if (state === 'running') return;
    if (!mpHands || !stream || !stream.active) await prepare();
    startPump();
    setState('running');
  }

  return {
    hands,
    start,
    prepare,
    requestCamera,
    tick,
    angleDiff,
    stop: stopPump,
    // Procesa un resultado con el mismo formato que entrega MediaPipe. Sirve
    // para probar gestos/manos sin cámara (pruebas automáticas, demos).
    injectResults: onResults,
    setTargetHz(hz) { targetHz = clamp(hz, 8, 60); },
    get targetHz() { return targetHz; },
    get inferMs() { return inferMs; },
    get inferHz() { return inferHz; },
    get ready() { return state === 'running'; },
    get state() { return state; },
    get error() { return lastError; },
    get hasCamera() { return !!(stream && stream.active); },
    onState(cb) { stateListeners.push(cb); },
    onStatus(cb) { statusCallback = cb; }
  };
})();

window.HandTracking = HandTracking;
