/**
 * A que persona del padron corresponde el nombre escrito en un registro.
 *
 * Los registros de capacitacion guardan el nombre como texto libre, y el mismo
 * nombre aparece escrito de varias formas: "SEBASTIAN IMPERIAL" en la planilla
 * de marzo, "SEBASTIAN IMPERIAL SAVIO" en el padron. La app lo resuelve con
 * `findPerson` -coincidencia exacta, tabla de alias y parecido por palabras- y
 * el correo semanal comparaba el texto exacto. Resultado: el legajo mostraba
 * las cuatro capacitaciones de Sebastian y el correo del 14/09/2026 decia que
 * le faltaban el reglamento y la induccion GMP.
 *
 * Esto es una copia fiel de `findPerson` de capacitaciones_vessena.html. Si se
 * cambia una, hay que cambiar la otra: si divergen, la pantalla y el correo
 * vuelven a contar cosas distintas sobre los mismos registros.
 *
 * La tabla de alias NO se copia: se lee del propio html, que es donde se
 * mantiene. Dos copias de una lista de ~60 nombres terminan distintas en el
 * primer alias que se agregue.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HTML = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'capacitaciones_vessena.html');

function cargarAlias() {
    try {
        const html = readFileSync(HTML, 'utf8');
        const m = html.match(/const NAME_ALIAS=(\{[\s\S]*?\r?\n\});/);
        if (!m) throw new Error('no se encontro `const NAME_ALIAS={...};` en el html');
        const alias = JSON.parse(m[1]);
        console.log(`[capacitaciones] ${Object.keys(alias).length} alias de nombres cargados`);
        return alias;
    } catch (err) {
        // Sin alias se sigue con coincidencia exacta y por palabras, pero tiene
        // que verse: es la diferencia entre un correo correcto y uno que
        // reclama inducciones que estan hechas.
        console.error('[capacitaciones] SIN alias de nombres:', err.message);
        return {};
    }
}

export const ALIAS = cargarAlias();

const CORTAS = new Set(['DE', 'DEL', 'LOS', 'LA']);
const palabras = (s) => new Set(s.split(' ').filter((w) => w.length > 2 && !CORTAS.has(w)));

/** Devuelve una funcion nombre -> persona del padron (o null), con cache. */
export function buscadorDePersonas(personal) {
    const lista = (personal || []).filter(Boolean);
    const cache = new Map();

    return function persona(nombre) {
        const rn = String(nombre == null ? '' : nombre).toUpperCase().trim();
        if (cache.has(rn)) return cache.get(rn);

        // 1. Coincidencia exacta
        let p = lista.find((x) => String(x.n) === rn);
        // 2. Alias
        if (!p && ALIAS[rn]) p = lista.find((x) => String(x.n) === ALIAS[rn]);
        // 2b. Nombre de una ficha duplicada que se unifico en esta
        if (!p) p = lista.find((x) => Array.isArray(x.alias) && x.alias.includes(rn));
        // 3. Todas las palabras del registro en el nombre del padron
        if (!p) {
            const partes = palabras(rn);
            for (const pe of lista) {
                const pw = palabras(String(pe.n));
                let coinciden = 0;
                partes.forEach((w) => { if (pw.has(w)) coinciden++; });
                if (coinciden >= 2 || (partes.size === 1 && coinciden === 1)) { p = pe; break; }
            }
        }
        cache.set(rn, p || null);
        return p || null;
    };
}
