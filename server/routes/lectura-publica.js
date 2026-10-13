/**
 * Lectura de documentos por QR, sin usuario (migracion 058).
 *
 * Lo usan los operarios de planta desde un celular o una tablet de la red
 * interna. No hay sesion: el acceso es el token del QR, largo y aleatorio.
 *
 *   /s/:token  sesion de capacitacion abierta por Calidad (vence en horas)
 *   /d/:token  QR fijo del puesto: siempre la version vigente, solo lectura
 *
 * El PDF se entrega para verlo en la pagina, marcado como copia no controlada
 * y sin ofrecer descarga. Que nadie pueda sacarle una foto a la pantalla no se
 * puede garantizar; por eso la marca lleva la fecha.
 */
import { Router } from 'express';
import { consultar } from '../db.js';
import { enTransaccionSistema } from '../lib/audit-trail.js';
import { leer as leerArchivo } from '../lib/almacen-documentos.js';
import { marcarCopiaNoControlada } from '../lib/marca-agua.js';
import { personaPorCodigo, preguntasPublicas, corregir } from '../lib/lectura-qr.js';

export const rutasLecturaPublica = Router();

const verTxt = (n) => (Number.isInteger(Number(n)) ? Number(n).toFixed(1) : String(Number(n)));

function fallo(status, mensaje) {
    const e = new Error(mensaje);
    e.status = status;
    return e;
}
function responder(err, res, next) {
    if (err.status) return res.status(err.status).json({ ok: false, error: err.message });
    if (err.code === 'P0001') return res.status(409).json({ ok: false, error: err.message });
    next(err);
}

async function sesion(token) {
    const { rows: [s] } = await consultar(
        `SELECT s.id, s.vence_en, s.cerrada_en, s.lugar, v.id AS version_id, v.numero, v.evaluacion,
                v.puntaje_minimo, v.pdf_ruta, d.codigo, d.titulo, u.nombre AS capacitador,
                (s.cerrada_en IS NULL AND s.vence_en > now()) AS abierta
         FROM dc_sesiones s
         JOIN dc_versiones v ON v.id = s.version_id
         JOIN dc_documentos d ON d.id = v.documento_id
         JOIN usuarios u ON u.id = s.abierta_por_id
         WHERE s.token = $1`, [String(token || '')]);
    if (!s) throw fallo(404, 'el código QR no corresponde a ninguna sesión');
    return s;
}

async function fijo(token) {
    const { rows: [d] } = await consultar(
        `SELECT d.codigo, d.titulo, v.id AS version_id, v.numero, v.fecha_vigencia, v.pdf_ruta
         FROM dc_documentos d
         LEFT JOIN dc_versiones v ON v.documento_id = d.id AND v.estado = 'vigente'
         WHERE d.qr_token = $1`, [String(token || '')]);
    if (!d) throw fallo(404, 'el código QR no corresponde a ningún documento');
    return d;
}

async function enviarPdf(res, { pdf_ruta: ruta, codigo, numero }) {
    if (!ruta) throw fallo(404, 'el documento todavía no tiene el PDF cargado');
    const cuando = new Date().toLocaleString('es-UY', {
        timeZone: process.env.ZONA_HORARIA || 'America/Montevideo',
        day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
    });
    const pdf = await marcarCopiaNoControlada(await leerArchivo(ruta), {
        codigo, version: verTxt(numero), cuando, pantalla: true,
    });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline');
    res.setHeader('Cache-Control', 'no-store');
    res.end(pdf);
}

/** GET /api/lectura/s/:token — que documento es y que hay que contestar. */
rutasLecturaPublica.get('/s/:token', async (req, res, next) => {
    try {
        const s = await sesion(req.params.token);
        res.json({
            ok: true, abierta: s.abierta, codigo: s.codigo, titulo: s.titulo, version: verTxt(s.numero),
            capacitador: s.capacitador, lugar: s.lugar, vence: s.vence_en,
            preguntas: preguntasPublicas(s.evaluacion), puntajeMinimo: s.puntaje_minimo,
        });
    } catch (err) { responder(err, res, next); }
});

rutasLecturaPublica.get('/s/:token/pdf', async (req, res, next) => {
    try {
        const s = await sesion(req.params.token);
        if (!s.abierta) throw fallo(410, 'la sesión ya cerró');
        await enviarPdf(res, s);
    } catch (err) { responder(err, res, next); }
});

/** POST /api/lectura/s/:token/identificar { codigo } — a quien corresponde la credencial. */
rutasLecturaPublica.post('/s/:token/identificar', async (req, res, next) => {
    try {
        const s = await sesion(req.params.token);
        if (!s.abierta) throw fallo(410, 'la sesión ya cerró');
        const p = await personaPorCodigo((req.body || {}).codigo);
        if (!p) throw fallo(404, 'no encontramos a nadie con ese código; avisale a quien capacita');
        const { rows: ya } = await consultar(
            'SELECT aprobado FROM dc_sesion_asistentes WHERE sesion_id = $1 AND persona_nombre = $2', [s.id, String(p.n)]);
        res.json({ ok: true, nombre: p.n, sector: p.s || '', yaConfirmo: ya[0]?.aprobado === true });
    } catch (err) { responder(err, res, next); }
});

/**
 * POST /api/lectura/s/:token/confirmar { codigo, respuestas }
 * Corrige la evaluacion y registra al asistente. Si no aprueba puede volver a
 * intentar: queda el ultimo intento y la cantidad.
 */
rutasLecturaPublica.post('/s/:token/confirmar', async (req, res, next) => {
    const b = req.body || {};
    try {
        const s = await sesion(req.params.token);
        if (!s.abierta) throw fallo(410, 'la sesión ya cerró');
        const p = await personaPorCodigo(b.codigo);
        if (!p) throw fallo(404, 'no encontramos a nadie con ese código');
        const r = corregir(s.evaluacion, b.respuestas, s.puntaje_minimo);

        await enTransaccionSistema(`lectura QR · ${p.n}`,
            `${r.aprobado ? 'confirmó la lectura' : 'no aprobó la evaluación'} de ${s.codigo} v${verTxt(s.numero)} (sesión ${s.id})`,
            async (c) => {
                const { rows: [ya] } = await c.query(
                    'SELECT id, aprobado FROM dc_sesion_asistentes WHERE sesion_id = $1 AND persona_nombre = $2 FOR UPDATE',
                    [s.id, String(p.n)]);
                if (ya?.aprobado) return;
                if (ya) {
                    await c.query(
                        `UPDATE dc_sesion_asistentes SET puntaje = $2, aprobado = $3, respuestas = $4,
                                intentos = intentos + 1, confirmado_en = now(), identificador = $5 WHERE id = $1`,
                        [ya.id, r.puntaje, r.aprobado, JSON.stringify(b.respuestas || null), String(b.codigo).trim()]);
                } else {
                    await c.query(
                        `INSERT INTO dc_sesion_asistentes (sesion_id, persona_nombre, persona_sector, identificador,
                                                           puntaje, aprobado, respuestas)
                         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
                        [s.id, String(p.n), p.s || null, String(b.codigo).trim(), r.puntaje, r.aprobado,
                         JSON.stringify(b.respuestas || null)]);
                }
            });
        res.json({ ok: true, nombre: p.n, aprobado: r.aprobado, puntaje: r.puntaje, errores: r.errores, minimo: s.puntaje_minimo });
    } catch (err) { responder(err, res, next); }
});

/** GET /api/lectura/d/:token — QR fijo: la version vigente del documento. */
rutasLecturaPublica.get('/d/:token', async (req, res, next) => {
    try {
        const d = await fijo(req.params.token);
        res.json({
            ok: true, codigo: d.codigo, titulo: d.titulo, vigente: Boolean(d.version_id),
            version: d.version_id ? verTxt(d.numero) : null, fechaVigencia: d.fecha_vigencia, tienePdf: Boolean(d.pdf_ruta),
        });
    } catch (err) { responder(err, res, next); }
});

rutasLecturaPublica.get('/d/:token/pdf', async (req, res, next) => {
    try {
        const d = await fijo(req.params.token);
        if (!d.version_id) throw fallo(404, 'el documento no tiene una versión vigente');
        await enviarPdf(res, d);
    } catch (err) { responder(err, res, next); }
});
