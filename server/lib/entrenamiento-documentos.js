/**
 * Entrenamiento en documentos (migracion 057).
 *
 * Quien tiene que conocer un documento sale del padron de Capacitaciones (PE):
 * las personas activas de los sectores de la matriz del documento. Quien ya
 * lo conoce sale de dos lugares, sin cargar nada dos veces:
 *   - los registros de Capacitaciones (R) cuyo "Codigo Doc." nombra al
 *     documento, desde la aprobacion de la version;
 *   - las firmas "Leido y comprendido" sobre la version, de quien tiene usuario.
 *
 * Los nombres se resuelven con buscadorDePersonas, la misma logica que usa la
 * app de Capacitaciones: si no, el legajo y este calculo dirian cosas
 * distintas de la misma persona.
 */
import { consultar } from '../db.js';
import { coleccionCapacitaciones } from './tareas.js';
import { buscadorDePersonas } from './personas-capacitaciones.js';

const norm = (s) => String(s ?? '').toUpperCase().replace(/\s+/g, ' ').trim();
// Se conservan los espacios: en "SOP-AC-029 V8" el espacio separa el codigo de
// la version; sin el quedaria SOP-AC-029V8 y el borde no se encontraria.
const normCod = (s) => String(s ?? '').toUpperCase().replace(/\s+/g, ' ').trim();

/**
 * Si el texto del "Codigo Doc." de un registro nombra este documento. Se pide
 * borde a los dos lados: SOP-AC-029 no tiene que contar REG-SOP-AC-029-A ni
 * SOP-AC-0290. Un registro puede nombrar varios ("SOP-AC-029 / SOP-AC-030").
 */
export function nombraDocumento(codRegistro, codigo) {
    const txt = normCod(codRegistro);
    const c = normCod(codigo);
    if (!txt || !c) return false;
    let i = txt.indexOf(c);
    while (i >= 0) {
        const antes = i === 0 ? '' : txt[i - 1];
        const despues = txt[i + c.length] ?? '';
        if (!/[A-Z0-9-]/.test(antes) && !/[A-Z0-9]/.test(despues) && !(despues === '-' && /[A-Z0-9]/.test(txt[i + c.length + 1] ?? ''))) {
            return true;
        }
        i = txt.indexOf(c, i + 1);
    }
    return false;
}

/** Sectores del padron con gente activa, para armar la matriz. */
export async function sectoresDelPadron() {
    const personal = await coleccionCapacitaciones('PE');
    const s = new Map();
    for (const p of personal) {
        if (!p || p.a === false || !p.s) continue;
        const k = norm(p.s);
        s.set(k, (s.get(k) || 0) + 1);
    }
    return [...s.entries()].map(([sector, personas]) => ({ sector, personas })).sort((a, b) => a.sector.localeCompare(b.sector));
}

/**
 * Avance del entrenamiento de una version.
 * doc: { codigo, capacitar_sectores }; version: { id, fecha_aprobacion }
 * Devuelve { total, capacitados: [...], pendientes: [...], desde, sinMatriz }.
 */
export async function avance(doc, version, datos) {
    const sectores = new Set((doc.capacitar_sectores || []).map(norm));
    if (!sectores.size) return { sinMatriz: true, total: 0, capacitados: [], pendientes: [] };

    const personal = datos?.personal || await coleccionCapacitaciones('PE');
    const registros = datos?.registros || await coleccionCapacitaciones('R');
    const persona = datos?.persona || buscadorDePersonas(personal);

    const alcance = personal.filter((p) => p && p.a !== false && sectores.has(norm(p.s)));
    // Desde la aprobacion de la version: una capacitacion en la version
    // anterior no cubre los cambios de esta. Las importadas no tienen fecha de
    // aprobacion en el sistema: cuenta cualquier registro del documento.
    const desde = version.fecha_aprobacion ? diaLocal(version.fecha_aprobacion) : null;

    const hecho = new Map(); // nombre del padron -> { como, fecha }
    for (const r of registros) {
        if (!r || !nombraDocumento(r.cod, doc.codigo)) continue;
        const f = String(r.fecha || '').slice(0, 10);
        if (desde && f && f < desde) continue;
        const p = persona(r.nom);
        if (!p) continue;
        const k = String(p.n);
        if (!hecho.has(k) || f > hecho.get(k).fecha) hecho.set(k, { como: r.tipo || 'capacitación', fecha: f });
    }
    const { rows: lecturas } = await consultar(
        `SELECT nombre, firmado_en FROM firmas_electronicas
         WHERE tabla = 'dc_versiones' AND registro_id = $1 AND significado = 'lectura'`,
        [String(version.id)]);
    for (const l of lecturas) {
        const p = persona(l.nombre);
        if (!p) continue;
        hecho.set(String(p.n), { como: 'lectura con firma', fecha: diaLocal(l.firmado_en) });
    }

    const capacitados = [];
    const pendientes = [];
    for (const p of alcance) {
        const h = hecho.get(String(p.n));
        (h ? capacitados : pendientes).push({ nombre: p.n, sector: p.s, ...(h || {}) });
    }
    const orden = (a, b) => String(a.sector).localeCompare(String(b.sector)) || String(a.nombre).localeCompare(String(b.nombre));
    return { total: alcance.length, capacitados: capacitados.sort(orden), pendientes: pendientes.sort(orden), desde };
}

/** Datos del padron una sola vez, para calcular el avance de varias versiones. */
export async function datosPadron() {
    const [personal, registros] = await Promise.all([coleccionCapacitaciones('PE'), coleccionCapacitaciones('R')]);
    return { personal, registros, persona: buscadorDePersonas(personal) };
}

/** La persona del padron que corresponde a un usuario del sistema, por nombre. */
export function personaDeUsuario(datos, nombre) {
    return nombre ? datos.persona(nombre) : null;
}

function diaLocal(v) {
    const d = v instanceof Date ? v : new Date(v);
    return d.toLocaleDateString('sv-SE', { timeZone: process.env.ZONA_HORARIA || 'America/Montevideo' });
}
