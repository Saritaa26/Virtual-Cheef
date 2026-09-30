/* ============================================================
   ITEMS.JS — Ingredientes, utensilios, sartenes y platos
   ============================================================
   Responsabilidad de este archivo (y SOLO esto):
     1) Construir las mallas 3D de cada objeto agarrable, con
        suficiente detalle (multi-malla, texturas de canvas,
        geometría con más segmentos) para que se lean como
        objetos tridimensionales reales y no como formas
        primitivas planas.
     2) Llevar el ciclo de vida de esas instancias: arrays
        globales (ingredients, pans, plates, utensils), spawn,
        cambios de estado (crudo → picado/cocido).
     3) Ofrecer un sistema de "glow" (resaltado) genérico que
        cualquier objeto pueda usar — lo consume guide.js para
        iluminar los ingredientes del pedido activo.

   Depende de World (escena, ZONE) ya cargado. No sabe nada de
   gestos de mano ni de pedidos: eso vive en game.js / guide.js.
   ============================================================ */

const Items = (() => {
  const { scene } = World;
  const { rand, makeTexture, makeTextPanel } = World.utils;

  // ══════════════════════════════════════════════════════════
  // TEXTURAS DE COMIDA (detalle visual: vetas, semillas, marcas)
  // ══════════════════════════════════════════════════════════
  const TX_MEAT_RAW = makeTexture((ctx, s) => {
    ctx.fillStyle = '#c9584a'; ctx.fillRect(0, 0, s, s);
    for (let i = 0; i < 80; i++) {
      const v = (Math.random() * 26 | 0) - 13;
      ctx.fillStyle = `rgba(${200 + v},${90 + v},${75 + v},.5)`;
      ctx.fillRect(Math.random() * s, Math.random() * s, 2, 2);
    }
  }, 64, [1, 1]);
  const TX_MEAT_GRILL_RAW = makeTexture((ctx, s) => {
    ctx.fillStyle = '#c9584a'; ctx.fillRect(0, 0, s, s);
    ctx.strokeStyle = 'rgba(120,40,30,.55)'; ctx.lineWidth = s * 0.07;
    for (let i = -1; i < 3; i++) { ctx.beginPath(); ctx.moveTo(i * s / 2, s); ctx.lineTo(i * s / 2 + s / 2, 0); ctx.stroke(); }
  }, 64, [1, 1]);
  const TX_MEAT_GRILL_COOKED = makeTexture((ctx, s) => {
    ctx.fillStyle = '#7a4326'; ctx.fillRect(0, 0, s, s);
    for (let i = 0; i < 60; i++) {
      const v = (Math.random() * 20 | 0) - 10;
      ctx.fillStyle = `rgba(${110 + v},${65 + v},${38 + v},.5)`;
      ctx.fillRect(Math.random() * s, Math.random() * s, 2, 2);
    }
    ctx.strokeStyle = 'rgba(35,15,8,.75)'; ctx.lineWidth = s * 0.08;
    for (let i = -1; i < 3; i++) { ctx.beginPath(); ctx.moveTo(i * s / 2, s); ctx.lineTo(i * s / 2 + s / 2, 0); ctx.stroke(); }
  }, 64, [1, 1]);
  const TX_BUN_TOP = makeTexture((ctx, s) => {
    ctx.fillStyle = '#d9a55b'; ctx.fillRect(0, 0, s, s);
    for (let i = 0; i < 55; i++) {
      const v = (Math.random() * 16 | 0) - 8;
      ctx.fillStyle = `rgba(${210 + v},${165 + v},${95 + v},.55)`;
      ctx.fillRect(Math.random() * s, Math.random() * s, 2, 2);
    }
    ctx.fillStyle = '#f4e4bd';
    for (let i = 0; i < 14; i++) {
      ctx.save();
      ctx.translate(rand(6, s - 6), rand(6, s - 6));
      ctx.rotate(rand(0, Math.PI));
      ctx.fillRect(-2.4, -1, 4.8, 2);
      ctx.restore();
    }
  }, 64, [1, 1]);
  const TX_CHEESE = makeTexture((ctx, s) => {
    ctx.fillStyle = '#f5c542'; ctx.fillRect(0, 0, s, s);
    ctx.fillStyle = 'rgba(200,150,20,.35)';
    for (let i = 0; i < 6; i++) {
      const r = rand(2, 4.5);
      ctx.beginPath(); ctx.ellipse(rand(6, s - 6), rand(6, s - 6), r, r * 0.8, 0, 0, Math.PI * 2); ctx.fill();
    }
  }, 48, [1, 1]);

  // ══════════════════════════════════════════════════════════
  // INGREDIENTES
  // ══════════════════════════════════════════════════════════
  const INGREDIENT_DEF = {
    tomato: { label: 'Tomate', color: 0xd1372b, needsChop: true, needsCook: false },
    lettuce: { label: 'Lechuga', color: 0x5fae3d, needsChop: true, needsCook: false },
    cheese: { label: 'Queso', color: 0xf5c542, needsChop: false, needsCook: false },
    bun: { label: 'Pan', color: 0xd9a55b, needsChop: false, needsCook: false },
    meat: { label: 'Carne', color: 0xc98169, needsChop: false, needsCook: true }
  };

  function chunkPiece(mat, s) {
    const geo = new THREE.IcosahedronGeometry(s * rand(0.85, 1.15), 0);
    const m = new THREE.Mesh(geo, mat);
    m.rotation.set(rand(0, Math.PI), rand(0, Math.PI), rand(0, Math.PI));
    m.scale.set(rand(0.8, 1.2), rand(0.6, 1), rand(0.8, 1.2));
    return m;
  }

  function buildIngredientMesh(kind, state) {
    const def = INGREDIENT_DEF[kind];
    const group = new THREE.Group();

    if (kind === 'meat') {
      const cooked = state === 'cooked';
      const sideMat = new THREE.MeshStandardMaterial({ color: cooked ? 0x5c3018 : 0xa8442f, roughness: 0.75 });
      const capMat = new THREE.MeshStandardMaterial({ map: cooked ? TX_MEAT_GRILL_COOKED : TX_MEAT_GRILL_RAW, roughness: 0.7 });
      const patty = new THREE.Mesh(new THREE.CylinderGeometry(0.088, 0.092, 0.05, 24), [sideMat, capMat, capMat]);
      group.add(patty);
    } else if (kind === 'bun') {
      const bottomMat = new THREE.MeshStandardMaterial({ color: 0xc9924e, roughness: 0.75 });
      const topMat = new THREE.MeshStandardMaterial({ map: TX_BUN_TOP, roughness: 0.7 });
      const top = new THREE.Mesh(new THREE.SphereGeometry(0.097, 20, 14, 0, Math.PI * 2, 0, Math.PI / 1.7), topMat);
      top.position.y = 0.012;
      const base = new THREE.Mesh(new THREE.CylinderGeometry(0.097, 0.09, 0.035, 20), bottomMat);
      base.position.y = -0.02;
      group.add(top, base);
    } else if (kind === 'cheese') {
      const mat = new THREE.MeshStandardMaterial({ map: TX_CHEESE, roughness: 0.4, metalness: 0.05 });
      const edgeMat = new THREE.MeshStandardMaterial({ color: 0xe0ac2f, roughness: 0.5 });
      const slice = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.03, 0.13), [edgeMat, edgeMat, mat, mat, edgeMat, edgeMat]);
      group.add(slice);
    } else { // tomato / lettuce
      if (state === 'chopped') {
        const mat = new THREE.MeshStandardMaterial({ color: def.color, roughness: 0.55 });
        const seedMat = kind === 'tomato' ? new THREE.MeshStandardMaterial({ color: 0xffd27a, roughness: 0.4 }) : null;
        for (let i = 0; i < 7; i++) {
          const piece = chunkPiece(mat, 0.026);
          piece.position.set(rand(-0.055, 0.055), 0.012, rand(-0.055, 0.055));
          group.add(piece);
        }
        if (seedMat) {
          for (let i = 0; i < 4; i++) {
            const seed = new THREE.Mesh(new THREE.SphereGeometry(0.006, 6, 6), seedMat);
            seed.position.set(rand(-0.05, 0.05), 0.02, rand(-0.05, 0.05));
            group.add(seed);
          }
        }
      } else if (kind === 'tomato') {
        const mat = new THREE.MeshStandardMaterial({ color: def.color, roughness: 0.3, metalness: 0.05 });
        const body = new THREE.Mesh(new THREE.SphereGeometry(0.09, 20, 16), mat);
        body.scale.y = 0.92;
        group.add(body);
        const calyxMat = new THREE.MeshStandardMaterial({ color: 0x4c8a2f, roughness: 0.7 });
        for (let i = 0; i < 5; i++) {
          const leaf = new THREE.Mesh(new THREE.ConeGeometry(0.014, 0.03, 6), calyxMat);
          const a = (i / 5) * Math.PI * 2;
          leaf.position.set(Math.cos(a) * 0.02, 0.078, Math.sin(a) * 0.02);
          leaf.rotation.x = Math.PI;
          leaf.rotation.z = Math.cos(a) * 0.5;
          group.add(leaf);
        }
      } else { // lettuce entera: capas de hojas para lectura clara de "lechuga"
        const shades = [0x4f9c34, 0x5fae3d, 0x72c04d, 0x5fae3d];
        for (let layer = 0; layer < 4; layer++) {
          const mat = new THREE.MeshStandardMaterial({ color: shades[layer], roughness: 0.65 });
          const leafCount = 5;
          const ringR = 0.075 - layer * 0.014;
          const y = 0.01 + layer * 0.018;
          for (let i = 0; i < leafCount; i++) {
            const a = (i / leafCount) * Math.PI * 2 + layer * 0.4;
            const leaf = new THREE.Mesh(new THREE.SphereGeometry(0.045, 8, 6, 0, Math.PI * 2, 0, Math.PI / 2), mat);
            leaf.scale.set(1, 0.5, 1.3);
            leaf.position.set(Math.cos(a) * ringR, y, Math.sin(a) * ringR);
            leaf.rotation.y = -a;
            leaf.rotation.z = 0.35;
            group.add(leaf);
          }
        }
      }
    }
    group.userData.kind = kind;
    return group;
  }

  const ingredients = [];
  const plates = [];

  function spawnIngredient(kind, worldPos) {
    const mesh = buildIngredientMesh(kind, 'raw');
    mesh.position.copy(worldPos);
    scene.add(mesh);
    const obj = {
      kind: 'ingredient',
      ingredientType: kind,
      state: 'raw',
      choppedHits: 0,
      cookProgress: 0,
      mesh,
      heldBy: null,
      onBoard: false,
      inPan: false,
      grabOffset: new THREE.Vector3(),
      radius: 0.2,
      glow: null
    };
    ingredients.push(obj);
    return obj;
  }

  function setIngredientState(obj, newState) {
    obj.state = newState;
    const pos = obj.mesh.position.clone();
    const parent = obj.mesh.parent;
    const hadGlow = !!obj.glow;
    if (hadGlow) removeGlow(obj);
    parent.remove(obj.mesh);
    obj.mesh = buildIngredientMesh(obj.ingredientType, newState);
    obj.mesh.position.copy(pos);
    parent.add(obj.mesh);
    if (hadGlow) addGlow(obj, hadGlow);
  }

  function isIngredientReady(obj) {
    const def = INGREDIENT_DEF[obj.ingredientType];
    if (def.needsChop && obj.state !== 'chopped') return false;
    if (def.needsCook && obj.state !== 'cooked') return false;
    return true;
  }

  // ---------- Sartenes y ollas: se mueven libremente entre los 4 fogones ----------
  function buildPanMesh() {
    const group = new THREE.Group();
    const mat = new THREE.MeshStandardMaterial({ color: 0x2b2b2e, roughness: 0.32, metalness: 0.65 });
    const rimMat = new THREE.MeshStandardMaterial({ color: 0x9aa0a6, roughness: 0.25, metalness: 0.8 });
    group.add(new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.2, 0.055, 32), mat));
    const rim = new THREE.Mesh(new THREE.TorusGeometry(0.22, 0.008, 8, 32), rimMat);
    rim.rotation.x = Math.PI / 2;
    rim.position.y = 0.028;
    group.add(rim);
    const handle = new THREE.Mesh(new THREE.CylinderGeometry(0.016, 0.02, 0.32, 12), new THREE.MeshStandardMaterial({ color: 0x1c1c1c, roughness: 0.55 }));
    handle.rotation.z = Math.PI / 2;
    handle.position.set(0.33, 0, 0);
    group.add(handle);
    return group;
  }
  // Olla: cuerpo más alto y angosto que el sartén, con dos asas laterales
  // en forma de aro (en vez de un mango largo) para que se lea claramente
  // como una pieza distinta al sartén.
  function buildPotMesh() {
    const group = new THREE.Group();
    const mat = new THREE.MeshStandardMaterial({ color: 0x33363b, roughness: 0.3, metalness: 0.7 });
    const rimMat = new THREE.MeshStandardMaterial({ color: 0xb7bcc2, roughness: 0.22, metalness: 0.8 });
    const body = new THREE.Mesh(new THREE.CylinderGeometry(0.165, 0.155, 0.17, 28), mat);
    body.position.y = 0.03;
    group.add(body);
    const rim = new THREE.Mesh(new THREE.TorusGeometry(0.165, 0.009, 8, 28), rimMat);
    rim.rotation.x = Math.PI / 2;
    rim.position.y = 0.115;
    group.add(rim);
    [-1, 1].forEach(side => {
      const handle = new THREE.Mesh(new THREE.TorusGeometry(0.032, 0.007, 6, 12, Math.PI), rimMat);
      handle.rotation.z = Math.PI / 2;
      handle.rotation.y = side > 0 ? 0 : Math.PI;
      handle.position.set(side * 0.18, 0.06, 0);
      group.add(handle);
    });
    return group;
  }
  const pans = [2, 3].map(burnerIdx => {
    const b = World.ZONE.burners[burnerIdx];
    const mesh = buildPanMesh();
    mesh.position.set(b.pos.x, b.pos.y + 0.03, b.pos.z);
    scene.add(mesh);
    return { kind: 'pan', mesh, heldBy: null, onStove: true, contents: [], grabOffset: new THREE.Vector3(), radius: 0.3, glow: null };
  });
  // Sartén de repuesto, lista para tomar del mostrador (más sartenes disponibles
  // que fogones, así siempre hay una libre aunque las otras estén ocupadas).
  (function spareSkillet() {
    const mesh = buildPanMesh();
    mesh.position.set(2.6, World.COUNTER_TOP_Y + 0.03, World.BACK_WALL_Z + World.COUNTER_DEPTH / 2);
    scene.add(mesh);
    pans.push({ kind: 'pan', mesh, heldBy: null, onStove: false, contents: [], grabOffset: new THREE.Vector3(), radius: 0.3, glow: null });
  })();
  const pots = [0, 1].map(burnerIdx => {
    const b = World.ZONE.burners[burnerIdx];
    const mesh = buildPotMesh();
    mesh.position.set(b.pos.x, b.pos.y + 0.058, b.pos.z);
    scene.add(mesh);
    return { kind: 'pot', mesh, heldBy: null, onStove: true, contents: [], grabOffset: new THREE.Vector3(), radius: 0.3, glow: null };
  });

  // ---------- Platos ----------
  function buildPlateMesh() {
    const group = new THREE.Group();
    const rim = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.207, 0.018, 32), new THREE.MeshStandardMaterial({ color: 0xfbfaf6, roughness: 0.3 }));
    group.add(rim);
    const accent = new THREE.Mesh(new THREE.TorusGeometry(0.185, 0.003, 6, 32), new THREE.MeshStandardMaterial({ color: 0x2f8f4e, roughness: 0.4, metalness: 0.3 }));
    accent.rotation.x = Math.PI / 2;
    accent.position.y = 0.01;
    group.add(accent);
    const inner = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.16, 0.006, 32), new THREE.MeshStandardMaterial({ color: 0xefeade, roughness: 0.35 }));
    inner.position.y = 0.011;
    group.add(inner);
    return group;
  }
  function spawnPlate(worldPos) {
    const mesh = buildPlateMesh();
    mesh.position.copy(worldPos);
    scene.add(mesh);
    const obj = { kind: 'plate', mesh, heldBy: null, contents: [], grabOffset: new THREE.Vector3(), radius: 0.28, glow: null };
    plates.push(obj);
    return obj;
  }
  function despawnPlate(plate) {
    removeGlow(plate);
    scene.remove(plate.mesh);
    const i = plates.indexOf(plate);
    if (i !== -1) plates.splice(i, 1);
  }
  for (let i = 0; i < 4; i++) {
    const deco = buildPlateMesh();
    deco.position.set(World.ZONE.plateStack.pos.x, World.ZONE.plateStack.pos.y - 0.05 + i * 0.02, World.ZONE.plateStack.pos.z);
    scene.add(deco);
  }

  // ---------- Utensilios (cuchillo, espátula, cucharón) ----------
  function buildKnifeMesh() {
    const group = new THREE.Group();
    const blade = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.022, 0.05), new THREE.MeshStandardMaterial({ color: 0xdfe4e8, roughness: 0.2, metalness: 0.85 }));
    blade.position.x = 0.12;
    const bolster = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.03, 0.055), new THREE.MeshStandardMaterial({ color: 0x9a9a9a, roughness: 0.3, metalness: 0.7 }));
    bolster.position.x = 0.005;
    const handle = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.03, 0.032), new THREE.MeshStandardMaterial({ color: 0x2a1c10, roughness: 0.55 }));
    handle.position.x = -0.065;
    group.add(blade, bolster, handle);
    return group;
  }
  function buildSpatulaMesh() {
    const group = new THREE.Group();
    const handle = new THREE.Mesh(new THREE.CylinderGeometry(0.013, 0.013, 0.24, 12), new THREE.MeshStandardMaterial({ color: 0x3a3a3a, roughness: 0.45 }));
    handle.rotation.z = Math.PI / 2;
    handle.position.x = -0.02;
    const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.014, 0.04, 10), new THREE.MeshStandardMaterial({ color: 0xaaaaaa, roughness: 0.3, metalness: 0.5 }));
    neck.rotation.z = Math.PI / 2;
    neck.position.x = 0.1;
    const head = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.007, 0.075), new THREE.MeshStandardMaterial({ color: 0xcfd3d6, roughness: 0.3, metalness: 0.55 }));
    head.position.x = 0.15;
    group.add(handle, neck, head);
    return group;
  }
  function buildLadleMesh() {
    const group = new THREE.Group();
    const handle = new THREE.Mesh(new THREE.CylinderGeometry(0.011, 0.011, 0.26, 12), new THREE.MeshStandardMaterial({ color: 0x555555, roughness: 0.35, metalness: 0.65 }));
    handle.rotation.z = Math.PI / 2;
    handle.position.x = -0.03;
    const bowl = new THREE.Mesh(new THREE.SphereGeometry(0.05, 16, 10, 0, Math.PI * 2, 0, Math.PI / 1.8), new THREE.MeshStandardMaterial({ color: 0x8c9094, roughness: 0.25, metalness: 0.65 }));
    bowl.rotation.x = Math.PI;
    bowl.position.x = 0.14;
    group.add(handle, bowl);
    return group;
  }

  const utensils = [];
  function makeUtensil(toolType, mesh, pos, radius) {
    mesh.rotation.y = Math.PI / 2;
    mesh.position.copy(pos);
    scene.add(mesh);
    const obj = { kind: 'utensil', toolType, mesh, heldBy: null, grabOffset: new THREE.Vector3(), radius, glow: null };
    utensils.push(obj);
    return obj;
  }
  const knife = makeUtensil('knife', buildKnifeMesh(), World.ZONE.utensilSlots.knife, 0.22);
  const spatula = makeUtensil('spatula', buildSpatulaMesh(), World.ZONE.utensilSlots.spatula, 0.22);
  const ladle = makeUtensil('ladle', buildLadleMesh(), World.ZONE.utensilSlots.ladle, 0.22);

  // ---------- Decoración de la despensa y el estante de utensilios ----------
  // `pantryMarkers` expone la malla estática de cada canasta para que
  // guide.js pueda iluminarla cuando ese ingrediente haga falta.
  const pantryMarkers = {};
  World.ZONE.pantrySlots.forEach(slot => {
    const marker = buildIngredientMesh(slot.kind, 'raw');
    marker.scale.setScalar(1.15);
    marker.position.copy(slot.pos);
    scene.add(marker);
    pantryMarkers[slot.kind] = { mesh: marker, glow: null };
    const basket = new THREE.Mesh(
      new THREE.CylinderGeometry(0.13, 0.11, 0.08, 20, 1, true),
      new THREE.MeshStandardMaterial({ color: 0xd7dbe0, roughness: 0.5, metalness: 0.3, side: THREE.DoubleSide })
    );
    basket.position.set(slot.pos.x, slot.pos.y - 0.055, slot.pos.z);
    scene.add(basket);
    const label = new THREE.Mesh(
      new THREE.PlaneGeometry(0.24, 0.09),
      new THREE.MeshBasicMaterial({ map: makeTextPanel(INGREDIENT_DEF[slot.kind].label, '', 300, 110, { bg: '#20262b', border: '#7fd7c4' }), transparent: true })
    );
    label.position.set(slot.pos.x + 0.06, slot.pos.y - 0.14, slot.pos.z);
    label.rotation.y = Math.PI / 2;
    scene.add(label);
  });
  [
    { name: 'CUCHILLO', pos: World.ZONE.utensilSlots.knife },
    { name: 'ESPÁTULA', pos: World.ZONE.utensilSlots.spatula },
    { name: 'CUCHARÓN', pos: World.ZONE.utensilSlots.ladle }
  ].forEach(u => {
    const label = new THREE.Mesh(
      new THREE.PlaneGeometry(0.24, 0.09),
      new THREE.MeshBasicMaterial({ map: makeTextPanel(u.name, '', 300, 110, { bg: '#20262b', border: '#7fd7c4' }), transparent: true })
    );
    label.position.set(u.pos.x - 0.06, u.pos.y - 0.18, u.pos.z);
    label.rotation.y = -Math.PI / 2;
    scene.add(label);
  });

  // ══════════════════════════════════════════════════════════
  // GLOW GENÉRICO — resalta cualquier objeto (usado por guide.js
  // para señalar los ingredientes/utensilios del pedido activo)
  // ══════════════════════════════════════════════════════════
  const glowing = [];
  function addGlow(obj, color = 0xffd54a) {
    if (obj.glow) return obj.glow;
    obj.mesh.updateWorldMatrix(true, false);
    const box = new THREE.Box3().setFromObject(obj.mesh);
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    const r = Math.max(sphere.radius * 1.35, 0.08);
    const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.32, side: THREE.BackSide, depthWrite: false });
    const shell = new THREE.Mesh(new THREE.IcosahedronGeometry(r, 2), mat);
    // sphere.center está en espacio de mundo: lo convertimos al espacio
    // local de obj.mesh para que el glow quede bien ubicado aunque el
    // objeto esté anidado (p. ej. un ingrediente ya dentro de un sartén).
    shell.position.copy(obj.mesh.worldToLocal(sphere.center.clone()));
    obj.mesh.add(shell);
    obj.glow = { shell, mat, baseR: r, phase: Math.random() * Math.PI * 2, color };
    glowing.push(obj);
    return color;
  }
  function removeGlow(obj) {
    if (!obj.glow) return;
    obj.mesh.remove(obj.glow.shell);
    const i = glowing.indexOf(obj);
    if (i !== -1) glowing.splice(i, 1);
    obj.glow = null;
  }
  function updateGlows(t) {
    for (const obj of glowing) {
      const g = obj.glow;
      if (!g) continue;
      const pulse = 1 + Math.sin(t * 3.4 + g.phase) * 0.12;
      g.shell.scale.setScalar(pulse);
      g.mat.opacity = 0.24 + Math.sin(t * 3.4 + g.phase) * 0.12;
    }
  }

  return {
    INGREDIENT_DEF,
    ingredients, plates, pans, pots, utensils,
    get vessels() { return [...pans, ...pots]; }, // sartenes + ollas: cualquier recipiente que cocina
    knife, spatula, ladle,
    pantryMarkers,
    buildIngredientMesh, spawnIngredient, setIngredientState, isIngredientReady,
    buildPlateMesh, spawnPlate, despawnPlate,
    addGlow, removeGlow, updateGlows
  };
})();

window.Items = Items;
