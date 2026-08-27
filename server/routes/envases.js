import { Router } from 'express';
import { consultar } from '../db.js';
import { sincronizarEnvases } from '../sync/sync-envases.js';

export const rutasEnvases = Router();

/**
 * GET /api/envases?action=getAll
 *
 * Devuelve exactamente la misma forma que el Apps Script que reemplaza:
 *   { ordenes: [ { ...orden, controles: [ ... ] } ], lcc: [ ... ] }
 *
 * Se reconstruye desde la columna `raw` a proposito. En este primer corte el
 * unico cambio del dashboard es la URL: si el payload fuera distinto habria que
 * tocar tambien el render, y no se sabria si un bug vino de la base o de la UI.
 * Las columnas normalizadas y la tabla `mediciones` quedan disponibles para los
 * endpoints por SQL de los dashboards siguientes.
 */
rutasEnvases.get('/', async (req, res, next) => {
    try {
        const accion = req.query.action || 'getAll';
        if (accion !== 'getAll') {
            return res.status(400).json({ error: `accion no soportada: ${accion}` });
        }

        // Se ordena por `pos`, la posicion que traia el origen. El orden de la
        // hoja de calculo no siempre coincide con el cronologico: hay ordenes y
        // controles con el createdAt/timestamp invertido respecto de su fila.
        // Ordenar por fecha devolvia elementos intercambiados de lugar.
        const [ordenesRes, controlesRes] = await Promise.all([
            consultar('SELECT id, raw FROM ordenes ORDER BY pos NULLS LAST, creado_en NULLS LAST, id'),
            consultar(
                `SELECT orden_id, origen, raw
                 FROM controles
                 ORDER BY origen, orden_id NULLS LAST, pos NULLS LAST, ts`
            ),
        ]);

        const controlesPorOrden = new Map();
        const lcc = [];

        for (const fila of controlesRes.rows) {
            if (fila.origen === 'lcc') {
                lcc.push(fila.raw);
                continue;
            }
            if (!controlesPorOrden.has(fila.orden_id)) controlesPorOrden.set(fila.orden_id, []);
            controlesPorOrden.get(fila.orden_id).push(fila.raw);
        }

        const ordenes = ordenesRes.rows.map((fila) => ({
            ...fila.raw,
            controles: controlesPorOrden.get(fila.id) || [],
        }));

        res.json({ ordenes, lcc });
    } catch (err) {
        next(err);
    }
});

/**
 * GET /api/envases/estado
 * Frescura del dato: cuando corrio el ultimo sync y como le fue.
 */
rutasEnvases.get('/estado', async (_req, res, next) => {
    try {
        const [ultimo, totales] = await Promise.all([
            consultar(
                `SELECT iniciado_en, fin_en, estado, ordenes, controles, lcc, mediciones, error
                 FROM sync_log
                 WHERE dominio = 'envases'
                 ORDER BY iniciado_en DESC
                 LIMIT 1`
            ),
            consultar(
                `SELECT
                    (SELECT count(*) FROM ordenes)                          AS ordenes,
                    (SELECT count(*) FROM controles WHERE origen = 'orden') AS controles,
                    (SELECT count(*) FROM controles WHERE origen = 'lcc')   AS lcc,
                    (SELECT count(*) FROM mediciones)                       AS mediciones`
            ),
        ]);

        res.json({
            ultimoSync: ultimo.rows[0] || null,
            totales: totales.rows[0],
        });
    } catch (err) {
        next(err);
    }
});

/**
 * POST /api/envases/sync
 * Dispara la replica a mano. Protegido por SYNC_TOKEN porque escribe en la base.
 */
rutasEnvases.post('/sync', async (req, res, next) => {
    const esperado = process.env.SYNC_TOKEN;
    if (!esperado) {
        return res.status(503).json({ error: 'SYNC_TOKEN no configurado en el servidor' });
    }

    const recibido = req.get('x-sync-token');
    if (recibido !== esperado) {
        return res.status(401).json({ error: 'token invalido' });
    }

    try {
        const conteo = await sincronizarEnvases();
        res.json({ estado: 'ok', ...conteo });
    } catch (err) {
        next(err);
    }
});
