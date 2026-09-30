/* ============================================================
   GUIDE.JS — Sistema de guía: pedidos, resaltado y tutorial
   ============================================================
   Responsabilidad de este archivo (y SOLO esto):
     1) Recetas y ciclo de pedidos (temporizador amplio, puntaje).
     2) Un motor de "pista" que, cuadro a cuadro, mira el estado
        REAL del mundo (qué ingredientes existen, en qué estado,
        si están en un plato, si la estufa está encendida...) y
        deduce la siguiente acción concreta que el jugador debe
        realizar para completar el pedido activo. Al ser derivado
        del estado en vez de un guion fijo, sigue siendo correcto
        sin importar en qué orden el jugador decida trabajar.
     3) A partir de esa pista: (a) hace brillar (glow) los objetos
        involucrados, (b) mueve un marcador luminoso al punto
        exacto del mesón donde hay que actuar, y (c) actualiza el
        panel de tutorial y el ticket de pedido (tachando lo que
        ya está listo en el plato).

   Lee `Game.stoveOn` / `Game.showToast` (expuestos por game.js);
   todo lo demás lo deriva de Items/World. No conoce gestos de
   mano: solo observa el resultado de que game.js ya los procesó
   (heldBy, onBoard, inPan, contents...).
   ============================================================ */

const Guide = (() => {
  const { scene } = World;

  // ══════════════════════════════════════════════════════════
  // RECETAS — sin límite de tiempo: el pedido espera lo que haga
  // falta, sin presión de reloj.
  // ══════════════════════════════════════════════════════════
  const RECIPES = [
    { name: 'Hamburguesa Especial', items: [
        { kind: 'bun', state: 'raw' }, { kind: 'meat', state: 'cooked' },
        { kind: 'cheese', state: 'raw' }, { kind: 'lettuce', state: 'chopped' }
    ]},
    { name: 'Ensalada Fresca', items: [
        { kind: 'lettuce', state: 'chopped' }, { kind: 'tomato', state: 'chopped' }, { kind: 'cheese', state: 'raw' }
    ]},
    { name: 'Hamburguesa Simple', items: [
        { kind: 'bun', state: 'raw' }, { kind: 'meat', state: 'cooked' }, { kind: 'tomato', state: 'chopped' }
    ]}
  ];

  let currentOrder = null, score = 0;

  // ---------- Ticket de pedido ----------
  function renderOrderTicket() {
    document.getElementById('order-name').textContent = currentOrder.name;
    const ul = document.getElementById('order-items');
    ul.innerHTML = '';
    currentOrder.items.forEach(it => {
      const li = document.createElement('li');
      const extra = it.state === 'chopped' ? ' (picado)' : it.state === 'cooked' ? ' (cocido)' : '';
      li.textContent = Items.INGREDIENT_DEF[it.kind].label + extra;
      li.dataset.kind = it.kind;
      li.dataset.state = it.state;
      ul.appendChild(li);
    });
  }
  function markTicketProgress(plate) {
    const have = plate ? plate.contents.slice() : [];
    document.querySelectorAll('#order-items li').forEach(li => {
      const idx = have.findIndex(h => h.kind === li.dataset.kind && h.state === li.dataset.state);
      if (idx !== -1) { have.splice(idx, 1); li.classList.add('done'); }
      else li.classList.remove('done');
    });
  }

  function nextOrder() {
    let r;
    do { r = RECIPES[Math.floor(Math.random() * RECIPES.length)]; }
    while (RECIPES.length > 1 && currentOrder && r.name === currentOrder.name);
    currentOrder = r;
    renderOrderTicket();
  }
  function startFirstOrder() { nextOrder(); }

  function tryServe(plate) {
    const need = currentOrder.items.slice();
    const have = plate.contents.slice();
    const ok = need.length === have.length && need.every(n => {
      const idx = have.findIndex(h => h.kind === n.kind && h.state === n.state);
      if (idx === -1) return false;
      have.splice(idx, 1);
      return true;
    });
    if (ok) {
      score += 100;
      document.getElementById('score').textContent = score;
      Game.showToast(`🎉 ¡${currentOrder.name} servido! +100`);
      Items.despawnPlate(plate);
      nextOrder();
    } else {
      Game.showToast('❌ Ese plato no coincide con el pedido');
    }
    return ok;
  }

  // ══════════════════════════════════════════════════════════
  // MOTOR DE PISTA — deriva la siguiente acción del estado real
  // ══════════════════════════════════════════════════════════
  const pantryPos = {};
  World.ZONE.pantrySlots.forEach(s => { pantryPos[s.kind] = s.pos; });
  const stoveKnobWrapper = { mesh: World.stoveButtonMesh, glow: null };

  function pickActivePlate() {
    if (!Items.plates.length) return null;
    let best = null, bestScore = -1;
    for (const p of Items.plates) {
      let s = 0;
      const have = p.contents.slice();
      for (const n of currentOrder.items) {
        const idx = have.findIndex(h => h.kind === n.kind && h.state === n.state);
        if (idx !== -1) { s++; have.splice(idx, 1); }
      }
      if (s >= bestScore) { bestScore = s; best = p; }
    }
    return best;
  }

  function computeMissing(plate) {
    const have = plate ? plate.contents.slice() : [];
    const missing = [];
    for (const n of currentOrder.items) {
      const idx = have.findIndex(h => h.kind === n.kind && h.state === n.state);
      if (idx === -1) missing.push(n); else have.splice(idx, 1);
    }
    return missing;
  }

  function findBestInstance(kind) {
    const candidates = Items.ingredients.filter(o => o.ingredientType === kind);
    if (!candidates.length) return null;
    return candidates.find(o => Items.isIngredientReady(o) && !o.heldBy)
      || candidates.find(o => Items.isIngredientReady(o))
      || candidates.find(o => o.inPan)
      || candidates.find(o => o.onBoard)
      || candidates[candidates.length - 1];
  }

  function anyStoveVessel() { return Items.vessels.find(p => p.onStove) || null; }

  // Qué tan avanzado está un ingrediente pendiente (mayor = más cerca de
  // terminar). Se usa para que la pista siempre hable del ingrediente en
  // el que el jugador ya está trabajando, en vez de quedarse fija en el
  // primer ítem de la receta mientras ignora el progreso real.
  function progressRank(kind) {
    const inst = findBestInstance(kind);
    if (!inst) return 0;
    if (Items.isIngredientReady(inst)) return 5;
    if (inst.inPan) return 4;
    if (inst.onBoard) return 3;
    if (inst.heldBy) return 2;
    return 1;
  }

  function computeHint(plate) {
    const missing = computeMissing(plate);

    if (!missing.length) {
      return plate
        ? { text: `Lleva el plato a la ventanilla de pase y suéltalo para servir "${currentOrder.name}".`, glow: [plate], marker: World.ZONE.pass.pos, color: 0x3ddc84 }
        : { text: 'Toma un plato de la pila del mostrador para emplatar el pedido.', glow: [], marker: World.ZONE.plateStack.pos, color: 0xffd54a };
    }

    let need = missing[0];
    for (const m of missing) if (progressRank(m.kind) > progressRank(need.kind)) need = m;
    const def = Items.INGREDIENT_DEF[need.kind];
    const label = def.label.toLowerCase();
    const inst = findBestInstance(need.kind);

    if (!inst) {
      const marker = pantryPos[need.kind];
      return { text: `Toma ${label} de la despensa (izquierda).`, glow: [Items.pantryMarkers[need.kind]], marker, color: 0xffd54a };
    }

    if (inst.heldBy) {
      if (def.needsChop && inst.state === 'raw') return { text: `Lleva ${label} a la tabla de picar.`, glow: [inst], marker: World.ZONE.board.pos, color: 0xffd54a };
      if (def.needsCook && inst.state !== 'cooked') {
        const vessel = anyStoveVessel();
        return { text: vessel ? `Suelta ${label} dentro del sartén o la olla.` : `Coloca un sartén o una olla sobre un fogón (lo soltaste fuera de la estufa).`,
          glow: [inst], marker: vessel ? vessel.mesh.position : World.ZONE.burners[2].pos, color: 0xffd54a };
      }
      return { text: `Coloca ${label} en el plato.`, glow: [inst], marker: plate ? World.ZONE.assembly.pos : World.ZONE.plateStack.pos, color: 0xffd54a };
    }

    if (def.needsChop && inst.state === 'raw') {
      if (!inst.onBoard) return { text: `Lleva ${label} a la tabla de picar.`, glow: [inst], marker: World.ZONE.board.pos, color: 0xffd54a };
      const knifeGlow = Items.knife.heldBy ? [] : [Items.knife];
      return { text: `Toma el cuchillo y agita la mano sobre ${label} para picarlo.`, glow: [inst, ...knifeGlow], marker: World.ZONE.board.pos, color: 0xff8a3d };
    }

    if (def.needsCook && inst.state !== 'cooked') {
      const vessel = anyStoveVessel();
      if (!vessel) return { text: 'Coloca un sartén o una olla sobre uno de los fogones de la estufa.', glow: [inst], marker: World.ZONE.burners[2].pos, color: 0xffd54a };
      if (!inst.inPan) return { text: `Lleva ${label} al sartén o la olla sobre la estufa.`, glow: [inst], marker: vessel.mesh.position, color: 0xffd54a };
      if (!Game.stoveOn) return { text: 'Enciende la estufa: gira la mano hacia la derecha sobre la perilla.', glow: [stoveKnobWrapper], marker: World.ZONE.stoveButton.pos, color: 0xff5c5c };
      const spatulaGlow = Items.spatula.heldBy ? [] : [Items.spatula];
      return { text: `Espera a que ${label} se cocine (agita la mano con el cucharón/espátula sobre el sartén u olla para acelerar).`, glow: [inst, ...spatulaGlow], marker: vessel.mesh.position, color: 0xff8a3d };
    }

    if (!plate) return { text: `Toma un plato del mostrador para emplatar ${label}.`, glow: [inst], marker: World.ZONE.plateStack.pos, color: 0xffd54a };
    return { text: `Coloca ${label} en el plato.`, glow: [inst], marker: World.ZONE.assembly.pos, color: 0xffd54a };
  }

  // ══════════════════════════════════════════════════════════
  // MARCADOR LUMINOSO EN EL MESÓN (waypoint reutilizable)
  // ══════════════════════════════════════════════════════════
  const markerRingMat = new THREE.MeshBasicMaterial({ color: 0xffd54a, transparent: true, opacity: 0.85, side: THREE.DoubleSide, depthWrite: false });
  const markerRing = new THREE.Mesh(new THREE.RingGeometry(0.15, 0.19, 32), markerRingMat);
  markerRing.rotation.x = -Math.PI / 2;
  const markerBeamMat = new THREE.MeshBasicMaterial({ color: 0xffd54a, transparent: true, opacity: 0.22, side: THREE.DoubleSide, depthWrite: false });
  const markerBeam = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.09, 0.5, 16, 1, true), markerBeamMat);
  markerBeam.position.y = 0.27;
  const markerGroup = new THREE.Group();
  markerGroup.add(markerRing, markerBeam);
  markerGroup.visible = false;
  scene.add(markerGroup);

  let currentGlowSet = [];
  let lastHintText = null;
  function applyHint(hint) {
    const newSet = hint.glow || [];
    for (const obj of currentGlowSet) if (!newSet.includes(obj)) Items.removeGlow(obj);
    for (const obj of newSet) if (!currentGlowSet.includes(obj)) Items.addGlow(obj, hint.color);
    currentGlowSet = newSet;

    markerGroup.visible = !!hint.marker;
    if (hint.marker) {
      markerGroup.position.set(hint.marker.x, hint.marker.y + 0.015, hint.marker.z);
      markerRingMat.color.setHex(hint.color);
      markerBeamMat.color.setHex(hint.color);
    }
    if (hint.text !== lastHintText) {
      const el = document.getElementById('tutorial-text');
      if (el) el.textContent = hint.text;
      lastHintText = hint.text;
    }
  }

  // ══════════════════════════════════════════════════════════
  // ACTUALIZACIÓN POR CUADRO
  // ══════════════════════════════════════════════════════════
  function update(dt, t) {
    if (!currentOrder) return;
    const plate = pickActivePlate();
    markTicketProgress(plate);
    applyHint(computeHint(plate));

    const pulse = 1 + Math.sin(t * 4) * 0.1;
    markerRing.scale.setScalar(pulse);
    markerBeam.position.y = 0.27 + Math.sin(t * 4) * 0.05;
  }

  return { startFirstOrder, nextOrder, tryServe, update, get score() { return score; }, get currentOrder() { return currentOrder; } };
})();

window.Guide = Guide;
