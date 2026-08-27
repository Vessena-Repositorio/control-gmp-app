import { createHash } from 'node:crypto';

// Helpers compartidos por los sincronizadores. Los origenes son hojas de
// calculo detras de Apps Script, asi que todo llega con el tipo que quedo en la
// celda: numeros como texto, fechas vacias como '', booleanos como booleanos o
// como 'TRUE'. Estas funciones normalizan eso antes de tocar la base.

const TIMEOUT_MS = 120_000;

/** GET con timeout que devuelve JSON, o lanza con un mensaje util. */
export async function descargar(url) {
    const ctrl = new AbortController();
    const reloj = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
        const r = await fetch(url, { redirect: 'follow', signal: ctrl.signal });
        if (!r.ok) throw new Error(`el origen respondio HTTP ${r.status}`);
        const datos = await r.json();
        if (datos && datos.error) throw new Error(`el origen respondio error: ${datos.error}`);
        return datos;
    } finally {
        clearTimeout(reloj);
    }
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
    const ctrl = new AbortController();
    const reloj = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
        const r = await fetch(url, { redirect: 'follow', signal: ctrl.signal });
        if (!r.ok) throw new Error(`el origen respondio HTTP ${r.status}`);
        const texto = await r.text();

        // Google devuelve una pagina de error con 200 cuando algo falla.
        if (texto.trim().startsWith('<')) {
            throw new Error('el origen devolvio HTML en vez de CSV (posible error del origen)');
        }
        return texto;
    } finally {
        clearTimeout(reloj);
    }
}

/** Fecha ISO -> Date, o null si viene vacia o corrupta. */
export function aFecha(valor) {
    if (!valor) return null;
    const d = new Date(valor);
    return Number.isNaN(d.getTime()) ? null : d;
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
