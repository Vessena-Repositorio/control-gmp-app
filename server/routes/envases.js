import { Router } from 'express';
import { consultar } from '../db.js';
import { sincronizarEnvases } from '../sync/sync-envases.js';
import { exigirTokenSync } from '../lib/auth.js';
import { exigirPermiso } from '../lib/acceso.js';

const RECURSO = 'control-calidad-envases';

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
        // El origen expone los dos productos por acciones distintas.
        const PRODUCTO_POR_ACCION = { getAll: 'envases', getAllTapas: 'tapas' };

        const accion = req.query.action || 'getAll';
        const producto = PRODUCTO_POR_ACCION[accion];
        if (!producto) {
            return res.status(400).json({ error: `accion no soportada: ${accion}` });
        }

        // Se ordena por `pos`, la posicion que traia el origen. El orden de la
        // hoja de calculo no siempre coincide con el cronologico: hay ordenes y
        // controles con el createdAt/timestamp invertido respecto de su fila.
        // Ordenar por fecha devolvia elementos intercambiados de lugar.
        const [ordenesRes, controlesRes] = await Promise.all([
            consultar(
                `SELECT id, raw FROM ordenes
                 WHERE producto = $1
                 ORDER BY pos NULLS LAST, creado_en NULLS LAST, id`,
                [producto]
            ),
            consultar(
                `SELECT orden_id, origen, raw
                 FROM controles
                 WHERE producto = $1
                 ORDER BY origen, orden_id NULLS LAST, pos NULLS LAST, ts`,
                [producto]
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
                    p.producto,
                    (SELECT count(*) FROM ordenes o
                      WHERE o.producto = p.producto)                        AS ordenes,
                    (SELECT count(*) FROM controles c
                      WHERE c.producto = p.producto AND c.origen = 'orden') AS controles,
                    (SELECT count(*) FROM controles c
                      WHERE c.producto = p.producto AND c.origen = 'lcc')   AS lcc,
                    (SELECT count(*) FROM mediciones m
                      JOIN controles c ON c.id = m.control_id
                      WHERE c.producto = p.producto)                        AS mediciones
                 FROM (VALUES ('envases'), ('tapas')) AS p(producto)
                 ORDER BY p.producto`
            ),
        ]);

        // Desglosado por producto: envases y tapas comparten tablas, y un total
        // unico esconderia si tapas dejo de replicarse.
        const porProducto = {};
        for (const fila of totales.rows) {
            const { producto, ...conteos } = fila;
            porProducto[producto] = conteos;
        }

        res.json({
            ultimoSync: ultimo.rows[0] || null,
            totales: porProducto,
        });
    } catch (err) {
        next(err);
    }
});

/**
 * POST /api/envases/sync
 * Dispara la replica a mano. Protegido por SYNC_TOKEN porque escribe en la base.
 */

/**
 * GET /api/envases/aprobaciones
 *
 * Devuelve un objeto indexado por id de control LCC, que es con lo que la app
 * los tiene en pantalla:  { "1788016440296": { por, en } }
 *
 * Va aparte del getAll a proposito: esta app todavia lee los controles del
 * Apps Script, asi que la aprobacion se cruza en pantalla en vez de venir
 * mezclada. Cuando la lectura pase a Postgres, esto se puede fusionar.
 */
rutasEnvases.get('/aprobaciones', exigirPermiso(RECURSO, 'ver'), async (_req, res, next) => {
    try {
        const { rows } = await consultar(
            `SELECT control_clave, aprobado_por, aprobado_en
             FROM envases_aprobaciones ORDER BY aprobado_en DESC`
        );
        const porId = {};
        for (const f of rows) {
            const id = f.control_clave.startsWith('lcc:') ? f.control_clave.slice(4) : f.control_clave;
            porId[id] = { por: f.aprobado_por, en: f.aprobado_en };
        }
        res.json({ aprobaciones: porId });
    } catch (err) {
        next(err);
    }
});

/**
 * POST /api/envases/aprobaciones  { id }
 *
 * Registra la aprobacion de un control LCC. El permiso se exige aca y no solo
 * en la pantalla: esconder el boton no impide nada a quien sepa abrir la
 * consola.
 */
rutasEnvases.post('/aprobaciones', exigirPermiso(RECURSO, 'aprobar'), async (req, res, next) => {
    const id = String(req.body?.id ?? '').trim();
    if (!id) return res.status(400).json({ error: 'falta el id del control' });

    // Quien aprueba sale de la sesion, nunca del cuerpo del pedido: es la firma
    // del registro y tiene que ser quien realmente aprobo.
    const quien = req.usuario.nombre || req.usuario.usuario;
    const clave = `lcc:${id}`;

    try {
        const { rows } = await consultar(
            `INSERT INTO envases_aprobaciones (control_clave, usuario_id, aprobado_por)
             VALUES ($1, $2, $3)
             ON CONFLICT (control_clave) DO NOTHING
             RETURNING aprobado_por, aprobado_en`,
            [clave, req.usuario.id, quien]
        );

        // Ya estaba aprobado: se devuelve la aprobacion original, no la de
        // ahora. Una segunda firma no reemplaza a la primera.
        if (!rows.length) {
            const previa = await consultar(
                `SELECT aprobado_por, aprobado_en FROM envases_aprobaciones
                 WHERE control_clave = $1`, [clave]
            );
            return res.json({ ok: true, yaEstaba: true, ...previa.rows[0] });
        }

        res.json({ ok: true, yaEstaba: false, ...rows[0] });
    } catch (err) {
        next(err);
    }
});

rutasEnvases.post('/sync', exigirTokenSync, async (_req, res) => {
    try {
        const conteo = await sincronizarEnvases();
        res.json({ estado: 'ok', ...conteo });
    } catch (err) {
        // Endpoint autenticado y de diagnostico: se devuelve el motivo real.
        // Ocultarlo obliga a entrar a los logs del contenedor para saber si
        // falto una variable, si el origen no respondio o si fallo la base.
        console.error('[sync] fallo por HTTP:', err.message);
        res.status(500).json({ estado: 'error', error: err.message });
    }
});
