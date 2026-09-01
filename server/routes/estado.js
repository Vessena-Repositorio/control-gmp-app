import { Router } from 'express';
import { consultar, pool, hayBase } from '../db.js';
import { DOMINIOS } from '../lib/dominios.js';

export const rutasEstado = Router();

/**
 * GET /api/estado
 *
 * Salud de toda la replica en una sola respuesta: la base y el ultimo sync de
 * cada dominio. Existe para que el chequeo post-deploy sea una sola llamada en
 * vez de parsear cinco respuestas distintas en bash.
 *
 * Por defecto un sync en curso NO cuenta como problema: es un estado normal de
 * segundos y fallar por eso daria alarmas falsas. Con ?estricto=1 se exige que
 * todos hayan terminado bien, que es lo que necesita un deploy para decir que
 * quedo sano.
 *
 * Responde 200 si esta sano y 503 si no, asi quien lo consulta puede mirar solo
 * el codigo HTTP.
 */
rutasEstado.get('/', async (req, res, next) => {
    const estricto = req.query.estricto === '1';

    if (!hayBase) {
        return res.status(503).json({
            ok: false,
            base: 'no configurada',
            problemas: ['no hay DATABASE_URL: la API no puede responder datos'],
        });
    }

    try {
        try {
            await pool.query('SELECT 1');
        } catch (err) {
            return res.status(503).json({
                ok: false,
                base: 'sin conexion',
                problemas: [`la base no responde: ${err.message}`],
            });
        }

        const { rows } = await consultar(
            `SELECT DISTINCT ON (dominio)
                    dominio, iniciado_en, fin_en, estado, error
             FROM sync_log
             WHERE dominio = ANY($1::text[])
             ORDER BY dominio, iniciado_en DESC`,
            [DOMINIOS]
        );

        const porDominio = new Map(rows.map((f) => [f.dominio, f]));
        const dominios = {};
        const problemas = [];
        const pendientes = [];

        for (const nombre of DOMINIOS) {
            const f = porDominio.get(nombre);

            if (!f) {
                dominios[nombre] = { estado: 'sin replicar' };
                problemas.push(`${nombre}: nunca replico`);
                continue;
            }

            // Minutos desde que termino. No decide la salud, pero es lo que
            // permite ver de un vistazo si un dominio se quedo atras.
            const edadMin = f.fin_en
                ? Math.round((Date.now() - new Date(f.fin_en).getTime()) / 60000)
                : null;

            dominios[nombre] = { estado: f.estado, fin_en: f.fin_en, edadMin };

            if (f.estado === 'error') {
                problemas.push(`${nombre}: ${f.error || 'sin detalle'}`);
            } else if (f.estado !== 'ok') {
                pendientes.push(nombre);
            }
        }

        const ok = problemas.length === 0 && (!estricto || pendientes.length === 0);

        res.status(ok ? 200 : 503).json({
            ok,
            base: 'conectada',
            dominios,
            problemas,
            pendientes,
        });
    } catch (err) {
        next(err);
    }
});
