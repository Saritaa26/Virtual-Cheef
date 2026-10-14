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

      DERIVA: el giro lateral de la fuente relativa se acumula con los minutos. Se
      corrige con un filtro complementario hacia la brújula (deviceorientationabsolute)
      con ganancia muy baja y compuertas anti-interferencia; además `recenterWhenStable`
      fija el frente cuando el celular ya está quieto dentro de las gafas, y se puede
      recentrar a mano (botón, tecla R o doble toque en Modo Cartón).

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

  // Dos fuentes de orientación, con virtudes opuestas:
  //   · RELATIVA (`deviceorientation`): giroscopio + acelerómetro. Es suave y
  //     rápida, el cabeceo/ladeo no derivan (la gravedad los corrige), pero el
  //     GIRO LATERAL (yaw) se va acumulando sin corrección: es la "deriva" —
  //     unos grados por minuto según el celular y su temperatura.
  //   · ABSOLUTA (`deviceorientationabsolute`): usa además la brújula. No deriva
  //     nunca, pero es ruidosa (±5-10°) y se desvía cerca de metales/imanes.
  // Un FILTRO COMPLEMENTARIO usa cada una donde es buena: lo inmediato sale de la
  // relativa y, MUY despacio, el yaw se va corrigiendo hacia la absoluta (ver
  // updateCompass). Así la vista no tiembla ni se descuadra con los minutos.
  let ev = null;            // { alpha, beta, gamma, absolute }
  let evAt = 0;             // performance.now() de la última lectura válida
  let evAbs = null;         // lo mismo, de la fuente absoluta
  let evAbsAt = 0;
  let headingOffset = null; // rumbo del dispositivo al calibrar (null = recalibrar en el próximo cuadro)
  let hasCur = false;

  function readOrientation(e) {
    if (e.alpha == null && e.beta == null && e.gamma == null) return null; // sensor sin datos (típico en PC)
    return { alpha: e.alpha || 0, beta: e.beta || 0, gamma: e.gamma || 0, absolute: !!e.absolute };
  }
  function onDeviceOrientation(e) {
    const o = readOrientation(e);
    if (!o) return;
    ev = o; evAt = performance.now();
  }
  function onDeviceOrientationAbsolute(e) {
    const o = readOrientation(e);
    if (!o) return;
    evAbs = o; evAbsAt = performance.now();
  }
  window.addEventListener('deviceorientation', onDeviceOrientation);
  window.addEventListener('deviceorientationabsolute', onDeviceOrientationAbsolute);

  // Algunos navegadores dejan de emitir eventos si el celular está perfectamente
  // quieto; con 1.5 s la cámara saltaba al modo teclado en esos instantes. Con 10 s
  // se tolera la quietud, y sin sensores (PC) `ev` nunca llega y se usa el teclado.
  function active() { return ev !== null && performance.now() - evAt < 10000; }

  // Algoritmo estándar (three.js DeviceOrientationControls): alpha/beta/gamma
  // del sensor + ángulo de pantalla → quaternion cámara.
  function deviceQuaternion(src, out) {
    const alpha = THREE.MathUtils.degToRad(src.alpha);
    const beta = THREE.MathUtils.degToRad(src.beta);
    const gamma = THREE.MathUtils.degToRad(src.gamma);
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

  const DEG = Math.PI / 180;
  function wrap(a) { return a - 2 * Math.PI * Math.round(a / (2 * Math.PI)); }

  // ---------- Filtro complementario con la brújula (corrige la deriva del yaw) ----------
  // yawBias = cuánto hay que SUMAR al rumbo relativo para acercarlo al de la
  // brújula. Se mueve con una constante de tiempo larga (TAU) y una velocidad
  // máxima baja, y solo cuando la medición es confiable:
  //   · la brújula está "fresca" y es una fuente distinta de la relativa;
  //   · lo que FALTA por corregir (el desacuerdo promediado menos lo ya corregido)
  //     es menor de GATE (10°): una diferencia grande y repentina casi siempre es
  //     una anomalía magnética (imán de las gafas, metal, parlantes), no deriva
  //     (la deriva real es de décimas de grado por segundo), y se ignora;
  //   · el desacuerdo es ESTABLE (eDev bajo): una brújula que baila se descarta;
  //   · la cabeza no se está moviendo rápido (las dos fuentes llegan en eventos
  //     distintos y, girando, no están alineadas en el tiempo).
  // Con TAU = 20 s el ruido de la brújula (±8°) queda en décimas de grado, y una
  // deriva real de unos 3°/min se corrige con ~1° de retraso. Primero se calibra 3 s
  // (sin corregir) y la corrección nunca pasa de 0.3°/s (18°/min).
  let compassEnabled = storageGet('rvr_compass') !== '0';
  const COMPASS = { TAU: 20, MAX_RATE: 0.3 * DEG, DEV_MAX: 7 * DEG, GATE: 10 * DEG, SPEED_MAX: 35 * DEG, FRESH_MS: 1000, AVG_TAU: 1.5, CAL_SECONDS: 3 };
  let compassRef = null;    // desacuerdo brújula-relativa medido al calibrar (el "cero")
  let eAvg = 0, eDev = 0;   // desacuerdo promedio y su variabilidad
  let yawBias = 0;
  let calT = 0, calS = 0, calC = 0;   // acumuladores de la media circular durante la calibración
  let compassLive = false;  // ¿se está usando de verdad la brújula en este momento?
  const _Dabs = new THREE.Quaternion();

  function resetCompass() { compassRef = null; eAvg = 0; eDev = 0; yawBias = 0; compassLive = false; calT = 0; calS = 0; calC = 0; }

  function updateCompass(dt, speed) {
    compassLive = false;
    if (!compassEnabled || !evAbs || ev.absolute) return;      // sin brújula, apagada, o la fuente ya es absoluta
    const now = performance.now();
    if (now - evAbsAt > COMPASS.FRESH_MS || now - evAt > COMPASS.FRESH_MS) return;
    const hRel = headingOf(_D);
    deviceQuaternion(evAbs, _Dabs);
    const diff = wrap(headingOf(_Dabs) - hRel);
    if (compassRef === null) {
      // El "cero" se promedia durante CAL_SECONDS (media circular): una sola lectura
      // ruidosa (±8°) lo dejaría con un error constante que se vería como deriva.
      if (speed < COMPASS.SPEED_MAX) { calS += Math.sin(diff) * dt; calC += Math.cos(diff) * dt; calT += dt; }
      if (calT >= COMPASS.CAL_SECONDS) { compassRef = Math.atan2(calS, calC); eAvg = 0; eDev = 0; }
      return;
    }
    const e = wrap(diff - compassRef);                         // deriva acumulada de la fuente relativa (con signo)
    const a = 1 - Math.exp(-dt / COMPASS.AVG_TAU);
    const d = wrap(e - eAvg);
    eAvg = wrap(eAvg + d * a);
    eDev += (Math.abs(d) - eDev) * a;
    const resid = wrap(eAvg - yawBias);                        // lo que todavía falta corregir
    if (Math.abs(resid) > COMPASS.GATE || eDev > COMPASS.DEV_MAX || speed > COMPASS.SPEED_MAX) return;
    compassLive = true;
    yawBias = wrap(yawBias + clamp(resid * dt / COMPASS.TAU, -COMPASS.MAX_RATE * dt, COMPASS.MAX_RATE * dt));
  }

  // ---------- Recentrar cuando el celular ya está QUIETO y a nivel ----------
  // Calibrar al tocar el botón «Modo Cartón» fijaba el "frente" mientras el
  // celular todavía estaba en tu mano (apuntando al piso o a tu regazo); al
  // ponerlo en las gafas el frente quedaba en otra dirección y parecía una
  // descalibración. Esto espera a que el celular esté casi inmóvil y con el
  // horizonte a la vista (ya puesto en el visor) y recién entonces centra.
  const STILL = { SPEED: 4 * DEG, SECONDS: 1.2, MAX_WAIT: 25, LEVEL_SIN: 0.64 };
  let settle = null;
  function recenterWhenStable(onDone) { settle = { quiet: 0, waited: 0, onDone }; }
  function cancelRecenterWhenStable() { settle = null; }
  function updateSettle(dt, speed) {
    if (!settle) return;
    settle.waited += dt;
    _v.set(0, 0, -1).applyQuaternion(_D);
    if (speed < STILL.SPEED && Math.abs(_v.y) < STILL.LEVEL_SIN) settle.quiet += dt; else settle.quiet = 0;
    if (settle.quiet >= STILL.SECONDS || settle.waited >= STILL.MAX_WAIT) {
      const ok = settle.quiet >= STILL.SECONDS, cb = settle.onDone;
      settle = null;
      recenter();
      if (cb) cb(ok);
    }
  }

  // Suavizado: constante de seguimiento (1/s) entre K_MIN (cabeza casi quieta,
  // filtra ruido) y K_MAX (giro rápido, casi sin retraso).
  const K_MIN = 14, K_MAX = 70;
  const SPEED_LOW = 0.15, SPEED_HIGH = 2.0; // rad/s del objetivo (≈ 9°/s y 115°/s)
  const _prevD = new THREE.Quaternion();
  let hasPrevD = false;

  // Escribe en `out` la orientación de la cámara para un jugador que mira hacia
  // `yaw` (rad, el de las flechas del teclado). Devuelve false si no hay sensor.
  function orientationInto(out, yaw, dt) {
    if (!active()) { hasPrevD = false; return false; }
    dt = Math.max(dt, 1e-3);
    deviceQuaternion(ev, _D);
    const relSpeed = hasPrevD ? _prevD.angleTo(_D) / dt : 0;   // velocidad angular REAL de la cabeza (antes de filtrar)
    _prevD.copy(_D); hasPrevD = true;

    if (headingOffset === null) { headingOffset = headingOf(_D); hasCur = false; resetCompass(); }
    updateCompass(dt, relSpeed);
    updateSettle(dt, relSpeed);

    _yawQ.setFromAxisAngle(AXIS_Y, yaw - headingOffset + yawBias);
    _target.copy(_yawQ).multiply(_D);

    if (!hasCur) {
      _cur.copy(_target); _prevTarget.copy(_target); hasCur = true;
    } else {
      const speed = _prevTarget.angleTo(_target) / dt;
      _prevTarget.copy(_target);
      const k = K_MIN + (K_MAX - K_MIN) * clamp((speed - SPEED_LOW) / (SPEED_HIGH - SPEED_LOW), 0, 1);
      _cur.slerp(_target, 1 - Math.exp(-k * dt));
    }
    out.copy(_cur);
    // Rotación base de la VISTA (sobre el eje de mirada), aplicada DESPUÉS de todo
    // lo anterior: no toca la calibración, el suavizado ni el mapeo del giroscopio.
    if (viewRoll !== 0) out.multiply(_rollQ.setFromAxisAngle(AXIS_Z, viewRoll));
    return true;
  }

  // Gira la imagen `rad` radianes sobre el eje de mirada (π = 180°, "de cabeza").
  // El Modo Cartón la usa porque en horizontal el sensor reporta el celular
  // girado media vuelta respecto a la pantalla en algunos aparatos/navegadores.
  let viewRoll = 0;
  const _rollQ = new THREE.Quaternion();
  function setViewRoll(rad) { viewRoll = rad || 0; }

  // Fija como "frente" la dirección actual (y reinicia la corrección de la brújula).
  function recenter() { headingOffset = null; }

  function setCompass(on) {
    compassEnabled = !!on;
    storageSet('rvr_compass', compassEnabled ? '1' : '0');
    resetCompass();
    return compassEnabled;
  }

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
    recenterWhenStable,
    cancelRecenterWhenStable,
    setCompass,
    setViewRoll,
    toggleOrientSign,
    orientationInto,
    consumeWalk,
    setWalking(on) { walkingEnabled = !!on; if (!on) walkRemaining = 0; },
    get active() { return active(); },
    get supported() { return 'DeviceOrientationEvent' in window; },
    get orientSign() { return orientSign; },
    get viewRoll() { return viewRoll; },
    get compassEnabled() { return compassEnabled; },
    get compassLive() { return compassLive; },                       // ¿la brújula está corrigiendo ahora mismo?
    get hasCompass() { return evAbs !== null && performance.now() - evAbsAt < 3000; },
    get driftCorrectionDeg() { return yawBias / DEG; },              // cuánto se ha corregido el yaw (grados)
    get stepCount() { return stepCount; },
    get walkingEnabled() { return walkingEnabled; }
  };
})();

window.Sensors = Sensors;
