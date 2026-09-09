#!/usr/bin/env bash
# Calcula la huella del arbol de trabajo: la misma que el servidor publica en
# GET /api/salud. Sirve para saber, desde afuera y sin sesion, si lo que esta
# corriendo es este commit o el anterior.
#
# Tiene que dar identico al calculo de server/index.js (const HUELLA). Si se
# cambia uno hay que cambiar el otro; si divergen, la verificacion del deploy
# empieza a fallar siempre y no sirve para nada.
#
# Reglas, iguales de los dos lados:
#   - archivos: los *.html de la raiz, package.json y todo lo que cuelga de
#     server/ (js y las migraciones .sql).
#   - orden: por ruta, byte a byte (LC_ALL=C, que es como ordena JavaScript).
#   - cada archivo aporta su ruta, un salto de linea, y su contenido sin \r.
#     La ruta va incluida para que renombrar algo tambien mueva la huella.
#     Los \r se sacan porque el repo se clona con finales de linea distintos
#     segun el sistema, y si no el mismo commit daria huellas distintas.
set -uo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/../.."

{
    ls *.html 2>/dev/null
    echo package.json
    find server -type f 2>/dev/null
} | LC_ALL=C sort | while IFS= read -r f; do
    printf '%s\n' "$f"
    tr -d '\r' < "$f"
done | sha256sum | cut -c1-12
