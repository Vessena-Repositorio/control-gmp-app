/**
 * Capacitacion del puesto (migracion 063): la matriz SOP x cargo y el plan de
 * cada persona segun el cargo que ocupa.
 *
 *   prioridad 1  el dia que asume el cargo
 *   prioridad 2  dentro de los 3 meses (o antes si le toca hacer la tarea:
 *                eso lo decide quien capacita, el sistema no lo puede saber)
 *
 * Lo hecho sale de los registros de Capacitaciones (por el "Codigo Doc."), de
 * la version vigente en adelante, igual que el avance del entrenamiento.
 */
import { consultar } from '../db.js';
import { nombraDocumento } from './entrenamiento-documentos.js';
import { sumarMeses } from './importar-listado.js';

export const MESES_PRIORIDAD_2 = 3;

const iso = (v) => (v == null ? null : v instanceof Date
    ? v.toLocaleDateString('sv-SE', { timeZone: process.env.ZONA_HORARIA || 'America/Montevideo' })
    : String(v).slice(0, 10));

/** Personas que ocupan hoy un cargo con 1 o 2 en ese SOP: { nombre -> {cargo, prioridad} }. */
export async function personasPorCargo(codigo) {
    const { rows } = await consultar(
        `SELECT pc.persona_nombre, c.nombre AS cargo, m.valor
         FROM dc_matriz m JOIN dc_cargos c ON c.id = m.cargo_id
         JOIN dc_personal_cargos pc ON pc.cargo_id = m.cargo_id AND pc.hasta IS NULL
         WHERE upper(m.codigo) = upper($1) AND m.valor IN ('1', '2')`, [codigo]);
    const m = new Map();
    for (const r of rows) {
        const ya = m.get(r.persona_nombre);
        if (!ya || r.valor < ya.prioridad) m.set(r.persona_nombre, { cargo: r.cargo, prioridad: r.valor });
    }
    return m;
}

/** Codigos que la persona tiene que conocer por su cargo: Set de codigos en mayuscula. */
export async function codigosDePersona(nombre) {
    const { rows } = await consultar(
        `SELECT DISTINCT upper(m.codigo) AS codigo FROM dc_personal_cargos pc
         JOIN dc_matriz m ON m.cargo_id = pc.cargo_id
         WHERE pc.persona_nombre = $1 AND pc.hasta IS NULL AND m.valor IN ('1', '2')`, [nombre]);
    return new Set(rows.map((r) => r.codigo));
}

/**
 * Plan de capacitacion de una persona por sus cargos actuales.
 * `datos` = datosPadron() (registros de Capacitaciones y buscador de nombres).
 */
export async function planPersona(nombre, datos, hoy) {
    const { rows: asign } = await consultar(
        `SELECT pc.id, pc.cargo_id, pc.desde, c.nombre AS cargo FROM dc_personal_cargos pc
         JOIN dc_cargos c ON c.id = pc.cargo_id WHERE pc.persona_nombre = $1 AND pc.hasta IS NULL
         ORDER BY pc.desde`, [nombre]);
    if (!asign.length) return { cargos: [], items: [] };

    const { rows: mat } = await consultar(
        `SELECT m.cargo_id, upper(m.codigo) AS codigo, m.valor FROM dc_matriz m
         WHERE m.cargo_id = ANY($1) AND m.valor IN ('1', '2')`, [asign.map((a) => a.cargo_id)]);
    const codigos = [...new Set(mat.map((m) => m.codigo))];
    const { rows: docs } = await consultar(
        `SELECT upper(d.codigo) AS codigo, d.titulo, v.id AS version_id, v.numero, v.fecha_aprobacion
         FROM dc_documentos d LEFT JOIN dc_versiones v ON v.documento_id = d.id AND v.estado = 'vigente'
         WHERE upper(d.codigo) = ANY($1)`, [codigos]);
    const docDe = new Map(docs.map((d) => [d.codigo, d]));

    // Lo que ya hizo: registros de Capacitaciones de esta persona.
    const mios = (datos.registros || []).filter((r) => r && datos.persona(r.nom)?.n === nombre);
    const { rows: lecturas } = docs.length ? await consultar(
        `SELECT registro_id, nombre, firmado_en FROM firmas_electronicas
         WHERE tabla = 'dc_versiones' AND significado = 'lectura' AND registro_id = ANY($1)`,
        [docs.filter((d) => d.version_id).map((d) => String(d.version_id))]) : { rows: [] };

    const porCodigo = new Map();
    for (const m of mat) {
        const a = asign.find((x) => x.cargo_id === m.cargo_id);
        const desde = iso(a.desde);
        const plazo = m.valor === '1' ? desde : sumarMeses(desde, MESES_PRIORIDAD_2);
        const ya = porCodigo.get(m.codigo);
        // Si dos cargos piden el mismo SOP, vale el plazo mas corto.
        if (!ya || plazo < ya.plazo) porCodigo.set(m.codigo, { codigo: m.codigo, prioridad: m.valor, plazo, cargo: a.cargo });
    }

    const items = [];
    for (const it of porCodigo.values()) {
        const d = docDe.get(it.codigo);
        const desde = d?.fecha_aprobacion ? iso(d.fecha_aprobacion) : null;
        let hecho = null;
        for (const r of mios) {
            if (!nombraDocumento(r.cod, it.codigo)) continue;
            const f = String(r.fecha || '').slice(0, 10);
            if (desde && f && f < desde) continue;
            if (!hecho || f > hecho.fecha) hecho = { fecha: f, como: r.tipo || 'capacitación' };
        }
        for (const l of lecturas) {
            if (String(l.registro_id) !== String(d?.version_id) || datos.persona(l.nombre)?.n !== nombre) continue;
            hecho = { fecha: iso(l.firmado_en), como: 'lectura con firma' };
        }
        const estado = !d ? 'sin_documento' : hecho ? 'capacitado' : it.plazo < hoy ? 'vencido' : 'pendiente';
        items.push({ ...it, titulo: d?.titulo || null, version: d?.numero ?? null, estado, ...(hecho || {}) });
    }
    items.sort((a, b) => a.prioridad.localeCompare(b.prioridad) || a.codigo.localeCompare(b.codigo));
    return { cargos: asign.map((a) => ({ id: a.id, cargo: a.cargo, cargoId: a.cargo_id, desde: iso(a.desde) })), items };
}
