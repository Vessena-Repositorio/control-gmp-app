/**
 * Ciclo de revision y aprobacion de documentos (migracion 056).
 *
 * Todas las funciones reciben una transaccion `c` que ya tiene el autor y el
 * motivo declarados (audit-trail.js): cada cambio de estado queda en el audit
 * trail por el trigger de la tabla.
 *
 * Los correos no se mandan desde aca: cada funcion devuelve que hay que
 * avisar, y la ruta los manda DESPUES del COMMIT. Un correo que sale y una
 * transaccion que despues se revierte avisarian algo que no paso.
 */
import { firmar } from './firma-electronica.js';
import { sumarMeses } from './importar-listado.js';

export const MESES_REVISION = 36;
export const PLAZO_DIAS = 7;

function fallo(status, mensaje) {
    const e = new Error(mensaje);
    e.status = status;
    return e;
}

const huellaSql = 'coalesce(v.pdf_sha256, v.contenido_sha256, v.archivo_sha256)';

async function hoy(c) {
    const { rows } = await c.query(
        `SELECT (now() AT TIME ZONE $1)::date::text AS hoy`,
        [process.env.ZONA_HORARIA || 'America/Montevideo']);
    return rows[0].hoy;
}

function masDias(dia, n) {
    const [a, m, d] = dia.split('-').map(Number);
    return new Date(Date.UTC(a, m - 1, d + n)).toISOString().slice(0, 10);
}

async function versionBloqueada(c, versionId) {
    const { rows: [v] } = await c.query(
        `SELECT v.*, ${huellaSql} AS huella, d.codigo, d.titulo, d.id AS doc_id
         FROM dc_versiones v JOIN dc_documentos d ON d.id = v.documento_id
         WHERE v.id = $1 FOR UPDATE OF v`,
        [versionId]);
    if (!v) throw fallo(404, 'version inexistente');
    return v;
}

/** Quien tiene que poder abrir la pantalla para hacer su tarea. */
async function asegurarAcceso(c, usuarioIds) {
    for (const id of usuarioIds) {
        await c.query(
            `INSERT INTO usuario_recursos (usuario_id, recurso, rol)
             VALUES ($1, 'control-documentos', 'vista')
             ON CONFLICT (usuario_id, recurso) DO NOTHING`,
            [id]);
    }
}

/**
 * Nueva version en borrador de un documento, a partir de la vigente.
 * Numero: la vigente (o la mayor) + 1, redondeado: despues de 6.0 va 7.0.
 */
export async function nuevaVersion(c, req, documentoId) {
    const { rows: [d] } = await c.query('SELECT id FROM dc_documentos WHERE id = $1 FOR UPDATE', [documentoId]);
    if (!d) throw fallo(404, 'documento inexistente');
    const { rows: vs } = await c.query(
        'SELECT numero, estado, formato, contenido_html, contenido_sha256 FROM dc_versiones WHERE documento_id = $1',
        [documentoId]);
    const enCurso = vs.find((v) => ['borrador', 'en_revision', 'en_aprobacion', 'aprobado', 'en_entrenamiento'].includes(v.estado));
    if (enCurso) throw fallo(409, `ya hay una versión ${enCurso.estado.replace('_', ' ')} (${enCurso.numero})`);
    const vigente = vs.find((v) => v.estado === 'vigente');
    const numero = Math.floor(Math.max(0, ...vs.map((v) => Number(v.numero)))) + 1;
    const editor = vigente?.formato === 'editor';

    const { rows: [n] } = await c.query(
        `INSERT INTO dc_versiones (documento_id, numero, formato, contenido_html, contenido_sha256, creado_por_id)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, numero`,
        [documentoId, numero, editor ? 'editor' : 'archivo',
         editor ? vigente.contenido_html : null, editor ? vigente.contenido_sha256 : null, req.usuario.id]);
    return n;
}

/**
 * El autor firma y envia. `revisores` puede venir vacio (pasa directo a
 * aprobacion); `aprobadores` no.
 */
export async function enviarARevision(c, req, versionId, b) {
    const v = await versionBloqueada(c, versionId);
    if (v.estado !== 'borrador') throw fallo(409, 'solo se envía una versión en borrador');
    if (v.formato === 'archivo' && (!v.pdf_sha256 || !v.archivo_sha256)) {
        throw fallo(409, 'antes de enviar subí el Word (editable) y el PDF de la versión');
    }
    if (!v.huella) throw fallo(409, 'la versión no tiene contenido');

    const resumen = String(b.resumenCambios ?? v.resumen_cambios ?? '').trim();
    if (!resumen) throw fallo(400, 'describí qué cambia en esta versión');

    const ids = (l) => [...new Set((Array.isArray(l) ? l : []).map(Number).filter((x) => Number.isInteger(x) && x > 0))];
    const revisores = ids(b.revisores);
    const aprobadores = ids(b.aprobadores);
    if (!aprobadores.length) throw fallo(400, 'elegí al menos un aprobador');
    if (revisores.includes(req.usuario.id) || aprobadores.includes(req.usuario.id)) {
        throw fallo(400, 'quien elabora no puede revisar ni aprobar su propio documento');
    }
    // Entrenamiento (057): como se capacita en esta version y que sectores.
    const modo = String(b.modoCapacitacion || '');
    if (!['lectura', 'presencial', 'no_requiere'].includes(modo)) {
        throw fallo(400, 'elegí cómo se capacita al personal en esta versión');
    }
    const sectores = [...new Set((Array.isArray(b.sectores) ? b.sectores : [])
        .map((s) => String(s).toUpperCase().replace(/\s+/g, ' ').trim()).filter(Boolean))];
    if (modo !== 'no_requiere' && !sectores.length) {
        throw fallo(400, 'elegí qué sectores tienen que capacitarse');
    }
    const plazoRev = Number(b.plazoRevision) || PLAZO_DIAS;
    const plazoApr = Number(b.plazoAprobacion) || PLAZO_DIAS;
    if (plazoRev < 1 || plazoApr < 1 || plazoRev > 90 || plazoApr > 90) throw fallo(400, 'los plazos van de 1 a 90 días');

    const { rows: personas } = await c.query(
        `SELECT id, nombre, coalesce(email, usuario) AS correo FROM usuarios
         WHERE id = ANY($1) AND activo AND origen = 'vessena'`,
        [[...revisores, ...aprobadores]]);
    const faltan = [...revisores, ...aprobadores].filter((id) => !personas.some((p) => p.id === id));
    if (faltan.length) throw fallo(400, 'hay revisores o aprobadores que no son usuarios activos');

    const firma = await firmar(c, req, {
        usuario: b.usuario, clave: b.clave, significado: 'autor',
        recurso: 'control-documentos', tabla: 'dc_versiones', registroId: v.id,
        contenidoSha256: v.huella, comentario: resumen,
    });

    const ronda = v.ronda + 1;
    const dia = await hoy(c);
    const estado = revisores.length ? 'en_revision' : 'en_aprobacion';
    await c.query(
        `UPDATE dc_versiones SET estado = $2, ronda = $3, resumen_cambios = $4,
                elaborado_por_nombre = $5, cc_codigo = coalesce($6, cc_codigo), modo_capacitacion = $7
         WHERE id = $1`,
        [v.id, estado, ronda, resumen, req.usuario.nombre || req.usuario.usuario,
         String(b.ccCodigo || '').trim() || null, modo]);
    // La matriz es del documento: la ultima version que se envia la actualiza.
    if (sectores.length) {
        await c.query('UPDATE dc_documentos SET capacitar_sectores = $2 WHERE id = $1', [v.doc_id, sectores]);
    }

    const crear = async (tipo, usuarioId, activa, plazo) => c.query(
        `INSERT INTO dc_tareas (version_id, ronda, tipo, usuario_id, plazo_dias, vence_el, estado, creada_por_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [v.id, ronda, tipo, usuarioId, plazo, activa ? masDias(dia, plazo) : null,
         activa ? 'pendiente' : 'en_espera', req.usuario.id]);
    for (const id of revisores) await crear('revision', id, true, plazoRev);
    for (const id of aprobadores) await crear('aprobacion', id, !revisores.length, plazoApr);
    await asegurarAcceso(c, [...revisores, ...aprobadores]);

    const avisar = (revisores.length ? revisores : aprobadores).map((id) => personas.find((p) => p.id === id));
    return {
        firma, estado, ronda,
        avisos: [{ tipo: revisores.length ? 'revision' : 'aprobacion', para: avisar, plazo: masDias(dia, revisores.length ? plazoRev : plazoApr) }],
        doc: { codigo: v.codigo, titulo: v.titulo, numero: v.numero, resumen },
    };
}

/**
 * Quien tiene la tarea la firma: aprueba o rechaza.
 * b = { decision: 'aprobar'|'rechazar', usuario, clave, comentario, fechaVigencia }
 */
export async function firmarTarea(c, req, tareaId, b) {
    const { rows: [t] } = await c.query('SELECT * FROM dc_tareas WHERE id = $1 FOR UPDATE', [tareaId]);
    if (!t) throw fallo(404, 'tarea inexistente');
    if (t.usuario_id !== req.usuario.id) throw fallo(403, 'esta tarea es de otra persona');
    if (t.estado !== 'pendiente') throw fallo(409, `la tarea está ${t.estado.replace('_', ' ')}`);

    const v = await versionBloqueada(c, t.version_id);
    const esperado = t.tipo === 'revision' ? 'en_revision' : 'en_aprobacion';
    if (v.estado !== esperado || v.ronda !== t.ronda) throw fallo(409, 'la versión ya no está en este paso');

    const comentario = String(b.comentario || '').trim();
    const rechaza = b.decision === 'rechazar';
    if (!rechaza && b.decision !== 'aprobar') throw fallo(400, 'decisión inválida');
    if (rechaza && !comentario) throw fallo(400, 'para rechazar explicá qué hay que cambiar');

    const dia = await hoy(c);
    let fechaVigencia = null;
    if (!rechaza && t.tipo === 'aprobacion') {
        fechaVigencia = String(b.fechaVigencia || dia).slice(0, 10);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(fechaVigencia)) throw fallo(400, 'fecha de vigencia inválida');
        if (fechaVigencia < dia) throw fallo(400, 'la fecha de vigencia no puede ser anterior a hoy');
    }

    const firma = await firmar(c, req, {
        usuario: b.usuario, clave: b.clave,
        significado: rechaza ? 'rechazo' : (t.tipo === 'revision' ? 'revisor' : 'aprobador'),
        recurso: 'control-documentos', tabla: 'dc_versiones', registroId: v.id,
        contenidoSha256: v.huella, comentario: comentario || null,
    });
    await c.query(
        `UPDATE dc_tareas SET estado = $2, firma_id = $3, comentario = $4, cerrada_en = now() WHERE id = $1`,
        [t.id, rechaza ? 'rechazada' : 'firmada', firma.id, comentario || null]);

    const doc = { codigo: v.codigo, titulo: v.titulo, numero: v.numero, versionId: v.id };
    const autor = await autorDeRonda(c, v.id, v.ronda);

    if (rechaza) {
        await c.query(
            `UPDATE dc_tareas SET estado = 'cancelada', cerrada_en = now()
             WHERE version_id = $1 AND ronda = $2 AND estado IN ('pendiente', 'en_espera')`,
            [v.id, v.ronda]);
        await c.query(`UPDATE dc_versiones SET estado = 'borrador' WHERE id = $1`, [v.id]);
        return { firma, resultado: 'rechazada', doc, avisos: [{ tipo: 'rechazo', para: autor ? [autor] : [], comentario, quien: firma.nombre }] };
    }

    const { rows: [{ quedan }] } = await c.query(
        `SELECT count(*)::int AS quedan FROM dc_tareas
         WHERE version_id = $1 AND ronda = $2 AND tipo = $3 AND estado = 'pendiente'`,
        [v.id, v.ronda, t.tipo]);
    if (quedan) return { firma, resultado: 'firmada', doc, avisos: [] };

    if (t.tipo === 'revision') {
        const { rows: activadas } = await c.query(
            `UPDATE dc_tareas SET estado = 'pendiente', vence_el = ($3::date + plazo_dias)
             WHERE version_id = $1 AND ronda = $2 AND tipo = 'aprobacion' AND estado = 'en_espera'
             RETURNING usuario_id, vence_el`,
            [v.id, v.ronda, dia]);
        await c.query(`UPDATE dc_versiones SET estado = 'en_aprobacion' WHERE id = $1`, [v.id]);
        const para = await personas(c, activadas.map((a) => a.usuario_id));
        return { firma, resultado: 'revisada', doc,
            avisos: [{ tipo: 'aprobacion', para, plazo: activadas[0] ? String(activadas[0].vence_el).slice(0, 10) : null }] };
    }

    // Ultima aprobacion: queda aprobada, y vigente hoy o en la fecha elegida.
    await c.query(
        `UPDATE dc_versiones SET estado = 'aprobado', fecha_aprobacion = now(), fecha_vigencia = $2,
                aprobado_por_id = $3, aprobado_por_nombre = $4,
                revisado_por_nombre = (
                    SELECT string_agg(u.nombre, ', ' ORDER BY t.cerrada_en) FROM dc_tareas t
                    JOIN usuarios u ON u.id = t.usuario_id
                    WHERE t.version_id = $1 AND t.ronda = $5 AND t.tipo = 'revision' AND t.estado = 'firmada')
         WHERE id = $1`,
        [v.id, fechaVigencia, req.usuario.id, req.usuario.nombre || req.usuario.usuario, v.ronda]);
    let resultado = 'aprobada';
    if (fechaVigencia <= dia) {
        await ponerVigente(c, v.id);
        resultado = 'vigente';
    } else {
        // Hasta la fecha de vigencia queda en espera; ahi se entrena al
        // personal (etapa del entrenamiento) y la tarea diaria la activa.
        await c.query(`UPDATE dc_versiones SET estado = 'en_entrenamiento' WHERE id = $1`, [v.id]);
    }
    const calidad = await personasCalidad(c);
    return { firma, resultado, doc: { ...doc, fechaVigencia },
        avisos: [{ tipo: resultado, para: unicos([autor, ...calidad]) }] };
}

/**
 * Pone vigente una version aprobada: la vigente anterior pasa a obsoleta y el
 * vencimiento se cuenta 3 años desde la fecha de vigencia.
 */
export async function ponerVigente(c, versionId) {
    const { rows: [v] } = await c.query(
        'SELECT id, documento_id, fecha_vigencia FROM dc_versiones WHERE id = $1 FOR UPDATE', [versionId]);
    const { rows: [doc] } = await c.query(
        `SELECT coalesce(d.meses_revision, t.meses_revision, $2) AS meses
         FROM dc_documentos d JOIN dc_tipos t ON t.codigo = d.tipo WHERE d.id = $1 FOR UPDATE OF d`,
        [v.documento_id, MESES_REVISION]);
    await c.query(
        `UPDATE dc_versiones SET estado = 'obsoleto', fecha_obsoleto = now()
         WHERE documento_id = $1 AND estado = 'vigente'`, [v.documento_id]);
    await c.query(`UPDATE dc_versiones SET estado = 'vigente' WHERE id = $1`, [v.id]);
    const desde = String(v.fecha_vigencia instanceof Date ? isoLocal(v.fecha_vigencia) : v.fecha_vigencia).slice(0, 10);
    await c.query(
        `UPDATE dc_documentos SET proxima_revision = $2, avisar_desde = NULL WHERE id = $1`,
        [v.documento_id, sumarMeses(desde, doc.meses)]);
}

function isoLocal(f) {
    const p = (n) => String(n).padStart(2, '0');
    return `${f.getFullYear()}-${p(f.getMonth() + 1)}-${p(f.getDate())}`;
}

/**
 * Calidad pone vigente hoy una version aprobada que esperaba su fecha, porque
 * el entrenamiento ya esta completo (o porque no hace falta esperar).
 */
export async function vigenteAhora(c, versionId) {
    const v = await versionBloqueada(c, versionId);
    if (v.estado !== 'en_entrenamiento') throw fallo(409, 'solo una versión aprobada que espera su vigencia');
    await c.query('UPDATE dc_versiones SET fecha_vigencia = $2 WHERE id = $1', [v.id, await hoy(c)]);
    await ponerVigente(c, v.id);
    return { codigo: v.codigo, titulo: v.titulo, numero: v.numero, versionId: v.id };
}

/** Anula un borrador que no va a seguir. */
export async function anularBorrador(c, versionId) {
    const v = await versionBloqueada(c, versionId);
    if (v.estado !== 'borrador') throw fallo(409, 'solo se anula una versión en borrador');
    await c.query(`UPDATE dc_versiones SET estado = 'anulado' WHERE id = $1`, [v.id]);
    await c.query(
        `UPDATE dc_tareas SET estado = 'cancelada', cerrada_en = now()
         WHERE version_id = $1 AND estado IN ('pendiente', 'en_espera')`, [v.id]);
    return { codigo: v.codigo, numero: v.numero };
}

async function personas(c, ids) {
    if (!ids.length) return [];
    const { rows } = await c.query(
        `SELECT id, nombre, coalesce(email, usuario) AS correo FROM usuarios WHERE id = ANY($1) AND activo`, [ids]);
    return rows;
}

async function personasCalidad(c) {
    const { rows } = await c.query(
        `SELECT DISTINCT u.id, u.nombre, coalesce(u.email, u.usuario) AS correo
         FROM usuario_recursos r JOIN usuarios u ON u.id = r.usuario_id
         WHERE r.recurso = 'control-documentos' AND r.rol = 'administrador' AND u.activo`);
    return rows;
}

/** Quien firmo como autor la ronda: a quien se le avisa un rechazo. */
async function autorDeRonda(c, versionId, ronda) {
    const { rows } = await c.query(
        `SELECT u.id, u.nombre, coalesce(u.email, u.usuario) AS correo
         FROM firmas_electronicas f JOIN usuarios u ON u.id = f.usuario_id
         WHERE f.tabla = 'dc_versiones' AND f.registro_id = $1 AND f.significado = 'autor'
         ORDER BY f.firmado_en DESC LIMIT 1`,
        [String(versionId)]);
    void ronda; // la ultima firma de autor es la de la ronda en curso
    return rows[0] || null;
}

function unicos(lista) {
    const vistos = new Set();
    return lista.filter((p) => p && p.correo && !vistos.has(p.id) && vistos.add(p.id));
}

/**
 * Tarea diaria: las versiones aprobadas cuya fecha de vigencia llego pasan a
 * vigentes. Corre como "Sistema"; quien aprobo y cuando ya esta en la firma.
 */
export async function activarVigencias(c) {
    const dia = await hoy(c);
    const { rows } = await c.query(
        `SELECT v.id, d.codigo, v.numero FROM dc_versiones v JOIN dc_documentos d ON d.id = v.documento_id
         WHERE v.estado = 'en_entrenamiento' AND v.fecha_vigencia <= $1`, [dia]);
    for (const v of rows) await ponerVigente(c, v.id);
    return rows;
}
