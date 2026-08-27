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
import { descargar, aFecha, aTexto, aEnteroSeguro } from '../lib/origen.js';

/** Inserta o actualiza un control y reescribe sus mediciones. */
async function guardarControl(cliente, ctrl, { origen, ordenId, envase, pos, producto }) {
    const ts = aFecha(ctrl.timestamp);
    if (!ts) return { control: 0, mediciones: 0 }; // sin timestamp no hay clave natural

    const extId = origen === 'lcc' ? aEnteroSeguro(ctrl.id) : null;
    if (origen === 'lcc' && extId === null) return { control: 0, mediciones: 0 };

    // Envases no lleva prefijo a proposito: sus claves ya existen en la base y
    // cambiarles el formato reinsertaria los 784 controles como filas nuevas.
    const pref = producto === 'envases' ? '' : `${producto}:`;
    const claveNatural =
        origen === 'lcc' ? `${pref}lcc:${extId}` : `${pref}orden:${ordenId}:${ts.toISOString()}`;

    const { rows } = await cliente.query(
        `INSERT INTO controles (clave_natural, producto, origen, orden_id, ext_id, envase, tipo,
                                fecha, hora, operador, analista, turno, observaciones, ts, pos,
                                raw, sincronizado_en)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16, now())
         ON CONFLICT (clave_natural) DO UPDATE SET
            producto = EXCLUDED.producto,
            origen = EXCLUDED.origen, orden_id = EXCLUDED.orden_id,
            ext_id = EXCLUDED.ext_id, envase = EXCLUDED.envase, tipo = EXCLUDED.tipo,
            fecha = EXCLUDED.fecha, hora = EXCLUDED.hora, operador = EXCLUDED.operador,
            analista = EXCLUDED.analista, turno = EXCLUDED.turno,
            observaciones = EXCLUDED.observaciones, ts = EXCLUDED.ts, pos = EXCLUDED.pos,
            raw = EXCLUDED.raw, sincronizado_en = now()
         RETURNING id`,
        [
            claveNatural,
            producto,
            origen,
            ordenId,
            extId,
            aTexto(ctrl.envase) ?? envase ?? null,
            aTexto(ctrl.tipo),
            aFecha(ctrl.fecha),
            aTexto(ctrl.hora),
            aTexto(ctrl.operador),
            aTexto(ctrl.analista),
            aTexto(ctrl.turno),
            aTexto(ctrl.observaciones),
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
    // El log se abre antes de validar la configuracion: si falta la variable,
    // el fallo tiene que quedar registrado y visible en /estado, no solo en los
    // logs del contenedor.
    const { rows: logRows } = await consultar(
        `INSERT INTO sync_log (dominio) VALUES ('envases') RETURNING id`
    );
    const logId = logRows[0].id;
    const t0 = Date.now();

    try {
        const url = process.env.ORIGEN_ENVASES;
        if (!url) throw new Error('Falta ORIGEN_ENVASES en las variables de entorno.');

        // El mismo endpoint sirve dos productos por acciones distintas.
        const porProducto = {
            envases: await descargar(`${url}?action=getAll`),
            tapas: await descargar(`${url}?action=getAllTapas`),
        };

        // Un origen vacio casi siempre es una falla de Apps Script, no una purga
        // real. Abortar evita vaciar los dashboards por un error transitorio.
        // Se mira solo envases: tapas devuelve vacio de verdad hasta que
        // empiecen a cargar, y no puede bloquear la replica del resto.
        const base = porProducto.envases;
        if (!base?.ordenes?.length && !base?.lcc?.length) {
            throw new Error('el origen no devolvio ordenes ni registros LCC; no se toca la base');
        }

        const conteo = { ordenes: 0, controles: 0, lcc: 0, mediciones: 0 };

        await enTransaccion(async (cliente) => {
        for (const [producto, datos] of Object.entries(porProducto)) {
            const ordenes = Array.isArray(datos?.ordenes) ? datos.ordenes : [];
            const lcc = Array.isArray(datos?.lcc) ? datos.lcc : [];

            for (const [posOrden, orden] of ordenes.entries()) {
                const ordenId = aEnteroSeguro(orden.id);
                if (ordenId === null) continue;

                // El raw de la orden se guarda sin los controles: esos viven en
                // su propia tabla y duplicarlos aca desincronizaria los datos.
                const { controles, ...ordenSinControles } = orden;

                await cliente.query(
                    `INSERT INTO ordenes (id, producto, numero_orden, envase, fecha, operador,
                                          analista, maquina, turno, estado, campaign_id,
                                          creado_en, pos, raw, sincronizado_en)
                     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14, now())
                     ON CONFLICT (producto, id) DO UPDATE SET
                        numero_orden = EXCLUDED.numero_orden, envase = EXCLUDED.envase,
                        fecha = EXCLUDED.fecha, operador = EXCLUDED.operador,
                        analista = EXCLUDED.analista, maquina = EXCLUDED.maquina,
                        turno = EXCLUDED.turno, estado = EXCLUDED.estado,
                        campaign_id = EXCLUDED.campaign_id, creado_en = EXCLUDED.creado_en,
                        pos = EXCLUDED.pos, raw = EXCLUDED.raw, sincronizado_en = now()`,
                    [
                        ordenId,
                        producto,
                        aTexto(orden.numeroOrden),
                        aTexto(orden.envase),
                        aFecha(orden.fecha),
                        aTexto(orden.operador),
                        aTexto(orden.analista),
                        aTexto(orden.maquina),
                        aTexto(orden.turno),
                        aTexto(orden.estado),
                        aEnteroSeguro(orden.campaign_id),
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
                        envase: aTexto(orden.envase),
                        pos: posCtrl,
                        producto,
                    });
                    conteo.controles += r.control;
                    conteo.mediciones += r.mediciones;
                }
            }

            for (const [posLcc, registro] of lcc.entries()) {
                const r = await guardarControl(cliente, registro, {
                    origen: 'lcc',
                    ordenId: null,
                    envase: aTexto(registro.envase),
                    pos: posLcc,
                    producto,
                });
                conteo.lcc += r.control;
                conteo.mediciones += r.mediciones;
            }
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
