/* ============================================================
   GAME.JS — Restaurante VR: manos, interacción y bucle principal
   ============================================================
   Responsabilidad de este archivo:
     - Convertir cada mano rastreada en dos punteros (pinza y palma) que se
       proyectan como rayos desde la cámara. El dibujo 2D de la mano vive en
       handoverlay.js.
     - Movimiento y mirada del jugador en primera persona: teclado, o los
       sensores del celular (sensors.js: giroscopio + pasos reales). La
       cámara se actualiza ANTES de calcular manos y objetos agarrados, así
       todo usa la misma cámara y las manos siguen a la vista sin retraso.
     - Arranque: permiso de cámara (automático en celular) con mensajes de
       error claros, y entrada al juego con o sin cámara.
     - Mecánicas de interacción: agarrar/soltar con la pinza,
       abrir puertas, picar, remover, cocinar, descartar, servir,
       y el gesto de GIRAR LA MANO para encender/apagar la estufa.
     - El bucle principal, que además llama a `Guide.update` e
       `Items.updateGlows` para que el sistema de guía y los
       resaltados de objetos se actualicen cada cuadro.

   Este archivo consume `World` (escena/zonas), `Items`
   (ingredientes/utensilios/platos/sartenes) y `HandTracking`
   (gestos). Expone `window.Game` para que guide.js pueda leer el
   estado de la estufa y usar el mismo sistema de toasts.
   ============================================================ */

(() => {

const { scene, camera, renderer, ZONE, resolvePlayerXZ,
        COUNTER_TOP_Y, PLAYER_EYE } = World;
const { clamp, lerp } = World.utils;

// Estado de juego compartido con guide.js a través de `window.Game`.
const GameState = { stoveOn: false, activeGrab: { left: null, right: null }, fridgeOpen: false, entranceOpen: false, blenderOn: false, showToast: null };
window.Game = GameState;

// ══════════════════════════════════════════════════════════
// PUNTEROS: cada mano es un puntero 2D sobre la pantalla (ver handoverlay.js)
// ══════════════════════════════════════════════════════════
// Antes cada punto de la mano se colocaba en 3D usando la "profundidad" (z) que
// estima MediaPipe, que es MUY ruidosa: por eso la mano se deformaba con el más
// mínimo movimiento. Ahora la mano se dibuja en 2D y lo que cuenta para jugar es
// un RAYO desde la cámara que atraviesa la pantalla justo por donde está la mano:
//   · rayo de PINZA  (punto entre las yemas del pulgar e índice) → agarrar/soltar.
//   · rayo de PALMA  (centro de la palma)                         → perilla, picar, remover.
// Lo que ves bajo el puntero es lo que agarras, a cualquier distancia, y no hay
// ningún dato de profundidad que pueda "temblar".
function makeRay() { return { o: new THREE.Vector3(), d: new THREE.Vector3(), valid: false }; }
const handRays = { left: { pinch: makeRay(), palm: makeRay() }, right: { pinch: makeRay(), palm: makeRay() } };
const REACH_MIN = 0.15, REACH_MAX = 2.6;   // metros a lo largo del rayo en que se puede agarrar algo

function setRay(r, ndcX, ndcY, aspect) {
  const tanH = Math.tan(THREE.MathUtils.degToRad(camera.fov * 0.5));
  r.o.copy(camera.position);
  r.d.set(ndcX * tanH * aspect, ndcY * tanH, -1).transformDirection(camera.matrixWorld);
  r.valid = true;
}
function updateHandRays() {
  const view = HandOverlay.view;
  for (const handKey of ['left', 'right']) {
    const st = HandOverlay.state[handKey];
    const rays = handRays[handKey];
    if (!st.visible) { rays.pinch.valid = false; rays.palm.valid = false; continue; }
    setRay(rays.pinch, st.pinchNdc.x, st.pinchNdc.y, view.aspect);
    setRay(rays.palm, st.palmNdc.x, st.palmNdc.y, view.aspect);
  }
}

// Distancia a lo largo del rayo hasta `pos` si queda a menos de `radius` del rayo
// (y dentro del alcance); -1 si no. Es el "¿lo estoy tocando?" de todo el juego.
const _rv = new THREE.Vector3(), _wp = new THREE.Vector3();
function rayHit(r, pos, radius) {
  if (!r.valid) return -1;
  _rv.copy(pos).sub(r.o);
  const t = _rv.dot(r.d);
  if (t < REACH_MIN || t > REACH_MAX) return -1;
  return (_rv.lengthSq() - t * t) < radius * radius ? t : -1;
}
function rayPoint(r, t, out) { return out.copy(r.d).multiplyScalar(t).add(r.o); }

// ══════════════════════════════════════════════════════════
// INTERACCIÓN: agarrar, soltar, picar, remover, cocinar, servir
// ══════════════════════════════════════════════════════════
const activeGrab = GameState.activeGrab;

// Un pequeño margen extra al buscar perdona los píxeles que siempre se pierden
// con una cámara y hace más fácil acertar a objetos pequeños.
const GRAB_TOLERANCE = 1.25;
const _tmpPinch = new THREE.Vector3(), _qInv = new THREE.Quaternion();

// El objeto agarrado conserva la distancia (a lo largo del rayo) a la que lo
// tomaste, y su desfase respecto al puntero se guarda en coordenadas de CÁMARA:
// así sigue exactamente el giro de tu cabeza y el avance al caminar.
const heldDepth = { left: 2, right: 2 };
const heldOffsetLocal = { left: new THREE.Vector3(), right: new THREE.Vector3() };
// Cada pinza/suelta se atiende UNA sola vez (la bandera `pinchStarted` de la IA
// puede verse en varios cuadros de dibujo seguidos).
const seenStart = { left: 0, right: 0 }, seenEnd = { left: 0, right: 0 };

function allGrabbables() { return [...Items.ingredients, ...Items.vessels, ...Items.plates, ...Items.utensils]; }

function isGrabbable(obj) {
  if (obj.heldBy) return false;
  if (obj.onBoard) {
    const def = obj.ingredientType && Items.INGREDIENT_DEF[obj.ingredientType];
    if (def && def.needsChop && obj.state === 'raw') return false;
  }
  return true;
}

function detachFromVessel(obj) {
  for (const p of Items.vessels) {
    if (obj.mesh.parent === p.mesh) {
      const worldPos = new THREE.Vector3();
      obj.mesh.getWorldPosition(worldPos);
      p.mesh.remove(obj.mesh);
      scene.add(obj.mesh);
      obj.mesh.position.copy(worldPos);
      obj.mesh.rotation.set(0, 0, 0);
      const i = p.contents.indexOf(obj);
      if (i !== -1) p.contents.splice(i, 1);
      break;
    }
  }
  obj.inPan = false;
}

// `t`: distancia a lo largo del rayo de pinza a la que está el objeto.
function grabObject(handKey, obj, t) {
  detachFromVessel(obj);
  obj.heldBy = handKey;
  obj.onBoard = false;
  if (obj.onStove !== undefined) obj.onStove = false;
  rayPoint(handRays[handKey].pinch, t, _tmpPinch);
  obj.grabOffset.copy(obj.mesh.position).sub(_tmpPinch);
  heldOffsetLocal[handKey].copy(obj.grabOffset).applyQuaternion(_qInv.copy(camera.quaternion).invert());
  heldDepth[handKey] = t;
  activeGrab[handKey] = obj;
}

// ---------- Estufa: gesto de GIRAR la mano sobre la perilla ----------
// A propósito NO se enciende con solo tocar/pellizcar la perilla (eso
// causaba activaciones accidentales). Hay que MANTENER la mano sobre
// la perilla y girarla como una perilla real: a la derecha enciende,
// a la izquierda apaga. Se exige un giro acumulado mínimo (con
// decaimiento si la mano tiembla en vez de girar) más un cooldown
// entre cambios, así que un roce accidental no dispara nada.
const STOVE_TURN_THRESHOLD = 0.68; // rad ≈ 39° de giro intencional
const STOVE_TOGGLE_COOLDOWN = 700; // ms
// Con la cámara TRASERA (imagen sin espejo, ver tracking.js) el sentido
// del giro medido en el plano de la imagen queda invertido respecto a
// como estaba calibrado para una cámara frontal; -1 lo corrige para que
// "girar a la derecha" siga encendiendo la estufa.
const STOVE_TURN_SIGN = -1;
const knobEngage = { left: { active: false, accum: 0, lastAngle: 0 }, right: { active: false, accum: 0, lastAngle: 0 } };
let lastStoveToggleAt = 0;

function setStove(on) {
  if (GameState.stoveOn === on) return;
  GameState.stoveOn = on;
  World.stoveButtonMat.color.set(on ? 0x2ecc71 : 0xcc2222);
  World.stoveButtonMat.emissive.set(on ? 0x2ecc71 : 0x000000);
  World.stoveButtonMat.emissiveIntensity = on ? 0.8 : 0;
  const el = document.getElementById('stove-state');
  el.textContent = on ? 'Encendida' : 'Apagada';
  el.classList.toggle('on', on);
  showToast(on ? '🔥 Estufa encendida (4 fogones)' : '🔥 Estufa apagada');
}

function updateStoveKnob(dt) {
  for (const handKey of ['left', 'right']) {
    const h = HandTracking.hands[handKey];
    const eng = knobEngage[handKey];
    if (!h.detected || !h.rollValid) { eng.active = false; eng.accum = 0; continue; }

    const inZone = rayHit(handRays[handKey].palm, ZONE.stoveButton.pos, ZONE.stoveButton.r * GRAB_TOLERANCE) > 0;
    if (!inZone) { eng.active = false; eng.accum = 0; continue; }

    if (!eng.active) {
      eng.active = true;
      eng.accum = 0;
      eng.lastAngle = h.rollAngle;
      continue;
    }

    const delta = HandTracking.angleDiff(h.rollAngle, eng.lastAngle);
    eng.lastAngle = h.rollAngle;
    eng.accum = lerp(eng.accum, 0, dt * 0.5); // decaimiento suave anti-temblor
    eng.accum += delta * STOVE_TURN_SIGN;
    eng.accum = clamp(eng.accum, -STOVE_TURN_THRESHOLD, STOVE_TURN_THRESHOLD);

    const now = performance.now();
    if (now - lastStoveToggleAt < STOVE_TOGGLE_COOLDOWN) continue;

    if (eng.accum >= STOVE_TURN_THRESHOLD && !GameState.stoveOn) {
      setStove(true); eng.accum = 0; lastStoveToggleAt = now;
    } else if (eng.accum <= -STOVE_TURN_THRESHOLD && GameState.stoveOn) {
      setStove(false); eng.accum = 0; lastStoveToggleAt = now;
    }
  }
}

function toggleFridge() {
  GameState.fridgeOpen = !GameState.fridgeOpen;
  showToast(GameState.fridgeOpen ? '🚪 Nevera abierta' : '🚪 Nevera cerrada');
}
function toggleEntranceDoor() {
  GameState.entranceOpen = !GameState.entranceOpen;
  showToast(GameState.entranceOpen ? '🚪 Puerta abierta' : '🚪 Puerta cerrada');
}
function toggleBlender() {
  GameState.blenderOn = !GameState.blenderOn;
  showToast(GameState.blenderOn ? '🥤 Licuadora encendida' : '🥤 Licuadora apagada');
}

function handleGrabStart(handKey) {
  // La perilla de la estufa YA NO se activa por pinza: se gira (ver updateStoveKnob).
  const r = handRays[handKey].pinch;
  let best = null;   // lo más cercano a la cámara que el puntero toca (como un objeto que tapa a otro)
  const consider = (t, act) => { if (t > 0 && (!best || t < best.t)) best = { t, act }; };

  consider(rayHit(r, ZONE.fridgeHandle.pos, ZONE.fridgeHandle.r * GRAB_TOLERANCE), () => toggleFridge());
  consider(rayHit(r, ZONE.entranceHandle.pos, ZONE.entranceHandle.r * GRAB_TOLERANCE), () => toggleEntranceDoor());
  consider(rayHit(r, ZONE.blender.pos, ZONE.blender.r * GRAB_TOLERANCE), () => toggleBlender());

  for (const slot of ZONE.pantrySlots) {
    const t = rayHit(r, slot.pos, 0.24 * GRAB_TOLERANCE);
    consider(t, () => grabObject(handKey, Items.spawnIngredient(slot.kind, slot.pos.clone()), t));
  }
  const tp = rayHit(r, ZONE.plateStack.pos, ZONE.plateStack.r * GRAB_TOLERANCE);
  consider(tp, () => grabObject(handKey, Items.spawnPlate(ZONE.plateStack.pos.clone()), tp));

  for (const obj of allGrabbables()) {
    if (!isGrabbable(obj)) continue;
    obj.mesh.getWorldPosition(_wp);
    const t = rayHit(r, _wp, obj.radius * GRAB_TOLERANCE);
    consider(t, () => grabObject(handKey, obj, t));
  }
  if (best) best.act();
}

function surfaceYAt(x, z) {
  if (z < ZONE.board.pos.z + 0.35 && x > -World.ROOM_HALF + 0.6 && x < World.ROOM_HALF - 0.6) return COUNTER_TOP_Y;
  if (x > World.ZONE.pass.pos.x - 0.4 && z > -0.85 && z < 0.85) return 0.9;
  return 0;
}
function settleOnSurface(obj) {
  obj.mesh.position.y = surfaceYAt(obj.mesh.position.x, obj.mesh.position.z) + 0.05;
}

function nearestPlateWithin(worldPos, maxDist) {
  let best = null, bestD = Infinity;
  for (const p of Items.plates) {
    const d = p.mesh.position.distanceTo(worldPos);
    if (d < maxDist && d < bestD) { bestD = d; best = p; }
  }
  return best;
}
function findVesselOnRay(r, radius) {
  let best = null, bestT = Infinity;
  for (const p of Items.vessels) {
    if (!p.onStove) continue;
    const t = rayHit(r, p.mesh.position, radius);
    if (t > 0 && t < bestT) { bestT = t; best = p; }
  }
  return best;
}
function findNearbyVessel(worldPos, maxDist) {
  let best = null, bestD = Infinity;
  for (const p of Items.vessels) {
    if (!p.onStove) continue;
    const d = p.mesh.position.distanceTo(worldPos);
    if (d < maxDist && d < bestD) { bestD = d; best = p; }
  }
  return best;
}

function addIngredientToPlate(plate, obj) {
  detachFromVessel(obj);
  Items.removeGlow(obj);
  plate.contents.push({ kind: obj.ingredientType, state: obj.state });
  scene.remove(obj.mesh);
  const i = Items.ingredients.indexOf(obj);
  if (i !== -1) Items.ingredients.splice(i, 1);

  const topping = Items.buildIngredientMesh(obj.ingredientType, obj.state);
  topping.scale.setScalar(0.85);
  topping.position.set(Math.random() * 0.1 - 0.05, 0.015 + plate.contents.length * 0.02, Math.random() * 0.1 - 0.05);
  plate.mesh.add(topping);
  showToast(`✅ ${Items.INGREDIENT_DEF[obj.ingredientType].label} agregado al plato`);
}

function releaseIngredient(obj, worldPos) {
  if (worldPos.distanceTo(ZONE.trash.pos) < ZONE.trash.r) {
    Items.removeGlow(obj);
    scene.remove(obj.mesh);
    const i = Items.ingredients.indexOf(obj);
    if (i !== -1) Items.ingredients.splice(i, 1);
    showToast('🗑 Ingrediente descartado');
    return;
  }
  const plate = nearestPlateWithin(worldPos, 0.32);
  if (plate) {
    if (Items.isIngredientReady(obj)) { addIngredientToPlate(plate, obj); return; }
    showToast(`⚠ Prepara primero el ${Items.INGREDIENT_DEF[obj.ingredientType].label.toLowerCase()}`);
  }
  if (worldPos.distanceTo(ZONE.board.pos) < ZONE.board.r) {
    obj.mesh.position.set(worldPos.x, COUNTER_TOP_Y + 0.05, worldPos.z);
    obj.onBoard = true;
    return;
  }
  const targetVessel = findNearbyVessel(worldPos, 0.26);
  if (targetVessel && obj.ingredientType === 'meat') {
    obj.inPan = true;
    targetVessel.mesh.add(obj.mesh);
    obj.mesh.position.set(0, 0.05, 0);
    obj.mesh.rotation.set(0, 0, 0);
    if (!targetVessel.contents.includes(obj)) targetVessel.contents.push(obj);
    return;
  }
  settleOnSurface(obj);
}

function releaseVessel(obj, worldPos) {
  for (const b of ZONE.burners) {
    if (worldPos.distanceTo(b.pos) < b.r) {
      obj.mesh.position.set(b.pos.x, b.pos.y + (obj.kind === 'pot' ? 0.058 : 0.03), b.pos.z);
      obj.onStove = true;
      return;
    }
  }
  obj.onStove = false;
  settleOnSurface(obj);
}

function releaseUtensil(obj, worldPos) {
  settleOnSurface(obj);
}

function releasePlate(obj, worldPos) {
  if (worldPos.distanceTo(ZONE.trash.pos) < ZONE.trash.r) {
    Items.despawnPlate(obj);
    showToast('🗑 Plato descartado');
    return;
  }
  if (worldPos.distanceTo(ZONE.pass.pos) < ZONE.pass.r) { Guide.tryServe(obj); return; }
  if (worldPos.distanceTo(ZONE.assembly.pos) < ZONE.assembly.r) {
    obj.mesh.position.set(worldPos.x, COUNTER_TOP_Y + 0.02, worldPos.z);
    return;
  }
  settleOnSurface(obj);
}

function handleGrabEnd(handKey, worldPos) {
  const obj = activeGrab[handKey];
  activeGrab[handKey] = null;
  if (!obj) return;
  obj.heldBy = null;
  if (obj.kind === 'plate') releasePlate(obj, worldPos);
  else if (obj.kind === 'pan' || obj.kind === 'pot') releaseVessel(obj, worldPos);
  else if (obj.kind === 'utensil') releaseUtensil(obj, worldPos);
  else releaseIngredient(obj, worldPos);
}

function updateHeldObjects() {
  for (const handKey of ['left', 'right']) {
    const obj = activeGrab[handKey];
    if (!obj) continue;
    const rays = handRays[handKey];
    if (!rays.pinch.valid) continue;                      // mano perdida un instante: el objeto se queda donde estaba
    rayPoint(rays.pinch, heldDepth[handKey], _tmpPinch);
    obj.grabOffset.copy(heldOffsetLocal[handKey]).applyQuaternion(camera.quaternion);
    obj.mesh.position.copy(_tmpPinch).add(obj.grabOffset);
  }
}

function updateHandGesturesAndInteractions() {
  for (const handKey of ['left', 'right']) {
    const h = HandTracking.hands[handKey];
    if (h.startCount !== seenStart[handKey]) {
      seenStart[handKey] = h.startCount;
      if (!activeGrab[handKey]) handleGrabStart(handKey);
    }
    if (h.endCount !== seenEnd[handKey]) {
      seenEnd[handKey] = h.endCount;
      const obj = activeGrab[handKey];
      if (obj) {
        const rays = handRays[handKey];
        const dropAt = rays.pinch.valid ? rayPoint(rays.pinch, heldDepth[handKey], _tmpPinch).clone() : obj.mesh.position.clone();
        handleGrabEnd(handKey, dropAt);
      }
    }
  }
  updateHeldObjects();
}

// ---------- Picar ingredientes: requiere sostener el cuchillo ----------
const CHOP_HITS_REQUIRED = 4;
const _chopSpikeLatch = { left: false, right: false };
let lastNoKnifeHint = 0;

function spawnChopFX(pos) {
  const mat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9 });
  const spark = new THREE.Mesh(new THREE.SphereGeometry(0.02, 6, 6), mat);
  spark.position.copy(pos).add(new THREE.Vector3(0, 0.05, 0));
  scene.add(spark);
  const start = performance.now();
  (function fade() {
    const t = (performance.now() - start) / 250;
    if (t >= 1) { scene.remove(spark); return; }
    spark.scale.setScalar(1 + t * 3);
    mat.opacity = 0.9 * (1 - t);
    requestAnimationFrame(fade);
  })();
}

function updateChopping() {
  for (const obj of Items.ingredients) {
    if (!obj.onBoard) continue;
    const def = Items.INGREDIENT_DEF[obj.ingredientType];
    if (!def.needsChop || obj.state !== 'raw') continue;

    for (const handKey of ['left', 'right']) {
      const h = HandTracking.hands[handKey];
      if (rayHit(handRays[handKey].palm, obj.mesh.position, 0.26 * GRAB_TOLERANCE) < 0) continue;

      const spikeEdge = h.chopSpike && !_chopSpikeLatch[handKey];
      _chopSpikeLatch[handKey] = h.chopSpike;
      if (!spikeEdge) continue;

      if (activeGrab[handKey] !== Items.knife) {
        const now = performance.now();
        if (now - lastNoKnifeHint > 4000) {
          showToast('🔪 Necesitas sostener el cuchillo para picar');
          lastNoKnifeHint = now;
        }
        continue;
      }

      obj.choppedHits++;
      spawnChopFX(obj.mesh.position);
      if (obj.choppedHits >= CHOP_HITS_REQUIRED) {
        Items.setIngredientState(obj, 'chopped');
        showToast(`🔪 ${def.label} picado`);
      }
    }
  }
}

// ---------- Remover con la espátula/cucharón: acelera la cocción ----------
const _stirLatch = { left: false, right: false };
function updateStirring() {
  for (const handKey of ['left', 'right']) {
    const held = activeGrab[handKey];
    if (held !== Items.spatula && held !== Items.ladle) { _stirLatch[handKey] = false; continue; }
    const h = HandTracking.hands[handKey];
    const nearVessel = findVesselOnRay(handRays[handKey].palm, 0.28 * GRAB_TOLERANCE);

    const spikeEdge = h.chopSpike && !_stirLatch[handKey];
    _stirLatch[handKey] = h.chopSpike;
    if (!spikeEdge || !nearVessel || !GameState.stoveOn) continue;

    for (const obj of nearVessel.contents) {
      if (obj.state !== 'cooked') obj.cookProgress += 0.6;
    }
  }
}

// ---------- Cocinar en la estufa ----------
const COOK_TIME = 3.5;
function updateCooking(dt) {
  if (!GameState.stoveOn) return;
  for (const p of Items.vessels) {
    if (!p.onStove) continue;
    for (const obj of p.contents) {
      if (obj.state === 'cooked') continue;
      obj.cookProgress += dt;
      if (obj.cookProgress >= COOK_TIME) {
        Items.setIngredientState(obj, 'cooked');
        showToast(`🍳 ${Items.INGREDIENT_DEF[obj.ingredientType].label} lista`);
      }
    }
  }
}

// ---------- Animación de puertas, llamas y licuadora ----------
let fridgeDoorAngle = 0, entranceAngle = 0, clockT = 0;
function updateFridgeDoorAnim(dt) {
  fridgeDoorAngle = lerp(fridgeDoorAngle, GameState.fridgeOpen ? 1.3 : 0, Math.min(1, dt * 4));
  World.fridgeDoorMesh.rotation.y = fridgeDoorAngle;
  World.fridgeBottles.forEach(b => b.visible = GameState.fridgeOpen);
}
function updateEntranceDoorAnim(dt) {
  entranceAngle = lerp(entranceAngle, GameState.entranceOpen ? 1.1 : 0, Math.min(1, dt * 4));
  World.entranceDoorL.rotation.y = -entranceAngle;
  World.entranceDoorR.rotation.y = entranceAngle;
}
function updateFlameVisual() {
  World.flames.forEach(f => {
    f.visible = GameState.stoveOn;
    if (GameState.stoveOn) {
      const s = 1 + Math.sin(clockT * 14) * 0.12;
      f.scale.set(s, 1 + Math.sin(clockT * 11) * 0.15, s);
    }
  });
}
function updateBlenderVisual(dt) {
  if (GameState.blenderOn) World.blenderBladeGroup.rotation.y += dt * 28;
}

// ---------- Toasts ----------
function showToast(text) {
  const wrap = document.getElementById('toast-wrap');
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = text;
  wrap.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => { el.classList.remove('show'); setTimeout(() => el.remove(), 300); }, 2200);
}
GameState.showToast = showToast;

// ---------- HUD de manos ----------
// Solo se escribe en el DOM cuando el valor CAMBIA: escribir cada cuadro (aunque
// sea el mismo texto) obliga al navegador a recalcular estilos y, en Modo
// Cartón, además dispara la copia del HUD a los dos ojos.
const UTENSIL_LABEL = { knife: 'Cuchillo', spatula: 'Espátula', ladle: 'Cucharón' };
const hudEls = {
  pl: document.getElementById('pinch-l'), pr: document.getElementById('pinch-r'),
  status: document.getElementById('status-text'), held: document.getElementById('held-info')
};
const hudLast = { pl: -1, pr: -1, gl: null, gr: null, status: '', held: '' };
function updateHudHands() {
  const l = HandTracking.hands.left, r = HandTracking.hands.right;
  const pl = Math.round(l.pinch * 20) * 5, pr = Math.round(r.pinch * 20) * 5; // pasos de 5 %
  if (pl !== hudLast.pl) { hudEls.pl.style.width = pl + '%'; hudLast.pl = pl; }
  if (pr !== hudLast.pr) { hudEls.pr.style.width = pr + '%'; hudLast.pr = pr; }
  if (l.isPinching !== hudLast.gl) { hudEls.pl.classList.toggle('grabbing', l.isPinching); hudLast.gl = l.isPinching; }
  if (r.isPinching !== hudLast.gr) { hudEls.pr.classList.toggle('grabbing', r.isPinching); hudLast.gr = r.isPinching; }

  let status;
  if (!HandTracking.hasCamera) status = 'Sin cámara';
  else if (!l.detected && !r.detected) status = 'Buscando manos…';
  else if (l.detected && r.detected) status = 'Ambas manos';
  else status = l.detected ? 'Mano izquierda' : 'Mano derecha';
  if (status !== hudLast.status) { hudEls.status.textContent = status; hudLast.status = status; }

  const nameOf = (o) => {
    if (!o) return null;
    if (o.kind === 'plate') return `Plato (${o.contents.length} ing.)`;
    if (o.kind === 'pan') return 'Sartén';
    if (o.kind === 'pot') return 'Olla';
    if (o.kind === 'utensil') return UTENSIL_LABEL[o.toolType];
    const extra = o.state !== 'raw' ? ` (${o.state === 'chopped' ? 'picado' : 'cocido'})` : '';
    return Items.INGREDIENT_DEF[o.ingredientType].label + extra;
  };
  const l2 = nameOf(activeGrab.left), r2 = nameOf(activeGrab.right);
  const held = (!l2 && !r2) ? 'Manos vacías' :
    [l2 ? `Izq: <b>${l2}</b>` : '', r2 ? `Der: <b>${r2}</b>` : ''].filter(Boolean).join(' · ');
  if (held !== hudLast.held) { hudEls.held.innerHTML = held; hudLast.held = held; }
}

// ══════════════════════════════════════════════════════════
// JUGADOR: movimiento en primera persona (teclado + sensores del celular)
// ══════════════════════════════════════════════════════════
const K = {};
window.addEventListener('keydown', e => {
  K[e.code] = true;
  if (e.code === 'KeyR') Sensors.recenter();
});
window.addEventListener('keyup', e => { K[e.code] = false; });

const player = { pos: new THREE.Vector3(0, PLAYER_EYE, 3.5), yaw: 0, pitch: 0 };
const MOVE_SPEED = 2.2, TURN_SPEED = 1.6, LOOK_SPEED = 1.2;
// Agacharse: mantén C para bajar la cámara y poder alcanzar objetos que
// se cayeron al piso (el alcance de las manos es relativo a la cámara,
// así que al bajarla también baja toda la zona donde se puede agarrar).
const CROUCH_EYE = PLAYER_EYE - 0.62;
const CROUCH_SPEED_MULT = 0.55;
let eyeHeight = PLAYER_EYE;
const _camQ = new THREE.Quaternion(), _lookV = new THREE.Vector3();

// Orden dentro del cuadro (importa): 1) orientación (giroscopio o teclado),
// 2) avance (teclado o pasos reales), 3) matriz de la cámara. Recién después
// se calculan manos, objetos agarrados y se dibuja — todos con LA MISMA cámara.
function updatePlayerMovement(dt) {
  if (K['ArrowLeft']) player.yaw += TURN_SPEED * dt;
  if (K['ArrowRight']) player.yaw -= TURN_SPEED * dt;
  if (K['ArrowUp']) player.pitch = clamp(player.pitch + LOOK_SPEED * dt, -1.2, 1.2);
  if (K['ArrowDown']) player.pitch = clamp(player.pitch - LOOK_SPEED * dt, -1.2, 1.2);

  const crouching = !!K['KeyC'];
  eyeHeight = lerp(eyeHeight, crouching ? CROUCH_EYE : PLAYER_EYE, Math.min(1, dt * 6));
  const moveSpeed = MOVE_SPEED * (crouching ? CROUCH_SPEED_MULT : 1);

  // Con sensores, la cámara mira donde miras en la vida real y "adelante"
  // (WASD y pasos) es hacia donde apunta la vista, no el yaw del teclado.
  const gyro = Sensors.orientationInto(_camQ, player.yaw, dt);
  let heading = player.yaw;
  if (gyro) {
    _lookV.set(0, 0, -1).applyQuaternion(_camQ);
    if (Math.hypot(_lookV.x, _lookV.z) > 0.25) heading = Math.atan2(-_lookV.x, -_lookV.z);
  }
  const sinY = Math.sin(heading), cosY = Math.cos(heading);
  const fwd = { x: -sinY, z: -cosY };
  const right = { x: cosY, z: -sinY };

  let mx = 0, mz = 0;
  if (K['KeyW']) { mx += fwd.x; mz += fwd.z; }
  if (K['KeyS']) { mx -= fwd.x; mz -= fwd.z; }
  if (K['KeyD']) { mx += right.x; mz += right.z; }
  if (K['KeyA']) { mx -= right.x; mz -= right.z; }

  let dx = 0, dz = 0;
  const len = Math.hypot(mx, mz);
  if (len > 0.0001) { dx = (mx / len) * moveSpeed * dt; dz = (mz / len) * moveSpeed * dt; }
  const walk = Sensors.consumeWalk(dt) * (crouching ? CROUCH_SPEED_MULT : 1); // pasos reales, repartidos en el tiempo
  if (walk > 0) { dx += fwd.x * walk; dz += fwd.z * walk; }
  if (dx !== 0 || dz !== 0) {
    const resolved = resolvePlayerXZ(player.pos.x + dx, player.pos.z + dz);
    player.pos.x = resolved.x;
    player.pos.z = resolved.z;
  }

  player.pos.y = eyeHeight;
  camera.position.copy(player.pos);
  if (gyro) camera.quaternion.copy(_camQ);
  else camera.rotation.set(player.pitch, player.yaw, 0, 'YXZ');
  camera.updateMatrixWorld(true);
}

// ══════════════════════════════════════════════════════════
// BUCLE PRINCIPAL
// ══════════════════════════════════════════════════════════
let lastT = performance.now();
function loop() {
  requestAnimationFrame(loop);
  const now = performance.now();
  const rawDt = (now - lastT) / 1000;
  const dt = Math.min(rawDt, 0.05);
  lastT = now;
  clockT += dt;

  Perf.update(rawDt);
  HandTracking.tick(dt);
  updatePlayerMovement(dt);
  HandOverlay.update(HandTracking.hands, HandTracking.aspect, !!(window.Cardboard && Cardboard.active));
  updateHandRays();
  updateHandGesturesAndInteractions();
  updateStoveKnob(dt);
  updateChopping();
  updateStirring();
  updateCooking(dt);
  updateFridgeDoorAnim(dt);
  updateEntranceDoorAnim(dt);
  updateFlameVisual();
  updateBlenderVisual(dt);
  updateHudHands();
  Items.updateGlows(clockT);
  Guide.update(dt, clockT);

  renderer.render(scene, camera);
  HandOverlay.draw();
}

// Fusiona la geometría estática (menos llamadas de dibujo por cuadro). Se hace
// UNA vez, ya con items.js cargado: lo que ese módulo mueve o ilumina queda fuera.
(function batchStaticWorld() {
  const dyn = [];
  for (const list of [Items.ingredients, Items.plates, Items.pans, Items.pots, Items.utensils]) {
    for (const o of list) if (o && o.mesh) dyn.push(o.mesh);
  }
  const markers = Object.values(Items.pantryMarkers).filter(o => o && o.mesh).map(o => o.mesh);
  World.batchStatic(dyn.concat(markers), markers);
})();

// ══════════════════════════════════════════════════════════
// ARRANQUE: permiso de cámara (automático en celular) -> juego
// ══════════════════════════════════════════════════════════
const startBtn = document.getElementById('start-btn');
const startStatus = document.getElementById('start-status');
const camStatus = document.getElementById('camera-status');
const retryBtn = document.getElementById('retry-camera-btn');
const noCamBtn = document.getElementById('nocam-btn');
let gameStarted = false;

function setCamStatus(kind, text) {
  camStatus.className = kind;       // info | ok | error
  camStatus.textContent = text;
}

// Refleja en la pantalla de inicio cada etapa del acceso a la cámara. Si algo
// falla, el mensaje dice POR QUÉ y se ofrece reintentar o entrar sin cámara.
HandTracking.onState((state, err) => {
  const failed = state === 'error';
  retryBtn.classList.toggle('hidden', !failed);
  noCamBtn.classList.toggle('hidden', !failed);
  switch (state) {
    case 'requesting':   setCamStatus('info', '📷 Solicitando permiso de la cámara trasera… acéptalo en el aviso del navegador.'); break;
    case 'loading':      setCamStatus('info', '🧠 Cámara lista. Cargando el reconocimiento de manos…'); break;
    case 'camera-ready': setCamStatus('ok', '✅ Cámara trasera lista.'); break;
    case 'running':      setCamStatus('ok', '✅ Cámara y reconocimiento de manos activos.'); break;
    case 'error':        setCamStatus('error', '⚠ ' + (err && err.userMessage ? err.userMessage : 'No se pudo usar la cámara.')); break;
  }
});

function enterGame() {
  if (gameStarted) return;
  gameStarted = true;
  document.getElementById('start-screen').classList.add('hidden');
  document.getElementById('hud').classList.remove('hidden');
  Guide.startFirstOrder();
  lastT = performance.now();
  requestAnimationFrame(loop);
  if (!HandTracking.hasCamera) {
    showToast('📷 Sin cámara: puedes recorrer la cocina, pero las manos no estarán activas.');
  }
  // En celular, si a los pocos segundos no llegó ningún dato de movimiento, avisar por qué.
  if (World.IS_MOBILE) {
    setTimeout(() => {
      if (!Sensors.active) showToast('🧭 Sin sensores de movimiento: abre la página por https:// y permite «Movimiento y orientación».');
    }, 2500);
  }
}

async function startWithHands() {
  // iOS exige pedir el permiso de movimiento DENTRO del toque del usuario, así
  // que se lanza aquí, antes de cualquier `await`. En Android no hace nada.
  const motionAsk = Sensors.enable();
  startBtn.disabled = true;
  startStatus.textContent = '';
  try {
    await HandTracking.start();
    enterGame();
  } catch (_) {
    startBtn.disabled = false;   // el motivo ya se muestra en #camera-status
  }
  motionAsk.then(ok => { if (!ok && gameStarted) showToast('🧭 Permiso de movimiento denegado: el giro de cabeza y caminar no funcionarán.'); });
}

startBtn.addEventListener('click', startWithHands);
retryBtn.addEventListener('click', startWithHands);
noCamBtn.addEventListener('click', () => { Sensors.enable(); enterGame(); });

// En celular el permiso se pide solo al abrir la página (sin esperar el botón),
// y el modelo de manos se va cargando mientras se lee la pantalla de inicio.
if (World.IS_MOBILE) HandTracking.prepare().catch(() => { /* el estado de error ya se muestra */ });

document.getElementById('restart-btn').addEventListener('click', () => location.reload());
document.getElementById('recenter-btn').addEventListener('click', () => { Sensors.recenter(); showToast('🧭 Vista recentrada.'); });

})();
