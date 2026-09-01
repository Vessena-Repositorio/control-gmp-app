#!/usr/bin/env bash
# Espera a que el servicio vuelva despues del deploy y confirma que quedo sano
# de verdad. Sin esto, el job termina en verde apenas el webhook devuelve 200,
# lo cual solo prueba que Coolify recibio la orden: ni que el contenedor
# levanto, ni que la base respondio, ni que las replicas corrieron.
#
# Consulta /api/estado?estricto=1, que resume la base y las nueve replicas en
# una sola respuesta y devuelve 503 mientras algo no este bien. Con `estricto`
# ademas exige que ninguna replica siga en curso, que es lo que hace falta para
# afirmar que el deploy quedo terminado.
#
# URL es la base del servicio en Coolify (vars.URL_APP), sin barra final. NO es
# la de GitHub Pages: Pages no tiene backend que consultar. Si no esta
# configurada, no falla: avisa y sigue, para no bloquear el pipeline por una
# variable que todavia nadie cargo.
set -uo pipefail

INTENTOS=40
ESPERA=10

if [ -z "${URL:-}" ]; then
    echo "No hay URL configurada para verificar (vars.URL_APP)."
    echo "Cargala en Settings > Secrets and variables > Actions > Variables,"
    echo "con la base del servicio en Coolify, por ejemplo http://10.0.0.1:3000"
    echo "Se omite la verificacion."
    exit 0
fi

echo "Verificando $URL (hasta $((INTENTOS * ESPERA))s)"

for i in $(seq 1 "$INTENTOS"); do
    # Una sola llamada: el codigo va al final del cuerpo y se separa despues.
    # Con dos curl distintos el estado podria cambiar entre uno y otro.
    RESPUESTA=$(curl -s -w $'\n%{http_code}' --max-time 10 \
                "$URL/api/estado?estricto=1" 2>/dev/null || true)
    CODIGO=$(printf '%s' "$RESPUESTA" | tail -n 1)
    CUERPO=$(printf '%s' "$RESPUESTA" | sed '$d')
    [ -z "$CODIGO" ] && CODIGO="000"

    if [ "$CODIGO" = "200" ]; then
        echo "OK tras $((i * ESPERA))s — base y las nueve replicas sanas"
        echo "$CUERPO"
        exit 0
    fi

    # Cada minuto se muestra que esta faltando, para no mirar un log mudo
    # durante siete minutos.
    if [ $((i % 6)) -eq 0 ]; then
        echo "  [$((i * ESPERA))s] HTTP $CODIGO — ${CUERPO:-sin respuesta}"
    fi

    sleep "$ESPERA"
done

echo
echo "El servicio no quedo sano tras $((INTENTOS * ESPERA))s."
echo "Ultima respuesta de /api/estado?estricto=1 (HTTP $CODIGO):"
echo "${CUERPO:-sin respuesta}"
echo
echo "El campo 'problemas' dice que dominio fallo y por que."
echo "'pendientes' son replicas que seguian corriendo al agotarse el tiempo."
exit 1
