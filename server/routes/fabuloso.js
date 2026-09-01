import { Router } from 'express';
import { consultar } from '../db.js';
import { sincronizarFabuloso } from '../sync/sync-fabuloso.js';
import { exigirTokenSync } from '../lib/auth.js';

export const rutasFabuloso = Router();

/**
 * GET /api/fabuloso
 * Devuelve el CSV tal cual lo servia gviz, para que el dashboard lo parsee
 * exactamente igual que antes.
 */
rutasFabuloso.get('/', async (_req, res, next) => {
    try {
        const { rows } = await consultar(
            'SELECT csv FROM fabuloso_snapshot ORDER BY descargado_en DESC LIMIT 1'
        );

        if (!rows.length) {
            return res.status(503).type('text/plain').send(
                'todavia no se replico el CSV de Fabuloso'
            );
        }

        res.type('text/csv; charset=utf-8').send(rows[0].csv);
    } catch (err) {
        next(err);
    }
});

/** GET /api/fabuloso/estado — frescura del dato. */
rutasFabuloso.get('/estado', async (_req, res, next) => {
    try {
        const [ultimo, totales] = await Promise.all([
            consultar(
                `SELECT iniciado_en, fin_en, estado, controles, mediciones, error
                 FROM sync_log
                 WHERE dominio = 'fabuloso'
                 ORDER BY iniciado_en DESC
                 LIMIT 1`
            ),
            consultar(
                `SELECT
                    (SELECT count(*) FROM fabuloso_lotes)   AS lotes,
                    (SELECT count(*) FROM fabuloso_valores) AS valores,
                    (SELECT bytes FROM fabuloso_snapshot
                      ORDER BY descargado_en DESC LIMIT 1)  AS bytes_csv`
            ),
        ]);

        res.json({ ultimoSync: ultimo.rows[0] || null, totales: totales.rows[0] });
    } catch (err) {
        next(err);
    }
});

/** POST /api/fabuloso/sync — dispara la replica a mano. */
rutasFabuloso.post('/sync', exigirTokenSync, async (_req, res) => {
    try {
        const conteo = await sincronizarFabuloso();
        res.json({ estado: 'ok', ...conteo });
    } catch (err) {
        // Endpoint autenticado y de diagnostico: se devuelve el motivo real.
        // Ocultarlo obliga a entrar a los logs del contenedor para saber si
        // falto una variable, si el origen no respondio o si fallo la base.
        console.error('[sync] fallo por HTTP:', err.message);
        res.status(500).json({ estado: 'error', error: err.message });
    }
});
