#!/usr/bin/env bash
# Espera a que el servicio vuelva despues del deploy y confirma que lo que
# quedo corriendo es ESTE commit y que quedo sano.
#
# Antes solo miraba /api/estado. Eso alcanzaba para decir "el servicio
# contesta", no para decir "el servicio contesta con lo que acabo de subir": si
# el contenedor viejo seguia en pie -y sigue, mientras el nuevo se construye-,
# respondia sano al instante y el job daba verde en trece segundos. Paso de
# verdad, y costo dos vueltas mirando una pantalla vieja convencidas de que el
# arreglo estaba mal.
#
# Ahora son dos condiciones, y hacen falta las dos:
#   1. GET /api/salud devuelve la huella del arbol que se esta desplegando.
#      Esa huella la calcula huella.sh sobre el checkout, y el servidor la
#      calcula igual al arrancar. Si no coinciden, lo que corre es otra cosa.
#   2. GET /api/estado?estricto=1 devuelve 200: base y replicas sanas, y
#      ninguna replica todavia en curso.
#
# URL es la base del servicio en Coolify (vars.URL_APP), sin barra final. NO es
# la de GitHub Pages: Pages no tiene backend que consultar. Si no esta
# configurada, no falla: avisa y sigue, para no bloquear el pipeline por una
# variable que todavia nadie cargo.
set -uo pipefail

INTENTOS=60
ESPERA=10

if [ -z "${URL:-}" ]; then
    echo "No hay URL configurada para verificar (vars.URL_APP)."
    echo "Cargala en Settings > Secrets and variables > Actions > Variables,"
    echo "con la base del servicio en Coolify, por ejemplo http://10.0.0.1:3000"
    echo "Se omite la verificacion."
    exit 0
fi

RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ESPERADA=$(bash "$RAIZ/.github/scripts/huella.sh")

if [ -z "$ESPERADA" ]; then
    echo "No se pudo calcular la huella del checkout. Revisa huella.sh."
    exit 1
fi

echo "Verificando $URL (hasta $((INTENTOS * ESPERA))s)"
echo "Huella esperada: $ESPERADA"

# Se recuerda la ultima huella distinta que se vio, para que el mensaje de
# fracaso distinga dos casos que se arreglan distinto: el contenedor viejo
# sigue arriba (huella vieja) o el server nuevo no sabe calcularla (ausente).
VISTA=""

for i in $(seq 1 "$INTENTOS"); do
    SALUD=$(curl -s --max-time 10 "$URL/api/salud" 2>/dev/null || true)
    # Sin jq en el runner: se saca el campo con sed, que para un valor
    # hexadecimal sin comillas adentro es suficiente.
    ACTUAL=$(printf '%s' "$SALUD" | sed -n 's/.*"huella":"\([^"]*\)".*/\1/p')
    [ -n "$ACTUAL" ] && VISTA="$ACTUAL"

    if [ "$ACTUAL" = "$ESPERADA" ]; then
        # Recien con la version correcta arriba tiene sentido preguntar si esta
        # sana: preguntarselo al contenedor viejo no dice nada del nuevo.
        RESPUESTA=$(curl -s -w $'\n%{http_code}' --max-time 10 \
                    "$URL/api/estado?estricto=1" 2>/dev/null || true)
        CODIGO=$(printf '%s' "$RESPUESTA" | tail -n 1)
        CUERPO=$(printf '%s' "$RESPUESTA" | sed '$d')

        if [ "$CODIGO" = "200" ]; then
            echo "OK tras $((i * ESPERA))s — corriendo $ESPERADA, base y replicas sanas"
            echo "$CUERPO"
            exit 0
        fi

        if [ $((i % 6)) -eq 0 ]; then
            echo "  [$((i * ESPERA))s] version correcta, todavia no sana: HTTP $CODIGO — ${CUERPO:-sin respuesta}"
        fi
    elif [ $((i % 6)) -eq 0 ]; then
        echo "  [$((i * ESPERA))s] todavia corre ${ACTUAL:-(sin huella: build anterior a este chequeo)}"
    fi

    sleep "$ESPERA"
done

echo
echo "El deploy no quedo confirmado tras $((INTENTOS * ESPERA))s."
echo "Esperada: $ESPERADA"
if [ -z "$VISTA" ]; then
    echo "El servidor nunca reporto una huella. O el contenedor nuevo no levanto"
    echo "-y sigue en pie el anterior, que es de antes de que existiera este"
    echo "campo-, o /api/salud no esta respondiendo."
    echo "Revisa los logs del contenedor en Coolify: si el proceso se cae al"
    echo "arrancar, Coolify deja el viejo sirviendo y desde afuera no se nota."
elif [ "$VISTA" != "$ESPERADA" ]; then
    echo "Lo ultimo que se vio corriendo fue $VISTA: el contenedor no se cambio."
else
    echo "La version correcta llego a estar arriba pero /api/estado nunca dio 200."
    echo "El campo 'problemas' dice que dominio fallo y por que."
fi
exit 1
