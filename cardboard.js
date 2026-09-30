/* ============================================================
   CARDBOARD.JS — Modo Cartón (gafas de plástico/cartón + celular)
   ============================================================
   Añade la opción de ver la cocina en estéreo con unas gafas de
   cartón, igual que en MedVR Biomédico, SIN tocar ninguna otra
   pieza del restaurante:

     1) Render estéreo: parcha `World.renderer.render` para que,
        en vez de dibujar una sola vez, dibuje la escena dos veces
        (ojo izquierdo y ojo derecho), cada una en su mitad de la
        pantalla, con un pequeño desplazamiento horizontal entre
        ellas — la misma técnica (y los mismos números) que usa
        MedVR. La mayoría de gafas de cartón NO tienen WebXR
        nativo, así que esto se simula "a mano".

     2) Mirar alrededor con la cabeza: mientras el Modo Cartón está
        activo, se lee el giroscopio del teléfono (evento
        `deviceorientation`) y su orientación se aplica a
        `World.camera` justo antes de dibujar cada cuadro — es
        decir, DESPUÉS de que game.js ya calculó la posición y
        rotación por teclado para ese cuadro. Por eso nunca compite
        con el movimiento WASD/flechas: simplemente se dibuja con
        la orientación más reciente del giroscopio.

        Como el rumbo absoluto del compás no es fiable ni
        comparable entre dispositivos, al entrar en Modo Cartón se
        "calibra": la primera lectura del giroscopio se ancla a la
        dirección a la que ya estabas mirando, y desde ahí solo se
        seguyen los giros relativos de la cabeza.

     3) Caminar en el sitio: mientras el Modo Cartón está activo, se
        lee el acelerómetro (evento `devicemotion`) y se detecta el
        rebote rítmico de cada paso real. No hay forma confiable de
        distinguir "paso hacia adelante" de "paso hacia atrás" solo
        con el acelerómetro, así que — igual que la mayoría de apps
        de RV con "caminar en el sitio" — cada paso avanza en la
        dirección a la que YA estás mirando; para ir hacia otro lado,
        se gira la cabeza y se vuelve a caminar. El avance respeta
        las mismas paredes/muebles que el teclado (World.resolvePlayerXZ).

     4) Divisor central + botones de salida duplicados (uno por
        ojo), pantalla completa y bloqueo de orientación horizontal
        — igual que en MedVR.

   Este archivo SOLO lee `World.camera` / `World.renderer` /
   `World.resolvePlayerXZ` y `Game.showToast`. No modifica
   tracking.js, world.js, items.js, game.js ni guide.js, y no
   depende de que ellos lo conozcan a él.
   ============================================================ */

(() => {
  const { camera, renderer } = World;

  let cardboardMode = false;
  let stereoInstalled = false;

  // ══════════════════════════════════════════════════════════
  // GIROSCOPIO → ORIENTACIÓN DE LA CÁMARA
  // ══════════════════════════════════════════════════════════
  let gyroActive = false;
  let lastOrientationEvent = null;
  let calibrationQuaternion = null;

  const _zee = new THREE.Vector3(0, 0, 1);
  const _euler = new THREE.Euler();
  const _q0 = new THREE.Quaternion();
  const _q1 = new THREE.Quaternion(-Math.sqrt(0.5), 0, 0, Math.sqrt(0.5)); // -90° en X
  const _deviceQ = new THREE.Quaternion();

  // El Modo Cartón siempre bloquea la pantalla en horizontal
  // (screen.orientation.lock('landscape')), así que hay que compensar
  // esa rotación de 90°. Ese término (orient) es el más sensible al
  // navegador/celular concreto — el signo correcto varía según el
  // fabricante y no hay forma honesta de adivinarlo sin probarlo en el
  // celular real. En vez de arriesgarnos a dejarlo al revés, queda
  // como un interruptor de un toque: el botón "↔ Invertir giro de
  // cabeza" del HUD llama a toggleOrientSign() y lo recuerda para la
  // próxima vez (localStorage), así que solo hay que probarlo UNA vez.
  let orientSign = parseFloat(localStorage.getItem('rvr_orientSign')) || 1;
  function toggleOrientSign() {
    orientSign *= -1;
    localStorage.setItem('rvr_orientSign', String(orientSign));
    if (Game.showToast) Game.showToast('↔ Giro de cabeza: ' + (orientSign < 0 ? 'invertido' : 'normal') + ' — prueba el Modo Cartón de nuevo');
  }

  // Algoritmo estándar (el mismo que usan three.js y la mayoría de
  // visores "phone as VR") para convertir alpha/beta/gamma del
  // sensor, más el ángulo de rotación de pantalla, en un quaternion.
  function deviceQuaternion(e, out) {
    const alpha = THREE.MathUtils.degToRad(e.alpha || 0);
    const beta = THREE.MathUtils.degToRad(e.beta || 0);
    const gamma = THREE.MathUtils.degToRad(e.gamma || 0);
    const screenAngle = (screen.orientation && screen.orientation.angle) || window.orientation || 0;
    const orient = THREE.MathUtils.degToRad(screenAngle) * orientSign;
    _euler.set(beta, alpha, -gamma, 'YXZ');
    out.setFromEuler(_euler);
    out.multiply(_q1);
    out.multiply(_q0.setFromAxisAngle(_zee, -orient));
    return out;
  }

  function onDeviceOrientation(e) {
    if (e.alpha == null && e.beta == null && e.gamma == null) return; // sensor sin datos
    lastOrientationEvent = e;
    gyroActive = true;
  }
  window.addEventListener('deviceorientation', onDeviceOrientation);

  // Ancla la primera lectura del giroscopio a la orientación actual
  // de la cámara, para no "saltar" de golpe a un rumbo arbitrario.
  function calibrateGyro() {
    if (!lastOrientationEvent) { calibrationQuaternion = null; return; }
    deviceQuaternion(lastOrientationEvent, _deviceQ);
    calibrationQuaternion = camera.quaternion.clone().multiply(_deviceQ.clone().invert());
  }

  function applyGyroToCamera() {
    if (!gyroActive || !lastOrientationEvent) return;
    if (!calibrationQuaternion) calibrateGyro();
    deviceQuaternion(lastOrientationEvent, _deviceQ);
    camera.quaternion.copy(calibrationQuaternion).multiply(_deviceQ);
  }

  // ══════════════════════════════════════════════════════════
  // CAMINAR EN EL SITIO (detección de pasos por acelerómetro)
  // ══════════════════════════════════════════════════════════
  // `devicemotion` dispara MUCHO más seguido que un cuadro de render,
  // así que aquí solo se CUENTAN los pasos (rápido, barato); el
  // movimiento real de la cámara se aplica una sola vez por cuadro,
  // dentro del render (ver applyWalkOffset), igual que el giro.
  const STEP_THRESHOLD = 1.6;   // m/s² de "rebote" por encima de lo normal para contar un paso
  const STEP_RELEASE = 0.6;     // hay que bajar de esto antes de poder contar el siguiente paso
  const STEP_COOLDOWN = 280;    // ms mínimos entre pasos (evita contar un mismo paso dos veces)
  const STEP_DISTANCE = 0.5;    // metros que avanza cada paso detectado
  let baselineMag = null;       // línea base suavizada (sirve tanto si el navegador da
                                 // acceleration con gravedad como sin ella — no hace falta saberlo)
  let overThreshold = false;
  let lastStepAt = 0;
  let pendingSteps = 0;

  function onDeviceMotion(e) {
    const a = (e.acceleration && e.acceleration.x != null) ? e.acceleration : e.accelerationIncludingGravity;
    if (!a || a.x == null) return;
    const mag = Math.sqrt((a.x || 0) ** 2 + (a.y || 0) ** 2 + (a.z || 0) ** 2);
    if (baselineMag == null) baselineMag = mag;
    else baselineMag = baselineMag * 0.9 + mag * 0.1;
    const spike = mag - baselineMag;
    const now = performance.now();
    if (!overThreshold && spike > STEP_THRESHOLD && now - lastStepAt > STEP_COOLDOWN) {
      overThreshold = true;
      lastStepAt = now;
      pendingSteps++;
    } else if (overThreshold && spike < STEP_RELEASE) {
      overThreshold = false;
    }
  }
  window.addEventListener('devicemotion', onDeviceMotion);

  let walkOffsetX = 0, walkOffsetZ = 0; // avance acumulado por pasos, ya corregido por colisión
  const _fwd = new THREE.Vector3();

  // Se llama una vez por cuadro (dentro del render, después del giro):
  // convierte los pasos pendientes en avance real, respetando paredes
  // y muebles (World.resolvePlayerXZ es la MISMA colisión del teclado).
  function applyWalkOffset() {
    if (!cardboardMode) return;
    const baseX = camera.position.x, baseZ = camera.position.z; // = posición del jugador este cuadro, sin nuestro avance
    let offX = walkOffsetX, offZ = walkOffsetZ;
    if (pendingSteps > 0) {
      _fwd.set(0, 0, -1).applyQuaternion(camera.quaternion);
      _fwd.y = 0;
      if (_fwd.lengthSq() > 1e-6) {
        _fwd.normalize();
        offX += _fwd.x * STEP_DISTANCE * pendingSteps;
        offZ += _fwd.z * STEP_DISTANCE * pendingSteps;
      }
      pendingSteps = 0;
    }
    const resolved = World.resolvePlayerXZ(baseX + offX, baseZ + offZ);
    walkOffsetX = resolved.x - baseX;
    walkOffsetZ = resolved.z - baseZ;
    camera.position.x = resolved.x;
    camera.position.z = resolved.z;
  }

  // ══════════════════════════════════════════════════════════
  // RENDER ESTÉREO (misma técnica que MedVR: parchar renderer.render)
  // ══════════════════════════════════════════════════════════
  function installStereoRenderer() {
    if (stereoInstalled) return;
    stereoInstalled = true;
    const originalRender = renderer.render.bind(renderer);
    const EYE_SEP = 0.032; // separación por ojo (mitad del promedio interpupilar humano)

    renderer.render = function (scene, cam) {
      if (!cardboardMode || !cam.isPerspectiveCamera) { originalRender(scene, cam); return; }
      if (cam === camera) { applyGyroToCamera(); applyWalkOffset(); }

      const w = renderer.domElement.clientWidth, h = renderer.domElement.clientHeight;
      const halfW = w / 2;
      const prevAspect = cam.aspect;
      cam.aspect = halfW / h;
      cam.updateProjectionMatrix();
      const localX = new THREE.Vector3(1, 0, 0).applyQuaternion(cam.quaternion);

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
  // PERMISO DE GIROSCOPIO (iOS 13+)
  // Safari en iPhone exige pedir permiso explícito, y solo lo
  // concede si se pide dentro de un toque directo del usuario —
  // por eso se llama aquí mismo, dentro del botón, no al cargar.
  // Solo funciona si la página se abre por https:// (no file://).
  // ══════════════════════════════════════════════════════════
  function requestMotionPermission() {
    const DOE = window.DeviceOrientationEvent;
    const DME = window.DeviceMotionEvent; // permiso separado, lo usa el detector de pasos
    if (DME && typeof DME.requestPermission === 'function') DME.requestPermission().catch(() => {});
    const needsPermission = DOE && typeof DOE.requestPermission === 'function';
    if (!needsPermission) return Promise.resolve(true);
    return DOE.requestPermission().then(state => state === 'granted').catch(() => false);
  }

  // ══════════════════════════════════════════════════════════
  // ENTRAR / SALIR DEL MODO CARTÓN
  // ══════════════════════════════════════════════════════════
  // El render estéreo dibuja la escena DOS veces por cuadro (una por
  // ojo) — el costo de cada píxel se paga el doble. Para que los FPS
  // no se desplomen (y con ellos la fluidez del giro de cabeza, que
  // depende de cuántos cuadros por segundo se alcanzan a dibujar) se
  // baja la resolución interna del render SOLO mientras dura el Modo
  // Cartón, y se restaura tal cual estaba al salir.
  const originalPixelRatio = renderer.getPixelRatio();
  const CARDBOARD_PIXEL_RATIO = Math.min(originalPixelRatio, 1.25);

  function enterCardboard() {
    requestMotionPermission().then(ok => {
      installStereoRenderer();
      calibrationQuaternion = null; // recalibrar el rumbo al entrar
      cardboardMode = true;
      renderer.setPixelRatio(CARDBOARD_PIXEL_RATIO);
      document.body.classList.add('cardboard-on');
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
    renderer.setPixelRatio(originalPixelRatio);
    document.body.classList.remove('cardboard-on');
    if (document.exitFullscreen) document.exitFullscreen().catch(() => {});
    if (screen.orientation && screen.orientation.unlock) screen.orientation.unlock();
    if (Game.showToast) Game.showToast('🥽 Modo Cartón desactivado.');
  }

  document.getElementById('cardboard-btn').addEventListener('click', enterCardboard);
  document.querySelectorAll('#cardboard-exit button').forEach(b => b.addEventListener('click', exitCardboard));
  document.getElementById('invert-gyro-btn').addEventListener('click', toggleOrientSign);
})();
