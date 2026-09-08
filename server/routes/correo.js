/**
 * Diagnostico del correo saliente y de los avisos programados.
 *
 * Existe para poder responder "el mail sale o no sale" sin depender de que
 * alguna app lo dispare. Es lo primero que hay que correr despues de configurar
 * el SMTP, y lo primero que hay que mirar cuando un aviso no llego.
 *
 * Todos los POST de avisos son PREVISUALIZACION por defecto: arman los mensajes
 * y no mandan nada. Probar una notificacion no deberia costar molestar a media
 * planta.
 */
import { Router } from 'express';
import { exigirTokenSync } from '../lib/auth.js';
import { hayCorreo, faltantes, verificar, enviar } from '../lib/correo.js';
import { revisarAvisosCapa, configAvisos } from '../lib/avisos.js';
import { revisarAvisosEstabilidad, configEstabilidad } from '../lib/avisos-estabilidad.js';
import {
    revisarRecordatoriosPlan, revisarInduccionesPendientes, configCapacitaciones,
} from '../lib/avisos-capacitaciones.js';
import { revisarPendientesAprobacion, configEnvases } from '../lib/avisos-envases.js';
import { consultar } from '../db.js';

export const rutasCorreo = Router();

// Solo se pueden mandar pruebas a la propia organizacion. Un endpoint que manda
// correo a cualquier direccion es un relay abierto si el token se filtra: el
// dominio propio acota el daño a mandarnos mensajes a nosotros mismos.
const DOMINIO = process.env.SMTP_DOMINIO_PRUEBA || 'vessena.com.uy';

/**
 * GET /api/correo/estado — si esta configurado y si el servidor SMTP acepta la
 * credencial. No devuelve ningun valor secreto, solo que variables faltan.
 */
rutasCorreo.get('/estado', exigirTokenSync, async (_req, res) => {
    if (!hayCorreo) {
        return res.status(503).json({ estado: 'sin configurar', faltan: faltantes() });
    }
    try {
        res.json({ estado: 'ok', ...(await verificar()) });
    } catch (err) {
        // Endpoint autenticado y de diagnostico: se devuelve el motivo real.
        // Ocultarlo obliga a entrar a los logs del contenedor para saber si el
        // host no resuelve, si la clave no sirve o si el puerto esta cerrado.
        console.error('[correo] verificacion fallida:', err.message);
        res.status(502).json({ estado: 'error', error: err.message });
    }
});

/**
 * POST /api/correo/prueba  { para }
 * Manda un mensaje real, para confirmar que ademas de conectar, entrega.
 */
rutasCorreo.post('/prueba', exigirTokenSync, async (req, res) => {
    const { para } = req.body || {};
    if (!para || typeof para !== 'string') {
        return res.status(400).json({ error: 'falta "para" con una direccion' });
    }
    if (!para.toLowerCase().endsWith('@' + DOMINIO)) {
        return res.status(400).json({ error: `solo se permiten pruebas a @${DOMINIO}` });
    }
    try {
        const r = await enviar({
            para,
            asunto: 'Prueba de notificaciones - Calidad Vessena',
            texto: 'Este es un mensaje de prueba del sistema de calidad.\n\n' +
                `Enviado: ${new Date().toISOString()}\n` +
                'Si lo recibiste, el correo saliente del servidor funciona.\n',
        });
        res.json({ estado: 'ok', ...r });
    } catch (err) {
        console.error('[correo] prueba fallida:', err.message);
        res.status(502).json({ estado: 'error', error: err.message });
    }
});

/**
 * GET /api/correo/avisos — configuracion de cada grupo de avisos y cuando
 * corrio por ultima vez cada tarea.
 */
rutasCorreo.get('/avisos', exigirTokenSync, async (_req, res, next) => {
    try {
        const { rows } = await consultar(
            'SELECT nombre, ultimo_dia, ultima_corrida, detalle FROM tarea_diaria ORDER BY nombre'
        );
        res.json({
            capa: configAvisos(),
            estabilidad: configEstabilidad(),
            capacitaciones: configCapacitaciones(),
            envases: configEnvases(),
            corridas: rows,
        });
    } catch (err) {
        next(err);
    }
});

/**
 * Envuelve una revision para que el POST sea previsualizacion por defecto.
 * Con { "enviar": true } manda de verdad.
 */
function endpointDeAviso(ruta, fn, opcionEnvio = 'soloPrevisualizar') {
    rutasCorreo.post(ruta, exigirTokenSync, async (req, res) => {
        const enviarDeVerdad = req.body?.enviar === true;
        try {
            res.json(await fn({ forzar: true, [opcionEnvio]: !enviarDeVerdad }));
        } catch (err) {
            console.error(`[avisos] ${ruta} fallo:`, err.message);
            res.status(500).json({ estado: 'error', error: err.message });
        }
    });
}

// CAPA usa `soloCalidad` porque ahi la previsualizacion si manda: le llega el
// consolidado a Calidad y no a cada responsable.
endpointDeAviso('/avisos', revisarAvisosCapa, 'soloCalidad');
endpointDeAviso('/avisos/estabilidad', revisarAvisosEstabilidad);
endpointDeAviso('/avisos/capacitaciones/plan', revisarRecordatoriosPlan);
endpointDeAviso('/avisos/capacitaciones/inducciones', revisarInduccionesPendientes);
endpointDeAviso('/avisos/envases', revisarPendientesAprobacion);
