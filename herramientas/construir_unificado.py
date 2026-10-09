#!/usr/bin/env python3
"""Genera el build UNIFICADO (un solo .html) a partir de los archivos de trabajo.

Toma `Restaurante - Paula y Sarita.html`, incrusta `styles.css` en un <style> y
cada `<script src="modulo.js">` local en un <script> en línea (los scripts de
CDN —Three.js, MediaPipe— se dejan como están), y escribe el resultado en
`index.html` y `restaurante_vr_unificado.html` (idénticos).

Uso (desde cualquier carpeta):
    python herramientas/construir_unificado.py

Edita SIEMPRE los archivos de trabajo (.js, .css y el .html con espacios en el
nombre) y vuelve a correr este script; no edites index.html a mano.
"""
import pathlib
import re
import sys

RAIZ = pathlib.Path(__file__).resolve().parent.parent
FUENTE = RAIZ / "Restaurante - Paula y Sarita.html"
SALIDAS = [RAIZ / "index.html", RAIZ / "restaurante_vr_unificado.html"]

BANNER = """<!-- ================================================================
     RESTAURANTE VR — build UNIFICADO en un solo archivo
     ================================================================
     GENERADO por herramientas/construir_unificado.py: NO es una versión
     distinta del juego, es el MISMO proyecto que vive en varios archivos
     (tracking.js, world.js, perf.js, sensors.js, handoverlay.js, items.js,
     game.js, guide.js, cardboard.js + styles.css) empaquetado en un único
     .html para publicarlo, abrirlo o subirlo como un solo archivo.

     Qué incluye:
       • Permiso automático de la cámara TRASERA en celular, con mensajes
         claros si se deniega o no hay cámara (tracking.js).
       • Detección de manos con MediaPipe Hands: identidad estable, filtro
         One-Euro y pinza relativa al tamaño de la mano (tracking.js); manos
         dibujadas en 2D como contorno y punteros en pantalla (handoverlay.js).
       • Giroscopio (mirar) y acelerómetro (caminar) con suavizado, con o
         sin gafas (sensors.js).
       • Calidad adaptativa hacia 60 FPS y fusión de mallas (perf.js,
         world.js).
       • Modo Cartón: render estéreo, HUD chico en las esquinas de cada ojo
         y vista volteable 180° (cardboard.js).

     Aclaración honesta sobre "WebXR": esto NO usa la API real de WebXR
     (navigator.xr). Usa DeviceOrientation para la mirada y un render
     estéreo hecho a mano, porque la API de manos de WebXR solo funciona
     dentro de una sesión inmersiva en un visor con esa capacidad (p. ej.
     Meta Quest) y NO con la cámara trasera de un celular común.
     ================================================================ -->"""


def leer(ruta: pathlib.Path) -> str:
    return ruta.read_text(encoding="utf-8")


def main() -> int:
    html = leer(FUENTE)

    css = leer(RAIZ / "styles.css")
    enlace = '<link rel="stylesheet" href="styles.css"/>'
    if enlace not in html:
        print("No se encontró el <link> de styles.css en el HTML de trabajo.", file=sys.stderr)
        return 1
    html = html.replace(enlace, "<style>\n" + css + "\n</style>")

    incrustados = []

    def incrustar(m: re.Match) -> str:
        nombre = m.group(1)
        js = leer(RAIZ / nombre)
        if "</script" in js.lower():
            raise SystemExit(f"{nombre} contiene '</script' y rompería el HTML en línea.")
        incrustados.append(nombre)
        return f"<script>\n/* ===== {nombre} ===== */\n{js}\n</script>"

    html = re.sub(r'<script src="([A-Za-z0-9_\-]+\.js)"></script>', incrustar, html)
    html = html.replace(
        "<title>Restaurante VR — Cocina de Restaurante con Control por Manos</title>",
        "<title>Restaurante VR — Build Unificado</title>",
    )
    html = html.replace("<!doctype html>", "<!doctype html>\n" + BANNER, 1)

    for salida in SALIDAS:
        salida.write_text(html, encoding="utf-8", newline="\n")

    print("Incrustados:", ", ".join(incrustados))
    print("Escrito:", ", ".join(s.name for s in SALIDAS), f"({len(html.splitlines())} líneas)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
