import { Router } from 'express';
import { consultar } from '../db.js';
import { sincronizarSao001 } from '../sync/sync-sao001.js';
import { exigirTokenSync } from '../lib/auth.js';

export const rutasSao001 = Router();

/**
 * GET /api/sao001
 *
 * Devuelve el CSV tal cual lo mandaba Apps Script. El dashboard hace
 * resp.text() y lo parsea el mismo, asi que devolver el texto literal es lo que
 * permite no tocarle nada del render.
 */
rutasSao001.get('/', async (_req, res, next) => {
    try {
        const { rows } = await consultar(
            'SELECT csv FROM sao001_snapshot ORDER BY descargado_en DESC LIMIT 1'
        );

        if (!rows.length) {
            return res.status(503).type('text/plain').send(
                'todavia no se replico el CSV de SAO-001'
            );
        }

        res.type('text/csv; charset=utf-8').send(rows[0].csv);
    } catch (err) {
        next(err);
    }
});

/** GET /api/sao001/estado — frescura del dato. */
rutasSao001.get('/estado', async (_req, res, next) => {
    try {
        const [ultimo, totales] = await Promise.all([
            consultar(
                `SELECT iniciado_en, fin_en, estado, controles, mediciones, error
                 FROM sync_log
                 WHERE dominio = 'sao001'
                 ORDER BY iniciado_en DESC
                 LIMIT 1`
            ),
            consultar(
                `SELECT
                    (SELECT count(*) FROM sao001_muestras)    AS muestras,
                    (SELECT count(*) FROM sao001_parametros)  AS parametros,
                    (SELECT bytes FROM sao001_snapshot
                      ORDER BY descargado_en DESC LIMIT 1)    AS bytes_csv`
            ),
        ]);

        res.json({ ultimoSync: ultimo.rows[0] || null, totales: totales.rows[0] });
    } catch (err) {
        next(err);
    }
});

/** POST /api/sao001/sync — dispara la replica a mano. */
rutasSao001.post('/sync', exigirTokenSync, async (_req, res, next) => {
    try {
        const conteo = await sincronizarSao001();
        res.json({ estado: 'ok', ...conteo });
    } catch (err) {
        next(err);
    }
});
