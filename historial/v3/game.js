/* ============================================================
   GAME.JS — Restaurante VR: manos, interacción y bucle principal
   ============================================================
   Responsabilidad de este archivo:
     - Avatar 3D de las manos rastreadas.
     - Movimiento del jugador en primera persona (teclado).
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
// MANOS 3D (avatar de las manos rastreadas)
// ══════════════════════════════════════════════════════════
const FINGER_SEGMENTS = [
  [1, 2], [2, 3], [3, 4],
  [5, 6], [6, 7], [7, 8],
  [9, 10], [10, 11], [11, 12],
  [13, 14], [14, 15], [15, 16],
  [17, 18], [18, 19], [19, 20]
];
const FINGER_NAMES = ['thumb', 'index', 'middle', 'ring', 'pinky'];
const FINGER_RADII = {
  thumb: [0.021, 0.018, 0.015, 0.012],
  index: [0.018, 0.016, 0.013, 0.010],
  middle: [0.019, 0.017, 0.014, 0.011],
  ring: [0.017, 0.015, 0.012, 0.010],
  pinky: [0.015, 0.013, 0.011, 0.009]
};
const HAND_ACCENT = { left: 0x4fc3f7, right: 0xffb74d };
const SKIN_COLOR = 0xe3a97a;
const _UP = new THREE.Vector3(0, 1, 0);

function buildHandVisual(handKey) {
  const root = new THREE.Group();
  const skinMat = new THREE.MeshStandardMaterial({ color: SKIN_COLOR, roughness: 0.55, emissive: 0x552200, emissiveIntensity: 0 });

  const palm = new THREE.Mesh(new THREE.SphereGeometry(1, 18, 14), skinMat);
  root.add(palm);

  const wrist = new THREE.Mesh(new THREE.TorusGeometry(0.035, 0.01, 8, 16),
    new THREE.MeshStandardMaterial({ color: HAND_ACCENT[handKey], roughness: 0.4, metalness: 0.3 }));
  root.add(wrist);

  const segs = FINGER_SEGMENTS.map(([a, b], i) => {
    const finger = FINGER_NAMES[Math.floor(i / 3)];
    const k = i % 3;
    const radii = FINGER_RADII[finger];
    const geo = new THREE.CylinderGeometry(radii[k + 1], radii[k], 1, 8);
    const mesh = new THREE.Mesh(geo, skinMat);
    root.add(mesh);
    return { mesh, a, b };
  });

  const tips = FINGER_NAMES.map(finger => {
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(FINGER_RADII[finger][3], 8, 8), skinMat);
    root.add(mesh);
    return mesh;
  });

  root.visible = false;
  scene.add(root);
  return { root, palm, wrist, skinMat, segs, tips };
}
const handVisuals = { left: buildHandVisual('left'), right: buildHandVisual('right') };

// ---------- Mapeo de coordenadas de la mano (0..1 MediaPipe) a espacio 3D ----------
const HAND_SPACE = { width: 1.7, height: 1.3, vOffset: -0.12, depthBase: 0.55, depthScale: 1.6 };
const _localOffset = new THREE.Vector3();
function handWorldPosition(nx, ny, nz, out) {
  const depth = clamp(HAND_SPACE.depthBase - nz * HAND_SPACE.depthScale, 0.28, 1.7);
  _localOffset.set(
    (nx - 0.5) * HAND_SPACE.width,
    (0.5 - ny) * HAND_SPACE.height + HAND_SPACE.vOffset,
    -depth
  );
  out.copy(_localOffset).applyMatrix4(camera.matrixWorld);
  return out;
}

const _tmpA = new THREE.Vector3(), _tmpB = new THREE.Vector3();
const _pR = new THREE.Vector3(), _pF = new THREE.Vector3(), _pU = new THREE.Vector3();
const _wristW = new THREE.Vector3(), _idxBaseW = new THREE.Vector3(), _pinkyBaseW = new THREE.Vector3(), _midBaseW = new THREE.Vector3();
const _basisMat = new THREE.Matrix4();

function updateHandVisuals() {
  for (const handKey of ['left', 'right']) {
    const h = HandTracking.hands[handKey];
    const vis = handVisuals[handKey];
    vis.root.visible = h.detected;
    if (!h.detected || !h.landmarks) continue;

    vis.skinMat.emissiveIntensity = h.isPinching ? 0.8 : 0;

    const lm = h.landmarks;
    handWorldPosition(lm[0].x, lm[0].y, lm[0].z, _wristW);
    handWorldPosition(lm[5].x, lm[5].y, lm[5].z, _idxBaseW);
    handWorldPosition(lm[17].x, lm[17].y, lm[17].z, _pinkyBaseW);
    handWorldPosition(lm[9].x, lm[9].y, lm[9].z, _midBaseW);

    _pR.copy(_idxBaseW).sub(_pinkyBaseW).normalize();
    _pF.copy(_midBaseW).sub(_wristW).normalize();
    _pU.crossVectors(_pR, _pF).normalize();
    _pF.crossVectors(_pU, _pR).normalize();
    _basisMat.makeBasis(_pR, _pU, _pF);
    vis.palm.quaternion.setFromRotationMatrix(_basisMat);
    vis.wrist.quaternion.copy(vis.palm.quaternion);

    handWorldPosition(h.palm.x, h.palm.y, h.palm.z, vis.palm.position);
    const width = _idxBaseW.distanceTo(_pinkyBaseW) * 1.2 + 0.01;
    const length = _wristW.distanceTo(_midBaseW) * 1.05 + 0.01;
    vis.palm.scale.set(width * 0.5, width * 0.28, length * 0.55);
    vis.wrist.position.copy(_wristW);

    for (const seg of vis.segs) {
      const a = lm[seg.a], b = lm[seg.b];
      const pa = handWorldPosition(a.x, a.y, a.z, _tmpA).clone();
      const pb = handWorldPosition(b.x, b.y, b.z, _tmpB).clone();
      const mid = pa.clone().add(pb).multiplyScalar(0.5);
      const dir = pb.clone().sub(pa);
      const len = dir.length() || 0.001;
      dir.normalize();
      seg.mesh.position.copy(mid);
      seg.mesh.scale.set(1, len, 1);
      seg.mesh.quaternion.setFromUnitVectors(_UP, dir);
    }

    for (let f = 0; f < 5; f++) {
      const tipIdx = FINGER_SEGMENTS[f * 3 + 2][1];
      const p = lm[tipIdx];
      handWorldPosition(p.x, p.y, p.z, vis.tips[f].position);
    }
  }
}

// ══════════════════════════════════════════════════════════
// INTERACCIÓN: agarrar, soltar, picar, remover, cocinar, servir
// ══════════════════════════════════════════════════════════
const activeGrab = GameState.activeGrab;

function allGrabbables() { return [...Items.ingredients, ...Items.vessels, ...Items.plates, ...Items.utensils]; }

function nearestGrabbable(worldPos) {
  let best = null, bestD = Infinity;
  for (const obj of allGrabbables()) {
    if (obj.heldBy) continue;
    if (obj.onBoard) {
      const def = obj.ingredientType && Items.INGREDIENT_DEF[obj.ingredientType];
      if (def && def.needsChop && obj.state === 'raw') continue;
    }
    const d = obj.mesh.position.distanceTo(worldPos);
    if (d < obj.radius && d < bestD) { bestD = d; best = obj; }
  }
  return best;
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

function grabObject(handKey, obj, worldPos) {
  detachFromVessel(obj);
  obj.heldBy = handKey;
  obj.onBoard = false;
  if (obj.onStove !== undefined) obj.onStove = false;
  obj.grabOffset.copy(obj.mesh.position).sub(worldPos);
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
const _tmpKnob = new THREE.Vector3();

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

    const worldPos = handWorldPosition(h.palm.x, h.palm.y, h.palm.z, _tmpKnob);
    const inZone = worldPos.distanceTo(ZONE.stoveButton.pos) < ZONE.stoveButton.r;
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

function handleGrabStart(handKey, worldPos) {
  // La perilla de la estufa YA NO se activa por pinza: se gira (ver updateStoveKnob).
  if (worldPos.distanceTo(ZONE.fridgeHandle.pos) < ZONE.fridgeHandle.r) { toggleFridge(); return; }
  if (worldPos.distanceTo(ZONE.entranceHandle.pos) < ZONE.entranceHandle.r) { toggleEntranceDoor(); return; }
  if (worldPos.distanceTo(ZONE.blender.pos) < ZONE.blender.r) { toggleBlender(); return; }

  for (const slot of ZONE.pantrySlots) {
    if (worldPos.distanceTo(slot.pos) < 0.24) {
      const obj = Items.spawnIngredient(slot.kind, slot.pos.clone());
      grabObject(handKey, obj, worldPos);
      return;
    }
  }
  if (worldPos.distanceTo(ZONE.plateStack.pos) < ZONE.plateStack.r) {
    const obj = Items.spawnPlate(ZONE.plateStack.pos.clone());
    grabObject(handKey, obj, worldPos);
    return;
  }

  const obj = nearestGrabbable(worldPos);
  if (obj) grabObject(handKey, obj, worldPos);
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
    const h = HandTracking.hands[handKey];
    const worldPos = handWorldPosition(h.palm.x, h.palm.y, h.palm.z, _tmpVec2);
    const target = worldPos.clone().add(obj.grabOffset);
    obj.mesh.position.lerp(target, 0.5);
  }
}

const _tmpVec = new THREE.Vector3(), _tmpVec2 = new THREE.Vector3();
function updateHandGesturesAndInteractions() {
  for (const handKey of ['left', 'right']) {
    const h = HandTracking.hands[handKey];
    const worldPos = handWorldPosition(h.palm.x, h.palm.y, h.palm.z, _tmpVec).clone();
    if (h.pinchStarted && !activeGrab[handKey]) handleGrabStart(handKey, worldPos);
    if (h.pinchEnded && activeGrab[handKey]) handleGrabEnd(handKey, worldPos);
  }
  updateHeldObjects();
}

// ---------- Picar ingredientes: requiere sostener el cuchillo ----------
const CHOP_HITS_REQUIRED = 4;
const _chopSpikeLatch = { left: false, right: false };
const _tmpChop = new THREE.Vector3();
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
      const worldPos = handWorldPosition(h.palm.x, h.palm.y, h.palm.z, _tmpChop);
      if (worldPos.distanceTo(obj.mesh.position) > 0.26) continue;

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
const _tmpStir = new THREE.Vector3();
const _stirLatch = { left: false, right: false };
function updateStirring() {
  for (const handKey of ['left', 'right']) {
    const held = activeGrab[handKey];
    if (held !== Items.spatula && held !== Items.ladle) { _stirLatch[handKey] = false; continue; }
    const h = HandTracking.hands[handKey];
    const worldPos = handWorldPosition(h.palm.x, h.palm.y, h.palm.z, _tmpStir);
    const nearVessel = findNearbyVessel(worldPos, 0.28);

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
const UTENSIL_LABEL = { knife: 'Cuchillo', spatula: 'Espátula', ladle: 'Cucharón' };
function updateHudHands() {
  const l = HandTracking.hands.left, r = HandTracking.hands.right;
  const pl = document.getElementById('pinch-l'), pr = document.getElementById('pinch-r');
  pl.style.width = (l.pinch * 100) + '%'; pl.classList.toggle('grabbing', l.isPinching);
  pr.style.width = (r.pinch * 100) + '%'; pr.classList.toggle('grabbing', r.isPinching);

  let status;
  if (!l.detected && !r.detected) status = 'Buscando manos… acércate a la cámara';
  else if (l.detected && r.detected) status = 'Ambas manos detectadas';
  else status = l.detected ? 'Mano izquierda detectada' : 'Mano derecha detectada';
  document.getElementById('status-text').textContent = status;

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
  const info = document.getElementById('held-info');
  info.innerHTML = (!l2 && !r2) ? 'Manos vacías' :
    [l2 ? `Izq: <b>${l2}</b>` : '', r2 ? `Der: <b>${r2}</b>` : ''].filter(Boolean).join(' · ');
}

// ══════════════════════════════════════════════════════════
// JUGADOR: movimiento en primera persona (teclado)
// ══════════════════════════════════════════════════════════
const K = {};
window.addEventListener('keydown', e => { K[e.code] = true; });
window.addEventListener('keyup', e => { K[e.code] = false; });

const player = { pos: new THREE.Vector3(0, PLAYER_EYE, 3.5), yaw: 0, pitch: 0 };
const MOVE_SPEED = 2.2, TURN_SPEED = 1.6, LOOK_SPEED = 1.2;
// Agacharse: mantén C para bajar la cámara y poder alcanzar objetos que
// se cayeron al piso (el alcance de las manos es relativo a la cámara,
// así que al bajarla también baja toda la zona donde se puede agarrar).
const CROUCH_EYE = PLAYER_EYE - 0.62;
const CROUCH_SPEED_MULT = 0.55;
let eyeHeight = PLAYER_EYE;

function updatePlayerMovement(dt) {
  if (K['ArrowLeft']) player.yaw += TURN_SPEED * dt;
  if (K['ArrowRight']) player.yaw -= TURN_SPEED * dt;
  if (K['ArrowUp']) player.pitch = clamp(player.pitch + LOOK_SPEED * dt, -1.2, 1.2);
  if (K['ArrowDown']) player.pitch = clamp(player.pitch - LOOK_SPEED * dt, -1.2, 1.2);

  const crouching = !!K['KeyC'];
  eyeHeight = lerp(eyeHeight, crouching ? CROUCH_EYE : PLAYER_EYE, Math.min(1, dt * 6));
  const moveSpeed = MOVE_SPEED * (crouching ? CROUCH_SPEED_MULT : 1);

  const sinY = Math.sin(player.yaw), cosY = Math.cos(player.yaw);
  const fwd = { x: -sinY, z: -cosY };
  const right = { x: cosY, z: -sinY };

  let mx = 0, mz = 0;
  if (K['KeyW']) { mx += fwd.x; mz += fwd.z; }
  if (K['KeyS']) { mx -= fwd.x; mz -= fwd.z; }
  if (K['KeyD']) { mx += right.x; mz += right.z; }
  if (K['KeyA']) { mx -= right.x; mz -= right.z; }

  const len = Math.hypot(mx, mz);
  if (len > 0.0001) {
    mx /= len; mz /= len;
    const resolved = resolvePlayerXZ(player.pos.x + mx * moveSpeed * dt, player.pos.z + mz * moveSpeed * dt);
    player.pos.x = resolved.x;
    player.pos.z = resolved.z;
  }

  player.pos.y = eyeHeight;
  camera.position.copy(player.pos);
  camera.rotation.set(player.pitch, player.yaw, 0, 'YXZ');
  camera.updateMatrixWorld(true);
}

// ══════════════════════════════════════════════════════════
// BUCLE PRINCIPAL
// ══════════════════════════════════════════════════════════
let lastT = performance.now();
function loop() {
  requestAnimationFrame(loop);
  const now = performance.now();
  const dt = Math.min((now - lastT) / 1000, 0.05);
  lastT = now;
  clockT += dt;

  updatePlayerMovement(dt);
  updateHandGesturesAndInteractions();
  updateStoveKnob(dt);
  updateHandVisuals();
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
}

// ══════════════════════════════════════════════════════════
// ARRANQUE: pantalla de inicio -> permiso de cámara -> juego
// ══════════════════════════════════════════════════════════
const startBtn = document.getElementById('start-btn');
const startStatus = document.getElementById('start-status');

startBtn.addEventListener('click', async () => {
  startBtn.disabled = true;
  startStatus.textContent = 'Solicitando acceso a la cámara…';
  try {
    await HandTracking.start();
    document.getElementById('start-screen').classList.add('hidden');
    document.getElementById('hud').classList.remove('hidden');
    Guide.startFirstOrder();
    lastT = performance.now();
    requestAnimationFrame(loop);
  } catch (err) {
    startStatus.textContent = 'No se pudo acceder a la cámara: ' + (err && err.message ? err.message : err);
    startBtn.disabled = false;
  }
});

document.getElementById('restart-btn').addEventListener('click', () => location.reload());

})();
