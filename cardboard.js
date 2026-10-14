/* ============================================================
   CARDBOARD.JS — Modo Cartón (gafas de plástico/cartón + celular)
   ============================================================
   Añade la opción de ver la cocina en estéreo con unas gafas de
   cartón, igual que en MedVR Biomédico:

     1) Render estéreo: parcha `World.renderer.render` para que,
        en vez de dibujar una sola vez, dibuje la escena dos veces
        (ojo izquierdo y ojo derecho), cada una en su mitad de la
        pantalla, con un pequeño desplazamiento horizontal entre
        ellas — la misma técnica (y los mismos números) que usa
        MedVR. La mayoría de gafas de cartón NO tienen WebXR
        nativo, así que esto se simula "a mano".

     2) Divisor central + botones de salida duplicados (uno por
        ojo), pantalla completa y bloqueo de orientación horizontal
        — igual que en MedVR.

     3) HUD visible en ambos ojos: el HUD normal (#hud) se oculta
        entero porque está pensado para una sola pantalla completa,
        pero para poder cocinar con las gafas puestas hace falta
        seguir viendo la pinza de cada mano, qué llevas en la mano,
        el pedido y el tutorial. Se clonan esos paneles en dos
        copias (una por mitad de pantalla) y se mantienen al día con
        un MutationObserver sobre el #hud original — con un máximo de
        10 actualizaciones por segundo y SOLO cuando el contenido
        realmente cambió (clonar en cada cuadro costaba FPS).

     5) Cada ojo se dibuja con su propia cámara y un rectángulo entero; el efecto
        Cartoon (cartoon.js) se procesa por ojo antes de copiarlo a pantalla.
        Doble toque = recentrar; el frente definitivo se fija al quedar el
        celular quieto dentro de las gafas.

     4) Vista volteada 180°: en horizontal, el sensor de varios celulares reporta
        el aparato girado media vuelta respecto a la pantalla y la cocina se
        veía "de cabeza" (techo abajo). Al entrar se aplica una rotación base de
        180° sobre el eje de mirada (`Sensors.setViewRoll`) SIN tocar el mapeo
        del giroscopio. Si en tu celular quedara al revés, el botón «⟲ Voltear»
        de cada ojo la quita/pone y se recuerda.

   Girar la cabeza (giroscopio) y caminar (acelerómetro) YA NO viven aquí:
   funcionan igual con o sin gafas y los maneja sensors.js, aplicados en el
   bucle principal (game.js) ANTES de calcular manos y objetos agarrados.
   Esto es lo que mantiene las manos pegadas a la vista; antes el giro se
   aplicaba tarde, justo al dibujar, y las manos se quedaban atrás.

   Este archivo solo toca `World.renderer.render`, `Perf.setCap`,
   `Sensors.recenter/enable/toggleOrientSign`, `Game.showToast`, y clona
   (sin modificar) nodos del `#hud` que ya existe en el HTML.
   ============================================================ */

(() => {
  const { renderer } = World;

  let cardboardMode = false;
  let stereoInstalled = false;

  // Estado público de solo lectura (game.js / handoverlay.js lo consultan).
  window.Cardboard = { get active() { return cardboardMode; } };

  // Giro de 180° de la vista: activo por defecto (ver nota 4 del encabezado).
  const FLIP_KEY = 'rvr_cardboardFlip';
  function storedFlip() { try { return localStorage.getItem(FLIP_KEY) !== '0'; } catch (_) { return true; } }
  let flipView = storedFlip();
  function applyFlip() { Sensors.setViewRoll(cardboardMode && flipView ? Math.PI : 0); }
  function toggleFlip() {
    flipView = !flipView;
    try { localStorage.setItem(FLIP_KEY, flipView ? '1' : '0'); } catch (_) { /* modo privado */ }
    applyFlip();
    if (Game.showToast) Game.showToast('⟲ Vista volteada 180°: ' + (flipView ? 'sí' : 'no'));
  }

  // ══════════════════════════════════════════════════════════
  // HUD VISIBLE EN AMBOS OJOS (ver las manos para cocinar)
  // ══════════════════════════════════════════════════════════
  const HUD_CLONE_IDS = ['top-left', 'order-ticket', 'tutorial-panel', 'stove-indicator', 'held-info', 'toast-wrap'];
  const HUD_REFRESH_MS = 100;
  const hudEl = document.getElementById('hud');
  let hudLeft = null, hudRight = null, hudObserver = null;
  let hudSignature = '', hudTimer = 0;

  function currentHudSignature() {
    let sig = '';
    for (const id of HUD_CLONE_IDS) {
      const el = document.getElementById(id);
      if (el) sig += el.outerHTML;
    }
    return sig;
  }

  function refreshHudClones() {
    hudTimer = 0;
    if (!hudLeft || !hudRight) return;
    const sig = currentHudSignature();
    if (sig === hudSignature) return;           // nada cambió de verdad: no reclonar
    hudSignature = sig;
    for (const wrap of [hudLeft, hudRight]) {
      wrap.innerHTML = '';
      for (const id of HUD_CLONE_IDS) {
        const src = document.getElementById(id);
        if (src) wrap.appendChild(src.cloneNode(true));
      }
    }
  }

  function scheduleHudRefresh() {
    if (!hudTimer) hudTimer = setTimeout(refreshHudClones, HUD_REFRESH_MS);
  }

  function installHudClones() {
    if (!hudLeft) {
      hudLeft = document.createElement('div');
      hudLeft.className = 'cardboard-hud cardboard-hud-left';
      document.body.appendChild(hudLeft);
    }
    if (!hudRight) {
      hudRight = document.createElement('div');
      hudRight.className = 'cardboard-hud cardboard-hud-right';
      document.body.appendChild(hudRight);
    }
    hudSignature = '';
    refreshHudClones();
    if (!hudObserver) {
      hudObserver = new MutationObserver(scheduleHudRefresh);
      hudObserver.observe(hudEl, { childList: true, subtree: true, attributes: true, characterData: true });
    }
  }

  function stopHudClones() {
    if (hudObserver) { hudObserver.disconnect(); hudObserver = null; }
    if (hudTimer) { clearTimeout(hudTimer); hudTimer = 0; }
  }

  // ══════════════════════════════════════════════════════════
  // RENDER ESTÉREO (misma idea que MedVR: parchar renderer.render)
  // ══════════════════════════════════════════════════════════
  // Cómo queda la pantalla: cada ojo es un RECTÁNGULO entero de `half` x `h`
  // píxeles, el izquierdo pegado al borde izquierdo y el derecho al borde
  // derecho. Con ancho impar sobra UNA columna al centro (se deja limpia, es el
  // divisor); antes se usaba w/2 con decimales y los dos viewports se redondeaban
  // por separado: a veces un ojo salía 1 px más ancho o se montaban en el centro.
  //
  // Cada ojo tiene su PROPIA cámara (`eyeL`/`eyeR`), copiada de la principal cada
  // cuadro: la cámara del jugador ya no se mueve ni cambia de aspecto mientras se
  // dibuja (antes se le sumaba y restaba la separación de los ojos, y si algo
  // fallaba en medio quedaba descentrada). Los dos ojos usan el mismo frustum
  // simétrico con aspecto half/h y cámaras PARALELAS separadas EYE_SEP: lo
  // correcto para gafas de cartón, donde la pantalla está "en el infinito".
  //
  // El efecto Cartoon (cartoon.js), si está activo, se procesa por ojo dentro de
  // su rectángulo antes de volcarse a pantalla.
  const EYE_SEP = 0.032;                    // separación por ojo (mitad del promedio interpupilar humano)
  const eyeL = new THREE.PerspectiveCamera(), eyeR = new THREE.PerspectiveCamera();
  const _eyeX = new THREE.Vector3();

  function placeEye(eye, main, side, aspect) {
    eye.fov = main.fov; eye.near = main.near; eye.far = main.far; eye.zoom = main.zoom;
    eye.aspect = aspect;
    eye.updateProjectionMatrix();
    eye.quaternion.copy(main.quaternion);
    _eyeX.set(1, 0, 0).applyQuaternion(main.quaternion);          // "derecha" de la cámara (ya incluye el giro de vista)
    eye.position.copy(main.position).addScaledVector(_eyeX, side * EYE_SEP);
    eye.updateMatrixWorld(true);
  }

  function installStereoRenderer() {
    if (stereoInstalled) return;
    stereoInstalled = true;
    const originalRender = renderer.render.bind(renderer);

    function drawView(scene, camObj, rect) {
      if (Cartoon.enabled) { Cartoon.renderView(originalRender, scene, camObj, rect); return; }
      renderer.setViewport(rect.x, rect.y, rect.w, rect.h);
      renderer.setScissor(rect.x, rect.y, rect.w, rect.h);
      renderer.setScissorTest(true);
      originalRender(scene, camObj);
    }

    renderer.render = function (scene, cam) {
      // Solo se interviene el dibujo de la cámara principal y solo si hace falta.
      if (cam !== World.camera || (!cardboardMode && !Cartoon.enabled)) { originalRender(scene, cam); return; }
      const w = World.viewSize.w, h = World.viewSize.h;
      try {
        renderer.setRenderTarget(null);
        renderer.setScissorTest(false);
        renderer.setViewport(0, 0, w, h);
        renderer.clear();                                           // incluye la franja central y cualquier resto del cuadro anterior
        if (cardboardMode) {
          const half = Math.floor(w / 2);
          placeEye(eyeL, cam, -1, half / h);
          placeEye(eyeR, cam, +1, half / h);
          drawView(scene, eyeL, { x: 0, y: 0, w: half, h });
          drawView(scene, eyeR, { x: w - half, y: 0, w: half, h });
        } else {
          drawView(scene, cam, { x: 0, y: 0, w, h });
        }
      } finally {
        // pase lo que pase, el renderer queda en estado normal
        renderer.setRenderTarget(null);
        renderer.setScissorTest(false);
        renderer.setViewport(0, 0, w, h);
      }
    };
  }
  installStereoRenderer();

  // ══════════════════════════════════════════════════════════
  // ENTRAR / SALIR DEL MODO CARTÓN
  // ══════════════════════════════════════════════════════════
  // El render estéreo dibuja la escena DOS veces por cuadro, así que el costo
  // de cada píxel se paga el doble. Perf (perf.js) recibe un tope de
  // resolución más bajo SOLO mientras dura el Modo Cartón y lo restaura al salir.
  const CARDBOARD_PIXEL_CAP = 1.25;

  function enterCardboard() {
    Sensors.enable().then(ok => {
      Sensors.recenter();           // frente PROVISIONAL: hacia donde miras ahora
      cardboardMode = true;
      applyFlip();
      Perf.setCap(CARDBOARD_PIXEL_CAP);
      document.body.classList.add('cardboard-on');
      installHudClones();
      const el = document.documentElement;
      if (el.requestFullscreen) el.requestFullscreen().catch(() => {});
      if (screen.orientation && screen.orientation.lock) screen.orientation.lock('landscape').catch(() => {});
      if (Game.showToast) Game.showToast(ok
        ? '🥽 Modo Cartón activo — pon el celular en las gafas y quédate quieto: la vista se centra sola.'
        : '🥽 Modo Cartón activo (sin sensores: usa ←→ ↑↓ para mirar y WASD para moverte).');
      // El frente DEFINITIVO se fija cuando el celular ya está quieto y a nivel dentro
      // del visor (antes se fijaba al tocar el botón, con el celular todavía en la mano).
      if (ok) Sensors.recenterWhenStable(stable => {
        if (Game.showToast) Game.showToast(stable ? '🧭 Vista centrada. Doble toque = recentrar.' : '🧭 Vista centrada (no se detectó quietud).');
      });
    });
  }

  function exitCardboard() {
    cardboardMode = false;
    Sensors.cancelRecenterWhenStable();
    applyFlip();
    Perf.setCap(null);
    document.body.classList.remove('cardboard-on');
    stopHudClones();
    if (document.exitFullscreen && document.fullscreenElement) document.exitFullscreen().catch(() => {});
    if (screen.orientation && screen.orientation.unlock) screen.orientation.unlock();
    if (Game.showToast) Game.showToast('🥽 Modo Cartón desactivado.');
  }

  document.getElementById('cardboard-btn').addEventListener('click', enterCardboard);
  document.querySelectorAll('#cardboard-exit .btn-exit').forEach(b => b.addEventListener('click', exitCardboard));
  document.querySelectorAll('#cardboard-exit .btn-flip').forEach(b => b.addEventListener('click', toggleFlip));
  // Doble toque en cualquier parte (no en un botón) = recentrar. Las gafas con
  // botón conductivo (Cardboard v2) lo permiten sin sacar el celular.
  let lastTap = { t: 0, x: 0, y: 0 };
  document.addEventListener('pointerdown', (e) => {
    if (!cardboardMode || (e.target.closest && e.target.closest('button'))) return;
    const now = performance.now();
    if (now - lastTap.t < 450 && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 60) {
      Sensors.recenter(); lastTap.t = 0;
      if (Game.showToast) Game.showToast('🧭 Vista recentrada.');
    } else {
      lastTap = { t: now, x: e.clientX, y: e.clientY };
    }
  });

  // Efecto Cartoon (apagado por defecto) y corrección de deriva con la brújula.
  function paintToggles() {
    document.querySelectorAll('.btn-cartoon, #cartoon-btn').forEach(b => b.classList.toggle('on', Cartoon.enabled));
    const c = document.getElementById('compass-btn');
    if (c) c.classList.toggle('on', Sensors.compassEnabled);
  }
  function toggleCartoon() {
    Cartoon.setEnabled(!Cartoon.enabled);
    paintToggles();
    if (Game.showToast) Game.showToast('🎨 Cartoon: ' + (Cartoon.enabled ? 'activado (si baja el rendimiento, desactívalo)' : 'desactivado'));
  }
  function toggleCompass() {
    const on = Sensors.setCompass(!Sensors.compassEnabled);
    paintToggles();
    if (Game.showToast) Game.showToast(!on ? '🧭 Brújula desactivada (la vista puede derivar con los minutos).'
      : (Sensors.hasCompass ? '🧭 Brújula activada: corrige la deriva poco a poco.' : '🧭 Brújula activada, pero este navegador no entrega datos de brújula.'));
  }
  document.querySelectorAll('.btn-cartoon').forEach(b => b.addEventListener('click', toggleCartoon));
  const cartoonBtn = document.getElementById('cartoon-btn'); if (cartoonBtn) cartoonBtn.addEventListener('click', toggleCartoon);
  const compassBtn = document.getElementById('compass-btn'); if (compassBtn) compassBtn.addEventListener('click', toggleCompass);
  paintToggles();

  document.getElementById('invert-gyro-btn').addEventListener('click', () => {
    const sign = Sensors.toggleOrientSign();
    if (Game.showToast) Game.showToast('↔ Giro de cabeza: ' + (sign < 0 ? 'invertido' : 'normal') + ' — prueba mover la cabeza de nuevo');
  });
})();
