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
  // RENDER ESTÉREO (misma técnica que MedVR: parchar renderer.render)
  // ══════════════════════════════════════════════════════════
  function installStereoRenderer() {
    if (stereoInstalled) return;
    stereoInstalled = true;
    const originalRender = renderer.render.bind(renderer);
    const EYE_SEP = 0.032; // separación por ojo (mitad del promedio interpupilar humano)
    const localX = new THREE.Vector3();

    renderer.render = function (scene, cam) {
      if (!cardboardMode || !cam.isPerspectiveCamera) { originalRender(scene, cam); return; }

      const w = renderer.domElement.clientWidth, h = renderer.domElement.clientHeight;
      const halfW = w / 2;
      const prevAspect = cam.aspect;
      cam.aspect = halfW / h;
      cam.updateProjectionMatrix();
      localX.set(1, 0, 0).applyQuaternion(cam.quaternion);

      renderer.setScissorTest(true);
      // ojo izquierdo
      cam.position.addScaledVector(localX, -EYE_SEP);
      cam.updateMatrixWorld(true);
      renderer.setViewport(0, 0, halfW, h); renderer.setScissor(0, 0, halfW, h);
      originalRender(scene, cam);
      // ojo derecho
      cam.position.addScaledVector(localX, EYE_SEP * 2);
      cam.updateMatrixWorld(true);
      renderer.setViewport(halfW, 0, halfW, h); renderer.setScissor(halfW, 0, halfW, h);
      originalRender(scene, cam);
      // restablecer cámara y viewport a estado normal
      cam.position.addScaledVector(localX, -EYE_SEP);
      cam.updateMatrixWorld(true);
      renderer.setScissorTest(false);
      renderer.setViewport(0, 0, w, h);
      cam.aspect = prevAspect;
      cam.updateProjectionMatrix();
    };
  }

  // ══════════════════════════════════════════════════════════
  // ENTRAR / SALIR DEL MODO CARTÓN
  // ══════════════════════════════════════════════════════════
  // El render estéreo dibuja la escena DOS veces por cuadro, así que el costo
  // de cada píxel se paga el doble. Perf (perf.js) recibe un tope de
  // resolución más bajo SOLO mientras dura el Modo Cartón y lo restaura al salir.
  const CARDBOARD_PIXEL_CAP = 1.25;

  function enterCardboard() {
    Sensors.enable().then(ok => {
      installStereoRenderer();
      Sensors.recenter();           // el frente es hacia donde ya estabas mirando
      cardboardMode = true;
      Perf.setCap(CARDBOARD_PIXEL_CAP);
      document.body.classList.add('cardboard-on');
      installHudClones();
      const el = document.documentElement;
      if (el.requestFullscreen) el.requestFullscreen().catch(() => {});
      if (screen.orientation && screen.orientation.lock) screen.orientation.lock('landscape').catch(() => {});
      if (Game.showToast) Game.showToast(ok
        ? '🥽 Modo Cartón activo — coloca el celular en las gafas y camina para avanzar.'
        : '🥽 Modo Cartón activo (sin sensores: usa ←→ ↑↓ para mirar y WASD para moverte).');
    });
  }

  function exitCardboard() {
    cardboardMode = false;
    Perf.setCap(null);
    document.body.classList.remove('cardboard-on');
    stopHudClones();
    if (document.exitFullscreen && document.fullscreenElement) document.exitFullscreen().catch(() => {});
    if (screen.orientation && screen.orientation.unlock) screen.orientation.unlock();
    if (Game.showToast) Game.showToast('🥽 Modo Cartón desactivado.');
  }

  document.getElementById('cardboard-btn').addEventListener('click', enterCardboard);
  document.querySelectorAll('#cardboard-exit button').forEach(b => b.addEventListener('click', exitCardboard));
  document.getElementById('invert-gyro-btn').addEventListener('click', () => {
    const sign = Sensors.toggleOrientSign();
    if (Game.showToast) Game.showToast('↔ Giro de cabeza: ' + (sign < 0 ? 'invertido' : 'normal') + ' — prueba mover la cabeza de nuevo');
  });
})();
