// Replica el dominio de envases desde el Apps Script actual hacia Postgres.
//
// Es idempotente: se puede correr las veces que haga falta y converge al mismo
// estado. El origen NO da id para los controles (los 781 vienen vacios), asi
// que la clave natural se arma con orden + timestamp, que si es unico.
//
// Uso:  npm run sync
import { pool, consultar, enTransaccion } from '../db.js';
import { expandirMediciones } from '../lib/mediciones.js';
import { esEjecucionDirecta } from '../lib/entrypoint.js';

const TIMEOUT_MS = 120_000;

/** Fecha ISO -> objeto Date, o null si viene vacia o corrupta. */
function aFecha(valor) {
    if (!valor) return null;
    const d = new Date(valor);
    return Number.isNaN(d.getTime()) ? null : d;
}

/** Texto -> BIGINT, o null. Los ids del origen son epoch en ms. */
function aEntero(valor) {
    if (valor === null || valor === undefined || valor === '') return null;
    const n = Number(valor);
    return Number.isSafeInteger(n) ? n : null;
}

function limpiar(valor) {
    if (valor === null || valor === undefined) return null;
    const t = String(valor).trim();
    return t === '' ? null : t;
}

async function descargar(url) {
    const ctrl = new AbortController();
    const reloj = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
        const r = await fetch(url, { redirect: 'follow', signal: ctrl.signal });
        if (!r.ok) throw new Error(`el origen respondio HTTP ${r.status}`);
        const datos = await r.json();
        if (datos && datos.error) throw new Error(`el origen respondio error: ${datos.error}`);
        return datos;
    } finally {
        clearTimeout(reloj);
    }
}

/** Inserta o actualiza un control y reescribe sus mediciones. */
async function guardarControl(cliente, ctrl, { origen, ordenId, envase, pos }) {
    const ts = aFecha(ctrl.timestamp);
    if (!ts) return { control: 0, mediciones: 0 }; // sin timestamp no hay clave natural

    const extId = origen === 'lcc' ? aEntero(ctrl.id) : null;
    if (origen === 'lcc' && extId === null) return { control: 0, mediciones: 0 };

    const claveNatural =
        origen === 'lcc' ? `lcc:${extId}` : `orden:${ordenId}:${ts.toISOString()}`;

    const { rows } = await cliente.query(
        `INSERT INTO controles (clave_natural, origen, orden_id, ext_id, envase, tipo,
                                fecha, hora, operador, analista, turno, observaciones, ts, pos,
                                raw, sincronizado_en)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15, now())
         ON CONFLICT (clave_natural) DO UPDATE SET
            origen = EXCLUDED.origen, orden_id = EXCLUDED.orden_id,
            ext_id = EXCLUDED.ext_id, envase = EXCLUDED.envase, tipo = EXCLUDED.tipo,
            fecha = EXCLUDED.fecha, hora = EXCLUDED.hora, operador = EXCLUDED.operador,
            analista = EXCLUDED.analista, turno = EXCLUDED.turno,
            observaciones = EXCLUDED.observaciones, ts = EXCLUDED.ts, pos = EXCLUDED.pos,
            raw = EXCLUDED.raw, sincronizado_en = now()
         RETURNING id`,
        [
            claveNatural,
            origen,
            ordenId,
            extId,
            limpiar(ctrl.envase) ?? envase ?? null,
            limpiar(ctrl.tipo),
            aFecha(ctrl.fecha),
            limpiar(ctrl.hora),
            limpiar(ctrl.operador),
            limpiar(ctrl.analista),
            limpiar(ctrl.turno),
            limpiar(ctrl.observaciones),
            ts,
            pos,
            JSON.stringify(ctrl),
        ]
    );

    const controlId = rows[0].id;

    // Se reescriben todas: si el origen corrigio un valor, la vieja no debe quedar.
    await cliente.query('DELETE FROM mediciones WHERE control_id = $1', [controlId]);

    const filas = expandirMediciones(ctrl.mediciones);
    if (filas.length) {
        // Un solo INSERT con todas las filas: 781 controles x ~30 medidas serian
        // 23k viajes a la base si se insertaran de a una.
        const valores = [];
        const marcadores = filas.map((f, i) => {
            const b = i * 8;
            valores.push(
                controlId, f.clave, f.fase, f.parametro,
                f.cavidad, f.muestra, f.valor_texto, f.valor_num
            );
            return `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7},$${b + 8})`;
        });
        await cliente.query(
            `INSERT INTO mediciones
                (control_id, clave, fase, parametro, cavidad, muestra, valor_texto, valor_num)
             VALUES ${marcadores.join(',')}
             ON CONFLICT (control_id, clave, muestra) DO NOTHING`,
            valores
        );
    }

    return { control: 1, mediciones: filas.length };
}

export async function sincronizarEnvases() {
    const url = process.env.ORIGEN_ENVASES;
    if (!url) throw new Error('Falta ORIGEN_ENVASES en las variables de entorno.');

    const { rows: logRows } = await consultar(
        `INSERT INTO sync_log (dominio) VALUES ('envases') RETURNING id`
    );
    const logId = logRows[0].id;
    const t0 = Date.now();

    try {
        const datos = await descargar(`${url}?action=getAll`);
        const ordenes = Array.isArray(datos?.ordenes) ? datos.ordenes : [];
        const lcc = Array.isArray(datos?.lcc) ? datos.lcc : [];

        // Un origen vacio casi siempre es una falla de Apps Script, no una purga
        // real. Abortar evita vaciar los dashboards por un error transitorio.
        if (!ordenes.length && !lcc.length) {
            throw new Error('el origen no devolvio ordenes ni registros LCC; no se toca la base');
        }

        const conteo = { ordenes: 0, controles: 0, lcc: 0, mediciones: 0 };

        await enTransaccion(async (cliente) => {
            for (const [posOrden, orden] of ordenes.entries()) {
                const ordenId = aEntero(orden.id);
                if (ordenId === null) continue;

                // El raw de la orden se guarda sin los controles: esos viven en
                // su propia tabla y duplicarlos aca desincronizaria los datos.
                const { controles, ...ordenSinControles } = orden;

                await cliente.query(
                    `INSERT INTO ordenes (id, numero_orden, envase, fecha, operador, analista,
                                          maquina, turno, estado, campaign_id, creado_en, pos,
                                          raw, sincronizado_en)
                     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13, now())
                     ON CONFLICT (id) DO UPDATE SET
                        numero_orden = EXCLUDED.numero_orden, envase = EXCLUDED.envase,
                        fecha = EXCLUDED.fecha, operador = EXCLUDED.operador,
                        analista = EXCLUDED.analista, maquina = EXCLUDED.maquina,
                        turno = EXCLUDED.turno, estado = EXCLUDED.estado,
                        campaign_id = EXCLUDED.campaign_id, creado_en = EXCLUDED.creado_en,
                        pos = EXCLUDED.pos, raw = EXCLUDED.raw, sincronizado_en = now()`,
                    [
                        ordenId,
                        limpiar(orden.numeroOrden),
                        limpiar(orden.envase),
                        aFecha(orden.fecha),
                        limpiar(orden.operador),
                        limpiar(orden.analista),
                        limpiar(orden.maquina),
                        limpiar(orden.turno),
                        limpiar(orden.estado),
                        aEntero(orden.campaign_id),
                        aFecha(orden.createdAt),
                        posOrden,
                        JSON.stringify(ordenSinControles),
                    ]
                );
                conteo.ordenes++;

                for (const [posCtrl, ctrl] of (controles || []).entries()) {
                    const r = await guardarControl(cliente, ctrl, {
                        origen: 'orden',
                        ordenId,
                        envase: limpiar(orden.envase),
                        pos: posCtrl,
                    });
                    conteo.controles += r.control;
                    conteo.mediciones += r.mediciones;
                }
            }

            for (const [posLcc, registro] of lcc.entries()) {
                const r = await guardarControl(cliente, registro, {
                    origen: 'lcc',
                    ordenId: null,
                    envase: limpiar(registro.envase),
                    pos: posLcc,
                });
                conteo.lcc += r.control;
                conteo.mediciones += r.mediciones;
            }
        });

        await consultar(
            `UPDATE sync_log SET fin_en = now(), estado = 'ok',
                    ordenes = $2, controles = $3, lcc = $4, mediciones = $5
             WHERE id = $1`,
            [logId, conteo.ordenes, conteo.controles, conteo.lcc, conteo.mediciones]
        );

        const seg = ((Date.now() - t0) / 1000).toFixed(1);
        console.log(
            `[sync:envases] ok en ${seg}s - ${conteo.ordenes} ordenes, ` +
            `${conteo.controles} controles, ${conteo.lcc} lcc, ${conteo.mediciones} mediciones`
        );
        return conteo;
    } catch (err) {
        await consultar(
            `UPDATE sync_log SET fin_en = now(), estado = 'error', error = $2 WHERE id = $1`,
            [logId, err.message]
        );
        console.error('[sync:envases] fallo:', err.message);
        throw err;
    }
}

if (esEjecucionDirecta(import.meta.url)) {
    sincronizarEnvases()
        .then(() => pool?.end())
        .catch(() => process.exit(1));
}
