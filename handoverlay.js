/* ============================================================
   HANDOVERLAY.JS — Manos en 2D (contorno fino) + punteros en pantalla
   ============================================================
   Reemplaza el modelo 3D de la mano por una representación 2D, como en el
   video de referencia (el contorno de las manos de Meta Quest): un trazo
   fino y claro alrededor de la silueta, con un relleno oscuro translúcido.

   POR QUÉ 2D (y no una malla 3D):
     · La profundidad (z) que estima MediaPipe es muy ruidosa. En 3D cada
       dedo se estiraba o encogía con el menor movimiento ("se distorsiona").
       Aquí SOLO se usan x/y, que son estables: la forma no se deforma.
     · Una malla 3D cerca de la cámara, en el visor estéreo, se ve DOBLE (el
       ojo no logra fusionar objetos a 40 cm). Un dibujo 2D se ve igual en
       los dos ojos y no tiene disparidad: no hay doble imagen.
     · Es mucho más barato: una sola pasada de canvas 2D por cuadro.

   MAPEO A LA PANTALLA (todo en un solo lugar, para que lo que VES sea
   exactamente lo que el juego usa para agarrar):
     · POSICIÓN: la palma se mueve por la pantalla con una pequeña ganancia
       (`reach`) para poder alcanzar los bordes sin sacar la mano de la cámara.
     · TAMAÑO: el contorno se dibuja a una escala fija (`size`) relativa a la
       pantalla, independiente de la ganancia anterior. Ya no es 4 veces mayor
       que la cocina como el avatar 3D; ajusta `size` para hacerla mayor/menor.
     · En el Modo Cartón la pantalla son DOS mitades (una por ojo): el mismo
       dibujo se repite en las dos con coordenadas relativas a cada mitad.

   Salida para game.js: `state[mano]` con `visible`, `pinchNdc` y `palmNdc`
   (coordenadas -1..1 dentro de la mitad/pantalla activa) y `view.aspect`.
   ============================================================ */

const HandOverlay = (() => {

  // ---------- ajustes (en fracciones de la pantalla) ----------
  const CFG = {
    size: 0.80,      // tamaño de la mano: 1 = tal cual se ve en la cámara; menos = más pequeña
    reach: 1.15,     // cuánto se desplaza la palma por la pantalla respecto a la imagen de la cámara
    shiftY: 0.05,    // desplazamiento vertical (las manos en reposo quedan un poco abajo del centro)
    outline: 1.6,    // grosor del contorno en píxeles CSS
    fill: 'rgba(8, 18, 26, 0.38)',
    ink: 'rgba(255, 255, 255, 0.94)',
    inkGrab: 'rgba(120, 255, 226, 0.98)',
    fillGrab: 'rgba(30, 150, 130, 0.36)'
  };

  const FINGERS = [
    { idx: [1, 2, 3, 4],     w0: 0.30, w1: 0.20 },   // pulgar  (ancho como fracción del tamaño de la mano)
    { idx: [5, 6, 7, 8],     w0: 0.225, w1: 0.165 }, // índice
    { idx: [9, 10, 11, 12],  w0: 0.235, w1: 0.17 },  // medio
    { idx: [13, 14, 15, 16], w0: 0.215, w1: 0.155 }, // anular
    { idx: [17, 18, 19, 20], w0: 0.185, w1: 0.135 }  // meñique
  ];
  const PALM_POLY = [0, 1, 2, 5, 9, 13, 17];

  const canvas = document.createElement('canvas');
  canvas.id = 'hand-overlay';
  document.body.appendChild(canvas);
  const ctx = canvas.getContext('2d');
  // Lienzos auxiliares del tamaño de UNA vista (pantalla o mitad de pantalla):
  //   off  = resultado de las manos (se copia tal cual a cada ojo)
  //   maskC = interior de UNA mano, opaco → luego translúcido y uniforme
  //   ringC = contorno de UNA mano
  const off = document.createElement('canvas'), octx = off.getContext('2d');
  const maskC = document.createElement('canvas'), mctx = maskC.getContext('2d');
  const ringC = document.createElement('canvas'), rctx = ringC.getContext('2d');
  let dpr = 1, W = 0, H = 0;

  const view = { vw: 1, vh: 1, aspect: 1, stereo: false };

  function makeState() {
    return {
      visible: false, pinching: false, pinch: 0,
      pts: Array.from({ length: 21 }, () => ({ x: 0, y: 0 })),     // px dentro de la mitad/pantalla activa
      pinchPx: { x: 0, y: 0 }, palmPx: { x: 0, y: 0 },
      pinchNdc: { x: 0, y: 0 }, palmNdc: { x: 0, y: 0 },
      size: 1
    };
  }
  const state = { left: makeState(), right: makeState() };

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 1.5);   // el trazo es fino: no hace falta más resolución
    W = window.innerWidth; H = window.innerHeight;
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
  }
  window.addEventListener('resize', resize);
  resize();

  function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }

  // Proyecta los puntos de una mano (coordenadas normalizadas de la cámara) a
  // píxeles de la mitad/pantalla activa y calcula los punteros (NDC).
  function update(hands, imageAspect, stereo) {
    if (W !== window.innerWidth || H !== window.innerHeight) resize();
    view.stereo = stereo;
    view.vw = stereo ? W / 2 : W;
    view.vh = H;
    view.aspect = view.vh > 0 ? view.vw / view.vh : 1;
    const U = Math.min(view.vw, view.vh);
    const K = U * CFG.size;                                // píxeles por "altura de imagen" de la cámara
    const ar = imageAspect || 4 / 3;

    for (const key of ['left', 'right']) {
      const h = hands[key], st = state[key];
      st.visible = !!(h.visible && h.disp);
      if (!st.visible) continue;
      st.pinching = h.isPinching;
      st.pinch = h.pinch;

      const palm = h.dpalm;
      const px0 = view.vw / 2 + (palm.x - 0.5) * view.vw * CFG.reach;
      const py0 = view.vh / 2 + (palm.y - 0.5) * view.vh * CFG.reach + CFG.shiftY * view.vh;
      st.palmPx.x = px0; st.palmPx.y = py0;
      for (let i = 0; i < 21; i++) {
        const p = h.disp[i];
        st.pts[i].x = px0 + (p.x - palm.x) * ar * K;
        st.pts[i].y = py0 + (p.y - palm.y) * K;
      }
      const pin = h.dpinch;
      st.pinchPx.x = px0 + (pin.x - palm.x) * ar * K;
      st.pinchPx.y = py0 + (pin.y - palm.y) * K;
      // tamaño de la mano en píxeles (robusto a verla de canto)
      st.size = Math.max(dist(st.pts[5], st.pts[17]), 0.9 * dist(st.pts[0], st.pts[9]), 8);

      st.pinchNdc.x = (st.pinchPx.x - view.vw / 2) / (view.vw / 2);
      st.pinchNdc.y = -(st.pinchPx.y - view.vh / 2) / (view.vh / 2);
      st.palmNdc.x = (st.palmPx.x - view.vw / 2) / (view.vw / 2);
      st.palmNdc.y = -(st.palmPx.y - view.vh / 2) / (view.vh / 2);
    }
  }

  // Traza todas las formas de una mano (dedos, palma, antebrazo) con el mismo
  // grosor `extra` añadido; se usa tres veces con distinto grosor/composición.
  function tracePass(c, st, extra) {
    const S = st.size, pts = st.pts;
    c.lineCap = 'round'; c.lineJoin = 'round';

    // antebrazo: un tramo corto hacia atrás desde la muñeca
    const wx = pts[0].x, wy = pts[0].y;
    let fx = wx - pts[9].x, fy = wy - pts[9].y;
    const fl = Math.hypot(fx, fy) || 1; fx /= fl; fy /= fl;
    c.beginPath(); c.moveTo(wx, wy); c.lineTo(wx + fx * S * 0.9, wy + fy * S * 0.9);
    c.lineWidth = S * 0.62 + extra; c.stroke();

    // palma: polígono relleno + trazo grueso redondeado
    c.beginPath();
    c.moveTo(pts[PALM_POLY[0]].x, pts[PALM_POLY[0]].y);
    for (let i = 1; i < PALM_POLY.length; i++) c.lineTo(pts[PALM_POLY[i]].x, pts[PALM_POLY[i]].y);
    c.closePath();
    c.lineWidth = S * 0.30 + extra; c.stroke();
    c.fill();

    // dedos: tres segmentos de grosor decreciente (los extremos redondos los unen)
    for (const f of FINGERS) {
      for (let k = 0; k < 3; k++) {
        const a = pts[f.idx[k]], b = pts[f.idx[k + 1]];
        const t = (k + 0.5) / 3;
        c.lineWidth = S * (f.w0 + (f.w1 - f.w0) * t) + extra;
        c.beginPath(); c.moveTo(a.x, a.y); c.lineTo(b.x, b.y); c.stroke();
      }
    }
  }

  // Dibuja UNA mano en `off`: contorno claro + relleno oscuro translúcido.
  // El relleno se hace con una máscara OPACA que después se vuelve translúcida
  // de forma uniforme: si se pintara con trazos ya translúcidos, los solapes
  // (dedo sobre palma) se oscurecerían y la mano se vería manchada.
  function drawHandShape(st) {
    const ink = st.pinching ? CFG.inkGrab : CFG.ink;
    const fill = st.pinching ? CFG.fillGrab : CFG.fill;
    const o = CFG.outline;
    const w = off.width, h = off.height;

    // interior (máscara opaca → color translúcido uniforme)
    mctx.setTransform(1, 0, 0, 1, 0, 0); mctx.clearRect(0, 0, w, h);
    mctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    mctx.globalCompositeOperation = 'source-over';
    mctx.strokeStyle = '#000'; mctx.fillStyle = '#000';
    tracePass(mctx, st, 0);
    mctx.setTransform(1, 0, 0, 1, 0, 0);
    mctx.globalCompositeOperation = 'source-in';
    mctx.fillStyle = fill; mctx.fillRect(0, 0, w, h);
    mctx.globalCompositeOperation = 'source-over';

    // contorno: silueta un poco más gruesa en el color del trazo, vaciada por dentro
    rctx.setTransform(1, 0, 0, 1, 0, 0); rctx.clearRect(0, 0, w, h);
    rctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    rctx.globalCompositeOperation = 'source-over';
    rctx.strokeStyle = ink; rctx.fillStyle = ink;
    tracePass(rctx, st, 2 * o);
    rctx.globalCompositeOperation = 'destination-out';
    rctx.strokeStyle = '#000'; rctx.fillStyle = '#000';
    tracePass(rctx, st, 0);
    rctx.globalCompositeOperation = 'source-over';

    octx.setTransform(1, 0, 0, 1, 0, 0);
    octx.drawImage(maskC, 0, 0);
    octx.drawImage(ringC, 0, 0);
  }

  // Puntero de pinza: anillo que se cierra al juntar los dedos y se llena al agarrar.
  function drawPointer(c, st, ox) {
    const r = st.pinching ? 5 : 9 - 4 * Math.max(0, Math.min(1, (st.pinch - 0.2) / 0.5));
    c.beginPath();
    c.arc(ox + st.pinchPx.x, st.pinchPx.y, r, 0, Math.PI * 2);
    if (st.pinching) { c.fillStyle = 'rgba(120, 255, 226, 0.9)'; c.fill(); }
    c.lineWidth = 1.6; c.strokeStyle = st.pinching ? 'rgba(255,255,255,0.95)' : 'rgba(255,255,255,0.85)';
    c.stroke();
  }

  // Dibuja las manos visibles en pantalla (una vez, o una por ojo en estéreo).
  function draw() {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const hands = [state.left, state.right].filter(s => s.visible);
    if (!hands.length || view.vw < 2 || view.vh < 2) return;   // ventana sin tamaño (minimizada): nada que dibujar

    const vw = Math.max(1, Math.round(view.vw * dpr)), vh = Math.max(1, Math.round(view.vh * dpr));
    if (off.width !== vw || off.height !== vh) {
      off.width = maskC.width = ringC.width = vw;
      off.height = maskC.height = ringC.height = vh;
    }
    octx.setTransform(1, 0, 0, 1, 0, 0);
    octx.clearRect(0, 0, off.width, off.height);
    for (const st of hands) drawHandShape(st);

    const copies = view.stereo ? [0, view.vw] : [0];
    for (const ox of copies) {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.drawImage(off, Math.round(ox * dpr), 0);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      for (const st of hands) drawPointer(ctx, st, ox);
    }
  }

  return { CFG, view, state, update, draw };
})();

window.HandOverlay = HandOverlay;
