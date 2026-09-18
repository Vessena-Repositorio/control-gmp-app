/**
 * SAO-001 — carga de resultados en la app (migracion 039).
 *
 * Reemplaza la carga en la planilla de Google. Reglas pedidas por Claudia
 * (18/09/2026):
 *   - Especificaciones: las del dashboard (lib/sao001-specs.js).
 *   - Rango fisico (sao001_rangos): lo imposible no se guarda.
 *   - OOS: se guarda con comentario obligatorio. Si es fisicoquimico queda
 *     pendiente una segunda muestra de confirmacion; si es micro, no.
 *   - El micro se carga dias despues sobre la misma muestra.
 *   - Sin aprobacion; toda correccion lleva motivo y queda en sao001_cambios.
 *
 * El dashboard sigue leyendo /api/sao001 (routes/sao001.js): el CSV historico
 * mas las filas de aca, armadas con las mismas columnas (csvDeRegistros).
 */
import { Router } from 'express';
import { consultar, enTransaccion } from '../db.js';
import { exigirPermiso } from '../lib/acceso.js';
import { PERMISOS_POR_ROL } from '../lib/permisos.js';
import { ZONA } from '../lib/tareas.js';
import { parsearCsv } from '../lib/csv.js';
import { CODIGO, parseValor, evaluarValor } from '../lib/sao001-specs.js';
import { sincronizarSao001 } from '../sync/sync-sao001.js';

export const rutasSao001Carga = Router();

const RECURSO = 'sao001-carga';
const leer = exigirPermiso(RECURSO, 'ver');
const cargar = exigirPermiso(RECURSO, 'cargar');
const administrar = exigirPermiso(RECURSO, 'administrar');

const FECHA = /^\d{4}-\d{2}-\d{2}$/;
const texto = (v, max = 500) => String(v ?? '').trim().slice(0, max);

function fallo(status, mensaje) {
    const e = new Error(mensaje);
    e.status = status;
    return e;
}
function responder(err, res, next) {
    if (err.status) return res.status(err.status).json({ ok: false, error: err.message });
    next(err);
}

/* ═══════════════════════════════════════════════════════════════════════════
   Configuracion
   ═══════════════════════════════════════════════════════════════════════════ */

/** Columnas de la planilla con los limites de cada punto. */
const COLUMNAS_LIMITE = ['Min pH', 'Max. pH', 'Max Cond', 'Min Cloro', 'Max Cloro', 'Min Ozono', 'Max Ozono',
    'Alerta Micro', 'MAX MICRO', 'max TOC', 'Max Dureza'];

/**
 * Completa descripcion, sistema y textos de limites de los puntos desde el
 * ultimo CSV de la planilla (la fila mas nueva de cada punto). Se hace una vez.
 */
async function asegurarPuntos() {
    const { rows: faltan } = await consultar(
        "SELECT codigo FROM sao001_puntos WHERE limites = '{}'::jsonb OR descripcion IS NULL"
    );
    if (!faltan.length) return;
    const { rows } = await consultar('SELECT csv FROM sao001_snapshot ORDER BY descargado_en DESC LIMIT 1');
    if (!rows.length) return;
    const filas = parsearCsv(rows[0].csv);
    const enc = filas[0].map((h) => String(h).trim());
    const col = (nombre) => enc.indexOf(nombre);
    const ultimo = new Map();
    for (const f of filas.slice(1)) {
        const p = String(f[0] || '').trim();
        if (p) ultimo.set(p, f);
    }
    for (const { codigo } of faltan) {
        const f = ultimo.get(codigo);
        if (!f) continue;
        const limites = {};
        for (const c of COLUMNAS_LIMITE) if (col(c) >= 0) limites[c] = String(f[col(c)] ?? '').trim();
        await consultar(
            `UPDATE sao001_puntos SET descripcion = COALESCE(descripcion, $2), sistema = COALESCE(sistema, $3),
                    limites = CASE WHEN limites = '{}'::jsonb THEN $4::jsonb ELSE limites END
             WHERE codigo = $1`,
            [codigo, texto(f[1], 200), texto(f[2], 100), JSON.stringify(limites)]
        );
    }
}

async function config() {
    await asegurarPuntos();
    const [{ rows: puntos }, { rows: rangos }, { rows: cfg }] = await Promise.all([
        consultar('SELECT * FROM sao001_puntos ORDER BY orden'),
        consultar('SELECT * FROM sao001_rangos ORDER BY orden'),
        consultar('SELECT clave, valor FROM sao001_config'),
    ]);
    return {
        fase: (cfg.find((c) => c.clave === 'fase') || {}).valor || '',
        rangos: rangos.map((r) => ({ ...r, fis_min: Number(r.fis_min), fis_max: Number(r.fis_max) })),
        puntos,
    };
}

async function hoyLocal(c = null) {
    const q = c ? (s, p) => c.query(s, p) : consultar;
    const { rows } = await q('SELECT (now() AT TIME ZONE $1)::date::text AS hoy', [ZONA]);
    return rows[0].hoy;
}

/** 1 = lunes ... 7 = domingo */
function diaIso(fecha) {
    const d = new Date(`${fecha}T12:00:00Z`).getUTCDay();
    return d === 0 ? 7 : d;
}
const diasEntre = (a, b) => Math.round((new Date(`${b}T12:00:00Z`) - new Date(`${a}T12:00:00Z`)) / 86400000);

/* ═══════════════════════════════════════════════════════════════════════════
   Validacion de un valor
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Revisa un valor: que sea un numero (se acepta "<0.1"), que este dentro del
 * rango fisico, y como da contra la especificacion del dashboard.
 * Devuelve { texto, status, detail, spec } o tira 400.
 */
function revisarValor(punto, clave, valor, rango) {
    const t = texto(valor, 30).replace(',', '.');
    if (!t) return null;
    const p = parseValor(t);
    if (p.kind !== 'num') throw fallo(400, `${rango.nombre}: "${valor}" no es un número`);
    if (p.value < Number(rango.fis_min) || p.value > Number(rango.fis_max)) {
        throw fallo(400, `${rango.nombre}: ${t} es imposible (rango físico ${rango.fis_min} a ${rango.fis_max} ${rango.unidad || ''}). Revisá si hay un error de tipeo.`);
    }
    return { texto: t, ...evaluarValor(punto, clave, t) };
}

/* ═══════════════════════════════════════════════════════════════════════════
   Lectura
   ═══════════════════════════════════════════════════════════════════════════ */

rutasSao001Carga.get('/sesion', leer, async (req, res, next) => {
    try {
        const { rows } = await consultar('SELECT cerrado_en FROM sao001_corte');
        res.json({
            ok: true,
            nombre: req.usuario.nombre || req.usuario.usuario,
            permisos: PERMISOS_POR_ROL[req.rol] || [],
            planillaCerrada: rows.length > 0,
            hoy: await hoyLocal(),
        });
    } catch (err) { next(err); }
});

/** El codigo de las especificaciones del dashboard, para evaluar en la pantalla. */
rutasSao001Carga.get('/especificaciones.js', leer, (_req, res) => {
    res.type('application/javascript; charset=utf-8').send(
        `window.SAO_SPEC = (function () {\n${CODIGO}\nreturn { SPECS: SPECS, parseValor: parseValor, evaluar: evaluar, formatSpec: formatSpec };\n})();\n`
    );
});

rutasSao001Carga.get('/config', leer, async (_req, res, next) => {
    try { res.json({ ok: true, ...(await config()) }); } catch (err) { next(err); }
});

/**
 * GET /dia?fecha=AAAA-MM-DD — la planilla del dia: los puntos que tocan segun
 * el plan, con sus parametros y si toca micro, y lo ya cargado esa fecha.
 *
 * Diario = lunes a sabado. Quincenal y mensual se calculan desde el ultimo micro
 * de ese punto (en la planilla vieja o en la app): tocan en su dia si pasaron
 * 13 (quincenal) o 27 (mensual) dias, y cualquier dia si ya se atrasaron.
 */
rutasSao001Carga.get('/dia', leer, async (req, res, next) => {
    try {
        const fecha = FECHA.test(String(req.query.fecha)) ? String(req.query.fecha) : await hoyLocal();
        const cfg = await config();
        const dow = diaIso(fecha);
        const { rows: ult } = await consultar(
            `SELECT punto, max(fecha)::text AS ultima FROM (
                SELECT m.punto, m.fecha FROM sao001_muestras m
                JOIN sao001_parametros p ON p.muestra_id = m.id AND p.parametro = 'micro'
                WHERE m.fecha < $1::date
                UNION ALL
                SELECT punto, fecha FROM sao001_registros WHERE micro_esperado AND NOT anulado AND fecha < $1::date
             ) x GROUP BY punto`,
            [fecha]
        );
        const ultimoMicro = new Map(ult.map((u) => [u.punto, u.ultima]));
        const { rows: registros } = await consultar(
            'SELECT * FROM sao001_registros WHERE fecha = $1 AND NOT anulado ORDER BY registrado_en', [fecha]
        );

        const puntos = [];
        for (const p of cfg.puntos) {
            if (!p.activo) continue;
            const fq = (p.fq_frecuencia === 'diaria' && dow <= 6) || (p.fq_frecuencia === 'semanal' && dow === p.fq_dia)
                ? p.fq_parametros : [];
            const ultima = ultimoMicro.get(p.codigo) || null;
            const dias = ultima ? diasEntre(ultima, fecha) : Infinity;
            let micro = false; let atrasado = false;
            if (p.micro_frecuencia === 'semanal') { micro = dow === p.micro_dia; atrasado = !micro && dias >= 9; }
            if (p.micro_frecuencia === 'quincenal') { micro = dow === p.micro_dia && dias >= 13; atrasado = !micro && dias >= 17; }
            if (p.micro_frecuencia === 'mensual') { micro = dow === p.micro_dia && dias >= 27; atrasado = !micro && dias >= 34; }
            if (dow === 7) atrasado = false; // domingo no se muestrea
            if (!fq.length && !micro && !atrasado) continue;
            puntos.push({
                codigo: p.codigo, descripcion: p.descripcion || '', sistema: p.sistema || '',
                fq, micro: micro || atrasado, microAtrasado: atrasado,
                ultimoMicro: ultima,
            });
        }
        res.json({ ok: true, fecha, dia: dow, fase: cfg.fase, puntos, registros });
    } catch (err) { next(err); }
});

/** GET /pendientes — micro sin resultado y segundas muestras por hacer. */
rutasSao001Carga.get('/pendientes', leer, async (_req, res, next) => {
    try {
        const [{ rows: micro }, { rows: segundas }] = await Promise.all([
            consultar(`SELECT id, fecha::text, punto, registrado_por FROM sao001_registros
                       WHERE micro_esperado AND micro IS NULL AND NOT anulado ORDER BY fecha, punto`),
            consultar(`SELECT id, fecha::text, punto, valores, oos, comentarios_oos, registrado_por FROM sao001_registros
                       WHERE segunda_pendiente AND NOT anulado ORDER BY fecha, punto`),
        ]);
        res.json({ ok: true, micro, segundas });
    } catch (err) { next(err); }
});

/** GET /registros?desde=&hasta= — lo cargado en la app, con sus correcciones. */
rutasSao001Carga.get('/registros', leer, async (req, res, next) => {
    try {
        const hoy = await hoyLocal();
        const hasta = FECHA.test(String(req.query.hasta)) ? String(req.query.hasta) : hoy;
        const desde = FECHA.test(String(req.query.desde)) ? String(req.query.desde) : null;
        const { rows } = await consultar(
            `SELECT r.*, r.fecha::text AS fecha,
                    (SELECT json_agg(json_build_object('ts', c.ts, 'usuario', c.usuario, 'campo', c.campo,
                                                       'antes', c.antes, 'despues', c.despues, 'motivo', c.motivo)
                                     ORDER BY c.ts)
                     FROM sao001_cambios c WHERE c.registro_id = r.id) AS cambios
             FROM sao001_registros r
             WHERE r.fecha <= $1::date AND r.fecha >= COALESCE($2::date, $1::date - 30)
             ORDER BY r.fecha DESC, r.punto, r.id`,
            [hasta, desde]
        );
        res.json({ ok: true, registros: rows });
    } catch (err) { next(err); }
});

/* ═══════════════════════════════════════════════════════════════════════════
   Carga
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * POST /registros
 *   { id_envio, fecha, punto, valores: {cloro: "1.5"}, micro_esperado, micro,
 *     comentarios_oos: {cloro: "..."}, observaciones, segunda_de }
 */
rutasSao001Carga.post('/registros', cargar, async (req, res, next) => {
    const d = req.body || {};
    try {
        const idEnvio = texto(d.id_envio, 64);
        if (!/^[A-Za-z0-9-]{8,64}$/.test(idEnvio)) throw fallo(400, 'Falta el identificador del envío');
        const fecha = texto(d.fecha, 10);
        if (!FECHA.test(fecha)) throw fallo(400, 'Fecha inválida');
        const cfg = await config();
        const punto = cfg.puntos.find((p) => p.codigo === texto(d.punto, 20));
        if (!punto) throw fallo(400, 'Punto de muestreo desconocido');
        const rangos = new Map(cfg.rangos.map((r) => [r.parametro, r]));

        // Fisicoquimicos
        const valores = {}; const oos = []; const faltaComentario = []; const comentarios = {};
        const entrada = d.valores && typeof d.valores === 'object' ? d.valores : {};
        for (const [clave, valor] of Object.entries(entrada)) {
            const rango = rangos.get(clave);
            if (!rango || clave === 'micro') continue;
            const r = revisarValor(punto.codigo, clave, valor, rango);
            if (!r) continue;
            valores[clave] = r.texto;
            if (r.status === 'crit') {
                const com = texto(d.comentarios_oos?.[clave], 1000);
                if (com.length < 5) faltaComentario.push(`${rango.nombre} (${r.detail || 'OOS'})`);
                else comentarios[clave] = com;
                oos.push(clave);
            }
        }
        // Micro, si ya viene el resultado
        let micro = null;
        if (texto(d.micro)) {
            const r = revisarValor(punto.codigo, 'micro', d.micro, rangos.get('micro'));
            micro = r.texto;
            if (r.status === 'crit') {
                const com = texto(d.comentarios_oos?.micro, 1000);
                if (com.length < 5) faltaComentario.push(`Aerobios (${r.detail || 'OOS'})`);
                else comentarios.micro = com;
            }
        }
        if (faltaComentario.length) {
            throw fallo(400, `Fuera de especificación: ${faltaComentario.join(', ')}. Escribí un comentario para cada uno.`);
        }
        const microEsperado = d.micro_esperado === true || micro !== null;
        if (!Object.keys(valores).length && !microEsperado) throw fallo(400, 'No hay ningún valor para guardar');

        const segundaDe = d.segunda_de ? Number(d.segunda_de) : null;
        const resultado = await enTransaccion(async (c) => {
            await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['sao001-registro']);
            const prev = await c.query('SELECT * FROM sao001_registros WHERE id_envio = $1', [idEnvio]);
            if (prev.rows.length) return { registro: prev.rows[0], repetido: true };

            const hoy = await hoyLocal(c);
            if (fecha > hoy) throw fallo(400, 'La fecha de muestreo no puede ser futura');
            if (diasEntre(fecha, hoy) > 60) throw fallo(400, 'La fecha de muestreo tiene más de 60 días');

            let original = null;
            if (segundaDe) {
                const { rows } = await c.query('SELECT * FROM sao001_registros WHERE id = $1 FOR UPDATE', [segundaDe]);
                original = rows[0];
                if (!original || original.anulado || !original.segunda_pendiente) throw fallo(409, 'Esa muestra no tiene una segunda muestra pendiente');
                if (original.punto !== punto.codigo) throw fallo(400, 'La segunda muestra tiene que ser del mismo punto');
                const faltan = original.oos.filter((k) => !(k in valores));
                if (faltan.length) throw fallo(400, `La segunda muestra tiene que traer: ${faltan.map((k) => rangos.get(k)?.nombre || k).join(', ')}`);
            }

            const { rows } = await c.query(
                `INSERT INTO sao001_registros
                    (fecha, punto, fase, valores, micro, micro_esperado, micro_cargado_por, micro_cargado_en,
                     observaciones, comentarios_oos, oos, segunda_de, segunda_pendiente,
                     registrado_por, registrado_por_id, id_envio)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, CASE WHEN $5::text IS NULL THEN NULL ELSE now() END,
                         $8, $9, $10, $11, $12, $13, $14, $15)
                 RETURNING *`,
                [fecha, punto.codigo, cfg.fase, JSON.stringify(valores), micro, microEsperado,
                    micro ? (req.usuario.nombre || req.usuario.usuario) : null,
                    texto(d.observaciones, 1000) || null, JSON.stringify(comentarios), oos,
                    segundaDe, !segundaDe && oos.length > 0,
                    req.usuario.nombre || req.usuario.usuario, req.usuario.id, idEnvio]
            );
            if (original) {
                const conf = { ...original.confirmacion };
                for (const k of original.oos) conf[k] = oos.includes(k) ? 'confirmado' : 'no confirmado';
                await c.query(
                    'UPDATE sao001_registros SET segunda_pendiente = false, confirmacion = $2 WHERE id = $1',
                    [original.id, JSON.stringify(conf)]
                );
            }
            return { registro: rows[0], repetido: false };
        });
        res.json({ ok: true, ...resultado, segundaPendiente: resultado.registro.segunda_pendiente });
    } catch (err) { responder(err, res, next); }
});

/** POST /registros/:id/micro  { valor, comentario } — el resultado que llega despues. */
rutasSao001Carga.post('/registros/:id/micro', cargar, async (req, res, next) => {
    try {
        const cfg = await config();
        const rango = cfg.rangos.find((r) => r.parametro === 'micro');
        const r = await enTransaccion(async (c) => {
            const { rows } = await c.query('SELECT * FROM sao001_registros WHERE id = $1 FOR UPDATE', [req.params.id]);
            const reg = rows[0];
            if (!reg || reg.anulado) throw fallo(404, 'No existe esa muestra');
            if (reg.micro !== null) throw fallo(409, 'Esa muestra ya tiene el resultado de micro: para cambiarlo usá Corregir');
            const v = revisarValor(reg.punto, 'micro', req.body?.valor, rango);
            if (!v) throw fallo(400, 'Falta el resultado');
            const comentarios = { ...reg.comentarios_oos };
            if (v.status === 'crit') {
                const com = texto(req.body?.comentario, 1000);
                if (com.length < 5) throw fallo(400, `Fuera de especificación (${v.detail}). Escribí un comentario.`);
                comentarios.micro = com;
            }
            const { rows: act } = await c.query(
                `UPDATE sao001_registros SET micro = $2, micro_esperado = true, micro_cargado_por = $3,
                        micro_cargado_en = now(), comentarios_oos = $4
                 WHERE id = $1 RETURNING *`,
                [reg.id, v.texto, req.usuario.nombre || req.usuario.usuario, JSON.stringify(comentarios)]
            );
            return act[0];
        });
        res.json({ ok: true, registro: r });
    } catch (err) { responder(err, res, next); }
});

/**
 * POST /registros/:id/corregir  { campo, valor, motivo }
 * campo: un parametro, 'micro' u 'observaciones'. Queda en sao001_cambios.
 */
rutasSao001Carga.post('/registros/:id/corregir', cargar, async (req, res, next) => {
    try {
        const campo = texto(req.body?.campo, 20);
        const motivo = texto(req.body?.motivo, 1000);
        if (motivo.length < 10) throw fallo(400, 'Escribí el motivo de la corrección (al menos 10 caracteres)');
        const cfg = await config();
        const rango = cfg.rangos.find((r) => r.parametro === campo);
        if (!rango && campo !== 'observaciones') throw fallo(400, 'Campo desconocido');
        const r = await enTransaccion(async (c) => {
            const { rows } = await c.query('SELECT * FROM sao001_registros WHERE id = $1 FOR UPDATE', [req.params.id]);
            const reg = rows[0];
            if (!reg || reg.anulado) throw fallo(404, 'No existe esa muestra');
            let antes; let despues;
            if (campo === 'observaciones') {
                antes = reg.observaciones || ''; despues = texto(req.body?.valor, 1000);
                await c.query('UPDATE sao001_registros SET observaciones = $2 WHERE id = $1', [reg.id, despues || null]);
            } else {
                const v = revisarValor(reg.punto, campo, req.body?.valor, rango);
                despues = v ? v.texto : '';
                const comentarios = { ...reg.comentarios_oos };
                if (v && v.status === 'crit') comentarios[campo] = motivo;
                if (campo === 'micro') {
                    antes = reg.micro || '';
                    await c.query(
                        `UPDATE sao001_registros SET micro = $2, micro_esperado = true, comentarios_oos = $3,
                                micro_cargado_por = COALESCE(micro_cargado_por, $4), micro_cargado_en = COALESCE(micro_cargado_en, now())
                         WHERE id = $1`,
                        [reg.id, despues || null, JSON.stringify(comentarios), req.usuario.nombre || req.usuario.usuario]
                    );
                } else {
                    antes = reg.valores[campo] || '';
                    const valores = { ...reg.valores };
                    if (despues) valores[campo] = despues; else delete valores[campo];
                    let oos = reg.oos.filter((k) => k !== campo);
                    if (v && v.status === 'crit') oos = [...oos, campo];
                    const pendiente = !reg.segunda_de && oos.some((k) => !(k in (reg.confirmacion || {})));
                    await c.query(
                        `UPDATE sao001_registros SET valores = $2, oos = $3, comentarios_oos = $4, segunda_pendiente = $5
                         WHERE id = $1`,
                        [reg.id, JSON.stringify(valores), oos, JSON.stringify(comentarios), pendiente]
                    );
                }
            }
            if (antes === despues) throw fallo(400, 'El valor no cambió');
            await c.query(
                'INSERT INTO sao001_cambios (registro_id, usuario, campo, antes, despues, motivo) VALUES ($1, $2, $3, $4, $5, $6)',
                [reg.id, req.usuario.nombre || req.usuario.usuario, campo, antes, despues, motivo]
            );
            const { rows: act } = await c.query('SELECT * FROM sao001_registros WHERE id = $1', [reg.id]);
            return act[0];
        });
        res.json({ ok: true, registro: r });
    } catch (err) { responder(err, res, next); }
});

/** POST /registros/:id/anular { motivo } — solo administradoras; no se borra. */
rutasSao001Carga.post('/registros/:id/anular', administrar, async (req, res, next) => {
    try {
        const motivo = texto(req.body?.motivo, 1000);
        if (motivo.length < 10) throw fallo(400, 'Escribí el motivo (al menos 10 caracteres)');
        await enTransaccion(async (c) => {
            const { rows } = await c.query(
                'UPDATE sao001_registros SET anulado = true, anulado_motivo = $2, segunda_pendiente = false WHERE id = $1 AND NOT anulado RETURNING id',
                [req.params.id, motivo]
            );
            if (!rows.length) throw fallo(404, 'No existe esa muestra o ya está anulada');
            await c.query(
                "INSERT INTO sao001_cambios (registro_id, usuario, campo, antes, despues, motivo) VALUES ($1, $2, 'anulado', 'no', 'sí', $3)",
                [req.params.id, req.usuario.nombre || req.usuario.usuario, motivo]
            );
        });
        res.json({ ok: true });
    } catch (err) { responder(err, res, next); }
});

/* ═══════════════════════════════════════════════════════════════════════════
   Administracion
   ═══════════════════════════════════════════════════════════════════════════ */

rutasSao001Carga.post('/config/fase', administrar, async (req, res, next) => {
    try {
        const fase = texto(req.body?.fase, 10);
        if (!/^[1-9]$/.test(fase)) throw fallo(400, 'Fase inválida');
        await consultar("UPDATE sao001_config SET valor = $1 WHERE clave = 'fase'", [fase]);
        res.json({ ok: true, fase });
    } catch (err) { responder(err, res, next); }
});

rutasSao001Carga.post('/config/rangos/:parametro', administrar, async (req, res, next) => {
    try {
        const min = Number(req.body?.fis_min); const max = Number(req.body?.fis_max);
        if (!Number.isFinite(min) || !Number.isFinite(max) || min >= max) throw fallo(400, 'Rango inválido');
        const { rowCount } = await consultar(
            'UPDATE sao001_rangos SET fis_min = $2, fis_max = $3 WHERE parametro = $1', [req.params.parametro, min, max]
        );
        if (!rowCount) throw fallo(404, 'Parámetro desconocido');
        res.json({ ok: true });
    } catch (err) { responder(err, res, next); }
});

/**
 * POST /cerrar-planilla — una sola vez: ultima copia de la planilla de Google y
 * desde ahi la replica no la vuelve a bajar. Lo cargado en la hoja despues de
 * esto no entra.
 */
rutasSao001Carga.post('/cerrar-planilla', administrar, async (req, res, next) => {
    try {
        const { rows: ya } = await consultar('SELECT 1 FROM sao001_corte');
        if (ya.length) throw fallo(409, 'La planilla ya está cerrada');
        let conteo;
        try { conteo = await sincronizarSao001(); } catch (err) {
            throw fallo(502, `No se pudo hacer la última copia de la planilla (${err.message}). No se cerró nada.`);
        }
        await consultar('INSERT INTO sao001_corte (cerrado_por) VALUES ($1)', [req.usuario.nombre || req.usuario.usuario]);
        await asegurarPuntos();
        res.json({ ok: true, ...conteo });
    } catch (err) { responder(err, res, next); }
});

/* ═══════════════════════════════════════════════════════════════════════════
   CSV para el dashboard
   ═══════════════════════════════════════════════════════════════════════════ */

const csvCelda = (v) => {
    const s = String(v ?? '');
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/**
 * Las filas cargadas en la app, con el mismo encabezado que el CSV de la
 * planilla. Las anuladas no salen.
 */
export async function csvDeRegistros(encabezado) {
    const { rows } = await consultar(
        `SELECT r.*, to_char(r.fecha, 'DD/MM/YYYY') AS fecha_dma, p.descripcion, p.sistema, p.limites, p.orden
         FROM sao001_registros r JOIN sao001_puntos p ON p.codigo = r.punto
         WHERE NOT r.anulado
         ORDER BY r.fecha, p.orden, r.id`
    );
    if (!rows.length) return '';
    const { rows: rangos } = await consultar('SELECT parametro, nombre FROM sao001_rangos');
    const nombre = new Map(rangos.map((r) => [r.parametro, r.nombre]));
    const lineas = rows.map((r) => {
        const v = r.valores || {};
        const obs = [r.observaciones];
        if (r.segunda_de) obs.push('Segunda muestra (confirmación de OOS)');
        for (const [k, com] of Object.entries(r.comentarios_oos || {})) obs.push(`OOS ${nombre.get(k) || k}: ${com}`);
        for (const [k, res] of Object.entries(r.confirmacion || {})) obs.push(`${nombre.get(k) || k}: OOS ${res} en segunda muestra`);
        const campo = {
            '*': r.punto, 'Comentarios': r.descripcion || '', 'Sistema': r.sistema || '', 'Fases': r.fase || '',
            'pH': v.ph, 'Cond': v.cond, 'Cloro': v.cloro, 'Ozono': v.ozono, 'MICRO': r.micro, 'TOC': v.toc,
            'Dureza': v.dureza, 'OBSERVACIONES': obs.filter(Boolean).join(' · '),
            ...(r.limites || {}),
        };
        return encabezado.map((h) => csvCelda(h.startsWith('Fecha') ? r.fecha_dma : (campo[h] ?? ''))).join(',');
    });
    return lineas.join('\n');
}
