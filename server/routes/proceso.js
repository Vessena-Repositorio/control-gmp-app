import { Router } from 'express';
import { consultar } from '../db.js';
import { sincronizarProceso } from '../sync/sync-proceso.js';
import { exigirTokenSync } from '../lib/auth.js';

export const rutasProceso = Router();

/**
 * GET /api/proceso
 *
 * Devuelve { status:'ok', records:[...] }, la misma forma que el Apps Script
 * que reemplaza. Se reconstruye desde `raw` para que el unico cambio en
 * informe-gerencial.html sea la URL.
 *
 * El orden es por `pos`, la posicion en la hoja de origen: es la identidad de
 * cada registro y lo unico que distingue los controles duplicados.
 */
rutasProceso.get('/', async (_req, res, next) => {
    try {
        const { rows } = await consultar(
            'SELECT raw FROM proceso_controles ORDER BY pos'
        );
        res.json({ status: 'ok', records: rows.map((f) => f.raw) });
    } catch (err) {
        next(err);
    }
});

/** GET /api/proceso/estado — frescura del dato. */
rutasProceso.get('/estado', async (_req, res, next) => {
    try {
        const [ultimo, totales] = await Promise.all([
            consultar(
                `SELECT iniciado_en, fin_en, estado, controles, mediciones, error
                 FROM sync_log
                 WHERE dominio = 'proceso'
                 ORDER BY iniciado_en DESC
                 LIMIT 1`
            ),
            consultar(
                `SELECT
                    (SELECT count(*) FROM proceso_controles) AS controles,
                    (SELECT count(*) FROM proceso_pesos)     AS pesos`
            ),
        ]);

        res.json({ ultimoSync: ultimo.rows[0] || null, totales: totales.rows[0] });
    } catch (err) {
        next(err);
    }
});

/** POST /api/proceso/sync — dispara la replica a mano. */
rutasProceso.post('/sync', exigirTokenSync, async (_req, res, next) => {
    try {
        const conteo = await sincronizarProceso();
        res.json({ estado: 'ok', ...conteo });
    } catch (err) {
        next(err);
    }
});
