/* ============================================================
   WORLD.JS — Entorno 3D de la cocina de restaurante
   ============================================================
   Responsabilidad de este archivo (y SOLO esto):
     1) Crear la escena, cámara y renderer de Three.js.
     2) Construir la geometría estática del local: piso, paredes,
        techo con iluminación empotrada, mostrador, estufa,
        nevera, fregadero, estante de despensa, estante de
        utensilios, ventanilla de servicio, entrada y mobiliario
        decorativo — con una estética moderna y luminosa de
        cocina de restaurante (nada de madera rústica ni
        iluminación tipo "cueva").
     3) Definir las ZONAS de interacción (ZONE) y los
        colisionadores de movimiento, en un único lugar para que
        geometría e interacción nunca se desincronicen.

   Este archivo NO conoce mecánicas de juego ni gestos de mano:
   solo expone `window.World` con lo que game.js/items.js/guide.js
   necesitan para trabajar sobre este entorno.
   ============================================================ */

const World = (() => {

  // ---------- utilidades numéricas compartidas ----------
  function clamp(x, a, b) { return Math.max(a, Math.min(b, x)); }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function rand(a, b) { return a + Math.random() * (b - a); }

  function makeTexture(draw, size = 128, repeat = [1, 1]) {
    const c = document.createElement('canvas');
    c.width = c.height = size;
    draw(c.getContext('2d'), size);
    const t = new THREE.CanvasTexture(c);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(repeat[0], repeat[1]);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  }

  function makeTextPanel(line1, line2, w = 512, h = 192, opts = {}) {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d');
    ctx.fillStyle = opts.bg || '#1c2126'; ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = opts.border || '#7fd7c4'; ctx.lineWidth = 6; ctx.strokeRect(6, 6, w - 12, h - 12);
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillStyle = opts.color1 || '#f4faf8';
    ctx.font = `bold ${opts.size1 || 44}px Segoe UI, Arial, sans-serif`;
    ctx.fillText(line1, w / 2, h / 2 - (line2 ? 24 : 0));
    if (line2) {
      ctx.font = `${opts.size2 || 24}px Segoe UI, Arial, sans-serif`;
      ctx.fillStyle = opts.color2 || '#9fd8c9';
      ctx.fillText(line2, w / 2, h / 2 + 34);
    }
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  }

  // ══════════════════════════════════════════════════════════
  // TEXTURAS DEL ENTORNO — cocina de restaurante COLORIDA: piso a
  // cuadros mostaza/crema, paredes en terracota + azulejo teal,
  // acero inoxidable cepillado solo en el equipo funcional.
  // ══════════════════════════════════════════════════════════
  const TX_FLOOR = makeTexture((ctx, s) => {
    // Piso a cuadros (estilo diner): mostaza y crema alternados.
    const half = s / 2;
    ctx.fillStyle = '#e7d3a1'; ctx.fillRect(0, 0, s, s);
    ctx.fillStyle = '#d99a34';
    ctx.fillRect(0, 0, half, half);
    ctx.fillRect(half, half, half, half);
    ctx.strokeStyle = 'rgba(40,30,10,.28)'; ctx.lineWidth = 3; ctx.strokeRect(1.5, 1.5, s - 3, s - 3);
    for (let i = 0; i < 60; i++) {
      const v = (Math.random() * 16 | 0) - 8;
      ctx.fillStyle = `rgba(${180 + v},${140 + v},${80 + v},.4)`;
      ctx.fillRect(Math.random() * s, Math.random() * s, 2, 2);
    }
  }, 128, [10, 10]);

  const TX_WALL = makeTexture((ctx, s) => {
    // Zócalo de azulejo teal (40% inferior) + pintura terracota (60% superior)
    const tileH = s * 0.42;
    ctx.fillStyle = '#e0623f'; ctx.fillRect(0, 0, s, s - tileH);
    ctx.fillStyle = '#1f9d8a'; ctx.fillRect(0, s - tileH, s, tileH);
    ctx.strokeStyle = 'rgba(255,255,255,.22)'; ctx.lineWidth = 2;
    const cols = 4, rows = 3;
    for (let r = 0; r < rows; r++) {
      const y = s - tileH + (r / rows) * tileH;
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(s, y); ctx.stroke();
      for (let c = 0; c < cols; c++) {
        const x = ((c + (r % 2 ? 0.5 : 0)) / cols) * s;
        ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x, y + tileH / rows); ctx.stroke();
      }
    }
    ctx.strokeStyle = 'rgba(20,20,15,.3)'; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(0, s - tileH); ctx.lineTo(s, s - tileH); ctx.stroke();
    for (let i = 0; i < 30; i++) {
      const v = (Math.random() * 18 | 0) - 9;
      ctx.fillStyle = `rgba(${255},${200 + v},${170 + v},.18)`;
      ctx.fillRect(Math.random() * s, Math.random() * (s - tileH), 3, 3);
    }
  }, 128, [7, 1]);

  const TX_STEEL = makeTexture((ctx, s) => {
    ctx.fillStyle = '#c7ccd2'; ctx.fillRect(0, 0, s, s);
    for (let y = 0; y < s; y += 2) {
      const v = (Math.random() * 18 | 0) - 9;
      ctx.fillStyle = `rgba(${170 + v},${176 + v},${182 + v},.55)`;
      ctx.fillRect(0, y, s, 1);
    }
    ctx.strokeStyle = 'rgba(255,255,255,.35)'; ctx.lineWidth = 1;
    ctx.strokeRect(0.5, 0.5, s - 1, s - 1);
  }, 64, [5, 1]);

  const TX_WOOD = makeTexture((ctx, s) => {
    ctx.fillStyle = '#8a5a30'; ctx.fillRect(0, 0, s, s);
    for (let y = 0; y < s; y += 4) {
      ctx.fillStyle = (y % 8 === 0) ? '#6d4322' : '#9c6a3a';
      ctx.fillRect(0, y, s, 2);
    }
  }, 64, [3, 1]);

  // ══════════════════════════════════════════════════════════
  // ESCENA / CÁMARA / RENDERER
  // ══════════════════════════════════════════════════════════
  const canvasEl = document.getElementById('scene');
  const scene = new THREE.Scene();

  const camera = new THREE.PerspectiveCamera(65, innerWidth / innerHeight, 0.05, 80);

  const renderer = new THREE.WebGLRenderer({ canvas: canvasEl, antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
  renderer.setSize(innerWidth, innerHeight);
  renderer.setClearColor(0x000000, 0);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;

  window.addEventListener('resize', () => {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
  });

  // ---------- Iluminación: brillante, pareja, "profesional" ----------
  // Luz ambiental + hemisférica altas para eliminar el look oscuro de
  // cueva; varios focos de techo empotrados simulan paneles LED reales.
  // NOTA: Three.js r160 usa iluminación físicamente correcta por defecto
  // (PointLight en candelas, con caída por distancia al cuadrado). Por eso
  // las luces de techo usan decay:0 e intensidades más altas — con los
  // valores "de juego" clásicos (~1) la cocina se ve oscura a poca distancia.
  scene.add(new THREE.AmbientLight(0xffffff, 0.6));
  scene.add(new THREE.HemisphereLight(0xffffff, 0xd8dee4, 0.5));
  const keyLight = new THREE.DirectionalLight(0xffffff, 0.45);
  keyLight.position.set(3, 6, 4);
  scene.add(keyLight);

  // ══════════════════════════════════════════════════════════
  // DISTRIBUCIÓN DE LA COCINA (constantes de layout)
  // Cocina amplia: 10.8 x 10.8 m (antes 8 x 8) y techo más alto.
  // ══════════════════════════════════════════════════════════
  const ROOM_HALF = 5.4;
  const WALL_H = 3.2;
  const BACK_WALL_Z = -ROOM_HALF;
  const COUNTER_DEPTH = 0.7;
  const COUNTER_TOP_Y = 0.95;
  const PLAYER_EYE = 1.62;
  const PLAYER_RADIUS = 0.3;
  const STOVE_CX = -3.6;

  const ZONE = {
    stoveButton: { pos: new THREE.Vector3(STOVE_CX, 1.22, BACK_WALL_Z + COUNTER_DEPTH - 0.03), r: 0.2 },
    burners: [
      { pos: new THREE.Vector3(STOVE_CX - 0.45, COUNTER_TOP_Y, BACK_WALL_Z + 0.18), r: 0.24 },
      { pos: new THREE.Vector3(STOVE_CX + 0.45, COUNTER_TOP_Y, BACK_WALL_Z + 0.18), r: 0.24 },
      { pos: new THREE.Vector3(STOVE_CX - 0.45, COUNTER_TOP_Y, BACK_WALL_Z + 0.5), r: 0.24 },
      { pos: new THREE.Vector3(STOVE_CX + 0.45, COUNTER_TOP_Y, BACK_WALL_Z + 0.5), r: 0.24 }
    ],
    board: { pos: new THREE.Vector3(-1.9, COUNTER_TOP_Y, BACK_WALL_Z + 0.45), r: 0.42 },
    sink: { pos: new THREE.Vector3(-0.9, COUNTER_TOP_Y, BACK_WALL_Z + 0.45), r: 0.4 },
    assembly: { pos: new THREE.Vector3(0.0, COUNTER_TOP_Y, BACK_WALL_Z + 0.45), r: 0.42 },
    blender: { pos: new THREE.Vector3(0.85, COUNTER_TOP_Y + 0.22, BACK_WALL_Z + 0.42), r: 0.22 },
    plateStack: { pos: new THREE.Vector3(1.9, COUNTER_TOP_Y + 0.05, BACK_WALL_Z + 0.4), r: 0.32 },
    pass: { pos: new THREE.Vector3(ROOM_HALF - 0.45, 1.05, 0.1), r: 0.5 },
    fridgeHandle: { pos: new THREE.Vector3(-ROOM_HALF + 0.81, 1.2, -4.32), r: 0.5 },
    entranceHandle: { pos: new THREE.Vector3(ROOM_HALF - 0.1, 1.2, -4.15), r: 0.4 },
    trash: { pos: new THREE.Vector3(ROOM_HALF - 0.65, 0.55, -3.3), r: 0.42 },
    pantrySlots: [
      { kind: 'tomato', pos: new THREE.Vector3(-ROOM_HALF + 0.38, 1.75, 0.2) },
      { kind: 'lettuce', pos: new THREE.Vector3(-ROOM_HALF + 0.38, 1.75, 1.4) },
      { kind: 'cheese', pos: new THREE.Vector3(-ROOM_HALF + 0.38, 1.75, 2.6) },
      { kind: 'meat', pos: new THREE.Vector3(-ROOM_HALF + 0.38, 1.15, 0.8) },
      { kind: 'bun', pos: new THREE.Vector3(-ROOM_HALF + 0.38, 1.15, 2.0) }
    ],
    utensilSlots: {
      knife: new THREE.Vector3(ROOM_HALF - 0.38, 1.42, 2.0),
      spatula: new THREE.Vector3(ROOM_HALF - 0.38, 1.42, 2.8),
      ladle: new THREE.Vector3(ROOM_HALF - 0.38, 1.42, 3.6)
    }
  };

  // ---------- Colisionadores simples (AABB en XZ) para caminar ----------
  const colliders = [];
  function addCollider(minX, maxX, minZ, maxZ) { colliders.push({ minX, maxX, minZ, maxZ }); }
  addCollider(-ROOM_HALF + 0.5, ROOM_HALF - 0.5, BACK_WALL_Z, BACK_WALL_Z + COUNTER_DEPTH); // mostrador continuo
  addCollider(-ROOM_HALF, -ROOM_HALF + 0.75, -4.9, -3.4);      // nevera
  addCollider(-ROOM_HALF, -ROOM_HALF + 0.5, -0.3, 3.0);        // despensa
  addCollider(ROOM_HALF - 0.5, ROOM_HALF, -0.85, 0.95);        // ventanilla de servicio
  addCollider(ROOM_HALF - 0.5, ROOM_HALF, 1.5, 4.1);           // estante de utensilios
  addCollider(ROOM_HALF - 0.75, ROOM_HALF, -3.6, -3.0);        // caneca de basura
  addCollider(3.85, 4.55, 4.25, 4.95);                         // mesa de café decorativa

  function resolvePlayerXZ(newX, newZ) {
    let x = newX, z = newZ;
    const r = PLAYER_RADIUS;
    for (const c of colliders) {
      if (x > c.minX - r && x < c.maxX + r && z > c.minZ - r && z < c.maxZ + r) {
        const penLeft = x - (c.minX - r);
        const penRight = (c.maxX + r) - x;
        const penTop = z - (c.minZ - r);
        const penBot = (c.maxZ + r) - z;
        const minPen = Math.min(penLeft, penRight, penTop, penBot);
        if (minPen === penLeft) x = c.minX - r;
        else if (minPen === penRight) x = c.maxX + r;
        else if (minPen === penTop) z = c.minZ - r;
        else z = c.maxZ + r;
      }
    }
    const bound = ROOM_HALF - 0.15;
    x = clamp(x, -bound, bound);
    z = clamp(z, -bound, bound);
    return { x, z };
  }

  // ══════════════════════════════════════════════════════════
  // CONSTRUCCIÓN DEL ENTORNO
  // ══════════════════════════════════════════════════════════
  function buildBox(w, h, d, cx, cy, cz, material) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
    mesh.position.set(cx, cy, cz);
    scene.add(mesh);
    return mesh;
  }

  function buildShelfUnitZ(x, z0, z1, height, depth, tiers, dir, frameMat) {
    const length = Math.abs(z1 - z0);
    const cz = (z0 + z1) / 2;
    [z0, z1].forEach(z => {
      const side = new THREE.Mesh(new THREE.BoxGeometry(depth, height, 0.04), frameMat);
      side.position.set(x + dir * depth / 2, height / 2, z);
      scene.add(side);
    });
    const back = new THREE.Mesh(new THREE.BoxGeometry(0.03, height, length), frameMat);
    back.position.set(x + dir * 0.015, height / 2, cz);
    scene.add(back);
    tiers.forEach(y => {
      const shelf = new THREE.Mesh(new THREE.BoxGeometry(depth, 0.03, length), frameMat);
      shelf.position.set(x + dir * depth / 2, y, cz);
      scene.add(shelf);
    });
  }

  const counterMat = new THREE.MeshStandardMaterial({ map: TX_STEEL, roughness: 0.4, metalness: 0.55 });
  const steelMat = new THREE.MeshStandardMaterial({ color: 0xcfd4d9, roughness: 0.35, metalness: 0.7 });
  const darkSteelMat = new THREE.MeshStandardMaterial({ color: 0x4b5157, roughness: 0.4, metalness: 0.5 });
  const whiteMat = new THREE.MeshStandardMaterial({ color: 0xf6f7f5, roughness: 0.45 });
  const woodMat = new THREE.MeshStandardMaterial({ map: TX_WOOD, roughness: 0.65 });
  // Paleta de color de la cocina (gabinetes, nevera, estantes, puertas)
  const cabinetMat = new THREE.MeshStandardMaterial({ color: 0x1f9d8a, roughness: 0.55 });   // teal
  const accentMat = new THREE.MeshStandardMaterial({ color: 0xe0623f, roughness: 0.5 });     // terracota
  const shelfMat = new THREE.MeshStandardMaterial({ color: 0xd99a34, roughness: 0.6 });      // mostaza

  // ---------- Piso, paredes, techo con paneles de luz empotrados ----------
  (function buildShell() {
    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(ROOM_HALF * 2, ROOM_HALF * 2),
      new THREE.MeshStandardMaterial({ map: TX_FLOOR, roughness: 0.5, metalness: 0.05 })
    );
    floor.rotation.x = -Math.PI / 2;
    scene.add(floor);

    const wallMat = new THREE.MeshStandardMaterial({ map: TX_WALL, roughness: 0.85, side: THREE.DoubleSide });
    function wall(cx, cz, rotY) {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(ROOM_HALF * 2, WALL_H), wallMat);
      m.position.set(cx, WALL_H / 2, cz);
      m.rotation.y = rotY;
      scene.add(m);
    }
    wall(0, BACK_WALL_Z, 0);
    wall(0, ROOM_HALF, Math.PI);
    wall(-ROOM_HALF, 0, Math.PI / 2);
    wall(ROOM_HALF, 0, -Math.PI / 2);

    const ceiling = new THREE.Mesh(
      new THREE.PlaneGeometry(ROOM_HALF * 2, ROOM_HALF * 2),
      new THREE.MeshStandardMaterial({ color: 0xf5ead9, roughness: 0.9, side: THREE.DoubleSide })
    );
    ceiling.rotation.x = Math.PI / 2;
    ceiling.position.y = WALL_H;
    scene.add(ceiling);

    // Paneles de luz LED empotrados en el techo (rejilla 3x3) — la
    // principal fuente de una iluminación pareja y "de restaurante".
    const panelMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
    for (const px of [-3, 0, 3]) {
      for (const pz of [-3.6, 0, 3.6]) {
        const panel = new THREE.Mesh(new THREE.PlaneGeometry(0.9, 0.9), panelMat);
        panel.rotation.x = Math.PI / 2;
        panel.position.set(px, WALL_H - 0.02, pz);
        scene.add(panel);
        const bulb = new THREE.PointLight(0xffffff, 0.9, 7, 0);
        bulb.position.set(px, WALL_H - 0.15, pz);
        scene.add(bulb);
      }
    }

    // Ventanal frontal grande (luz natural, look luminoso)
    const win = new THREE.Mesh(
      new THREE.PlaneGeometry(2.0, 1.4),
      new THREE.MeshStandardMaterial({ color: 0xeaf6ff, emissive: 0xcfeeff, emissiveIntensity: 0.7 })
    );
    win.position.set(-3.4, 2.0, ROOM_HALF - 0.02);
    win.rotation.y = Math.PI;
    scene.add(win);
    [-0.35, 0.35].forEach(off => {
      const mullion = new THREE.Mesh(new THREE.BoxGeometry(0.05, 1.4, 0.05), darkSteelMat);
      mullion.position.set(-3.4 + off, 2.0, ROOM_HALF - 0.02);
      scene.add(mullion);
    });

    // Letrero "COCINA"
    const sign = new THREE.Mesh(new THREE.PlaneGeometry(1.8, 0.6),
      new THREE.MeshBasicMaterial({ map: makeTextPanel('COCINA', 'Restaurante VR', 512, 192, { bg: '#20262b', border: '#7fd7c4' }), transparent: true }));
    sign.position.set(0, 2.85, BACK_WALL_Z + 0.02);
    scene.add(sign);
  })();

  // ---------- Mostrador principal: gabinete de color + tapa de acero ----------
  const counterCX = 0, counterCZ = BACK_WALL_Z + COUNTER_DEPTH / 2;
  const COUNTER_LEN = ROOM_HALF * 2 - 1.0;
  const COUNTER_TOP_SLAB = 0.08;
  buildBox(COUNTER_LEN, COUNTER_TOP_Y - COUNTER_TOP_SLAB, COUNTER_DEPTH, counterCX, (COUNTER_TOP_Y - COUNTER_TOP_SLAB) / 2, counterCZ, cabinetMat);
  buildBox(COUNTER_LEN, COUNTER_TOP_SLAB, COUNTER_DEPTH + 0.02, counterCX, COUNTER_TOP_Y - COUNTER_TOP_SLAB / 2, counterCZ, counterMat);

  // ---------- Estufa detallada: cuerpo, 4 fogones, botón único, campana ----------
  buildBox(2.0, 0.1, COUNTER_DEPTH * 0.95, STOVE_CX, COUNTER_TOP_Y + 0.03, counterCZ, darkSteelMat);

  const burnerRingMat = new THREE.MeshStandardMaterial({ color: 0x1a1a1a, roughness: 0.45, metalness: 0.35 });
  ZONE.burners.forEach(b => {
    const outer = new THREE.Mesh(new THREE.TorusGeometry(0.15, 0.018, 8, 20), burnerRingMat);
    outer.rotation.x = Math.PI / 2;
    outer.position.set(b.pos.x, COUNTER_TOP_Y + 0.09, b.pos.z);
    scene.add(outer);
    const inner = new THREE.Mesh(new THREE.TorusGeometry(0.08, 0.012, 6, 16), burnerRingMat);
    inner.rotation.x = Math.PI / 2;
    inner.position.set(b.pos.x, COUNTER_TOP_Y + 0.09, b.pos.z);
    scene.add(inner);
    for (let i = 0; i < 6; i++) {
      const spoke = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.012, 0.012), burnerRingMat);
      spoke.position.set(b.pos.x, COUNTER_TOP_Y + 0.095, b.pos.z);
      spoke.rotation.y = (i / 6) * Math.PI;
      scene.add(spoke);
    }
  });

  // Panel de control frontal con la perilla giratoria de encendido
  buildBox(2.0, 0.16, 0.05, STOVE_CX, COUNTER_TOP_Y + 0.16, BACK_WALL_Z + COUNTER_DEPTH - 0.025, darkSteelMat);

  const knobSocket = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.055, 0.02, 20), new THREE.MeshStandardMaterial({ color: 0x111214, roughness: 0.5 }));
  knobSocket.rotation.x = Math.PI / 2;
  knobSocket.position.copy(ZONE.stoveButton.pos).add(new THREE.Vector3(0, 0, -0.015));
  scene.add(knobSocket);

  const stoveButtonMat = new THREE.MeshStandardMaterial({ color: 0xcc2222, emissive: 0x000000, emissiveIntensity: 0, roughness: 0.3, metalness: 0.3 });
  const stoveButtonMesh = new THREE.Mesh(new THREE.CylinderGeometry(0.042, 0.042, 0.028, 20), stoveButtonMat);
  stoveButtonMesh.rotation.x = Math.PI / 2;
  stoveButtonMesh.position.copy(ZONE.stoveButton.pos);
  scene.add(stoveButtonMesh);
  // Marca indicadora de dirección en la perilla (para leer visualmente el giro)
  const knobMark = new THREE.Mesh(new THREE.BoxGeometry(0.008, 0.03, 0.01), new THREE.MeshStandardMaterial({ color: 0xffffff }));
  knobMark.position.copy(ZONE.stoveButton.pos).add(new THREE.Vector3(0, 0.014, -0.012));
  stoveButtonMesh.add(knobMark);
  const powerLabel = new THREE.Mesh(new THREE.PlaneGeometry(0.22, 0.09),
    new THREE.MeshBasicMaterial({ map: makeTextPanel('◀ APAGAR   ENCENDER ▶', '', 420, 110, { size1: 30, bg: '#20262b', border: '#7fd7c4' }), transparent: true }));
  powerLabel.position.copy(ZONE.stoveButton.pos).add(new THREE.Vector3(0, -0.13, -0.02));
  scene.add(powerLabel);

  // Llamas de los 4 fogones (ocultas hasta encender la estufa)
  const flameMat = new THREE.MeshStandardMaterial({ color: 0xff7b1a, emissive: 0xff5500, emissiveIntensity: 1.4, transparent: true, opacity: 0.85 });
  const flames = ZONE.burners.map(b => {
    const g = new THREE.Group();
    for (let i = 0; i < 3; i++) {
      const cone = new THREE.Mesh(new THREE.ConeGeometry(0.05 - i * 0.008, 0.14 - i * 0.02, 8), flameMat);
      cone.position.y = i * 0.01;
      cone.rotation.y = i;
      g.add(cone);
    }
    g.position.set(b.pos.x, COUNTER_TOP_Y + 0.14, b.pos.z);
    g.visible = false;
    scene.add(g);
    return g;
  });

  // Campana extractora de acero
  buildBox(2.1, 0.5, 0.6, STOVE_CX, 2.75, BACK_WALL_Z + 0.35, steelMat);
  const hoodPipe = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.14, 0.35, 12), steelMat);
  hoodPipe.position.set(STOVE_CX, 3.05, BACK_WALL_Z + 0.35);
  scene.add(hoodPipe);
  const hoodLight = new THREE.PointLight(0xffffff, 0.8, 4, 0);
  hoodLight.position.set(STOVE_CX, 2.4, BACK_WALL_Z + 0.5);
  scene.add(hoodLight);

  // Barra de utensilios colgantes bajo la campana (detalle de cocina real)
  [-0.6, -0.3, 0, 0.3, 0.6].forEach(off => {
    const rod = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.008, 0.18, 6), darkSteelMat);
    rod.position.set(STOVE_CX + off, 2.35, BACK_WALL_Z + 0.6);
    scene.add(rod);
  });
  const hangRail = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 1.6, 8), steelMat);
  hangRail.rotation.z = Math.PI / 2;
  hangRail.position.set(STOVE_CX, 2.44, BACK_WALL_Z + 0.6);
  scene.add(hangRail);

  // ---------- Tabla de picar (acento cálido de madera sobre acero) ----------
  const boardMesh = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.03, 0.36), woodMat);
  boardMesh.position.set(ZONE.board.pos.x, COUNTER_TOP_Y + 0.016, ZONE.board.pos.z);
  scene.add(boardMesh);

  // ---------- Fregadero de acero inoxidable con grifo (nuevo) ----------
  (function buildSink() {
    const basin = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.16, 0.42), darkSteelMat);
    basin.position.set(ZONE.sink.pos.x, COUNTER_TOP_Y - 0.05, ZONE.sink.pos.z);
    scene.add(basin);
    const basinInner = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.1, 0.34), new THREE.MeshStandardMaterial({ color: 0x2a2e33, roughness: 0.3, metalness: 0.7 }));
    basinInner.position.set(ZONE.sink.pos.x, COUNTER_TOP_Y + 0.01, ZONE.sink.pos.z);
    scene.add(basinInner);
    const faucetBase = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, 0.26, 10), steelMat);
    faucetBase.position.set(ZONE.sink.pos.x, COUNTER_TOP_Y + 0.15, ZONE.sink.pos.z - 0.16);
    scene.add(faucetBase);
    const faucetArc = new THREE.Mesh(new THREE.TorusGeometry(0.09, 0.014, 8, 16, Math.PI), steelMat);
    faucetArc.rotation.z = Math.PI / 2;
    faucetArc.position.set(ZONE.sink.pos.x, COUNTER_TOP_Y + 0.27, ZONE.sink.pos.z - 0.07);
    scene.add(faucetArc);
  })();

  // Marca del mostrador de armado (anillo pintado, guía visual base)
  const assemblyMark = new THREE.Mesh(new THREE.RingGeometry(0.28, 0.32, 32), new THREE.MeshBasicMaterial({ color: 0x9fd8c9, side: THREE.DoubleSide }));
  assemblyMark.rotation.x = -Math.PI / 2;
  assemblyMark.position.set(ZONE.assembly.pos.x, COUNTER_TOP_Y + 0.012, ZONE.assembly.pos.z);
  scene.add(assemblyMark);

  // ---------- Licuadora (nueva, decorativa/interactiva simple) ----------
  const blenderBladeGroup = new THREE.Group();
  (function buildBlender() {
    const base = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.085, 0.09, 16), darkSteelMat);
    base.position.set(ZONE.blender.pos.x, COUNTER_TOP_Y + 0.045, ZONE.blender.pos.z);
    scene.add(base);
    const jar = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.05, 0.22, 16),
      new THREE.MeshPhysicalMaterial({ color: 0xbfe9ff, roughness: 0.15, transmission: 0.6, transparent: true, opacity: 0.55, metalness: 0 }));
    jar.position.set(ZONE.blender.pos.x, COUNTER_TOP_Y + 0.2, ZONE.blender.pos.z);
    scene.add(jar);
    const lid = new THREE.Mesh(new THREE.CylinderGeometry(0.062, 0.062, 0.025, 16), darkSteelMat);
    lid.position.set(ZONE.blender.pos.x, COUNTER_TOP_Y + 0.32, ZONE.blender.pos.z);
    scene.add(lid);
    blenderBladeGroup.add(new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.006, 0.014), steelMat));
    blenderBladeGroup.position.set(ZONE.blender.pos.x, COUNTER_TOP_Y + 0.1, ZONE.blender.pos.z);
    scene.add(blenderBladeGroup);
  })();

  // ---------- Nevera de color (teal), acento de restaurante moderno ----------
  const fridgeCX = -ROOM_HALF + 0.375, fridgeCZ = -4.15;
  const fridgeBodyMat = new THREE.MeshStandardMaterial({ color: 0x1f9d8a, roughness: 0.35, metalness: 0.4 });
  const fridgeBody = buildBox(0.75, 2.15, 1.5, fridgeCX, 1.075, fridgeCZ, fridgeBodyMat);
  const fridgeDoorGeo = new THREE.BoxGeometry(0.66, 2.0, 0.06);
  fridgeDoorGeo.translate(0, 0, 0.66 / 2);
  const fridgeDoorMat = new THREE.MeshStandardMaterial({ color: 0x2bbfa8, roughness: 0.25, metalness: 0.45 });
  const fridgeDoorMesh = new THREE.Mesh(fridgeDoorGeo, fridgeDoorMat);
  fridgeDoorMesh.position.set(fridgeCX + 0.375, 1.075, fridgeCZ - 0.75);
  scene.add(fridgeDoorMesh);
  const fridgeHandleMesh = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.4, 0.03), darkSteelMat);
  fridgeHandleMesh.position.set(0.06, 0, 0.58);
  fridgeDoorMesh.add(fridgeHandleMesh);
  // Panel LED táctil (detalle "de restaurante moderno")
  const fridgePanel = new THREE.Mesh(new THREE.PlaneGeometry(0.14, 0.09),
    new THREE.MeshBasicMaterial({ map: makeTextPanel('4°C', '', 200, 130, { size1: 42, bg: '#0e1114', border: '#7fd7c4', color1: '#7fd7c4' }), transparent: true }));
  fridgePanel.position.set(fridgeCX + 0.376, 1.55, fridgeCZ - 0.3);
  fridgePanel.rotation.y = Math.PI / 2;
  scene.add(fridgePanel);

  const fridgeBottles = [0xdc3545, 0x1e88e5].map((color, i) => {
    const bottle = new THREE.Group();
    const body = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.05, 0.22, 12),
      new THREE.MeshStandardMaterial({ color, roughness: 0.2, metalness: 0.1, transparent: true, opacity: 0.85 }));
    bottle.add(body);
    const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, 0.03, 8), new THREE.MeshStandardMaterial({ color: 0x333333 }));
    cap.position.y = 0.125;
    bottle.add(cap);
    bottle.position.set(fridgeCX + 0.15, 1.35 - i * 0.02, fridgeCZ - 0.4 + i * 0.5);
    bottle.visible = false;
    scene.add(bottle);
    return bottle;
  });

  // ---------- Despensa (pared izquierda) — alimentos siempre visibles ----------
  buildShelfUnitZ(-ROOM_HALF, -0.3, 3.0, 2.0, 0.48, [0.6, 1.2, 1.85], 1, shelfMat);
  const pantrySign = new THREE.Mesh(new THREE.PlaneGeometry(1.0, 0.32),
    new THREE.MeshBasicMaterial({ map: makeTextPanel('DESPENSA', '', 360, 120, { bg: '#20262b', border: '#7fd7c4' }), transparent: true }));
  pantrySign.position.set(-ROOM_HALF + 0.02, 2.3, 1.35);
  pantrySign.rotation.y = Math.PI / 2;
  scene.add(pantrySign);

  // ---------- Ventanilla de servicio (pared derecha) ----------
  buildBox(0.5, 0.9, 1.7, ROOM_HALF - 0.25, 0.45, 0.1, counterMat);
  const passOpening = new THREE.Mesh(new THREE.PlaneGeometry(1.5, 1.1),
    new THREE.MeshStandardMaterial({ color: 0xffe9c2, emissive: 0xffcf8a, emissiveIntensity: 0.5 }));
  passOpening.rotation.y = -Math.PI / 2;
  passOpening.position.set(ROOM_HALF - 0.02, 1.5, 0.1);
  scene.add(passOpening);
  const passSign = new THREE.Mesh(new THREE.PlaneGeometry(1.1, 0.4),
    new THREE.MeshBasicMaterial({ map: makeTextPanel('PASE', 'entrega aquí', 512, 192, { bg: '#20262b', border: '#7fd7c4' }), transparent: true }));
  passSign.rotation.y = -Math.PI / 2;
  passSign.position.set(ROOM_HALF - 0.03, 2.1, 0.1);
  scene.add(passSign);

  // ---------- Puerta doble de entrada (decorativa, pared derecha) ----------
  const doorLGeo = new THREE.BoxGeometry(0.5, 1.9, 0.05); doorLGeo.translate(0, 0, -0.25);
  const doorRGeo = new THREE.BoxGeometry(0.5, 1.9, 0.05); doorRGeo.translate(0, 0, 0.25);
  const doorMat = new THREE.MeshStandardMaterial({ color: 0xe0623f, roughness: 0.5, metalness: 0.2 });
  const entranceDoorL = new THREE.Mesh(doorLGeo, doorMat);
  const entranceDoorR = new THREE.Mesh(doorRGeo, doorMat);
  entranceDoorL.position.set(ROOM_HALF - 0.03, 1.05, -4.15);
  entranceDoorR.position.set(ROOM_HALF - 0.03, 1.05, -4.15);
  scene.add(entranceDoorL, entranceDoorR);

  // ---------- Estante de utensilios (pared derecha) ----------
  buildShelfUnitZ(ROOM_HALF, 1.5, 4.1, 2.0, 0.48, [0.6, 1.35], -1, shelfMat);
  const utensilSign = new THREE.Mesh(new THREE.PlaneGeometry(1.0, 0.32),
    new THREE.MeshBasicMaterial({ map: makeTextPanel('UTENSILIOS', '', 360, 120, { bg: '#20262b', border: '#7fd7c4' }), transparent: true }));
  utensilSign.position.set(ROOM_HALF - 0.02, 2.3, 2.8);
  utensilSign.rotation.y = -Math.PI / 2;
  scene.add(utensilSign);

  // ---------- Extintor de pared (equipamiento estándar) ----------
  (function buildExtinguisher() {
    const bracket = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.35, 0.14), darkSteelMat);
    bracket.position.set(ROOM_HALF - 0.02, 1.1, -1.6);
    scene.add(bracket);
    const body = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.06, 0.32, 12), new THREE.MeshStandardMaterial({ color: 0xd7261f, roughness: 0.4, metalness: 0.3 }));
    body.position.set(ROOM_HALF - 0.09, 1.12, -1.6);
    scene.add(body);
  })();

  // ---------- Caneca de basura ----------
  (function buildTrashCan() {
    const group = new THREE.Group();
    const body = new THREE.Mesh(new THREE.CylinderGeometry(0.26, 0.22, 0.55, 20), darkSteelMat);
    body.position.y = 0.275;
    group.add(body);
    const rim = new THREE.Mesh(new THREE.TorusGeometry(0.27, 0.02, 8, 20), steelMat);
    rim.rotation.x = Math.PI / 2;
    rim.position.y = 0.55;
    group.add(rim);
    group.position.set(ZONE.trash.pos.x, 0, ZONE.trash.pos.z);
    scene.add(group);
  })();

  // ---------- Rincón de café: mesa redonda + 2 sillas (decorativo) ----------
  (function buildLounge() {
    const legMat = darkSteelMat;
    const table = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.35, 0.03, 24), woodMat);
    table.position.set(4.2, 0.72, 4.6);
    scene.add(table);
    const tableLeg = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.7, 10), legMat);
    tableLeg.position.set(4.2, 0.37, 4.6);
    scene.add(tableLeg);
    [[-0.55, -0.1], [0.55, 0.15]].forEach(([dx, dz]) => {
      const seat = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.16, 0.04, 16), new THREE.MeshStandardMaterial({ color: 0xe0623f, roughness: 0.6 }));
      seat.position.set(4.2 + dx, 0.46, 4.6 + dz);
      scene.add(seat);
      const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.46, 8), legMat);
      leg.position.set(4.2 + dx, 0.23, 4.6 + dz);
      scene.add(leg);
    });
  })();

  return {
    scene, camera, renderer,
    ZONE, colliders, resolvePlayerXZ,
    ROOM_HALF, WALL_H, BACK_WALL_Z, COUNTER_DEPTH, COUNTER_TOP_Y, PLAYER_EYE, PLAYER_RADIUS, STOVE_CX,
    stoveButtonMat, stoveButtonMesh, flames, blenderBladeGroup,
    fridgeDoorMesh, fridgeBottles, entranceDoorL, entranceDoorR,
    materials: { counterMat, steelMat, darkSteelMat, whiteMat, woodMat },
    utils: { clamp, lerp, rand, makeTexture, makeTextPanel }
  };
})();

window.World = World;
