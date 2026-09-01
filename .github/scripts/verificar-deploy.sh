#!/usr/bin/env bash
# Espera a que el servicio vuelva a levantar despues del deploy y confirma que
# quedo sano de verdad. Sin esto, un deploy que rompe la base o una migracion
# que falla se ven igual de verdes en Actions que uno exitoso.
#
# Necesita la variable URL (la base del servicio, sin barra final). Si no esta
# configurada, no falla: avisa y sigue, para no bloquear el pipeline por una
# variable que todavia nadie cargo.
set -uo pipefail

INTENTOS=40
ESPERA=10

if [ -z "${URL:-}" ]; then
    echo "No hay URL configurada para verificar (vars.URL_APP)."
    echo "Cargala en Settings > Secrets and variables > Actions > Variables."
    echo "Se omite la verificacion."
    exit 0
fi

echo "Verificando $URL (hasta $((INTENTOS * ESPERA))s)"

for i in $(seq 1 "$INTENTOS"); do
    RESP=$(curl -s --max-time 10 "$URL/api/envases/estado" 2>/dev/null || true)

    # El sync arranca junto con el servidor y tarda unos segundos, asi que se
    # espera al estado 'ok' del ultimo sync, no solo a que el puerto responda.
    case "$RESP" in
        *'"estado":"ok"'*)
            echo "OK tras $((i * ESPERA))s"
            echo "$RESP"
            exit 0
            ;;
        *'"estado":"error"'*)
            echo "El ultimo sync fallo:"
            echo "$RESP"
            exit 1
            ;;
    esac

    # El sitio puede estar sirviendo los .html aunque la API no responda: eso es
    # el modo degradado a proposito, pero para un deploy sigue siendo un fallo.
    if [ $((i % 6)) -eq 0 ]; then
        SALUD=$(curl -s --max-time 5 "$URL/api/salud" 2>/dev/null || true)
        echo "  [$((i * ESPERA))s] esperando... salud: ${SALUD:-sin respuesta}"
    fi

    sleep "$ESPERA"
done

echo "El servicio no quedo sano tras $((INTENTOS * ESPERA))s."
echo "Ultima respuesta de /api/envases/estado: ${RESP:-sin respuesta}"
echo "Revisa los logs del contenedor en Coolify."
exit 1
