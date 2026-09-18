/**
 * Verificacion de rotulo por supervision — comun a Control Fabuloso y a
 * Control en proceso (migracion 037).
 *
 * Pedido de Claudia (18/09/2026): el lote o el vencimiento de una orden
 * estuvieron mal mas de una vez y la analista no se dio cuenta. Hace falta una
 * segunda mirada de un jefe:
 *
 *   1. El primer control de cada orden crea la verificacion con sus fotos de
 *      caja y envase, y les manda un correo con las fotos a Antonella, Gloria y
 *      Claudia (notificacion_supervisores 'rotulos').
 *   2. Una de ellas da el OK, o pide la correccion con un comentario (y marca
 *      reproceso si el error es critico, como un vencimiento). La orden sigue
 *      abierta: la analista ve el pedido en la app, sube las fotos corregidas y
 *      vuelve a supervision.
 *   3. Pasado su plazo (el dia de la orden a las 12, ROTULO_HORA_CORTE) una
 *      orden sin OK no acepta mas controles.
 *
 * Sabados (Claudia, 18/09/2026): la planta trabaja pero supervision no. Ese
 * dia no se frena ninguna orden ni salen correos en el momento; lo del fin de
 * semana vence el lunes a las 12 y llega el lunes a las 8 en un solo correo
 * (revisarRotulosDelFinde). El domingo se trata igual.
 *
 * Las ordenes que ya estaban en curso cuando se instalo esto crean su
 * verificacion con el siguiente control que se cargue.
 */
import { consultar, enTransaccion } from '../db.js';
import { hayCorreo, enviar } from './correo.js';
import { supervisoresDe } from './destinatarios.js';
import { ZONA, correrUnaVezPorDia } from './tareas.js';
import { paraCorreo } from './comprimir-foto.js';

export const HORA_CORTE = Number(process.env.ROTULO_HORA_CORTE ?? 12);
const BASE = (process.env.URL_PUBLICA || 'http://192.168.30.15:3000').replace(/\/+$/, '');

export const APPS = {
    fabuloso: {
        nombre: 'Control Fabuloso',
        pagina: '/fabuloso.html#rotulos',
        foto: /^\/api\/fabuloso-captura\/fotos\/(\d+)$/,
        tabla: 'fab_fotos',
    },
    proceso: {
        nombre: 'Control en proceso',
        pagina: '/control-en-proceso.html#rotulos',
        foto: /^\/api\/control-en-proceso\/fotos\/(\d+)$/,
        tabla: 'proceso_fotos',
    },
};

const texto = (v, max = 500) => String(v ?? '').trim().slice(0, max);

function fallo(status, mensaje) {
    const e = new Error(mensaje);
    e.status = status;
    return e;
}

function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ═══════════════════════════════════════════════════════════════════════════
   Lo que usan las rutas de carga de cada app, dentro de su transaccion
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Plazo del OK: el dia de la orden a las 12; si la orden empezo sabado o
 * domingo, el lunes siguiente a las 12. Usa $3 = zona y $4 = hora de corte.
 */
const VENCIDA = `(now() AT TIME ZONE $3) >= (
        ((creado_en AT TIME ZONE $3)::date
          + CASE EXTRACT(isodow FROM creado_en AT TIME ZONE $3)::int WHEN 6 THEN 2 WHEN 7 THEN 1 ELSE 0 END)
        + make_interval(hours => $4::int))`;
/** Hoy es sabado o domingo: no hay supervision. Usa $3 = zona. */
const FINDE = 'EXTRACT(isodow FROM now() AT TIME ZONE $3)::int >= 6';

async function esFinDeSemana(q = consultar) {
    const { rows } = await q(`SELECT ${FINDE.replace(/\$3/g, '$1')} AS finde`, [ZONA]);
    return rows[0].finde;
}

/**
 * Si la orden no puede recibir mas controles, el motivo; si puede, null.
 * Sin verificacion todavia (primer control) no hay freno.
 */
export async function frenoDe(c, app, orden) {
    const { rows } = await c.query(
        `SELECT estado, ${VENCIDA} AS vencida, ${FINDE} AS finde
         FROM rotulo_verificaciones WHERE app = $1 AND orden = $2`,
        [app, orden, ZONA, HORA_CORTE]
    );
    const v = rows[0];
    if (!v || v.estado === 'ok') return null;
    if (!v.vencida || v.finde) return null;
    return `Falta el segundo control de supervisión (OK de rótulo) de la orden ${orden}. ` +
        `Desde las ${HORA_CORTE}:00 no se pueden cargar más controles de una orden sin ese OK: ` +
        'pedí la aprobación desde la pestaña Rótulos.';
}

/**
 * Crea la verificacion de la orden si todavia no tiene. Devuelve su id si la
 * creo (hay que avisar a supervision despues del commit) o null.
 */
export async function registrarControl(c, app, d) {
    const { rows } = await c.query(
        `INSERT INTO rotulo_verificaciones
            (app, orden, foto_caja, foto_envase, lote, vence, producto, analista, analista_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (app, orden) DO NOTHING
         RETURNING id`,
        [app, d.orden, d.fotoCaja || null, d.fotoEnvase || null, d.lote || null, d.vence || null,
            d.producto || null, d.analista || null, d.analistaId || null]
    );
    if (!rows.length) return null;
    await c.query(
        `INSERT INTO rotulo_eventos (verificacion_id, usuario, accion, foto_caja, foto_envase)
         VALUES ($1, $2, 'primer_control', $3, $4)`,
        [rows[0].id, d.analista || null, d.fotoCaja || null, d.fotoEnvase || null]
    );
    return rows[0].id;
}

/** El estado del rotulo de una orden, para la hoja impresa y la aprobacion. */
export async function rotuloDe(app, orden, c = null) {
    const q = c ? (s, p) => c.query(s, p) : consultar;
    const { rows } = await q(
        `SELECT estado, revisado_por, revisado_en, comentario, reproceso
         FROM rotulo_verificaciones WHERE app = $1 AND orden = $2`,
        [app, orden]
    );
    return rows[0] || null;
}

/* ═══════════════════════════════════════════════════════════════════════════
   Correos
   ═══════════════════════════════════════════════════════════════════════════ */

async function cargar(id) {
    const { rows } = await consultar('SELECT * FROM rotulo_verificaciones WHERE id = $1', [id]);
    return rows[0] || null;
}

/** Las dos fotos como imagenes dentro del correo (cid), en JPEG. */
async function adjuntosDe(v) {
    const conf = APPS[v.app];
    const adjuntos = [];
    const enlaces = {};
    for (const [cid, url] of [['caja', v.foto_caja], ['envase', v.foto_envase]]) {
        if (!url) continue;
        const m = conf.foto.exec(url);
        if (!m) { enlaces[cid] = url; continue; }
        const { rows } = await consultar(`SELECT tipo, contenido FROM ${conf.tabla} WHERE id = $1`, [m[1]]);
        if (!rows[0]) continue;
        const { bytes, tipo } = await paraCorreo(rows[0].contenido, rows[0].tipo);
        adjuntos.push({ filename: `${cid}.${tipo.split('/')[1]}`, content: bytes, contentType: tipo, cid });
    }
    return { adjuntos, enlaces };
}

function cuerpo(v, { titulo, intro, color, conFotos, adjuntos, enlaces }) {
    const conf = APPS[v.app];
    const foto = (cid, rotulo) => {
        if (adjuntos.some((a) => a.cid === cid)) {
            return `<td style="padding:6px;text-align:center;vertical-align:top"><div style="font-size:12px;color:#475467;margin-bottom:4px">${rotulo}</div>` +
                `<img src="cid:${cid}" style="max-width:300px;max-height:300px;border:1px solid #d0d5dd;border-radius:6px"></td>`;
        }
        if (enlaces[cid]) return `<td style="padding:6px"><a href="${esc(enlaces[cid])}">${rotulo} (ver en Drive)</a></td>`;
        return `<td style="padding:6px;color:#b42318">${rotulo}: sin foto</td>`;
    };
    const fila = (k, val) => val ? `<tr><td style="padding:3px 10px 3px 0;color:#475467">${k}</td><td style="padding:3px 0"><b>${esc(val)}</b></td></tr>` : '';
    return `<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;color:#101828;max-width:680px">
        <div style="background:${color};color:#fff;padding:14px 18px;border-radius:10px 10px 0 0">
          <div style="font-size:12px;opacity:.85;text-transform:uppercase;letter-spacing:1px">${esc(conf.nombre)} · verificación de rótulo</div>
          <div style="font-size:19px;font-weight:700;margin-top:2px">${esc(titulo)}</div></div>
        <div style="border:1px solid #e4e7ec;border-top:0;border-radius:0 0 10px 10px;padding:14px 18px">
          <p style="margin:0 0 10px;font-size:14px">${intro}</p>
          <table style="font-size:14px;margin-bottom:10px">
            ${fila('Orden', v.orden)}${fila('Lote', v.lote)}${fila('Vencimiento', v.vence)}${fila('Producto', v.producto)}${fila('Analista', v.analista)}
          </table>
          ${v.comentario && v.estado === 'correccion' ? `<p style="background:#fef3f2;color:#b42318;padding:8px 10px;border-radius:6px;font-size:14px"><b>Corrección pedida:</b> ${esc(v.comentario)}${v.reproceso ? '<br><b>Requiere reproceso.</b>' : ''}</p>` : ''}
          ${conFotos ? `<table><tr>${foto('caja', '📦 Caja / sticker')}${foto('envase', '🏷️ Envase: lote y vencimiento')}</tr></table>` : ''}
          <p style="margin:14px 0 0"><a href="${BASE}${conf.pagina}" style="background:#0b5cff;color:#fff;text-decoration:none;padding:10px 16px;border-radius:8px;font-weight:600;display:inline-block">Abrir ${esc(conf.nombre)} → Rótulos</a></p>
          <p style="font-size:12px;color:#667085;margin:12px 0 0">Desde las ${HORA_CORTE}:00, una orden sin el OK de rótulo no acepta más controles.</p>
        </div></div>`;
}

async function mandar(para, asunto, html, texto, adjuntos) {
    if (!hayCorreo || !para.length) return;
    try {
        await enviar({ para, asunto, html, texto, adjuntos });
    } catch (err) {
        console.error('[rotulos] no se pudo mandar el correo:', err.message);
    }
}

/** A supervision: nueva orden, fotos corregidas o recordatorio. */
export async function avisarSupervision(id, motivo) {
    const v = await cargar(id);
    if (!v) return;
    // Sabado y domingo no hay quien lo lea: sale el lunes a las 8, junto con lo
    // demas del fin de semana (revisarRotulosDelFinde).
    if (await esFinDeSemana()) return;
    const para = await supervisoresDe('rotulos', 'verificacion');
    const { adjuntos, enlaces } = await adjuntosDe(v);
    const titulos = {
        nueva: [`Orden ${v.orden}: revisar rótulo`, 'Se cargó el primer control de esta orden. Revisá que el <b>lote</b> y el <b>vencimiento</b> de las fotos sean correctos y dá el OK en la app.', '#0b5cff'],
        corregida: [`Orden ${v.orden}: rótulo corregido`, 'La analista subió las fotos corregidas. Revisalas y dá el OK en la app.', '#0b5cff'],
        recordatorio: [`Orden ${v.orden}: piden el OK de rótulo`, 'La analista pide la aprobación del rótulo: sin el OK, desde el mediodía no puede cargar más controles de esta orden.', '#b54708'],
    };
    const [titulo, intro, color] = titulos[motivo] || titulos.nueva;
    await mandar(
        para,
        `[Calidad] ${APPS[v.app].nombre} — ${titulo}`,
        cuerpo(v, { titulo, intro, color, conFotos: true, adjuntos, enlaces }),
        `${titulo}\nLote: ${v.lote || '—'} · Vencimiento: ${v.vence || '—'} · Analista: ${v.analista || '—'}\n${BASE}${APPS[v.app].pagina}\n`,
        adjuntos
    );
}

/** A la analista: le piden corregir el rotulo. */
async function avisarAnalista(id) {
    const v = await cargar(id);
    if (!v || !v.analista_id) return;
    const { rows } = await consultar(
        `SELECT lower(coalesce(email, usuario)) AS correo FROM usuarios WHERE id = $1 AND coalesce(email, usuario) LIKE '%@%'`,
        [v.analista_id]
    );
    if (!rows.length) return;
    const titulo = `Orden ${v.orden}: corregir el rótulo`;
    await mandar(
        [rows[0].correo],
        `[Calidad] ${APPS[v.app].nombre} — ${titulo}`,
        cuerpo(v, {
            titulo, color: '#b42318', conFotos: false, adjuntos: [], enlaces: {},
            intro: `${esc(v.revisado_por || 'Supervisión')} pidió corregir el rótulo de esta orden. Entrá a la app, pestaña <b>Rótulos</b>, y subí las fotos corregidas.`,
        }),
        `${titulo}: ${v.comentario || ''}${v.reproceso ? ' (requiere reproceso)' : ''}\n${BASE}${APPS[v.app].pagina}\n`,
        []
    );
}

/* ═══════════════════════════════════════════════════════════════════════════
   Acciones y listado
   ═══════════════════════════════════════════════════════════════════════════ */

const ESPERA_RECORDATORIO_MIN = 10;

/**
 * ok | correccion (supervision) · corregido | solicitud (analista).
 * Devuelve la verificacion actualizada.
 */
export async function actuar(app, orden, accion, usuario, datos = {}) {
    const nombre = usuario.nombre || usuario.usuario;
    const { id, aviso } = await enTransaccion(async (c) => {
        await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`rotulo:${app}:${orden}`]);
        const { rows } = await c.query(
            'SELECT * FROM rotulo_verificaciones WHERE app = $1 AND orden = $2', [app, orden]
        );
        const v = rows[0];
        if (!v) throw fallo(404, 'Esa orden todavía no tiene controles');
        const evento = (acc, extra = {}) => c.query(
            `INSERT INTO rotulo_eventos (verificacion_id, usuario, accion, comentario, foto_caja, foto_envase, reproceso)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [v.id, nombre, acc, extra.comentario || null, extra.fotoCaja || null, extra.fotoEnvase || null,
                extra.reproceso ?? null]
        );

        if (accion === 'ok') {
            if (v.estado === 'ok') throw fallo(409, `El rótulo ya tiene el OK de ${v.revisado_por}`);
            await c.query(
                `UPDATE rotulo_verificaciones SET estado = 'ok', revisado_por = $2, revisado_por_id = $3,
                        revisado_en = now(), actualizado_en = now()
                 WHERE id = $1`,
                [v.id, nombre, usuario.id]
            );
            await evento('ok', { comentario: texto(datos.comentario, 500) });
            return { id: v.id, aviso: null };
        }
        if (accion === 'correccion') {
            if (v.estado === 'ok') throw fallo(409, 'El rótulo ya tiene el OK: no se puede pedir corrección');
            const comentario = texto(datos.comentario, 1000);
            if (comentario.length < 5) throw fallo(400, 'Escribí qué hay que corregir');
            const reproceso = datos.reproceso === true;
            await c.query(
                `UPDATE rotulo_verificaciones SET estado = 'correccion', comentario = $2, reproceso = $3,
                        revisado_por = $4, revisado_por_id = $5, revisado_en = now(), actualizado_en = now()
                 WHERE id = $1`,
                [v.id, comentario, reproceso, nombre, usuario.id]
            );
            await evento('correccion', { comentario, reproceso });
            return { id: v.id, aviso: 'analista' };
        }
        if (accion === 'corregido') {
            if (v.estado === 'ok') throw fallo(409, 'El rótulo ya tiene el OK');
            const fotoCaja = texto(datos.fotoCaja, 600);
            const fotoEnvase = texto(datos.fotoEnvase, 600);
            if (!APPS[app].foto.test(fotoCaja) || !APPS[app].foto.test(fotoEnvase)) {
                throw fallo(400, 'Faltan las dos fotos corregidas: caja y envase');
            }
            const nota = texto(datos.comentario, 1000);
            await c.query(
                `UPDATE rotulo_verificaciones SET estado = 'pendiente', foto_caja = $2, foto_envase = $3,
                        lote = COALESCE(NULLIF($4, ''), lote), vence = COALESCE(NULLIF($5, ''), vence),
                        actualizado_en = now()
                 WHERE id = $1`,
                [v.id, fotoCaja, fotoEnvase, texto(datos.lote, 60), texto(datos.vence, 30)]
            );
            await evento('corregido', { comentario: nota, fotoCaja, fotoEnvase });
            return { id: v.id, aviso: 'corregida' };
        }
        if (accion === 'solicitud') {
            if (v.estado === 'ok') throw fallo(409, 'El rótulo ya tiene el OK');
            if (await esFinDeSemana((s, p) => c.query(s, p))) {
                throw fallo(409, 'El fin de semana no hay supervisión: la orden no está frenada y se revisa el lunes');
            }
            if (v.ultimo_pedido && Date.now() - new Date(v.ultimo_pedido).getTime() < ESPERA_RECORDATORIO_MIN * 60000) {
                throw fallo(429, `Ya se pidió hace menos de ${ESPERA_RECORDATORIO_MIN} minutos`);
            }
            await c.query('UPDATE rotulo_verificaciones SET ultimo_pedido = now() WHERE id = $1', [v.id]);
            await evento('solicitud');
            return { id: v.id, aviso: 'recordatorio' };
        }
        throw fallo(400, 'Acción desconocida');
    });

    if (aviso === 'analista') avisarAnalista(id).catch(() => {});
    else if (aviso) avisarSupervision(id, aviso).catch(() => {});
    return cargar(id);
}

/** Las pendientes y en correccion, y las resueltas de los ultimos dias. */
export async function listar(app, dias = 7) {
    const { rows } = await consultar(
        `SELECT v.*,
                (SELECT json_agg(json_build_object('ts', e.ts, 'usuario', e.usuario, 'accion', e.accion,
                                                   'comentario', e.comentario, 'reproceso', e.reproceso)
                                 ORDER BY e.ts)
                 FROM rotulo_eventos e WHERE e.verificacion_id = v.id) AS eventos,
                ${VENCIDA.replace(/creado_en/g, 'v.creado_en')} AND NOT ${FINDE} AS vencida
         FROM rotulo_verificaciones v
         WHERE v.app = $1
           AND (v.estado <> 'ok' OR v.actualizado_en >= now() - ($2 || ' days')::interval)
         ORDER BY (v.estado = 'ok'), v.creado_en DESC`,
        [app, String(dias), ZONA, HORA_CORTE]
    );
    return rows.map((v) => ({
        orden: v.orden, estado: v.estado,
        fotoCaja: v.foto_caja, fotoEnvase: v.foto_envase,
        lote: v.lote || '', vence: v.vence || '', producto: v.producto || '', analista: v.analista || '',
        creadoEn: v.creado_en, revisadoPor: v.revisado_por || '', revisadoEn: v.revisado_en,
        comentario: v.comentario || '', reproceso: v.reproceso,
        frenada: v.estado !== 'ok' && Boolean(v.vencida),
        eventos: v.eventos || [],
    }));
}

/**
 * Las rutas de la pestaña Rótulos, iguales en las dos apps.
 * Los permisos son los de cada app: dan el OK quienes pueden aprobar alli.
 */
export function montarRutasRotulo(router, app, { leer, cargar: cargarP, aprobar }) {
    const responder = (err, res, next) => (err.status
        ? res.status(err.status).json({ ok: false, error: err.message })
        : next(err));
    const orden = (req) => texto(req.params.orden, 100);

    router.get('/rotulos', leer, async (_req, res, next) => {
        try {
            res.json({ ok: true, horaCorte: HORA_CORTE, rotulos: await listar(app) });
        } catch (err) { next(err); }
    });
    router.post('/rotulos/:orden/ok', aprobar, async (req, res, next) => {
        try { res.json({ ok: true, rotulo: await actuar(app, orden(req), 'ok', req.usuario, req.body || {}) }); }
        catch (err) { responder(err, res, next); }
    });
    router.post('/rotulos/:orden/correccion', aprobar, async (req, res, next) => {
        try { res.json({ ok: true, rotulo: await actuar(app, orden(req), 'correccion', req.usuario, req.body || {}) }); }
        catch (err) { responder(err, res, next); }
    });
    router.post('/rotulos/:orden/corregido', cargarP, async (req, res, next) => {
        try { res.json({ ok: true, rotulo: await actuar(app, orden(req), 'corregido', req.usuario, req.body || {}) }); }
        catch (err) { responder(err, res, next); }
    });
    router.post('/rotulos/:orden/solicitar', cargarP, async (req, res, next) => {
        try { res.json({ ok: true, rotulo: await actuar(app, orden(req), 'solicitud', req.usuario) }); }
        catch (err) { responder(err, res, next); }
    });
}

/**
 * Lunes a las 8: las ordenes del fin de semana que esperan el OK, con sus
 * fotos, en un solo correo. Tienen plazo hasta las 12 de ese lunes.
 */
export async function revisarRotulosDelFinde({ forzar = false, soloPrevisualizar = false } = {}) {
    if (!hayCorreo) return { estado: 'sin correo configurado' };
    return correrUnaVezPorDia('rotulos_fin_de_semana', { hora: 8, diaSemana: 1, forzar, activa: true }, async () => {
        const { rows } = await consultar(
            `SELECT * FROM rotulo_verificaciones
             WHERE estado <> 'ok'
               AND EXTRACT(isodow FROM actualizado_en AT TIME ZONE $1)::int >= 6
               AND actualizado_en >= now() - interval '4 days'
             ORDER BY app, creado_en`,
            [ZONA]
        );
        if (!rows.length) return { ordenes: 0, correos: 0, detalle: 'nada del fin de semana' };
        const para = await supervisoresDe('rotulos', 'verificacion');
        const asunto = `[Calidad] Rótulos del fin de semana: ${rows.length} orden(es) para revisar antes de las ${HORA_CORTE}`;
        if (soloPrevisualizar) {
            return { modo: 'previsualizacion', asunto, para, correos: 0, ordenes: rows.map((v) => `${APPS[v.app].nombre} ${v.orden}`) };
        }
        const adjuntos = [];
        const bloques = [];
        for (const [i, v] of rows.entries()) {
            const propios = await adjuntosDe(v);
            const cids = {};
            for (const a of propios.adjuntos) {
                const cid = `${a.cid}_${i}`;
                adjuntos.push({ ...a, cid, filename: `${v.orden}_${a.filename}` });
                cids[a.cid] = cid;
            }
            const foto = (k, t) => (cids[k]
                ? `<td style="padding:4px;vertical-align:top;text-align:center"><div style="font-size:12px;color:#475467">${t}</div><img src="cid:${cids[k]}" style="max-width:240px;max-height:240px;border:1px solid #d0d5dd;border-radius:6px"></td>`
                : `<td style="padding:4px;color:#b42318;font-size:12px">${t}: ${propios.enlaces[k] ? `<a href="${esc(propios.enlaces[k])}">ver en Drive</a>` : 'sin foto'}</td>`);
            bloques.push(`<div style="border:1px solid #e4e7ec;border-radius:10px;padding:12px;margin:10px 0">
                <div style="font-size:16px;font-weight:700">${esc(APPS[v.app].nombre)} · Orden ${esc(v.orden)}</div>
                <div style="font-size:13px;color:#475467;margin:4px 0 8px">Lote <b>${esc(v.lote || '—')}</b>${v.vence ? ` · Vence <b>${esc(v.vence)}</b>` : ''} · ${esc(v.producto || '')} · ${esc(v.analista || '')}${v.estado === 'correccion' ? ' · <b style="color:#b42318">corrección pedida</b>' : ''}</div>
                <table><tr>${foto('caja', '📦 Caja')}${foto('envase', '🏷️ Envase')}</tr></table>
                <a href="${BASE}${APPS[v.app].pagina}">Abrir ${esc(APPS[v.app].nombre)} → Rótulos</a></div>`);
        }
        const html = `<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;color:#101828;max-width:700px">
            <h2 style="margin:0 0 6px">Rótulos del fin de semana</h2>
            <p style="font-size:14px;margin:0 0 6px">Órdenes cargadas el sábado o el domingo que esperan el OK de rótulo. <b>Tienen plazo hasta hoy a las ${HORA_CORTE}:00</b>: después, sin OK no aceptan más controles.</p>
            ${bloques.join('')}</div>`;
        const texto = `${asunto}\n${rows.map((v) => `- ${APPS[v.app].nombre} orden ${v.orden} (lote ${v.lote || '—'})`).join('\n')}\n`;
        await mandar(para, asunto, html, texto, adjuntos);
        return { ordenes: rows.length, correos: 1, detalle: `${rows.length} orden(es) del fin de semana` };
    });
}
