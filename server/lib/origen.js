import { createHash } from 'node:crypto';

// Helpers compartidos por los sincronizadores. Los origenes son hojas de
// calculo detras de Apps Script, asi que todo llega con el tipo que quedo en la
// celda: numeros como texto, fechas vacias como '', booleanos como booleanos o
// como 'TRUE'. Estas funciones normalizan eso antes de tocar la base.

const TIMEOUT_MS = 120_000;

// Google corta de a ratos: el mismo Apps Script responde 404 o 500 y, unos
// segundos despues, 200. Sin reintentos una corrida se pierde entera y la
// replica queda desactualizada hasta la siguiente (15 minutos), que puede
// fallar igual. Se reintenta con espera creciente; el ultimo error es el que
// se informa. 429 y 5xx se tratan igual que 404: son del lado de Google.
const INTENTOS = 3;
const ESPERAS_MS = [2_000, 6_000];

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

/** Errores que suelen pasar solos: cortes de Google, red o timeout. */
function vaDeNuevo(err) {
    if (err?.name === 'AbortError') return true;
    const m = String(err?.message || '');
    return /HTTP (404|408|425|429|5\d\d)\b/.test(m)
        || /HTML en vez de/.test(m)
        || /fetch failed|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up/i.test(m);
}

/** Corre `hacer` reintentando los fallos pasajeros del origen. */
async function conReintentos(hacer, url) {
    let ultimo;
    for (let intento = 1; intento <= INTENTOS; intento++) {
        try {
            return await hacer();
        } catch (err) {
            ultimo = err;
            if (intento === INTENTOS || !vaDeNuevo(err)) break;
            const espera = ESPERAS_MS[intento - 1] ?? ESPERAS_MS[ESPERAS_MS.length - 1];
            console.warn(
                `[origen] intento ${intento}/${INTENTOS} fallo (${err.message}); ` +
                `reintento en ${espera / 1000}s — ${String(url).split('?')[0]}`
            );
            await dormir(espera);
        }
    }
    throw ultimo;
}

/** Un GET con timeout. Cada intento estrena su propio reloj. */
async function pedir(url) {
    const ctrl = new AbortController();
    const reloj = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
        const r = await fetch(url, { redirect: 'follow', signal: ctrl.signal });
        if (!r.ok) throw new Error(`el origen respondio HTTP ${r.status}`);
        return await r.text();
    } finally {
        clearTimeout(reloj);
    }
}

/** GET con timeout que devuelve JSON, o lanza con un mensaje util. */
export async function descargar(url) {
    return conReintentos(async () => {
        const cuerpo = await pedir(url);
        let datos;
        try {
            datos = JSON.parse(cuerpo);
        } catch {
            // Igual que con el CSV: una pagina de error de Google con HTTP 200.
            throw new Error('el origen devolvio HTML en vez de JSON (posible error del origen)');
        }
        if (datos && datos.error) throw new Error(`el origen respondio error: ${datos.error}`);
        return datos;
    }, url);
}

/**
 * Huella de contenido de un registro, para detectar el mismo dato enviado dos
 * veces. Se ordenan las claves antes de serializar para que la huella no
 * dependa del orden en que las mando el origen.
 */
export function huellaDe(valor) {
    return createHash('sha256').update(canonico(valor)).digest('hex');
}

function canonico(v) {
    if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
    if (Array.isArray(v)) return '[' + v.map(canonico).join(',') + ']';
    return (
        '{' +
        Object.keys(v)
            .sort()
            .map((k) => JSON.stringify(k) + ':' + canonico(v[k]))
            .join(',') +
        '}'
    );
}

/** GET con timeout que devuelve texto plano (los origenes que mandan CSV). */
export async function descargarTexto(url) {
    return conReintentos(async () => {
        const texto = await pedir(url);

        // Google devuelve una pagina de error con 200 cuando algo falla.
        if (texto.trim().startsWith('<')) {
            throw new Error('el origen devolvio HTML en vez de CSV (posible error del origen)');
        }
        return texto;
    }, url);
}

/**
 * Fecha ISO -> Date, o null si viene vacia o corrupta.
 *
 * Se descartan los años fuera de rango: un typo en la hoja puede producir un
 * año como 20024, que Postgres rechaza con 'time zone displacement out of
 * range' y voltea el sync entero. Una celda rara tiene que perder esa celda, no
 * la corrida.
 */
export function aFecha(valor) {
    if (!valor) return null;
    const d = new Date(valor);
    if (Number.isNaN(d.getTime())) return null;

    const anio = d.getUTCFullYear();
    return anio >= 1990 && anio <= 2100 ? d : null;
}

/** Texto limpio, o null si queda vacio. */
export function aTexto(valor) {
    if (valor === null || valor === undefined) return null;
    const t = String(valor).trim();
    return t === '' ? null : t;
}

/**
 * Numero, o null si no lo es.
 *
 * Solo acepta punto como separador decimal. Es deliberado: en estos origenes
 * hay campos que guardan listas separadas por coma (por ejemplo num_cavidad con
 * "1,2,3,4"), y tomar la coma como decimal convertiria "1,2" en 1.2.
 */
export function aNumero(valor) {
    if (valor === null || valor === undefined || valor === '') return null;
    if (typeof valor === 'number') return Number.isFinite(valor) ? valor : null;

    const t = String(valor).trim();
    if (!/^-?\d+(\.\d+)?$/.test(t)) return null;

    const n = Number(t);
    return Number.isFinite(n) ? n : null;
}

/**
 * Entero para columnas BIGINT. Los ids de estos origenes son epoch en
 * milisegundos, muy por debajo del limite seguro de JS; si algo no entra ahi,
 * es basura y vale mas descartarlo que guardar un numero redondeado.
 */
export function aEnteroSeguro(valor) {
    if (valor === null || valor === undefined || valor === '') return null;
    const n = Number(valor);
    return Number.isSafeInteger(n) ? n : null;
}

/** Booleano tolerante: acepta el tipo real y las variantes de hoja de calculo. */
export function aBooleano(valor) {
    if (valor === null || valor === undefined || valor === '') return null;
    if (typeof valor === 'boolean') return valor;

    const t = String(valor).trim().toLowerCase();
    if (['true', 'si', 'sí', 'x', '1', 'verdadero'].includes(t)) return true;
    if (['false', 'no', '0', 'falso'].includes(t)) return false;
    return null;
}
