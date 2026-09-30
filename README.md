# Restaurante VR — Cocina con control por manos y Modo Cartón

Juego de cocina en primera persona, controlado con las manos frente a la
cámara del celular (MediaPipe Hands), con soporte para gafas de
realidad virtual tipo cartón (Modo Cartón: mirar moviendo la cabeza,
usando el giroscopio del teléfono, más una vista estéreo).

## 🔗 Jugarlo

**https://saritaa26.github.io/Virtual-Cheef/**
*(activa GitHub Pages en Settings → Pages para que este link funcione — ver más abajo)*

Ábrelo directamente en el navegador del celular (Chrome recomendado en
Android). No requiere instalar nada.

## 📱 Cómo probarlo en el celular

1. Abre el link de arriba en Chrome.
2. Toca **"▶ Entrar a la cocina"** y acepta el permiso de **cámara**
   (usa la cámara trasera para detectar tus manos).
3. Junta pulgar e índice (pinza) para agarrar sartenes, ingredientes,
   utensilios y platos; sigue las instrucciones en pantalla.
4. Para el **Modo Cartón**: toca **"🥽 Modo Cartón"**, acepta el
   permiso de movimiento/orientación si te lo pide, y coloca el
   celular dentro de tus gafas de cartón/plástico. La vista se divide
   en dos mitades (una por ojo) y gira siguiendo el movimiento real de
   tu cabeza.

**Importante:** la cámara y el giroscopio solo funcionan sobre HTTPS
(por eso se publica en GitHub Pages) — abrir el archivo directo
(`file://`) no va a pedir esos permisos correctamente.

## 📂 Qué hay en este repositorio

- **`index.html`** — el juego completo en un solo archivo (HTML + CSS
  + JS en línea), listo para publicar o guardar y abrir directamente.
  Es el mismo contenido que `restaurante_vr_unificado.html`.
- **`Restaurante - Paula y Sarita.html`** + `tracking.js`, `world.js`,
  `items.js`, `game.js`, `guide.js`, `cardboard.js`, `styles.css` — la
  versión de trabajo en archivos separados (más cómoda para seguir
  desarrollando/editando módulo por módulo).
- **`historial/`** — snapshots de versiones anteriores del proyecto
  (v1: cámara trasera + estética visual; v2: + Modo Cartón; v3: la
  base de la versión actual), cada una con su propio conjunto de
  archivos funcional.
- **`MedVR_V1-Modelos3D_corregido.html`** — referencia visual (paleta
  de color y tipografía) usada como inspiración de estética.

## 🛠️ Stack técnico

- **Three.js** — escena 3D de la cocina.
- **MediaPipe Hands** — detección de manos vía la cámara trasera del
  celular (gestos de pinza, picar, girar la perilla de la estufa).
- **DeviceOrientationEvent** (giroscopio) — mirar alrededor con la
  cabeza en Modo Cartón. *Nota: esto NO usa la API real de WebXR
  (`navigator.xr`); usa el mismo enfoque de "ventana mágica" que la
  mayoría de apps de cartón, porque el hand-tracking de WebXR real
  solo funciona en visores dedicados (Quest), no con la cámara
  trasera de un celular común.*
