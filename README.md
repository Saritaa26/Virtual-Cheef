# Restaurante VR — Cocina con control por manos y Modo Cartón

Juego de cocina en primera persona, controlado con las manos frente a la
cámara del celular (MediaPipe Hands). La vista sigue el movimiento real del
celular (giroscopio), caminas dando pasos de verdad (acelerómetro) y hay un
Modo Cartón para gafas de realidad virtual de cartón/plástico (vista estéreo).

## 🔗 Jugarlo

**https://saritaa26.github.io/Virtual-Cheef/**

Ábrelo directamente en el navegador del celular (Chrome recomendado en
Android). No requiere instalar nada.

## 📱 Cómo probarlo en el celular

1. Abre el link de arriba. **En celular la página pide sola el permiso de la
   cámara trasera** al abrirse — acéptalo. (En PC lo pide al pulsar «Entrar».)
2. Pulsa **«▶ Entrar a la cocina»**. Si negaste la cámara, la pantalla de inicio
   te dice cómo activarla y ofrece **«Reintentar cámara»** o **«Entrar sin
   cámara»**. En iPhone también aparece el permiso de «Movimiento y orientación».
3. **Mueve el celular** (izquierda, derecha, arriba, abajo, ladeándolo): la vista
   gira igual que tú. **Camina**: cada paso real te avanza hacia donde miras.
   Si el frente quedó torcido, toca **«↺ Recentrar»** (o la tecla **R**).
4. Junta pulgar e índice (**pinza**) para agarrar ingredientes, sartenes,
   utensilios y platos; sigue las instrucciones en pantalla. El punto amarillo
   entre las yemas es exactamente donde agarras.
5. **Modo Cartón**: toca **«🥽 Modo Cartón»** y pon el celular en las gafas. El panel
   de manos, el pedido y el tutorial se ven **pequeños en la esquina izquierda de cada
   ojo** (el centro queda libre). Si la vista gira al revés de tu cabeza, toca
   **«↔ Invertir giro de cabeza»** una vez (se recuerda). Si la cocina se ve **de
   cabeza**, el botón **«⟲ Voltear»** (arriba, en cada ojo) gira la imagen 180° sin
   tocar el giroscopio; viene activado por defecto y también se recuerda.

**Importante:** la cámara y los sensores de movimiento solo funcionan sobre
HTTPS (por eso se publica en GitHub Pages); abrir el archivo directo
(`file://`) no pide esos permisos.

## 🧭 Deriva del giroscopio (la vista se va girando sola)

El giro lateral del giroscopio acumula error con los minutos (unos grados por minuto según
el celular). Qué hace el juego:

- **Filtro complementario con la brújula** (`sensors.js`): usa la orientación relativa
  (suave) para lo inmediato y corrige el giro lateral hacia la brújula
  (`deviceorientationabsolute`) muy despacio (nunca más de 0.3°/s) y solo cuando la
  medición es confiable. Simulado: 3°/min de deriva pasa de 15° a 0.5° en 5 min; 12°/min
  de 60° a 4°. Una anomalía magnética grande (imán de las gafas) se ignora. Se apaga con
  el botón **«🧭 Brújula»** (y se recuerda) si en tu celular o tus gafas se comporta raro.
- **Recentrado al quedar quieto**: al entrar al Modo Cartón el frente definitivo se fija
  cuando el celular ya está quieto y a nivel dentro de las gafas, no al tocar el botón.
- **Recentrar a mano**: botón «↺ Centrar», tecla **R**, o **doble toque** en cualquier parte
  de la pantalla en Modo Cartón.
- Limitaciones honestas: una perturbación magnética **menor de 10°** sí se sigue
  lentamente; y sin brújula en el navegador (iPhone/Safari) solo quedan los recentrados.
  No se usa WebXR: no hay una API nativa de "alineación espacial" disponible para
  cartón en Chrome de Android y tomaría el control del render y de la cámara.

## 🥽 Vista dividida y efecto Cartoon

- Cada ojo se dibuja con **su propia cámara** y un rectángulo entero (`cardboard.js`); el
  tamaño del lienzo lo manda el CSS y se mide en tiempo real (`world.js`), no `innerWidth`.
- **No había ningún shader Cartoon** en el proyecto («Cartoon» era el Modo Cartón). Se añadió
  uno opcional (botón **«🎨 Cartoon»**, apagado por defecto, `cartoon.js`) que se procesa **por
  ojo**: cada ojo va a un render target de su tamaño exacto, el shader lee solo ese target
  (coordenadas locales, nunca `gl_FragCoord` de la pantalla entera) y el resultado se copia con
  viewport y scissor limitados al rectángulo del ojo. Cuesta rendimiento: úsalo solo si sobra.
- El vidrio de la licuadora usaba `transmission`, que obligaba a three.js a dibujar toda la escena
  otra vez (pantalla completa, MSAA ×4, aspecto equivocado en cada ojo) mientras estuviera a la vista;
  ahora es simplemente transparente.

## ⚡ Rendimiento (objetivo: 60 FPS en celular)

El panel de manos muestra `FPS xx · res yy%`. La calidad se ajusta sola:

- **Resolución adaptativa** (`perf.js`): si el celular no alcanza ~50 FPS, baja la
  resolución interna por escalones (100 → 80 → 65 → 55 → 50 %) y la frecuencia del
  modelo de manos (30 → 15 Hz); si sobra, vuelve a subirla (sin oscilar).
- **Menos llamadas de dibujo**: la geometría estática se funde por material
  (~190 → ~100 llamadas en la vista principal; en Modo Cartón se pagan dos veces).
- **Celular**: sin antialias por hardware en pantallas de alta densidad, 2 luces
  reales de techo en vez de 4, y factor de píxeles inicial 1.5.
- **Manos a 60 FPS aunque la IA entregue ~25**: los puntos se interpolan cada
  cuadro, y se filtran con One-Euro (sin temblor, sin retraso al moverse rápido).
  Dibujarlas en 2D cuesta ~0.2 ms por cuadro.
- El HUD solo toca el DOM cuando algo cambia; en Modo Cartón la copia por ojo se
  limita a 10 actualizaciones por segundo.

## 🖐️ Manos

`handoverlay.js` dibuja cada mano en **2D**, como un contorno fino claro con relleno
oscuro translúcido (el estilo del video de referencia), y un anillo de puntero entre
las yemas del pulgar y el índice que se cierra y se llena al agarrar. Solo usa x/y de
MediaPipe (la profundidad z es muy ruidosa y era lo que deformaba la mano) y se ve igual
en los dos ojos del visor (sin doble imagen).

- **Estabilidad:** filtro One-Euro por punto; cada mano conserva su identidad por
  continuidad de posición (MediaPipe cambia izquierda/derecha cuadro a cuadro y a veces
  entrega la misma mano dos veces: eso causaba el efecto «fantasma»); si una mano se
  pierde, deja de dibujarse a los 150 ms.
- **Tamaño:** `HandOverlay.CFG.size` (0.8) controla el tamaño del contorno respecto a
  la pantalla y `reach` (1.15) cuánto se desplaza la palma; se ajustan en `handoverlay.js`.
- **Agarre por rayo:** lo que ves bajo el puntero es lo que agarras, a cualquier
  distancia (el más cercano a la cámara gana). El objeto agarrado conserva su distancia
  y queda fijo a la vista al girar la cabeza.

## 📂 Qué hay en este repositorio

- **`index.html`** — el juego completo en un solo archivo (HTML + CSS
  + JS en línea), listo para publicar. Es el mismo contenido que
  `restaurante_vr_unificado.html`.
- **`Restaurante - Paula y Sarita.html`** + módulos, la versión de trabajo en
  archivos separados (se cargan en este orden):
  - `tracking.js` — permiso de cámara trasera (con errores claros), MediaPipe, identidad estable de las manos, gestos filtrados.
  - `world.js` — escena 3D de la cocina, zonas de interacción, fusión de mallas.
  - `perf.js` — calidad adaptativa.
  - `sensors.js` — giroscopio (mirar) y acelerómetro (caminar).
  - `handoverlay.js` — manos en 2D (contorno) y punteros en pantalla.
  - `cartoon.js` — efecto Cartoon opcional, procesado por ojo.
  - `items.js` — ingredientes, utensilios, platos, sartenes.
  - `game.js` — manos, interacción y bucle principal.
  - `guide.js` — pedidos, resaltado y tutorial paso a paso.
  - `cardboard.js` — Modo Cartón: render estéreo + HUD en cada ojo.
  - `styles.css`
- **`historial/`** — snapshots de versiones anteriores del proyecto.
- **`MedVR_V1-Modelos3D_corregido.html`** — referencia visual (paleta y tipografía).

## 🛠️ Stack técnico

- **Three.js** — escena 3D de la cocina.
- **MediaPipe Hands** — detección de manos vía la cámara trasera del celular.
- **DeviceOrientation / DeviceMotion** — mirar y caminar. *Nota: esto NO usa la API
  real de WebXR (`navigator.xr`); usa el enfoque de «ventana mágica» de la mayoría
  de apps de cartón, porque el hand-tracking de WebXR solo funciona en visores
  dedicados (Quest), no con la cámara trasera de un celular común.*

## ⚠️ Probado así

El código se verificó en un navegador de escritorio simulando eventos de sensores,
una cámara y landmarks de mano sintéticos. **No se ha probado en un celular físico
con gafas**; los umbrales de pasos (`STEP_THRESHOLD`, `STEP_DISTANCE` en
`sensors.js`) y el suavizado del giro (`K_MIN`/`K_MAX`) pueden necesitar ajuste fino
según el aparato.
