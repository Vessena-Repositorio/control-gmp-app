/**
 * Parser de CSV minimo pero correcto para lo que mandan estos origenes:
 * campos entre comillas con comas adentro (por ejemplo "0,5", que es un decimal
 * escrito con coma), comillas escapadas duplicandolas, y saltos CRLF o LF.
 *
 * No se usa una libreria para no sumar dependencia por 40 lineas, y porque el
 * formato es acotado y conocido.
 */
export function parsearCsv(texto) {
    const filas = [];
    let campo = '';
    let fila = [];
    let enComillas = false;

    for (let i = 0; i < texto.length; i++) {
        const c = texto[i];

        if (enComillas) {
            if (c === '"') {
                // Dos comillas seguidas dentro de un campo entrecomillado son
                // una comilla literal, no el cierre.
                if (texto[i + 1] === '"') {
                    campo += '"';
                    i++;
                } else {
                    enComillas = false;
                }
            } else {
                campo += c;
            }
            continue;
        }

        if (c === '"') {
            enComillas = true;
        } else if (c === ',') {
            fila.push(campo);
            campo = '';
        } else if (c === '\n' || c === '\r') {
            // Se cierra la fila con \n, y se ignora el \r de un CRLF.
            if (c === '\r' && texto[i + 1] === '\n') i++;
            fila.push(campo);
            filas.push(fila);
            campo = '';
            fila = [];
        } else {
            campo += c;
        }
    }

    // Ultima fila si el archivo no termina en salto de linea.
    if (campo !== '' || fila.length) {
        fila.push(campo);
        filas.push(fila);
    }

    // Una fila con un unico campo vacio es una linea en blanco, no un dato.
    return filas.filter((f) => !(f.length === 1 && f[0].trim() === ''));
}

/**
 * Indices de columna por nombre de encabezado. Se busca por nombre y no por
 * posicion fija para que agregar una columna en la hoja no descoloque todo.
 */
export function indicesPorEncabezado(encabezado) {
    const indices = {};
    encabezado.forEach((nombre, i) => {
        indices[nombre.trim().toLowerCase()] = i;
    });
    return indices;
}

/** Valor de celda limpio; 'n/a' y vacio cuentan como sin dato. */
export function celda(fila, indice) {
    if (indice === undefined || indice < 0) return null;
    const v = (fila[indice] ?? '').trim();
    if (v === '' || v.toLowerCase() === 'n/a') return null;
    return v;
}

/**
 * Numero de celda.
 *
 * Esta hoja mezcla las dos convenciones decimales: el pH viene como 7.6 y el
 * cloro como "0,5". Asumir una sola rompe la otra, asi que se decide por celda:
 * si aparecen ambos separadores, el decimal es el que esta mas a la derecha y
 * el otro agrupa miles.
 *
 * Con coma sola se toma como decimal, que es el caso real del origen ("0,5").
 * Eso implica que un "1,234" se leeria 1.234 y no 1234; hoy no hay valores asi
 * en la hoja, y errarle al decimal es preferible a inventar un valor 1000 veces
 * mas grande en un dashboard de calidad de agua.
 */
export function celdaNumero(fila, indice) {
    const v = celda(fila, indice);
    if (v === null) return null;

    const limpio = v.replace(/\s/g, '');
    const ultimaComa = limpio.lastIndexOf(',');
    const ultimoPunto = limpio.lastIndexOf('.');

    let normalizado = limpio;
    if (ultimaComa >= 0 && ultimoPunto >= 0) {
        const decimal = ultimaComa > ultimoPunto ? ',' : '.';
        const miles = decimal === ',' ? '.' : ',';
        normalizado = limpio.split(miles).join('').replace(decimal, '.');
    } else if (ultimaComa >= 0) {
        normalizado = limpio.replace(',', '.');
    }

    const n = Number(normalizado);
    return Number.isFinite(n) ? n : null;
}

/**
 * Fecha dd/mm/aaaa -> 'AAAA-MM-DD'.
 *
 * Devuelve texto y no un Date a proposito. Un Date se manda como instante y
 * Postgres lo convierte a DATE usando la zona horaria de la sesion: la
 * medianoche UTC del 18 cae el 17 en una sesion en UTC-3, y la fecha de
 * muestreo se corre un dia. Un 'AAAA-MM-DD' no tiene esa ambiguedad.
 */
export function celdaFecha(fila, indice, saneadas) {
    const v = celda(fila, indice);
    if (!v) return null;

    // Separadores repetidos son un error de tipeo en la hoja ('15/07//2026').
    // Se toleran porque la intencion es inequivoca, pero NO en silencio: cada
    // caso se acumula en `saneadas` para que quede en el log del sync. En la
    // hoja el error sigue estando; esto solo evita perder la fecha.
    const normalizado = v.replace(/\/{2,}/g, '/').replace(/-{2,}/g, '-').trim();
    const anotar = (accion) => { if (saneadas) saneadas.push({ valor: v, accion }); };

    const resultado = interpretar(normalizado);

    // Ultima linea de defensa: solo sale de aca un AAAA-MM-DD con año plausible.
    // Sin esto, un '05/06/20024' (typo real de la hoja de Fabuloso) llegaba a
    // Postgres como '+020024-06' y volteaba el sync entero. Un dato raro tiene
    // que perder esa celda, no la corrida.
    const valido =
        /^\d{4}-\d{2}-\d{2}$/.test(resultado || '') &&
        +resultado.slice(0, 4) >= 1990 &&
        +resultado.slice(0, 4) <= 2100;

    if (!valido) {
        // Se reporta cualquier celda no vacia que se descarte, haya producido
        // basura o nada: en los dos casos se pierde un dato de la hoja.
        anotar('descartada');
        return null;
    }

    if (normalizado !== v) anotar('saneada');
    return resultado;
}

/** Cuenta por accion, para devolverla en la respuesta del sync. */
export function resumirFechas(anotaciones) {
    return anotaciones.reduce(
        (acc, a) => ({ ...acc, [a.accion]: (acc[a.accion] || 0) + 1 }),
        {}
    );
}

/**
 * Avisa en el log de cada corrida. No una sola vez: el error sigue en la hoja
 * de origen y el aviso solo desaparece cuando alguien lo corrige alla.
 */
export function avisarFechas(dominio, anotaciones) {
    if (!anotaciones.length) return;

    for (const accion of ['saneada', 'descartada']) {
        const casos = anotaciones.filter((a) => a.accion === accion);
        if (!casos.length) continue;

        const unicos = [...new Set(casos.map((c) => c.valor))];
        const que =
            accion === 'saneada'
                ? 'con formato raro, interpretadas igual'
                : 'invalidas, DESCARTADAS (esas celdas quedan sin fecha)';
        console.warn(
            `[sync:${dominio}] ${casos.length} fecha(s) ${que}: ` +
            `${unicos.join(', ')} — corregir en la hoja de origen`
        );
    }
}

function interpretar(texto) {
    const partes = texto.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/);
    if (partes) {
        const [, d, mes, a] = partes;
        // Año de dos digitos: estas hojas usan dd/mm/aaaa en todo lo demas, asi
        // que '24' es 2024. No hay ambiguedad de siglo en datos de produccion.
        const anio = a.length === 2 ? 2000 + +a : +a;
        return `${anio}-${String(+mes).padStart(2, '0')}-${String(+d).padStart(2, '0')}`;
    }

    const fecha = new Date(texto);
    return Number.isNaN(fecha.getTime()) ? null : fecha.toISOString().slice(0, 10);
}
