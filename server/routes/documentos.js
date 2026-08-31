import { Router } from 'express';
import { consultar } from '../db.js';
import { sincronizarDocumentos, DOMINIOS_DOCUMENTOS } from '../sync/sync-documentos.js';
import { exigirTokenSync } from '../lib/auth.js';

export const rutasDocumentos = Router();

/**
 * GET /api/documentos/estado
 *
 * Que hay replicado de los dominios que todavia no alimentan dashboards.
 * Ninguna app lee de aca: estos datos se migran para que existan en Postgres,
 * pero las apps siguen usando su hoja.
 */
rutasDocumentos.get('/estado', async (_req, res, next) => {
    try {
        const [porColeccion, ultimos] = await Promise.all([
            consultar(
                `SELECT dominio, coleccion, count(*)::int AS registros,
                        max(sincronizado_en) AS ultimo
                 FROM documentos
                 GROUP BY dominio, coleccion
                 ORDER BY dominio, coleccion`
            ),
            consultar(
                `SELECT DISTINCT ON (dominio)
                        dominio, iniciado_en, fin_en, estado, controles, error
                 FROM sync_log
                 WHERE dominio = ANY($1::text[])
                 ORDER BY dominio, iniciado_en DESC`,
                [DOMINIOS_DOCUMENTOS]
            ),
        ]);

        // Agrupado por dominio, que es como se mira: "que tengo de estabilidad".
        const dominios = {};
        for (const f of porColeccion.rows) {
            dominios[f.dominio] ??= { colecciones: {}, total: 0 };
            dominios[f.dominio].colecciones[f.coleccion] = f.registros;
            dominios[f.dominio].total += f.registros;
        }
        for (const f of ultimos.rows) {
            dominios[f.dominio] ??= { colecciones: {}, total: 0 };
            dominios[f.dominio].ultimoSync = {
                iniciado_en: f.iniciado_en,
                fin_en: f.fin_en,
                estado: f.estado,
                error: f.error,
            };
        }

        res.json({ dominios });
    } catch (err) {
        next(err);
    }
});

/**
 * GET /api/documentos/:dominio/:coleccion
 * Los registros tal cual los mando el origen. Para inspeccionar la replica;
 * ninguna app lo consume.
 */
rutasDocumentos.get('/:dominio/:coleccion', async (req, res, next) => {
    try {
        const { rows } = await consultar(
            `SELECT clave_natural, raw FROM documentos
             WHERE dominio = $1 AND coleccion = $2
             ORDER BY pos NULLS LAST, clave_natural`,
            [req.params.dominio, req.params.coleccion]
        );
        res.json({ total: rows.length, registros: rows.map((f) => f.raw) });
    } catch (err) {
        next(err);
    }
});

/** POST /api/documentos/sync — dispara la replica a mano. */
rutasDocumentos.post('/sync', exigirTokenSync, async (_req, res) => {
    try {
        const r = await sincronizarDocumentos();
        res.json({ estado: 'ok', ...r });
    } catch (err) {
        console.error('[sync] fallo por HTTP:', err.message);
        res.status(500).json({ estado: 'error', error: err.message });
    }
});
