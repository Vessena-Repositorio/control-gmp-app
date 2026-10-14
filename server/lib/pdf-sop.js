/**
 * PDF de un SOP escrito en la app (migracion 062).
 *
 * Junta lo que el formato necesita y que ya esta en el sistema -quien
 * preparo, reviso y aprobo (de las firmas), las fechas, el historico de
 * cambios (de las versiones)- y lo arma con lib/formato-sop.js.
 *
 * pdfmake se carga recien al generar el primer PDF: si la dependencia fallara,
 * se cae esta funcion y no el servidor entero.
 */
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { consultar } from '../db.js';
import { definicionSop } from './formato-sop.js';
import { LOGO_VESSENA } from './logo-vessena.js';
import { guardar } from './almacen-documentos.js';
import { enTransaccionSistema } from './audit-trail.js';

const require = createRequire(import.meta.url);
let impresora = null;

// Roboto (la que trae pdfmake) y no Helvetica: las fuentes estandar del PDF
// solo tienen Latin-1 y un "≤" o un "µg" en un procedimiento rompia el PDF.
function obtenerImpresora() {
    if (impresora) return impresora;
    const PdfPrinter = require('pdfmake');
    const m = require('pdfmake/build/vfs_fonts.js');
    const vfs = m?.pdfMake?.vfs || m?.vfs || m;
    const f = (n) => Buffer.from(vfs[n], 'base64');
    impresora = new PdfPrinter({
        Roboto: {
            normal: f('Roboto-Regular.ttf'), bold: f('Roboto-Medium.ttf'),
            italics: f('Roboto-Italic.ttf'), bolditalics: f('Roboto-MediumItalic.ttf'),
        },
    });
    return impresora;
}

function aBuffer(definicion) {
    return new Promise((ok, mal) => {
        const pdf = obtenerImpresora().createPdfKitDocument(definicion);
        const partes = [];
        pdf.on('data', (p) => partes.push(p));
        pdf.on('end', () => ok(Buffer.concat(partes)));
        pdf.on('error', mal);
        pdf.end();
    });
}

const verTxt = (n) => (Number.isInteger(Number(n)) ? Number(n).toFixed(1) : String(Number(n)));
const dia = (v) => (v ? (v instanceof Date ? v : new Date(v))
    .toLocaleDateString('sv-SE', { timeZone: process.env.ZONA_HORARIA || 'America/Montevideo' }) : null);
const soloDia = (v) => (v instanceof Date ? dia(v) : (v ? String(v).slice(0, 10) : null));

/** El cargo de la persona, de su firma registrada (tabla firmas), si la tiene. */
async function cargos(ids) {
    if (!ids.length) return new Map();
    const { rows } = await consultar(
        `SELECT DISTINCT ON (usuario_id) usuario_id, cargo FROM firmas
         WHERE usuario_id = ANY($1) ORDER BY usuario_id, cargada_en DESC`, [ids]);
    return new Map(rows.map((r) => [r.usuario_id, r.cargo]));
}

/** Todo lo que el formato necesita de una version, sacado de la base. */
export async function datosSop(versionId) {
    const { rows: [v] } = await consultar(
        `SELECT v.*, d.codigo, d.titulo, d.tipo, u.nombre AS creado_por
         FROM dc_versiones v JOIN dc_documentos d ON d.id = v.documento_id
         LEFT JOIN usuarios u ON u.id = v.creado_por_id WHERE v.id = $1`, [versionId]);
    if (!v) return null;

    // Firmas de la ronda vigente: las posteriores a la ultima firma de autor.
    const { rows: firmas } = await consultar(
        `SELECT significado, usuario_id, nombre, firmado_en FROM firmas_electronicas
         WHERE tabla = 'dc_versiones' AND registro_id = $1 ORDER BY firmado_en`, [String(v.id)]);
    const ultAutor = [...firmas].reverse().find((f) => f.significado === 'autor');
    const deRonda = ultAutor ? firmas.filter((f) => f.firmado_en >= ultAutor.firmado_en) : [];
    const { rows: tareas } = await consultar(
        `SELECT t.tipo, t.usuario_id, u.nombre FROM dc_tareas t JOIN usuarios u ON u.id = t.usuario_id
         WHERE t.version_id = $1 AND t.ronda = $2 AND t.estado <> 'cancelada' ORDER BY t.id`, [v.id, v.ronda]);
    const ids = [...new Set([...deRonda.map((f) => f.usuario_id), ...tareas.map((t) => t.usuario_id), v.creado_por_id].filter(Boolean))];
    const cargo = await cargos(ids);
    const fila = (f) => ({ nombre: f.nombre, cargo: cargo.get(f.usuario_id) || '', fecha: dia(f.firmado_en) });
    const quienes = (sig, tipo) => {
        const fs = deRonda.filter((f) => f.significado === sig).map(fila);
        // Lo que todavia no se firmo: el nombre de quien tiene la tarea, sin fecha.
        const pend = tareas.filter((t) => t.tipo === tipo && !fs.some((f) => f.nombre === t.nombre))
            .map((t) => ({ nombre: t.nombre, cargo: cargo.get(t.usuario_id) || '', fecha: null }));
        return [...fs, ...pend];
    };

    const { rows: versiones } = await consultar(
        `SELECT numero, estado, fecha_vigencia, fecha_aprobacion, resumen_cambios, observaciones
         FROM dc_versiones WHERE documento_id = $1 AND estado <> 'anulado' AND numero <= $2 ORDER BY numero`,
        [v.documento_id, v.numero]);

    const aprobada = ['aprobado', 'en_entrenamiento', 'vigente', 'obsoleto'].includes(v.estado);
    return {
        tipo: v.tipo, codigo: v.codigo, titulo: v.titulo, version: verTxt(v.numero),
        fechaAprobacion: dia(v.fecha_aprobacion), fechaVigencia: soloDia(v.fecha_vigencia),
        fechaEntrenamiento: v.modo_capacitacion && v.modo_capacitacion !== 'no_requiere' ? dia(v.fecha_aprobacion) : null,
        secciones: v.contenido_json || {},
        preparado: ultAutor ? [fila(ultAutor)] : [{ nombre: v.creado_por || '', cargo: cargo.get(v.creado_por_id) || '', fecha: null }],
        revisado: quienes('revisor', 'revision'),
        aprobado: quienes('aprobador', 'aprobacion'),
        historico: versiones.map((x) => ({
            version: verTxt(x.numero),
            fecha: soloDia(x.fecha_vigencia) || dia(x.fecha_aprobacion),
            cambios: x.resumen_cambios || x.observaciones || 'Versión anterior al control de documentos en el sistema',
        })),
        borrador: !aprobada,
        logo: LOGO_VESSENA,
        fuente: 'Roboto',
        _version: v,
    };
}

/** El PDF de la version, armado ahora (vista previa o para emitir). */
export async function pdfSop(versionId) {
    const d = await datosSop(versionId);
    if (!d) return null;
    if (d._version.formato !== 'editor') throw Object.assign(new Error('la versión no se escribió en la app'), { status: 409 });
    return { pdf: await aBuffer(definicionSop(d)), datos: d };
}

/**
 * PDF oficial: al aprobarse una version escrita en la app se genera con las
 * firmas y fechas, se guarda en el volumen y queda como pdf de la version.
 * Una sola vez: si ya tiene PDF no se toca.
 */
export async function emitirPdfOficial(versionId) {
    const r = await pdfSop(versionId);
    if (!r) return null;
    const v = r.datos._version;
    if (v.pdf_sha256) return { yaEstaba: true };
    if (r.datos.borrador) throw Object.assign(new Error('la versión todavía no está aprobada'), { status: 409 });
    const nombre = `${v.codigo || r.datos.codigo}_V${r.datos.version}.pdf`;
    const g = await guardar(r.pdf, nombre);
    await enTransaccionSistema('PDF oficial', `PDF oficial de ${r.datos.codigo} v${r.datos.version} generado al aprobar`, (c) =>
        c.query('UPDATE dc_versiones SET pdf_ruta = $2, pdf_sha256 = $3 WHERE id = $1 AND pdf_sha256 IS NULL',
            [versionId, g.ruta, g.sha256]));
    return { sha256: g.sha256, bytes: g.bytes };
}

/** Hash estable del contenido por secciones (orden de claves fijo). */
export function hashContenido(secciones) {
    const ordenado = Object.fromEntries(Object.keys(secciones).sort().map((k) => [k, secciones[k]]));
    return createHash('sha256').update(JSON.stringify(ordenado), 'utf8').digest('hex');
}
