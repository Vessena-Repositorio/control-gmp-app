/**
 * Control de Calidad Envases y Tapas — escritura en el servidor (migracion 040).
 *
 * Reemplaza las acciones del Apps Script (Code.gs v4) con el mismo contrato:
 * la pantalla manda las mismas acciones y recibe { success } o { error }. Los
 * datos se guardan en las tablas de la replica (ordenes, controles,
 * mediciones) con la misma forma `raw` que devolvia getAll, asi /api/envases y
 * los dashboards de supervision siguen igual.
 *
 * Diferencias a proposito:
 *   - Quien carga sale de la sesion del portal, y cada accion queda en
 *     envases_actividad.
 *   - Borrar marca (eliminado_en / eliminado_por) en vez de borrar la fila.
 *   - Editar un LCC completo anula su aprobacion (envases_aprobaciones): el
 *     Apps Script lo volvia a "pendiente".
 *   - El aviso de LCC completo sale por el correo del servidor, con enlace a la
 *     app (la aprobacion ya era del servidor, migracion 020).
 *
 * Hasta "Cerrar planilla" (envases_corte) la pantalla sigue usando Google.
 */
import { Router } from 'express';
import { consultar, enTransaccion } from '../db.js';
import { exigirPermiso } from '../lib/acceso.js';
import { hayCorreo, enviar } from '../lib/correo.js';
import { supervisoresDe } from '../lib/destinatarios.js';
import { descargar, aFecha, aTexto, aEnteroSeguro } from '../lib/origen.js';
import { guardarControl, sincronizarEnvases } from '../sync/sync-envases.js';
import { firmaDe } from '../lib/firmas.js';

export const rutasEnvasesCaptura = Router();

const RECURSO = 'control-calidad-envases';
const leer = exigirPermiso(RECURSO, 'ver');
const cargar = exigirPermiso(RECURSO, 'cargar');
const administrar = exigirPermiso(RECURSO, 'administrar');
const BASE = (process.env.URL_PUBLICA || 'http://192.168.30.15:3000').replace(/\/+$/, '');

function fallo(status, mensaje) {
    const e = new Error(mensaje);
    e.status = status;
    return e;
}

const quien = (req) => req.usuario.nombre || req.usuario.usuario;

/** Firma de la analista: quien envia el LCC completo (migracion 041). */
async function firmarAnalista(c, req, id) {
    await c.query(
        `INSERT INTO envases_lcc_firmas (control_clave, usuario_id, firmado_por, firmado_en)
         VALUES ($1, $2, $3, now())
         ON CONFLICT (control_clave) DO UPDATE SET
            usuario_id = EXCLUDED.usuario_id, firmado_por = EXCLUDED.firmado_por, firmado_en = now()`,
        [`lcc:${Number(id)}`, req.usuario.id, quien(req)]
    );
}

async function registrar(c, req, accion, producto, entidadId, detalles) {
    await c.query(
        `INSERT INTO envases_actividad (usuario, accion, producto, entidad_id, detalles)
         VALUES ($1, $2, $3, $4, $5)`,
        [quien(req), accion, producto, entidadId == null ? null : String(entidadId), detalles || null]
    );
}

export async function planillaCerrada() {
    const { rows } = await consultar('SELECT cerrado_en FROM envases_corte');
    return rows[0] || null;
}

/** La orden como la devolvia getAll (sin controles). */
function ordenRaw(o) {
    const id = Number(o.id);
    return {
        id,
        numeroOrden: o.numeroOrden,
        envase: o.envase,
        fecha: o.fecha,
        operador: o.operador || '',
        analista: o.analista || '',
        maquina: o.maquina || '',
        turno: o.turno || '',
        estado: o.estado,
        campaign_id: Number(o.campaign_id || id),
        createdAt: o.createdAt,
    };
}

/** Como las dejaba la hoja: booleanos como SÍ/NO, sin _analista (va aparte). */
function medicionesComoHoja(m) {
    const out = {};
    for (const [k, v] of Object.entries(m || {})) {
        if (k === '_analista' || v === undefined || v === null || v === '') continue;
        out[k] = typeof v === 'boolean' ? (v ? 'SÍ' : 'NO') : v;
    }
    return out;
}

async function guardarOrden(c, producto, o) {
    const raw = ordenRaw(o);
    if (!Number.isSafeInteger(raw.id)) throw fallo(400, 'Orden sin id');
    await c.query(
        `INSERT INTO ordenes (id, producto, numero_orden, envase, fecha, operador, analista, maquina,
                              turno, estado, campaign_id, creado_en, pos, raw, sincronizado_en)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,NULL,$13, now())
         ON CONFLICT (producto, id) DO UPDATE SET
            numero_orden = EXCLUDED.numero_orden, envase = EXCLUDED.envase, fecha = EXCLUDED.fecha,
            operador = EXCLUDED.operador, analista = EXCLUDED.analista, maquina = EXCLUDED.maquina,
            turno = EXCLUDED.turno, estado = EXCLUDED.estado, campaign_id = EXCLUDED.campaign_id,
            creado_en = EXCLUDED.creado_en, raw = EXCLUDED.raw, sincronizado_en = now()`,
        [raw.id, producto, aTexto(raw.numeroOrden), aTexto(raw.envase), aFecha(raw.fecha), aTexto(raw.operador),
            aTexto(raw.analista), aTexto(raw.maquina), aTexto(raw.turno), aTexto(raw.estado),
            aEnteroSeguro(raw.campaign_id), aFecha(raw.createdAt), JSON.stringify(raw)]
    );
    return raw;
}

/** Aviso a quien aprueba LCC (antes, MailApp del Apps Script a Antonella). */
async function avisarLccCompleto(d) {
    if (!hayCorreo) return;
    const para = await supervisoresDe(RECURSO, 'lcc-aprobacion');
    if (!para.length) return;
    const fila = (k, v) => `<tr><td style="padding:6px;color:#4a5568"><b>${k}</b></td><td style="padding:6px">${String(v || '—').replace(/[&<>"]/g, (x) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[x]))}</td></tr>`;
    const html = `<div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto">
        <div style="background:#028090;color:#fff;padding:20px;border-radius:8px 8px 0 0"><h2 style="margin:0">Vessena · Control LCC pendiente</h2></div>
        <div style="background:#f7fafc;padding:20px;border:1px solid #e2e8f0;border-top:none">
          <p>Se registró un control LCC que requiere aprobación:</p>
          <table style="width:100%;border-collapse:collapse;margin:16px 0">${fila('Envase', d.envase)}${fila('Tipo', d.tipo)}${fila('Fecha', d.fecha)}${fila('Analista', d.analista)}</table>
          <div style="text-align:center;margin:24px 0"><a href="${BASE}/control-calidad-envases.html?lcc=${encodeURIComponent(d.id)}" style="display:inline-block;background:#22543d;color:#fff;padding:14px 32px;border-radius:6px;text-decoration:none;font-weight:bold">Revisar, aprobar y firmar</a></div>
        </div></div>`;
    try {
        await enviar({ para, asunto: `[Vessena · LCC] Nuevo control pendiente de aprobación · ${d.envase || ''}`, html, texto: `Control LCC ${d.tipo} de ${d.envase} (${d.fecha}) pendiente de aprobación: ${BASE}/control-calidad-envases.html?lcc=${d.id}` });
    } catch (err) {
        console.error('[envases] no se pudo avisar el LCC completo:', err.message);
    }
}

/** El control LCC como lo devolvia getAll. */
function lccRaw(d, mediciones) {
    return {
        id: Number(d.id), tipo: d.tipo, envase: d.envase, fecha: d.fecha, hora: d.hora,
        operador: d.operador || '', turno: d.turno || '', mediciones,
        observaciones: d.observaciones || '', timestamp: d.timestamp, analista: d.analista || '',
    };
}

/* ═══════════════════════════════════════════════════════════════════════════
   Acciones (mismos nombres que el Apps Script)
   ═══════════════════════════════════════════════════════════════════════════ */

const ACCIONES = {
    saveOrden: ['envases', 'saveOrden'], saveOrdenTapa: ['tapas', 'saveOrden'],
    updateOrden: ['envases', 'updateOrden'], updateOrdenTapa: ['tapas', 'updateOrden'],
    deleteOrden: ['envases', 'deleteOrden'], deleteOrdenTapa: ['tapas', 'deleteOrden'],
    saveControlSoplado: ['envases', 'saveControl'], saveControlSopladoTapa: ['tapas', 'saveControl'],
    deleteControlSoplado: ['envases', 'deleteControl'], deleteControlSopladoTapa: ['tapas', 'deleteControl'],
    finalizarCampana: ['envases', 'finalizarCampana'], finalizarCampanaTapa: ['tapas', 'finalizarCampana'],
    saveLCC: ['envases', 'saveLCC'], updateLCC: ['envases', 'updateLCC'], deleteLCC: ['envases', 'deleteLCC'],
};

/** POST /api/envases-captura/accion/:accion?id=&campaign_id=   body: el mismo JSON que al Apps Script */
rutasEnvasesCaptura.post('/accion/:accion', cargar, async (req, res, next) => {
    const def = ACCIONES[req.params.accion];
    if (!def) return res.status(400).json({ error: `Acción no reconocida: ${req.params.accion}` });
    const [producto, tipo] = def;
    const d = req.body || {};
    const q = req.query || {};
    try {
        if (!(await planillaCerrada())) throw fallo(409, 'La planilla de Google todavía está abierta: la app sigue guardando allá');
        let avisar = null;
        const resultado = await enTransaccion(async (c) => {
            await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['envases-captura']);
            switch (tipo) {
                case 'saveOrden': {
                    const raw = await guardarOrden(c, producto, d);
                    await registrar(c, req, 'orden_nueva', producto, raw.id, `${raw.numeroOrden} · ${raw.envase}`);
                    return { success: true, message: 'Orden guardada' };
                }
                case 'updateOrden': {
                    const { rows } = await c.query(
                        'SELECT 1 FROM ordenes WHERE producto = $1 AND id = $2 AND eliminado_en IS NULL', [producto, Number(d.id)]
                    );
                    if (!rows.length) return { error: 'Orden no encontrada' };
                    const raw = await guardarOrden(c, producto, d);
                    await registrar(c, req, 'orden_editada', producto, raw.id, `estado ${raw.estado}`);
                    return { success: true, message: 'Orden actualizada' };
                }
                case 'deleteOrden': {
                    const id = Number(q.id);
                    const { rowCount } = await c.query(
                        `UPDATE ordenes SET eliminado_en = now(), eliminado_por = $3
                         WHERE producto = $1 AND id = $2 AND eliminado_en IS NULL`, [producto, id, quien(req)]
                    );
                    if (!rowCount) return { error: 'Registro no encontrado' };
                    const r = await c.query(
                        `UPDATE controles SET eliminado_en = now(), eliminado_por = $3
                         WHERE producto = $1 AND origen = 'orden' AND orden_id = $2 AND eliminado_en IS NULL`,
                        [producto, id, quien(req)]
                    );
                    await registrar(c, req, 'orden_eliminada', producto, id, `${r.rowCount} control(es)`);
                    return { success: true, message: 'Registro eliminado' };
                }
                case 'saveControl': {
                    const ordenId = Number(d.ordenId);
                    const { rows } = await c.query(
                        'SELECT envase FROM ordenes WHERE producto = $1 AND id = $2 AND eliminado_en IS NULL', [producto, ordenId]
                    );
                    if (!rows.length) return { error: 'Orden no encontrada' };
                    const raw = {
                        id: Number(d.id), tipo: d.tipoControl, fecha: d.fecha, hora: d.hora,
                        operador: d.operador || '', turno: d.turno || '', mediciones: medicionesComoHoja(d.mediciones),
                        observaciones: d.observaciones || '', timestamp: d.timestamp, analista: d.analista || '',
                    };
                    const r = await guardarControl(c, raw, { origen: 'orden', ordenId, envase: rows[0].envase, pos: null, producto });
                    if (!r.control) throw fallo(400, 'El control no trae fecha y hora de registro');
                    await registrar(c, req, 'control_nuevo', producto, ordenId, `${raw.tipo} ${raw.fecha} ${raw.hora}`);
                    return { success: true, message: 'Control guardado' };
                }
                case 'deleteControl': {
                    const { rowCount } = await c.query(
                        `UPDATE controles SET eliminado_en = now(), eliminado_por = $3
                         WHERE producto = $1 AND origen = 'orden' AND raw ->> 'id' = $2 AND eliminado_en IS NULL`,
                        [producto, String(q.id), quien(req)]
                    );
                    if (!rowCount) return { error: 'Registro no encontrado' };
                    await registrar(c, req, 'control_eliminado', producto, q.id);
                    return { success: true, message: 'Registro eliminado' };
                }
                case 'finalizarCampana': {
                    const cid = Number(q.campaign_id);
                    const { rowCount } = await c.query(
                        `UPDATE ordenes SET estado = 'finalizada',
                                raw = jsonb_set(raw::jsonb, '{estado}', '"finalizada"')::json
                         WHERE producto = $1 AND COALESCE(campaign_id, id) = $2 AND estado = 'activa' AND eliminado_en IS NULL`,
                        [producto, cid]
                    );
                    await registrar(c, req, 'campana_finalizada', producto, cid, `${rowCount} orden(es)`);
                    return { success: true, message: `Campaña finalizada (${rowCount} órdenes)`, count: rowCount };
                }
                case 'saveLCC': {
                    const med = medicionesComoHoja(d.mediciones);
                    const estado = med._estado || 'completo';
                    med._estado = estado;
                    if (estado === 'completo') med._aprobado = 'pendiente';
                    const raw = lccRaw(d, med);
                    const r = await guardarControl(c, raw, { origen: 'lcc', ordenId: null, envase: aTexto(d.envase), pos: null, producto });
                    if (!r.control) throw fallo(400, 'El control LCC no trae id o fecha de registro');
                    await registrar(c, req, 'lcc_nuevo', producto, raw.id, `${raw.tipo} ${raw.envase} · ${estado}`);
                    if (estado === 'completo') {
                        await firmarAnalista(c, req, raw.id);
                        avisar = raw;
                    }
                    return { success: true, message: 'Control guardado', emailEnviado: estado === 'completo' };
                }
                case 'updateLCC': {
                    const clave = `lcc:${Number(d.id)}`;
                    const { rows } = await c.query(
                        'SELECT raw FROM controles WHERE clave_natural = $1 AND eliminado_en IS NULL', [clave]
                    );
                    if (!rows.length) return { error: 'Control no encontrado' };
                    const estadoPrevio = rows[0].raw?.mediciones?._estado || 'completo';
                    const med = medicionesComoHoja(d.mediciones);
                    const estado = med._estado || 'completo';
                    med._estado = estado;
                    if (estado === 'completo') {
                        med._aprobado = 'pendiente';
                        delete med._aprobadoPor;
                        delete med._fechaAprobacion;
                        // Editar un control lo vuelve a pendiente: la aprobacion anterior no vale
                        const anul = await c.query('DELETE FROM envases_aprobaciones WHERE control_clave = $1 RETURNING aprobado_por', [clave]);
                        if (anul.rows.length) await registrar(c, req, 'lcc_aprobacion_anulada', producto, d.id, `aprobado antes por ${anul.rows[0].aprobado_por}`);
                    }
                    const raw = lccRaw(d, med);
                    await guardarControl(c, raw, { origen: 'lcc', ordenId: null, envase: aTexto(d.envase), pos: null, producto });
                    await registrar(c, req, 'lcc_editado', producto, raw.id, `${estadoPrevio} → ${estado}`);
                    if (estado === 'completo') await firmarAnalista(c, req, raw.id);
                    if (estado === 'completo' && estadoPrevio !== 'completo') avisar = raw;
                    return { success: true, message: 'Control guardado' };
                }
                case 'deleteLCC': {
                    const { rowCount } = await c.query(
                        `UPDATE controles SET eliminado_en = now(), eliminado_por = $2
                         WHERE clave_natural = $1 AND eliminado_en IS NULL`,
                        [`lcc:${Number(q.id)}`, quien(req)]
                    );
                    if (!rowCount) return { error: 'Registro no encontrado' };
                    await registrar(c, req, 'lcc_eliminado', producto, q.id);
                    return { success: true, message: 'Registro eliminado' };
                }
                default:
                    throw fallo(400, 'Acción desconocida');
            }
        });
        if (avisar) avisarLccCompleto(avisar).catch(() => {});
        res.status(resultado.error ? 404 : 200).json(resultado);
    } catch (err) {
        if (err.status) return res.status(err.status).json({ error: err.message });
        next(err);
    }
});

/** GET /api/envases-captura/estado — si la pantalla ya guarda en el servidor. */
rutasEnvasesCaptura.get('/estado', leer, async (_req, res, next) => {
    try {
        const corte = await planillaCerrada();
        res.json({ ok: true, planillaCerrada: Boolean(corte), cerradaEn: corte?.cerrado_en || null });
    } catch (err) { next(err); }
});

/**
 * GET /api/envases-captura/lcc/:id/impresion
 * El LCC con las dos firmas -analista y aprobadora-, cada una la vigente en su
 * momento (lib/firmas). Solo aprobado: se carga y firma, se aprueba y firma, y
 * recien ahi se imprime. Cada impresion queda en envases_actividad.
 */
rutasEnvasesCaptura.get('/lcc/:id/impresion', leer, async (req, res, next) => {
    const clave = `lcc:${Number(req.params.id)}`;
    try {
        const { rows } = await consultar(
            `SELECT c.raw, c.analista, f.usuario_id AS f_uid, f.firmado_por, f.firmado_en,
                    a.usuario_id AS a_uid, a.aprobado_por, a.aprobado_en
             FROM controles c
             LEFT JOIN envases_lcc_firmas f ON f.control_clave = c.clave_natural
             LEFT JOIN envases_aprobaciones a ON a.control_clave = c.clave_natural
             WHERE c.clave_natural = $1 AND c.eliminado_en IS NULL`,
            [clave]
        );
        if (!rows.length) return res.status(404).json({ error: 'Control no encontrado' });
        const r = rows[0];
        if (!r.aprobado_por) return res.status(409).json({ error: 'El control todavía no está aprobado' });
        const firmas = [];
        const fa = r.f_uid ? await firmaDe(r.f_uid, r.firmado_en, r.firmado_por) : null;
        firmas.push({
            rol: 'Analista', nombre: r.firmado_por || r.analista || '—', firmadoEn: r.firmado_en || null,
            sinFirma: !fa, deLaPlanilla: !r.firmado_por, ...(fa || {}),
        });
        const fb = r.a_uid ? await firmaDe(r.a_uid, r.aprobado_en, r.aprobado_por) : null;
        firmas.push({
            rol: 'Aprobado por', nombre: r.aprobado_por, firmadoEn: r.aprobado_en, sinFirma: !fb, ...(fb || {}),
        });
        await enTransaccion((c) => registrar(c, req, 'lcc_impreso', 'envases', req.params.id, `aprobado por ${r.aprobado_por}`));
        res.json({
            ok: true, control: r.raw, firmas,
            impreso: { por: quien(req), en: new Date().toISOString() },
        });
    } catch (err) { next(err); }
});

/**
 * POST /api/envases-captura/cerrar-planilla — una sola vez.
 *
 * Ultima copia de la planilla (envases y tapas). Lo que la replica tenia y ya
 * no esta en la hoja -porque se borro alla y la replica nunca borra- se marca
 * como eliminado. Si eso fuera mas del 10 % de lo guardado se frena: es mas
 * probable una respuesta incompleta de Google que una limpieza real.
 */
rutasEnvasesCaptura.post('/cerrar-planilla', administrar, async (req, res, next) => {
    try {
        if (await planillaCerrada()) throw fallo(409, 'La planilla ya está cerrada');
        const url = process.env.ORIGEN_ENVASES;
        if (!url) throw fallo(500, 'Falta ORIGEN_ENVASES');
        let porProducto;
        try {
            porProducto = {
                envases: await descargar(`${url}?action=getAll`),
                tapas: await descargar(`${url}?action=getAllTapas`),
            };
            await sincronizarEnvases();
        } catch (err) {
            throw fallo(502, `No se pudo hacer la última copia de la planilla (${err.message}). No se cerró nada.`);
        }

        const ordenesVivas = []; const clavesVivas = [];
        for (const [producto, datos] of Object.entries(porProducto)) {
            const pref = producto === 'envases' ? '' : `${producto}:`;
            for (const o of datos?.ordenes || []) {
                const id = aEnteroSeguro(o.id);
                if (id === null) continue;
                ordenesVivas.push(`${producto}:${id}`);
                for (const ctrl of o.controles || []) {
                    const ts = aFecha(ctrl.timestamp);
                    if (ts) clavesVivas.push(`${pref}orden:${id}:${ts.toISOString()}`);
                }
            }
            for (const l of datos?.lcc || []) {
                const id = aEnteroSeguro(l.id);
                if (id !== null) clavesVivas.push(`${pref}lcc:${id}`);
            }
        }

        const resumen = await enTransaccion(async (c) => {
            await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['envases-captura']);
            const { rows: tot } = await c.query(
                `SELECT (SELECT count(*)::int FROM ordenes WHERE eliminado_en IS NULL) AS ordenes,
                        (SELECT count(*)::int FROM controles WHERE eliminado_en IS NULL) AS controles,
                        (SELECT count(*)::int FROM ordenes WHERE eliminado_en IS NULL AND NOT ((producto || ':' || id) = ANY($1))) AS ordenes_fuera,
                        (SELECT count(*)::int FROM controles WHERE eliminado_en IS NULL AND NOT (clave_natural = ANY($2))) AS controles_fuera`,
                [ordenesVivas, clavesVivas]
            );
            const t = tot[0];
            if (t.ordenes_fuera > t.ordenes * 0.1 || t.controles_fuera > t.controles * 0.1) {
                throw fallo(409, `La última copia dejaría afuera ${t.ordenes_fuera} órdenes y ${t.controles_fuera} controles: demasiado para ser una limpieza real. No se cerró nada; probá de nuevo en unos minutos.`);
            }
            const motivo = 'cierre de planilla: ya no estaba en la hoja de Google';
            await c.query(
                `UPDATE ordenes SET eliminado_en = now(), eliminado_por = $2
                 WHERE eliminado_en IS NULL AND NOT ((producto || ':' || id) = ANY($1))`, [ordenesVivas, motivo]
            );
            await c.query(
                `UPDATE controles SET eliminado_en = now(), eliminado_por = $2
                 WHERE eliminado_en IS NULL AND NOT (clave_natural = ANY($1))`, [clavesVivas, motivo]
            );
            const detalle = JSON.stringify({ ordenes: t.ordenes - t.ordenes_fuera, controles: t.controles - t.controles_fuera, marcadasEliminadas: { ordenes: t.ordenes_fuera, controles: t.controles_fuera } });
            await c.query('INSERT INTO envases_corte (cerrado_por, detalle) VALUES ($1, $2)', [quien(req), detalle]);
            await registrar(c, req, 'planilla_cerrada', null, null, detalle);
            return JSON.parse(detalle);
        });
        res.json({ ok: true, ...resumen });
    } catch (err) {
        if (err.status) return res.status(err.status).json({ ok: false, error: err.message });
        next(err);
    }
});
