/* ============================================================
   HANDMODEL.JS — Mano 3D orgánica que sigue los 21 puntos detectados
   ============================================================
   Reemplaza el avatar anterior (cilindros rígidos de 8 lados + una esfera
   para la palma, que se veía como un muñeco de madera) por una mano con
   forma real, construida cada cuadro sobre los landmarks de MediaPipe:

     · DEDOS: tubos de radio variable que recorren una curva suave
       (Catmull-Rom) por las 4 articulaciones de cada dedo. El radio se
       afina hacia la punta, se hincha un poco en cada nudillo/articulación
       y termina en una yema redondeada. La sección es ligeramente aplanada
       (los dedos reales no son cilindros) y su orientación se transporta a
       lo largo del dedo, así que la uña siempre queda del lado del dorso
       aunque el dedo se doble. Uñas y pliegues van pintados por color de
       vértice (sin texturas, sin draw calls extra).
     · PALMA: una superficie de Coons que une la muñeca con la fila de
       nudillos y con las bases del pulgar/meñique, extruida con grosor
       (dorso más plano, palma con relieve en la eminencia del pulgar y del
       meñique). Se prolonga un poco más allá de los nudillos para formar
       la piel entre dedos.
     · ANTEBRAZO: un tubo corto hacia atrás con una pulsera de color (azul =
       izquierda, naranja = derecha) para distinguir las manos de un vistazo.

   AJUSTADA AL CONTORNO REAL: todos los radios son FRACCIONES del tamaño de
   la mano medido en el espacio 3D (ancho de palma), no valores fijos. Una
   mano más grande/cercana se ve proporcionalmente más gruesa, y las
   posiciones de cada articulación son exactamente las detectadas.

   RENDIMIENTO: cada mano es UNA sola malla (≈1 000 vértices, un solo draw
   call) cuyo buffer se reescribe cada cuadro; no se crean objetos nuevos
   durante el juego (cero basura para el recolector).

   Entrada de `update`: arreglo de 21 THREE.Vector3 en coordenadas de MUNDO.
   ============================================================ */

const HandModel = (() => {

  const R = 10;               // lados por anillo de dedo
  const BODY = 12;            // anillos a lo largo del cuerpo del dedo
  const CAP = 3;              // anillos de la yema (media esfera)
  const RINGS = BODY + CAP;
  const FR = 12;              // lados por anillo del antebrazo
  const FOREARM_RINGS = 6;
  const PU = 8, PV = 7;       // rejilla de la palma (columnas, filas)

  // Cadena de landmarks de cada dedo + radio relativo (fracción del ancho de
  // palma) en la base y en la punta. Proporciones reales aproximadas:
  // palma ≈ 85 mm, dedo índice ≈ 18 mm de diámetro, pulgar ≈ 24 mm.
  const FINGERS = [
    { idx: [1, 2, 3, 4],     r0: 0.150, r1: 0.100 },   // pulgar
    { idx: [5, 6, 7, 8],     r0: 0.112, r1: 0.084 },   // índice
    { idx: [9, 10, 11, 12],  r0: 0.116, r1: 0.086 },   // medio
    { idx: [13, 14, 15, 16], r0: 0.106, r1: 0.080 },   // anular
    { idx: [17, 18, 19, 20], r0: 0.092, r1: 0.070 }    // meñique
  ];
  const AY = 0.9;             // aplanado de la sección del dedo (espesor/ancho)

  const FINGER_VERTS = RINGS * R;
  const PALM_VERTS = (PU + 1) * (PV + 1);
  const FOREARM_VERTS = FOREARM_RINGS * FR;
  const BASE_TOP = 5 * FINGER_VERTS;
  const BASE_BOTTOM = BASE_TOP + PALM_VERTS;
  const BASE_FOREARM = BASE_BOTTOM + PALM_VERTS;
  const TOTAL_VERTS = BASE_FOREARM + FOREARM_VERTS;

  const COS = new Float32Array(R), SIN = new Float32Array(R);
  const COS_F = new Float32Array(FR), SIN_F = new Float32Array(FR);
  for (let j = 0; j < R; j++) { COS[j] = Math.cos(2 * Math.PI * j / R); SIN[j] = Math.sin(2 * Math.PI * j / R); }
  for (let j = 0; j < FR; j++) { COS_F[j] = Math.cos(2 * Math.PI * j / FR); SIN_F[j] = Math.sin(2 * Math.PI * j / FR); }

  const SKIN = new THREE.Color(0xdca077);
  const SKIN_PINK = new THREE.Color(0xd4837a);
  const NAIL = new THREE.Color(0xf4ded4);
  const PINCH_GLOW = new THREE.Color(0xff8a3c);
  const SKIN_GLOW = new THREE.Color(0x2b0f08);

  function gauss(x, c, w) { const d = (x - c) / w; return Math.exp(-d * d); }
  function smoothstep(a, b, x) { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); }

  // ---------- topología estática (índices) ----------
  function buildIndices() {
    const idx = [];
    const tube = (base, rings, radial) => {
      for (let i = 0; i < rings - 1; i++) {
        for (let j = 0; j < radial; j++) {
          const a = base + i * radial + j;
          const b = base + i * radial + (j + 1) % radial;
          const c = base + (i + 1) * radial + j;
          const d = base + (i + 1) * radial + (j + 1) % radial;
          idx.push(a, b, c, b, d, c);
        }
      }
    };
    for (let f = 0; f < 5; f++) tube(f * FINGER_VERTS, RINGS, R);
    const grid = (base, flip) => {
      for (let v = 0; v < PV; v++) {
        for (let u = 0; u < PU; u++) {
          const a = base + v * (PU + 1) + u, b = a + 1, c = a + (PU + 1), d = c + 1;
          if (flip) idx.push(a, c, b, b, c, d); else idx.push(a, b, c, b, d, c);
        }
      }
    };
    grid(BASE_TOP, false);
    grid(BASE_BOTTOM, true);
    tube(BASE_FOREARM, FOREARM_RINGS, FR);
    return idx;
  }

  // ---------- color por vértice (piel, pliegues, uñas, yemas, pulsera) ----------
  // nailBump: cuánto se "levanta" cada vértice de uña para dar relieve.
  function buildColors(accentHex) {
    const col = new Float32Array(TOTAL_VERTS * 3);
    const nailBump = new Float32Array(5 * FINGER_VERTS);
    const accent = new THREE.Color(accentHex);
    const tmp = new THREE.Color();
    const put = (vi, c, k) => { col[vi * 3] = c.r * k; col[vi * 3 + 1] = c.g * k; col[vi * 3 + 2] = c.b * k; };

    for (let f = 0; f < 5; f++) {
      for (let i = 0; i < RINGS; i++) {
        const tt = i < BODY ? i / (BODY - 1) : 1 + (i - BODY + 1) / CAP * 0.1;
        for (let j = 0; j < R; j++) {
          const vi = f * FINGER_VERTS + i * R + j;
          let k = 1 - 0.06 * gauss(tt, 0.57, 0.05) - 0.05 * gauss(tt, 0.81, 0.04); // pliegues de las articulaciones
          tmp.copy(SKIN).lerp(SKIN_PINK, smoothstep(0.80, 1.05, tt) * 0.55);       // yema más rosada
          const nailW = smoothstep(0.80, 0.86, tt) * smoothstep(0.50, 0.72, SIN[j]) * (1 - smoothstep(1.06, 1.09, tt));
          if (nailW > 0) { tmp.lerp(NAIL, nailW); nailBump[f * FINGER_VERTS + i * R + j] = 0.045 * nailW; }
          put(vi, tmp, k);
        }
      }
    }
    for (let v = 0; v <= PV; v++) {
      for (let u = 0; u <= PU; u++) {
        put(BASE_TOP + v * (PU + 1) + u, SKIN, 1);
        tmp.copy(SKIN).lerp(SKIN_PINK, 0.14);
        put(BASE_BOTTOM + v * (PU + 1) + u, tmp, 1.02);
      }
    }
    for (let k = 0; k < FOREARM_RINGS; k++) {
      for (let j = 0; j < FR; j++) put(BASE_FOREARM + k * FR + j, (k === 1 || k === 2) ? accent : SKIN, 1);
    }
    return { col, nailBump };
  }

  // ---------- utilidades de curvas (sin asignar memoria) ----------
  function crSeg(c, seg, u, out) {
    const p0 = c[Math.max(seg - 1, 0)], p1 = c[seg], p2 = c[seg + 1], p3 = c[Math.min(seg + 2, c.length - 1)];
    const u2 = u * u, u3 = u2 * u;
    out.x = 0.5 * (2 * p1.x + (-p0.x + p2.x) * u + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * u2 + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * u3);
    out.y = 0.5 * (2 * p1.y + (-p0.y + p2.y) * u + (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * u2 + (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * u3);
    out.z = 0.5 * (2 * p1.z + (-p0.z + p2.z) * u + (2 * p0.z - 5 * p1.z + 4 * p2.z - p3.z) * u2 + (-p0.z + 3 * p1.z - 3 * p2.z + p3.z) * u3);
    return out;
  }
  function bez2(a, c, b, t, out) {
    const m = 1 - t, wa = m * m, wc = 2 * m * t, wb = t * t;
    out.x = a.x * wa + c.x * wc + b.x * wb;
    out.y = a.y * wa + c.y * wc + b.y * wb;
    out.z = a.z * wa + c.z * wc + b.z * wb;
    return out;
  }

  const V = () => new THREE.Vector3();
  // memoria de trabajo compartida (una sola mano se actualiza a la vez)
  const _r = V(), _f = V(), _n = V(), _nBack = V(), _prevNBack = new THREE.Vector3(0, 1, 0);
  const _d = V(), _t = V();
  const ctrl = [V(), V(), V(), V(), V()];
  const cum = new Float32Array(5);
  const pts = Array.from({ length: BODY }, V);
  const tans = Array.from({ length: BODY }, V);
  const _U = V(), _Sd = V(), _Uprev = V();
  const _Wt = V(), _Wp = V(), _Cl = V(), _Mp = V(), _Pp = V();
  const KN = [V(), V(), V(), V()];
  const _B = V(), _T = V(), _L = V(), _Rr = V(), _S2 = V();

  function create(handKey, accentHex) {
    const isRight = handKey === 'right';
    const geometry = new THREE.BufferGeometry();
    const positions = new Float32Array(TOTAL_VERTS * 3);
    const { col, nailBump } = buildColors(accentHex);
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3).setUsage(THREE.DynamicDrawUsage));
    geometry.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(TOTAL_VERTS * 3), 3).setUsage(THREE.DynamicDrawUsage));
    geometry.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geometry.setIndex(buildIndices());

    // DoubleSide: si MediaPipe se equivoca de mano un instante (izq/der), el
    // dorso y la palma se intercambian; con ambas caras la mano no "se vacía".
    const material = new THREE.MeshStandardMaterial({
      vertexColors: true, roughness: 0.62, metalness: 0, side: THREE.DoubleSide,
      emissive: SKIN_GLOW.clone(), emissiveIntensity: 1
    });
    // La cocina está muy iluminada (luz ambiente + hemisférica altas) y casi no
    // hay sombras que den volumen: la mano se veía "lavada". Se oscurece
    // suavemente hacia el borde de la silueta (efecto fresnel inverso), lo que
    // redondea dedos y palma sin añadir luces ni texturas.
    material.onBeforeCompile = (shader) => {
      shader.fragmentShader = shader.fragmentShader.replace('#include <opaque_fragment>',
        `float rimFacing = clamp(dot(normal, normalize(vViewPosition)), 0.0, 1.0);
         outgoingLight *= mix(0.52, 1.0, smoothstep(0.0, 0.62, rimFacing));
         #include <opaque_fragment>`);
    };
    const mesh = new THREE.Mesh(geometry, material);
    mesh.frustumCulled = false; // el buffer cambia cada cuadro: la esfera envolvente inicial no sirve

    // Marcador del punto de pinza (entre yema del pulgar e índice): muestra
    // exactamente dónde se "agarra" y confirma el contacto.
    const markerMat = new THREE.MeshBasicMaterial({ color: accentHex, transparent: true, opacity: 0, depthWrite: false });
    const marker = new THREE.Mesh(new THREE.SphereGeometry(1, 12, 8), markerMat);

    const root = new THREE.Group();
    root.add(mesh, marker);
    root.visible = false;

    let size = 0;                          // ancho de palma suavizado
    const pos = geometry.attributes.position;
    const nor = geometry.attributes.normal;

    function update(P, pinchAmt, pinching) {
      // ---- tamaño de la mano (robusto a verla de canto) ----
      const s = Math.max(P[5].distanceTo(P[17]), 0.9 * P[0].distanceTo(P[9]), 1e-4);
      size = size ? size + (s - size) * 0.35 : s;
      const W = size;

      // ---- base de la mano ----
      _r.copy(P[5]).sub(P[17]).normalize();           // meñique → índice
      _f.copy(P[9]).sub(P[0]).normalize();            // muñeca → nudillo medio
      _n.crossVectors(_r, _f);
      if (_n.lengthSq() > 1e-6) {
        _n.normalize();
        // Con la mano derecha esa normal apunta a la PALMA; con la izquierda, al DORSO.
        _nBack.copy(_n).multiplyScalar(isRight ? -1 : 1);
        _prevNBack.copy(_nBack);
      } else {
        _nBack.copy(_prevNBack);
      }

      // ---- dedos ----
      const arr = positions;
      for (let fi = 0; fi < 5; fi++) {
        const ch = FINGERS[fi].idx;
        const C0 = P[ch[0]], C1 = P[ch[1]], C2 = P[ch[2]], C3 = P[ch[3]];
        _d.copy(C1).sub(C0);
        ctrl[0].copy(C0).addScaledVector(_d, -0.5);   // arranca adentro de la palma
        ctrl[1].copy(C0); ctrl[2].copy(C1); ctrl[3].copy(C2); ctrl[4].copy(C3);
        cum[0] = 0;
        for (let k = 1; k < 5; k++) cum[k] = cum[k - 1] + ctrl[k].distanceTo(ctrl[k - 1]);
        const total = Math.max(cum[4], 1e-5);
        const rEnd = FINGERS[fi].r1 * W;
        const bodyLen = Math.max(total - 0.6 * rEnd, total * 0.5);   // la yema redondeada se suma al final
        const j1 = cum[1] / total, j2 = cum[2] / total, j3 = cum[3] / total;

        for (let i = 0; i < BODY; i++) {
          const sLen = (i / (BODY - 1)) * bodyLen;
          let seg = 0;
          while (seg < 3 && sLen > cum[seg + 1]) seg++;
          const u = (sLen - cum[seg]) / Math.max(cum[seg + 1] - cum[seg], 1e-6);
          crSeg(ctrl, seg, Math.min(1, Math.max(0, u)), pts[i]);
        }
        for (let i = 0; i < BODY; i++) {
          if (i === 0) tans[i].copy(pts[1]).sub(pts[0]);
          else if (i === BODY - 1) tans[i].copy(pts[i]).sub(pts[i - 1]);
          else tans[i].copy(pts[i + 1]).sub(pts[i - 1]);
          tans[i].normalize();
        }

        const base = fi * FINGER_VERTS;
        // marco de la sección, transportado por el dedo (sin torsión)
        _U.copy(_nBack).addScaledVector(tans[0], -_nBack.dot(tans[0]));
        if (_U.lengthSq() < 1e-6) _U.copy(_r);
        _U.normalize();

        let rrLast = 0;
        for (let i = 0; i < BODY; i++) {
          if (i > 0) { _U.addScaledVector(tans[i], -_U.dot(tans[i])); if (_U.lengthSq() < 1e-8) _U.copy(_Uprev); _U.normalize(); }
          _Uprev.copy(_U);
          _Sd.crossVectors(_U, tans[i]);
          const sf = (i / (BODY - 1)) * bodyLen / total;
          const taper = FINGERS[fi].r0 + (FINGERS[fi].r1 - FINGERS[fi].r0) * sf;
          const bulge = 1 + 0.05 * gauss(sf, j1, 0.05) + 0.09 * gauss(sf, j2, 0.055) + 0.06 * gauss(sf, j3, 0.05);
          const rr = taper * W * bulge;
          rrLast = rr;
          const c = pts[i];
          for (let j = 0; j < R; j++) {
            const vi = base + i * R + j;
            const nb = 1 + nailBump[i * R + j + base];
            const cj = COS[j] * rr * nb, sj = SIN[j] * rr * AY * nb;
            arr[vi * 3] = c.x + _Sd.x * cj + _U.x * sj;
            arr[vi * 3 + 1] = c.y + _Sd.y * cj + _U.y * sj;
            arr[vi * 3 + 2] = c.z + _Sd.z * cj + _U.z * sj;
          }
        }
        // yema redondeada
        const tipC = pts[BODY - 1], tipT = tans[BODY - 1];
        for (let k = 1; k <= CAP; k++) {
          const phi = (k / CAP) * Math.PI * 0.5;
          const cs = Math.cos(phi), sn = Math.sin(phi);
          const cx = tipC.x + tipT.x * rrLast * sn * 0.95, cy = tipC.y + tipT.y * rrLast * sn * 0.95, cz = tipC.z + tipT.z * rrLast * sn * 0.95;
          const i = BODY + k - 1;
          for (let j = 0; j < R; j++) {
            const vi = base + i * R + j;
            const nb = 1 + nailBump[i * R + j + base];
            const cj = COS[j] * rrLast * cs * nb, sj = SIN[j] * rrLast * AY * cs * nb;
            arr[vi * 3] = cx + _Sd.x * cj + _U.x * sj;
            arr[vi * 3 + 1] = cy + _Sd.y * cj + _U.y * sj;
            arr[vi * 3 + 2] = cz + _Sd.z * cj + _U.z * sj;
          }
        }
      }

      // ---- palma (parche de Coons con grosor) ----
      _Wt.copy(P[0]).addScaledVector(_r, 0.36 * W);        // lado del pulgar
      _Wp.copy(P[0]).addScaledVector(_r, -0.36 * W);       // lado del meñique
      const mcp = [5, 9, 13, 17], pip = [6, 10, 14, 18];
      for (let k = 0; k < 4; k++) {
        _d.copy(P[pip[k]]).sub(P[mcp[k]]).normalize();
        KN[k].copy(P[mcp[k]]).addScaledVector(_d, 0.16 * W); // prolonga más allá del nudillo: piel entre dedos
      }
      // Los bordes de la palma deben llegar al borde EXTERNO del índice y del meñique
      // (no a su centro), si no el dedo sobresale con un escalón.
      KN[0].addScaledVector(_r, 0.08 * W);
      KN[3].addScaledVector(_r, -0.07 * W);
      // control del borde del pulgar: la eminencia tira hacia la articulación del pulgar
      _Pp.copy(_Wt).add(KN[0]).multiplyScalar(0.5);
      _Cl.copy(P[2]).multiplyScalar(0.8).addScaledVector(_Pp, 0.2);
      _Mp.copy(_Wp).add(KN[3]).multiplyScalar(0.5).addScaledVector(_r, -0.04 * W);

      for (let vi = 0; vi <= PV; vi++) {
        const v = vi / PV;
        bez2(_Wt, _Cl, KN[0], v, _L);
        bez2(_Wp, _Mp, KN[3], v, _Rr);
        const fv = Math.pow(Math.sin(Math.PI * (0.09 + 0.91 * v)), 0.5);
        for (let ui = 0; ui <= PU; ui++) {
          const u = isRight ? ui / PU : 1 - ui / PU;
          _B.copy(_Wt).lerp(_Wp, u);
          const tU = u * 3, tSeg = Math.min(2, Math.floor(tU));
          crSeg(KN, tSeg, tU - tSeg, _T);
          // Coons: (1-v)B + vT + (1-u)L + uR − correcciones de esquinas
          _S2.set(0, 0, 0)
            .addScaledVector(_B, 1 - v).addScaledVector(_T, v)
            .addScaledVector(_L, 1 - u).addScaledVector(_Rr, u)
            .addScaledVector(_Wt, -(1 - u) * (1 - v)).addScaledVector(_Wp, -u * (1 - v))
            .addScaledVector(KN[0], -(1 - u) * v).addScaledVector(KN[3], -u * v);
          const fu = Math.pow(Math.sin(Math.PI * Math.min(1, Math.max(0, u))), 0.55);
          const f = fu * fv;
          const thenar = 0.07 * W * gauss(u, 0.10, 0.16) * gauss(v, 0.33, 0.2) * f;
          const hypo = 0.035 * W * gauss(u, 0.88, 0.15) * gauss(v, 0.40, 0.2) * f;
          const hTop = 0.12 * W * f;
          const hBot = 0.15 * W * f + thenar + hypo;
          const iT = (BASE_TOP + vi * (PU + 1) + ui) * 3, iB = (BASE_BOTTOM + vi * (PU + 1) + ui) * 3;
          arr[iT] = _S2.x + _nBack.x * hTop; arr[iT + 1] = _S2.y + _nBack.y * hTop; arr[iT + 2] = _S2.z + _nBack.z * hTop;
          arr[iB] = _S2.x - _nBack.x * hBot; arr[iB + 1] = _S2.y - _nBack.y * hBot; arr[iB + 2] = _S2.z - _nBack.z * hBot;
        }
      }

      // ---- antebrazo con pulsera ----
      _t.copy(_f).multiplyScalar(-1);                       // hacia el codo
      _U.copy(_nBack).addScaledVector(_t, -_nBack.dot(_t)).normalize();
      _Sd.crossVectors(_U, _t);
      for (let k = 0; k < FOREARM_RINGS; k++) {
        const kf = k / (FOREARM_RINGS - 1);
        const cx = P[0].x + _f.x * 0.04 * W + _t.x * kf * 0.95 * W;
        const cy = P[0].y + _f.y * 0.04 * W + _t.y * kf * 0.95 * W;
        const cz = P[0].z + _f.z * 0.04 * W + _t.z * kf * 0.95 * W;
        const band = (k === 1 || k === 2) ? 1.07 : 1;
        const ax = 0.36 * W * (1 + 0.16 * kf) * band, ay = 0.25 * W * (1 + 0.10 * kf) * band;
        for (let j = 0; j < FR; j++) {
          const vi = (BASE_FOREARM + k * FR + j) * 3;
          arr[vi] = cx + _Sd.x * COS_F[j] * ax + _U.x * SIN_F[j] * ay;
          arr[vi + 1] = cy + _Sd.y * COS_F[j] * ax + _U.y * SIN_F[j] * ay;
          arr[vi + 2] = cz + _Sd.z * COS_F[j] * ax + _U.z * SIN_F[j] * ay;
        }
      }

      pos.needsUpdate = true;
      geometry.computeVertexNormals();
      nor.needsUpdate = true;

      // ---- retroalimentación visual de la pinza ----
      const amt = Math.max(0, Math.min(1, pinchAmt));
      material.emissive.copy(SKIN_GLOW).lerp(PINCH_GLOW, pinching ? 0.55 : amt * amt * 0.25);
      marker.position.copy(P[4]).add(P[8]).multiplyScalar(0.5);
      marker.scale.setScalar(W * (pinching ? 0.13 : 0.10));
      markerMat.opacity = pinching ? 0.9 : Math.max(0, (amt - 0.25)) * 0.8;
    }

    function pinchPoint(out) { return out.copy(marker.position); }

    return { root, update, pinchPoint, get size() { return size; }, geometry, material };
  }

  return { create };
})();

window.HandModel = HandModel;
