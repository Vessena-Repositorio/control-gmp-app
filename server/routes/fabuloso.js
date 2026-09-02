import { Router } from 'express';
import { consultar } from '../db.js';
import { sincronizarFabuloso } from '../sync/sync-fabuloso.js';
import { exigirTokenSync } from '../lib/auth.js';

export const rutasFabuloso = Router();

// La planilla de Fabuloso la cargan personas de afuera del sistema, asi que el
// dashboard tiene que mostrar lo que hay ahora, no lo de la ultima replica
// periodica. Si la copia esta mas vieja que esto, se refresca antes de
// responder: el dashboard tarda unos segundos de mas en ese caso, y a cambio
// nunca muestra un dato viejo.
const FRESCURA_MIN = Number(process.env.FABULOSO_FRESCURA_MIN ?? 2);

// Si entran varios pedidos juntos con la copia vencida, uno solo replica y los
// demas esperan a ese. Sin esto, cinco personas abriendo el dashboard a la vez
// dispararian cinco sincronizaciones contra Google.
let refrescoEnCurso = null;

async function refrescarSiHaceFalta() {
    const { rows } = await consultar(
        `SELECT descargado_en < now() - ($1 || ' minutes')::interval AS vencida
         FROM fabuloso_snapshot ORDER BY descargado_en DESC LIMIT 1`,
        [String(FRESCURA_MIN)]
    );

    // Sin snapshot todavia, tambien corresponde traerlo.
    if (rows.length && !rows[0].vencida) return;

    refrescoEnCurso ??= sincronizarFabuloso().finally(() => {
        refrescoEnCurso = null;
    });

    // Que falle el refresco no puede dejar sin dashboard: se sirve lo que haya.
    await refrescoEnCurso.catch((err) =>
        console.error('[fabuloso] no se pudo refrescar antes de servir:', err.message)
    );
}

/**
 * GET /api/fabuloso
 * Devuelve el CSV tal cual lo servia gviz, para que el dashboard lo parsee
 * exactamente igual que antes. La planilla sigue siendo la fuente de verdad:
 * aca solo se lee, nunca se escribe hacia Google.
 */
rutasFabuloso.get('/', async (_req, res, next) => {
    try {
        await refrescarSiHaceFalta();

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
