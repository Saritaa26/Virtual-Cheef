/* ============================================================
   SENSORS.JS — Giroscopio (mirar) y acelerómetro (caminar)
   ============================================================
   Sincroniza la cámara virtual con el movimiento real del celular:

   1) MIRAR (DeviceOrientationEvent): alpha/beta/gamma → quaternion con el
      algoritmo estándar de three.js para "phone as VR". La orientación se
      usa así:
        · INCLINACIÓN (arriba/abajo) y ROLL (ladear): ABSOLUTOS, medidos
          contra la gravedad. Si miras al techo en la vida real, miras al
          techo en la cocina, sin importar cómo sostuviste el celular al
          empezar.
        · GIRO (izquierda/derecha): RELATIVO. El rumbo del compás no es
          fiable ni comparable entre celulares, así que al activar/recentrar
          se toma la dirección actual como "frente" (la que ya traía el
          jugador) y desde ahí solo cuentan los giros reales.
      El resultado se suaviza con un seguidor exponencial ADAPTATIVO
      (estilo One-Euro, en quaternions): con la cabeza casi quieta absorbe
      el ruido del sensor (la vista no tiembla), y en un giro rápido casi no
      añade retraso. Es independiente de los FPS (usa el dt real del cuadro).

   2) CAMINAR (DeviceMotionEvent): cada paso real se detecta como un pico
      del acelerómetro por encima de su línea base (con histéresis y
      cooldown para no contar dos veces un mismo paso). El acelerómetro no
      distingue "paso adelante" de "paso atrás", así que cada paso avanza
      hacia donde miras ("caminar en el sitio", como casi toda app de RV con
      celular); para ir a otro lado, gira y camina. El avance NO se aplica
      de golpe: se reparte (~0.2 s por paso) para que se sienta como
      caminar y no como un teletransporte.

   Este módulo no conoce la escena: game.js le pide la orientación de la
   cámara (`orientationInto`) y los metros a avanzar (`consumeWalk`) una vez
   por cuadro, ANTES de calcular manos e interacciones, para que manos,
   objetos agarrados y vista usen siempre la misma cámara.
   ============================================================ */

const Sensors = (() => {

  const AXIS_Y = new THREE.Vector3(0, 1, 0);
  const AXIS_Z = new THREE.Vector3(0, 0, 1);
  const _euler = new THREE.Euler();
  const _q0 = new THREE.Quaternion();
  const Q_CAMERA_OUT_BACK = new THREE.Quaternion(-Math.sqrt(0.5), 0, 0, Math.sqrt(0.5)); // -90° en X: la cámara mira por la parte de atrás
  const _D = new THREE.Quaternion();
  const _yawQ = new THREE.Quaternion();
  const _target = new THREE.Quaternion();
  const _prevTarget = new THREE.Quaternion();
  const _cur = new THREE.Quaternion();
  const _v = new THREE.Vector3();
  const _u = new THREE.Vector3();

  function clamp(x, a, b) { return Math.max(a, Math.min(b, x)); }

  function storageGet(k) { try { return localStorage.getItem(k); } catch (_) { return null; } }
  function storageSet(k, v) { try { localStorage.setItem(k, v); } catch (_) { /* modo privado: simplemente no se recuerda */ } }

  // ══════════════════════════════════════════════════════════
  // ORIENTACIÓN (mirar)
  // ══════════════════════════════════════════════════════════
  // Compensación por la rotación de pantalla (el Modo Cartón la bloquea en
  // horizontal). El signo correcto puede variar según fabricante/navegador y
  // no hay forma honesta de adivinarlo sin probar en el celular: queda como
  // interruptor de un toque (botón "↔ Invertir giro de cabeza") y se recuerda.
  let orientSign = parseFloat(storageGet('rvr_orientSign')) || 1;

  let ev = null;            // { alpha, beta, gamma }
  let evAt = 0;             // performance.now() de la última lectura válida
  let headingOffset = null; // rumbo del dispositivo al calibrar (null = recalibrar en el próximo cuadro)
  let hasCur = false;

  function onDeviceOrientation(e) {
    if (e.alpha == null && e.beta == null && e.gamma == null) return; // sensor sin datos (típico en PC)
    ev = { alpha: e.alpha || 0, beta: e.beta || 0, gamma: e.gamma || 0 };
    evAt = performance.now();
  }
  window.addEventListener('deviceorientation', onDeviceOrientation);

  function active() { return ev !== null && performance.now() - evAt < 1500; }

  // Algoritmo estándar (three.js DeviceOrientationControls): alpha/beta/gamma
  // del sensor + ángulo de pantalla → quaternion cámara.
  function deviceQuaternion(out) {
    const alpha = THREE.MathUtils.degToRad(ev.alpha);
    const beta = THREE.MathUtils.degToRad(ev.beta);
    const gamma = THREE.MathUtils.degToRad(ev.gamma);
    const screenAngle = (screen.orientation && screen.orientation.angle) || window.orientation || 0;
    const orient = THREE.MathUtils.degToRad(screenAngle) * orientSign;
    _euler.set(beta, alpha, -gamma, 'YXZ');
    out.setFromEuler(_euler);
    out.multiply(Q_CAMERA_OUT_BACK);
    out.multiply(_q0.setFromAxisAngle(AXIS_Z, -orient));
    return out;
  }

  // Rumbo (rotación sobre Y) hacia donde apunta el dispositivo, con el mismo
  // convenio de game.js: adelante = (-sin yaw, 0, -cos yaw).
  function headingOf(q) {
    _v.set(0, 0, -1).applyQuaternion(q);
    if (Math.hypot(_v.x, _v.z) > 0.2) return Math.atan2(-_v.x, -_v.z);
    // Mirando casi vertical (al techo o al piso): el rumbo sale del "arriba" de la cámara.
    _u.set(0, 1, 0).applyQuaternion(q);
    return _v.y < 0 ? Math.atan2(-_u.x, -_u.z) : Math.atan2(_u.x, _u.z);
  }

  // Suavizado: constante de seguimiento (1/s) entre K_MIN (cabeza casi quieta,
  // filtra ruido) y K_MAX (giro rápido, casi sin retraso).
  const K_MIN = 14, K_MAX = 70;
  const SPEED_LOW = 0.15, SPEED_HIGH = 2.0; // rad/s del objetivo (≈ 9°/s y 115°/s)

  // Escribe en `out` la orientación de la cámara para un jugador que mira hacia
  // `yaw` (rad, el de las flechas del teclado). Devuelve false si no hay sensor.
  function orientationInto(out, yaw, dt) {
    if (!active()) return false;
    deviceQuaternion(_D);
    if (headingOffset === null) { headingOffset = headingOf(_D); hasCur = false; }

    _yawQ.setFromAxisAngle(AXIS_Y, yaw - headingOffset);
    _target.copy(_yawQ).multiply(_D);

    if (!hasCur) {
      _cur.copy(_target); _prevTarget.copy(_target); hasCur = true;
    } else {
      const speed = _prevTarget.angleTo(_target) / Math.max(dt, 1e-3);
      _prevTarget.copy(_target);
      const k = K_MIN + (K_MAX - K_MIN) * clamp((speed - SPEED_LOW) / (SPEED_HIGH - SPEED_LOW), 0, 1);
      _cur.slerp(_target, 1 - Math.exp(-k * Math.max(dt, 1e-3)));
    }
    out.copy(_cur);
    return true;
  }

  function recenter() { headingOffset = null; }

  function toggleOrientSign() {
    orientSign *= -1;
    storageSet('rvr_orientSign', String(orientSign));
    recenter();
    return orientSign;
  }

  // ══════════════════════════════════════════════════════════
  // PASOS (caminar)
  // ══════════════════════════════════════════════════════════
  const STEP_THRESHOLD = 1.6;   // m/s² de "rebote" sobre la línea base para contar un paso
  const STEP_RELEASE = 0.6;     // hay que bajar de esto antes de poder contar otro
  const STEP_COOLDOWN = 280;    // ms mínimos entre pasos
  const STEP_DISTANCE = 0.5;    // metros que avanza cada paso
  const WALK_SPEED = 2.4;       // m/s con que se reparte ese avance (≈ 0.2 s por paso)
  const WALK_QUEUE_MAX = 2.0;   // tope de metros pendientes (evita seguir avanzando mucho después de parar)

  let baselineMag = null;       // línea base suavizada (sirve con o sin gravedad en acceleration)
  let overThreshold = false;
  let lastStepAt = 0;
  let walkRemaining = 0;
  let walkingEnabled = true;
  let stepCount = 0;

  function onDeviceMotion(e) {
    if (!walkingEnabled) return;
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
      stepCount++;
      walkRemaining = Math.min(WALK_QUEUE_MAX, walkRemaining + STEP_DISTANCE);
    } else if (overThreshold && spike < STEP_RELEASE) {
      overThreshold = false;
    }
  }
  window.addEventListener('devicemotion', onDeviceMotion);

  // Metros que hay que avanzar en este cuadro (hacia donde mira el jugador).
  function consumeWalk(dt) {
    if (walkRemaining <= 0) return 0;
    const d = Math.min(walkRemaining, WALK_SPEED * dt);
    walkRemaining -= d;
    return d;
  }

  // ══════════════════════════════════════════════════════════
  // PERMISOS (iOS 13+)
  // ══════════════════════════════════════════════════════════
  // Safari en iPhone exige permiso explícito y solo lo concede si se pide
  // dentro de un toque directo del usuario — por eso game.js lo llama de forma
  // SÍNCRONA al inicio del manejador del botón "Entrar". En Android no hace
  // falta (devuelve true). Solo funciona por https:// (no file://).
  function enable() {
    const DOE = window.DeviceOrientationEvent;
    const DME = window.DeviceMotionEvent;
    const asks = [];
    if (DOE && typeof DOE.requestPermission === 'function') asks.push(DOE.requestPermission().then(s => s === 'granted').catch(() => false));
    if (DME && typeof DME.requestPermission === 'function') asks.push(DME.requestPermission().then(s => s === 'granted').catch(() => false));
    if (!asks.length) return Promise.resolve(true);
    return Promise.all(asks).then(r => r.every(Boolean));
  }

  return {
    enable,
    recenter,
    toggleOrientSign,
    orientationInto,
    consumeWalk,
    setWalking(on) { walkingEnabled = !!on; if (!on) walkRemaining = 0; },
    get active() { return active(); },
    get supported() { return 'DeviceOrientationEvent' in window; },
    get orientSign() { return orientSign; },
    get stepCount() { return stepCount; },
    get walkingEnabled() { return walkingEnabled; }
  };
})();

window.Sensors = Sensors;
