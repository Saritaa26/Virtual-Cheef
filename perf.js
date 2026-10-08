/* ============================================================
   PERF.JS — Calidad adaptativa para sostener ~60 FPS
   ============================================================
   Un celular tiene que, en el MISMO hilo y la MISMA GPU, dibujar la cocina
   en 3D (dos veces por cuadro en Modo Cartón), leer sensores y ejecutar el
   modelo de reconocimiento de manos. Como la potencia varía muchísimo entre
   aparatos, en vez de fijar una calidad "para todos" se mide el tiempo real
   de cada cuadro y se baja (o sube) la calidad en escalones:

     escalón 0: resolución completa del tope  · manos a 30 Hz
     escalón 1:  80 % de resolución            · manos a 30 Hz
     escalón 2:  65 %                          · manos a 24 Hz
     escalón 3:  55 %                          · manos a 20 Hz
     escalón 4:  50 %                          · manos a 15 Hz

   · Bajar la resolución interna del canvas alivia a la GPU (relleno de
     píxeles, luces por píxel); la imagen solo se ve un poco más suave.
   · Bajar la frecuencia de la IA alivia al hilo principal; como las manos se
     interpolan cada cuadro (HandTracking.tick) casi no se nota.
   · Para no oscilar (bajar, subir, bajar…) solo se intenta SUBIR de escalón
     tras varios segundos estables, y si al subir los FPS se caen otra vez
     se bloquea ese intento por un minuto.

   `setCap(r)` limita el factor de píxeles máximo (el Modo Cartón lo baja a
   1.25 porque dibuja dos veces) y `cap` se restaura al salir.
   ============================================================ */

const Perf = (() => {
  const { renderer, IS_MOBILE } = World;
  const dpr = window.devicePixelRatio || 1;
  const BASE_CAP = IS_MOBILE ? Math.min(dpr, 1.5) : Math.min(dpr, 2);
  const LEVELS = [
    { scale: 1.00, handHz: 30 },
    { scale: 0.80, handHz: 30 },
    { scale: 0.65, handHz: 24 },
    { scale: 0.55, handHz: 20 },
    { scale: 0.50, handHz: 15 }
  ];
  const MIN_RATIO = 0.5;

  let cap = BASE_CAP;
  let level = 0;
  let fps = 60;
  let frames = 0, acc = 0;
  let lastChange = performance.now();
  let noUpUntil = 0;
  let lastWasUp = false;
  let enabled = true;
  let fpsEl = null;
  let lastShown = '';

  function ratioFor(lv) { return Math.max(MIN_RATIO, cap * LEVELS[lv].scale); }

  function apply() {
    const r = ratioFor(level);
    if (Math.abs(renderer.getPixelRatio() - r) > 0.01) renderer.setPixelRatio(r);
    if (window.HandTracking) HandTracking.setTargetHz(LEVELS[level].handHz);
  }

  function show() {
    if (!fpsEl) fpsEl = document.getElementById('fps-text');
    if (!fpsEl) return;
    const txt = `FPS ${Math.round(fps)} · res ${Math.round(LEVELS[level].scale * 100)}%`;
    if (txt !== lastShown) { fpsEl.textContent = txt; lastShown = txt; }
  }

  // `rawDt`: segundos reales del cuadro (sin recortar).
  function update(rawDt) {
    if (rawDt > 0.5) return; // pestaña en segundo plano / pausa: no cuenta como "lento"
    acc += rawDt; frames++;
    if (acc < 0.6) return;
    fps = frames / acc;
    frames = 0; acc = 0;
    show();
    if (!enabled) return;

    const now = performance.now();
    if (fps < 50 && level < LEVELS.length - 1 && now - lastChange > 1200) {
      // si justo después de subir se vuelve a caer, no insistir en subir por un rato
      if (lastWasUp && now - lastChange < 9000) noUpUntil = now + 60000;
      level++; lastWasUp = false; lastChange = now; apply();
    } else if (fps >= 57 && level > 0 && now - lastChange > 6000 && now > noUpUntil) {
      level--; lastWasUp = true; lastChange = now; apply();
    }
  }

  function setCap(c) {
    cap = c == null ? BASE_CAP : Math.min(c, BASE_CAP);
    apply();
  }

  apply();

  return {
    update, setCap,
    get fps() { return fps; },
    get level() { return level; },
    get cap() { return cap; },
    set enabled(v) { enabled = !!v; }
  };
})();

window.Perf = Perf;
