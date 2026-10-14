/* ============================================================
   CARTOON.JS — Efecto "cartoon" (posterizado + contornos), por vista
   ============================================================
   Efecto opcional (apagado por defecto: cuesta rendimiento) pensado desde el
   principio para funcionar CON la vista dividida del Modo Cartón.

   POR QUÉ UN EFECTO DE PANTALLA COMPLETA FALLA EN ESTÉREO (y cómo se evita):
     Un post-proceso típico (EffectComposer) dibuja la escena en un render
     target del tamaño del CANVAS ENTERO y luego pasa un shader por toda la
     pantalla. Con la pantalla dividida eso se rompe de tres maneras:
       1) los dos ojos comparten un solo cuadro y el efecto se calcula sobre la
          unión (los bordes de un ojo "sangran" al otro en la franja central);
       2) los shaders que normalizan con `gl_FragCoord.xy / resolution` usan la
          resolución de la PANTALLA completa, pero cada ojo es solo una mitad:
          la imagen sale estirada o desplazada;
       3) el tamaño del texel (1/ancho) del filtro de contornos no coincide con
          el render target real y los bordes salen mal.
     Aquí el efecto se aplica POR OJO, en este orden:
       a) se dibuja el ojo en un render target del tamaño EXACTO de ese ojo
          (ancho de mitad × alto, en píxeles reales);
       b) se pasa el shader leyendo SOLO ese render target (coordenadas `vUv`
          locales 0..1, nunca `gl_FragCoord`) y con el texel de ESE target;
       c) el resultado se copia a la pantalla con viewport y scissor limitados
          al rectángulo del ojo (así no puede invadir la otra mitad).
     En vista normal es lo mismo con un solo rectángulo del tamaño de la pantalla.

   El render target no pasa por el tono/ColorSpace de salida de three.js (solo
   lo hace el framebuffer de pantalla), así que el shader final aplica tone
   mapping y conversión sRGB con los mismos "chunks" de three.js: los colores
   se ven igual que sin efecto.
   ============================================================ */

const Cartoon = (() => {
  const { renderer, IS_MOBILE } = World;
  const KEY = 'rvr_cartoon';
  function storageGet() { try { return localStorage.getItem(KEY); } catch (_) { return null; } }

  let enabled = storageGet() === '1' || /[?&]cartoon\b/.test(location.search);
  let rt = null;

  const vertexShader = `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = vec4(position.xy, 0.0, 1.0);   // cuadrado que cubre TODO el rectángulo del ojo
    }`;

  const fragmentShader = `
    uniform sampler2D tDiffuse;
    uniform vec2 texel;          // 1 / tamaño del render target DE ESTE OJO (no de la pantalla)
    uniform float levels;        // niveles de luminosidad del posterizado
    uniform float edgeStrength;  // 0 = sin contornos
    varying vec2 vUv;

    float lum(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }

    void main() {
      vec3 c = texture2D(tDiffuse, vUv).rgb;

      // Contornos: Sobel sobre la luminosidad (8 lecturas)
      float tl = lum(texture2D(tDiffuse, vUv + texel * vec2(-1.0,  1.0)).rgb);
      float tc = lum(texture2D(tDiffuse, vUv + texel * vec2( 0.0,  1.0)).rgb);
      float tr = lum(texture2D(tDiffuse, vUv + texel * vec2( 1.0,  1.0)).rgb);
      float ml = lum(texture2D(tDiffuse, vUv + texel * vec2(-1.0,  0.0)).rgb);
      float mr = lum(texture2D(tDiffuse, vUv + texel * vec2( 1.0,  0.0)).rgb);
      float bl = lum(texture2D(tDiffuse, vUv + texel * vec2(-1.0, -1.0)).rgb);
      float bc = lum(texture2D(tDiffuse, vUv + texel * vec2( 0.0, -1.0)).rgb);
      float br = lum(texture2D(tDiffuse, vUv + texel * vec2( 1.0, -1.0)).rgb);
      float gx = (tr + 2.0 * mr + br) - (tl + 2.0 * ml + bl);
      float gy = (tl + 2.0 * tc + tr) - (bl + 2.0 * bc + br);
      float edge = smoothstep(0.14, 0.42, length(vec2(gx, gy)));

      // Posterizado: se cuantiza la luminosidad y se reescala el color a ese nivel
      float l = lum(c);
      float lq = floor(l * levels + 0.5) / levels;
      vec3 toon = mix(c, c * (lq / max(l, 0.001)), 0.8);

      gl_FragColor = vec4(mix(toon, vec3(0.015, 0.02, 0.03), edge * edgeStrength), 1.0);

      #include <tonemapping_fragment>
      #include <colorspace_fragment>
    }`;

  const material = new THREE.ShaderMaterial({
    uniforms: {
      tDiffuse: { value: null },
      texel: { value: new THREE.Vector2(1, 1) },
      levels: { value: 5.0 },
      edgeStrength: { value: 0.8 }
    },
    vertexShader, fragmentShader,
    depthTest: false, depthWrite: false
  });
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
  quad.frustumCulled = false;
  const quadScene = new THREE.Scene();
  quadScene.add(quad);
  const quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  function ensureTarget(pxW, pxH) {
    if (!rt) {
      rt = new THREE.WebGLRenderTarget(pxW, pxH, {
        minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
        depthBuffer: true, samples: IS_MOBILE ? 0 : 4   // el render target no hereda el antialias del canvas
      });
    } else if (rt.width !== pxW || rt.height !== pxH) {
      rt.setSize(pxW, pxH);
    }
  }

  // Dibuja `scene` con `camera` DENTRO del rectángulo `rect` (píxeles CSS enteros,
  // origen abajo-izquierda) pasando el efecto. `plainRender` es el render original
  // de three.js (sin los parches de cardboard.js).
  function renderView(plainRender, scene, camera, rect) {
    const pr = renderer.getPixelRatio();
    const pxW = Math.max(1, Math.round(rect.w * pr)), pxH = Math.max(1, Math.round(rect.h * pr));
    ensureTarget(pxW, pxH);

    // a) el ojo, en un render target del tamaño exacto de ese ojo
    renderer.setRenderTarget(rt);
    renderer.setScissorTest(false);
    plainRender(scene, camera);

    // b) + c) shader sobre ese target, volcado SOLO al rectángulo del ojo
    renderer.setRenderTarget(null);
    renderer.setViewport(rect.x, rect.y, rect.w, rect.h);
    renderer.setScissor(rect.x, rect.y, rect.w, rect.h);
    renderer.setScissorTest(true);
    material.uniforms.tDiffuse.value = rt.texture;
    material.uniforms.texel.value.set(1 / pxW, 1 / pxH);
    plainRender(quadScene, quadCam);
  }

  function setEnabled(on) {
    enabled = !!on;
    try { localStorage.setItem(KEY, enabled ? '1' : '0'); } catch (_) { /* modo privado */ }
    return enabled;
  }

  return {
    renderView, setEnabled,
    get enabled() { return enabled; },
    get target() { return rt; }
  };
})();

window.Cartoon = Cartoon;
