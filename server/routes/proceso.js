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
 * Los controles duplicados quedan fuera. Es la unica diferencia deliberada
 * contra el origen: son el mismo control enviado dos veces, y contarlos dos
 * veces infla los totales y sesga los promedios del informe. Siguen guardados
 * en la base; para auditarlos, ?incluirDuplicados=1.
 *
 * El orden es por `pos`, la posicion en la hoja de origen.
 */
rutasProceso.get('/', async (req, res, next) => {
    try {
        const incluirDup = req.query.incluirDuplicados === '1';
        const { rows } = await consultar(
            `SELECT raw FROM proceso_controles
             ${incluirDup ? '' : 'WHERE duplicado_de IS NULL'}
             ORDER BY pos`
        );
        res.json({ status: 'ok', records: rows.map((f) => f.raw) });
    } catch (err) {
        next(err);
    }
});

/**
 * GET /api/proceso/duplicados
 * Los controles enviados dos veces, con la fila del original. El numero de fila
 * es el de la hoja de calculo (1 es el encabezado), para poder ir a corregirlo.
 */
rutasProceso.get('/duplicados', async (_req, res, next) => {
    try {
        const { rows } = await consultar(
            `SELECT d.pos + 2 AS fila_hoja, d.duplicado_de + 2 AS fila_original,
                    d.fecha, d.analista, d.lote, d.control_num, d.hora
             FROM proceso_controles d
             WHERE d.duplicado_de IS NOT NULL
             ORDER BY d.pos`
        );
        res.json({ total: rows.length, duplicados: rows });
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
                    (SELECT count(*) FROM proceso_controles
                      WHERE duplicado_de IS NULL)            AS controles,
                    (SELECT count(*) FROM proceso_controles
                      WHERE duplicado_de IS NOT NULL)        AS duplicados,
                    (SELECT count(*) FROM proceso_controles) AS filas_en_origen,
                    (SELECT count(*) FROM proceso_pesos)     AS pesos`
            ),
        ]);

        res.json({ ultimoSync: ultimo.rows[0] || null, totales: totales.rows[0] });
    } catch (err) {
        next(err);
    }
});

/** POST /api/proceso/sync — dispara la replica a mano. */
rutasProceso.post('/sync', exigirTokenSync, async (_req, res) => {
    try {
        const conteo = await sincronizarProceso();
        res.json({ estado: 'ok', ...conteo });
    } catch (err) {
        // Endpoint autenticado y de diagnostico: se devuelve el motivo real.
        // Ocultarlo obliga a entrar a los logs del contenedor para saber si
        // falto una variable, si el origen no respondio o si fallo la base.
        console.error('[sync] fallo por HTTP:', err.message);
        res.status(500).json({ estado: 'error', error: err.message });
    }
});
