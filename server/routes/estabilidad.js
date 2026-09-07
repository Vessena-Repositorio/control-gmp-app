/**
 * Programa de Estabilidad — lectura, escritura y avisos.
 *
 * Reemplaza al Apps Script. Se conserva su contrato clave -> valor para que el
 * cambio del lado de la app sea cambiar la URL y poco mas.
 *
 * Una diferencia que NO es cosmetica: el Apps Script exponia
 * `{action:'email', to, subject, body}` sin autenticacion, asi que cualquiera
 * con la URL podia mandar cualquier texto a cualquier direccion firmado como
 * Vessena. Aca el cliente dice QUE PASO -se asigno, se aprobo, se rechazo- y el
 * servidor decide a quien le escribe y que dice. No hay forma de pedirle que
 * mande otra cosa.
 */
import { Router } from 'express';
import { consultar, enTransaccion } from '../db.js';
import { exigirPermiso } from '../lib/acceso.js';
import { enviar, hayCorreo } from '../lib/correo.js';
import { supervisoresDe, unir } from '../lib/destinatarios.js';

export const rutasEstabilidad = Router();

const RECURSO = 'estabilidad';
const leer = exigirPermiso(RECURSO, 'ver');
const escribir = exigirPermiso(RECURSO, 'cargar');

const BASE = (process.env.URL_PUBLICA || 'http://192.168.30.15:3000').replace(/\/+$/, '');
const PREFIJO = '[LCC Estabilidad] ';

// Claves permitidas. El almacen es generico, pero aceptar cualquier clave lo
// convertiria en un deposito abierto donde cualquiera con permiso de carga
// puede guardar lo que quiera y hacerlo crecer sin control.
const CLAVES = new Set(['studies', 'productos', 'auditLog', 'config']);

/** GET /api/estabilidad/datos — todas las claves, como las devolvia el doGet. */
rutasEstabilidad.get('/datos', leer, async (_req, res, next) => {
    try {
        const { rows } = await consultar('SELECT clave, valor FROM estabilidad_datos');
        const salida = {};
        for (const f of rows) salida[f.clave] = f.valor;
        res.json(salida);
    } catch (err) {
        next(err);
    }
});

/**
 * POST /api/estabilidad/datos  { key, value }
 * `value` llega serializado, igual que se lo mandaba al Apps Script.
 */
rutasEstabilidad.post('/datos', escribir, async (req, res, next) => {
    const { key, value } = req.body || {};

    if (!CLAVES.has(key)) {
        return res.status(400).json({ error: `clave no permitida: ${key}` });
    }
    if (typeof value !== 'string') {
        return res.status(400).json({ error: 'value tiene que ser el JSON ya serializado' });
    }
    // Se valida que sea JSON antes de guardarlo: si entra algo roto, la app
    // deja de abrir y recuperarlo pide meterse en la base a mano.
    try {
        JSON.parse(value);
    } catch {
        return res.status(400).json({ error: 'value no es JSON valido' });
    }

    try {
        await enTransaccion(async (c) => {
            // Serializa los guardados entre si. Cada escritura reescribe la
            // coleccion completa, asi que dos simultaneas se pisarian.
            await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['estabilidad:' + key]);
            await c.query(
                `INSERT INTO estabilidad_datos (clave, valor, actualizado_por)
                 VALUES ($1, $2, $3)
                 ON CONFLICT (clave) DO UPDATE
                    SET valor = EXCLUDED.valor,
                        actualizado_en = now(),
                        actualizado_por = EXCLUDED.actualizado_por`,
                [key, value, req.usuario.nombre]
            );
        });
        res.json({ ok: true, clave: key, bytes: value.length });
    } catch (err) {
        next(err);
    }
});

// ---------------------------------------------------------------------------
// Avisos disparados por la app
// ---------------------------------------------------------------------------

function esc(s) {
    return String(s ?? '').replace(/[&<>"]/g, (c) =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function enlace(id, texto) {
    return `<a href="${BASE}/estabilidad.html#study=${encodeURIComponent(id)}" ` +
        `style="display:inline-block;margin:12px 0;padding:10px 20px;background:#0E6B67;` +
        `color:#fff;text-decoration:none;border-radius:6px;font-weight:bold">` +
        `${texto || 'Abrir estudio →'}</a>`;
}

const PIE = '<p style="color:#5B6B6E;font-size:12px">Programa de Estabilidad — LCC / Vessena S.A.</p></div>';

function cuerpoAsignacion(s) {
    const cps = (s.checkpoints || []).map((cp) =>
        `<li><strong>${esc(cp.codigo)}</strong> (Mes ${esc(cp.mes)}) — ${esc(cp.fechaProgramada)}</li>`).join('');
    const spec = (s.specParams || []).map((p) => `<li>${esc(p.p)}: ${esc(p.e)}</li>`).join('');
    const fila = (k, v) =>
        `<tr><td style="padding:4px 12px 4px 0;color:#5B6B6E">${k}</td><td>${v}</td></tr>`;

    return `<div style="font-family:Arial,sans-serif;max-width:600px">` +
        `<h2 style="color:#0A4F4C">Nueva asignación: Estudio de Estabilidad</h2>` +
        `<p>Se te asignó el siguiente estudio:</p>` +
        `<table style="border-collapse:collapse;font-size:14px;margin:10px 0">` +
        fila('Producto', `<strong>${esc(s.producto)}</strong>`) +
        fila('Lote', `<strong>${esc(s.lote)}</strong>`) +
        fila('Tipo', esc(s.tipoEstudio)) +
        fila('Inicio', esc(s.fechaInicio)) +
        fila('Creado por', esc(s.responsable || '—')) +
        `</table>` +
        `<h3 style="color:#0A4F4C">Especificación</h3><ul>${spec || '<li>Ver en la plataforma</li>'}</ul>` +
        `<h3 style="color:#0A4F4C">Cronograma de muestreo</h3><ul>${cps}</ul>` +
        enlace(s.id) + PIE;
}

function cuerpoAprobado(s) {
    return `<div style="font-family:Arial;max-width:600px">` +
        `<h2 style="color:#357A55">✓ Estudio APROBADO</h2>` +
        `<p>Producto: <strong>${esc(s.producto)}</strong> — Lote: <strong>${esc(s.lote)}</strong></p>` +
        `<p>El estudio fue aprobado por Dirección Técnica el ${esc(s.fechaAprobacion)}.</p>` +
        enlace(s.id) + PIE;
}

function cuerpoRechazado(s, motivo) {
    return `<div style="font-family:Arial;max-width:600px">` +
        `<h2 style="color:#B03A2E">✗ Estudio RECHAZADO</h2>` +
        `<p>Producto: <strong>${esc(s.producto)}</strong> — Lote: <strong>${esc(s.lote)}</strong></p>` +
        `<p><strong>Motivo:</strong> ${esc(motivo)}</p>` +
        `<p>Corregir y volver a enviar el informe.</p>` +
        enlace(s.id, 'Ver estudio rechazado →') + PIE;
}

/** Busca el estudio en nuestros propios datos: el cliente solo manda el id. */
async function estudio(id) {
    const { rows } = await consultar(
        `SELECT valor FROM estabilidad_datos WHERE clave = 'studies'`
    );
    if (!rows.length) return null;
    let lista;
    try { lista = JSON.parse(rows[0].valor); } catch { return null; }
    return (Array.isArray(lista) ? lista : []).find((s) => String(s?.id) === String(id)) || null;
}

/**
 * POST /api/estabilidad/aviso  { tipo, estudioId, motivo?, nuevo? }
 *
 * tipo: 'asignacion' | 'aprobado' | 'rechazado'
 *
 * El cliente no elige destinatarios ni texto: manda que paso y sobre que
 * estudio. Es la diferencia con el endpoint que reemplaza.
 */
rutasEstabilidad.post('/aviso', escribir, async (req, res, next) => {
    const { tipo, estudioId, motivo, nuevo } = req.body || {};

    if (!['asignacion', 'aprobado', 'rechazado'].includes(tipo)) {
        return res.status(400).json({ error: 'tipo de aviso desconocido' });
    }
    if (!estudioId) return res.status(400).json({ error: 'falta estudioId' });
    if (!hayCorreo) return res.status(503).json({ error: 'el correo no esta configurado' });

    try {
        const s = await estudio(estudioId);
        if (!s) return res.status(404).json({ error: 'no se encontro el estudio' });

        const supervision = await supervisoresDe(RECURSO, tipo);
        let para, asunto, html;

        if (tipo === 'asignacion') {
            para = unir(s.emailAnalista, supervision);
            asunto = nuevo
                ? `Asignación: ${s.producto} (${s.tipoEstudio}, Lote ${s.lote})`
                : `Asignación: ${s.producto} (Lote ${s.lote})`;
            html = cuerpoAsignacion(s);
        } else if (tipo === 'aprobado') {
            para = unir(s.emailAnalista, supervision);
            asunto = `✓ APROBADO: ${s.producto} (Lote ${s.lote})`;
            html = cuerpoAprobado(s);
        } else {
            // El rechazo va al analista y a quien creo el estudio. En el Apps
            // Script eran dos envios con el mismo texto; aca es uno solo con los
            // dos destinatarios, sin repetir si son la misma persona.
            para = unir([s.emailAnalista, s.emailCreador].filter(Boolean).join(','), supervision);
            asunto = `✗ RECHAZADO: ${s.producto} (Lote ${s.lote})`;
            html = cuerpoRechazado(s, motivo || 'sin motivo indicado');
        }

        if (!para.length) return res.json({ ok: true, enviado: false, motivo: 'sin destinatarios' });

        const r = await enviar({ para, asunto: PREFIJO + asunto, html, texto: asunto });
        res.json({ ok: true, enviado: true, para, ...r });
    } catch (err) {
        console.error('[estabilidad] aviso fallo:', err.message);
        next(err);
    }
});

/** GET /api/estabilidad/estado — que hay guardado y de cuando. */
rutasEstabilidad.get('/estado', leer, async (_req, res, next) => {
    try {
        const { rows } = await consultar(
            `SELECT clave, length(valor) AS bytes, actualizado_en, actualizado_por
             FROM estabilidad_datos ORDER BY clave`
        );
        res.json({ claves: rows });
    } catch (err) {
        next(err);
    }
});
