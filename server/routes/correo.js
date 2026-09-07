/**
 * Diagnostico del correo saliente.
 *
 * Existe para poder responder "el mail sale o no sale" sin depender de que
 * alguna app lo dispare. Es lo primero que hay que correr despues de configurar
 * el SMTP, y lo primero que hay que mirar cuando un aviso no llego.
 */
import { Router } from 'express';
import { exigirTokenSync } from '../lib/auth.js';
import { hayCorreo, faltantes, verificar, enviar } from '../lib/correo.js';
import { revisarAvisosCapa, configAvisos } from '../lib/avisos.js';
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
        return res.status(503).json({
            estado: 'sin configurar',
            faltan: faltantes(),
        });
    }
    try {
        const cfg = await verificar();
        res.json({ estado: 'ok', ...cfg });
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

    const cuando = new Date().toISOString();
    try {
        const r = await enviar({
            para,
            asunto: 'Prueba de notificaciones - Calidad Vessena',
            texto:
                'Este es un mensaje de prueba del sistema de calidad.\n\n' +
                `Enviado: ${cuando}\n` +
                'Si lo recibiste, el correo saliente del servidor funciona.\n',
        });
        res.json({ estado: 'ok', ...r });
    } catch (err) {
        console.error('[correo] prueba fallida:', err.message);
        res.status(502).json({ estado: 'error', error: err.message });
    }
});

/**
 * GET /api/correo/avisos — configuracion vigente y ultima corrida.
 */
rutasCorreo.get('/avisos', exigirTokenSync, async (_req, res, next) => {
    try {
        const { rows } = await consultar(
            'SELECT * FROM tarea_diaria WHERE nombre = $1', ['avisos_capa']
        );
        res.json({ config: configAvisos(), ultimaCorrida: rows[0] || null });
    } catch (err) {
        next(err);
    }
});
/**
 * POST /api/correo/avisos  { todos?: true }
 *
 * Corre la revision AHORA, sin esperar al horario. Por defecto es una
 * PREVISUALIZACION: arma los mismos mensajes pero solo se los manda a Calidad,
 * para poder ver como quedan sin escribirle a los responsables de verdad.
 * Con { "todos": true } manda en serio, a cada responsable.
 */
rutasCorreo.post('/avisos', exigirTokenSync, async (req, res) => {
    const todos = req.body?.todos === true;
    try {
        res.json(await revisarAvisosCapa({ forzar: true, soloCalidad: !todos }));
    } catch (err) {
        console.error('[avisos] corrida manual fallida:', err.message);
        res.status(500).json({ estado: 'error', error: err.message });
    }
});
