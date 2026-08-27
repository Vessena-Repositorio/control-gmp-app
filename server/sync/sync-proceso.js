// Replica el dominio de control en proceso desde su Apps Script hacia Postgres.
//
// El origen devuelve { status:'ok', records:[...] } sin ningun id, y hay
// registros completamente identicos entre si (controles enviados dos veces).
// La identidad es la posicion en la hoja: ver el comentario de
// migrations/004_proceso.sql.
//
// Uso:  npm run sync:proceso
import { consultar, enTransaccion, pool } from '../db.js';
import { esEjecucionDirecta } from '../lib/entrypoint.js';
import { descargar, aFecha, aNumero, aTexto, aBooleano, huellaDe } from '../lib/origen.js';

export async function sincronizarProceso() {
    const url = process.env.ORIGEN_PROCESO;
    if (!url) throw new Error('Falta ORIGEN_PROCESO en las variables de entorno.');

    const { rows: logRows } = await consultar(
        `INSERT INTO sync_log (dominio) VALUES ('proceso') RETURNING id`
    );
    const logId = logRows[0].id;
    const t0 = Date.now();

    try {
        const datos = await descargar(url);
        const registros = Array.isArray(datos?.records) ? datos.records : [];

        if (datos?.status && datos.status !== 'ok') {
            throw new Error(`el origen respondio status='${datos.status}'`);
        }
        // Un origen vacio casi siempre es una falla de Apps Script, no una purga.
        if (!registros.length) {
            throw new Error('el origen no devolvio registros; no se toca la base');
        }

        let pesos = 0;

        // Dos registros con el mismo contenido son el mismo control enviado dos
        // veces: no hay forma de que dos controles distintos coincidan en todos
        // los campos, incluida la hora al segundo. Gana el primero; los
        // siguientes quedan marcados apuntando a el.
        const primeraAparicion = new Map();
        const duplicados = [];

        await enTransaccion(async (cliente) => {
            for (const [pos, r] of registros.entries()) {
                const huella = huellaDe(r);
                const original = primeraAparicion.get(huella);
                if (original === undefined) {
                    primeraAparicion.set(huella, pos);
                } else {
                    duplicados.push({ pos, original });
                }

                const { rows } = await cliente.query(
                    `INSERT INTO proceso_controles
                        (pos, fecha, analista, orden, lote, vence, maquina, presentacion,
                         granel, cod_pt, control_num, hora, promedio, spec, ph, has_dev,
                         dev_desc, dev_qty, is_rep, num_fotos, obs, raw,
                         huella, duplicado_de, sincronizado_en)
                     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,
                             $17,$18,$19,$20,$21,$22,$23,$24, now())
                     ON CONFLICT (pos) DO UPDATE SET
                        fecha = EXCLUDED.fecha, analista = EXCLUDED.analista,
                        orden = EXCLUDED.orden, lote = EXCLUDED.lote,
                        vence = EXCLUDED.vence, maquina = EXCLUDED.maquina,
                        presentacion = EXCLUDED.presentacion, granel = EXCLUDED.granel,
                        cod_pt = EXCLUDED.cod_pt, control_num = EXCLUDED.control_num,
                        hora = EXCLUDED.hora, promedio = EXCLUDED.promedio,
                        spec = EXCLUDED.spec, ph = EXCLUDED.ph, has_dev = EXCLUDED.has_dev,
                        dev_desc = EXCLUDED.dev_desc, dev_qty = EXCLUDED.dev_qty,
                        is_rep = EXCLUDED.is_rep, num_fotos = EXCLUDED.num_fotos,
                        obs = EXCLUDED.obs, raw = EXCLUDED.raw, huella = EXCLUDED.huella,
                        duplicado_de = EXCLUDED.duplicado_de, sincronizado_en = now()
                     RETURNING id`,
                    [
                        pos,
                        aFecha(r.fecha),
                        aTexto(r.analista),
                        aTexto(r.orden),
                        aTexto(r.lote),
                        aFecha(r.vence),
                        aTexto(r.maquina),
                        aTexto(r.presentacion),
                        aTexto(r.granel),
                        aTexto(r.codPT),
                        aNumero(r.controlNum),
                        aTexto(r.hora),
                        aNumero(r.promedio),
                        aTexto(r.spec),
                        aNumero(r.ph),
                        aBooleano(r.hasDev),
                        aTexto(r.devDesc),
                        aTexto(r.devQty),
                        aBooleano(r.isRep),
                        aNumero(r.numFotos),
                        aTexto(r.obs),
                        JSON.stringify(r),
                        huella,
                        original === undefined ? null : original,
                    ]
                );

                const controlId = rows[0].id;
                await cliente.query('DELETE FROM proceso_pesos WHERE control_id = $1', [
                    controlId,
                ]);

                const lista = Array.isArray(r.pesos) ? r.pesos : [];
                const filas = [];
                lista.forEach((valor, i) => {
                    if (valor === null || valor === undefined || valor === '') return;
                    filas.push([controlId, i + 1, aNumero(valor), aTexto(valor)]);
                });

                if (filas.length) {
                    const valores = [];
                    const marcadores = filas.map((f, i) => {
                        const b = i * 4;
                        valores.push(...f);
                        return `($${b + 1},$${b + 2},$${b + 3},$${b + 4})`;
                    });
                    await cliente.query(
                        `INSERT INTO proceso_pesos (control_id, muestra, valor_num, valor_texto)
                         VALUES ${marcadores.join(',')}
                         ON CONFLICT (control_id, muestra) DO NOTHING`,
                        valores
                    );
                    pesos += filas.length;
                }
            }

            // Si alguien borro filas de la hoja, la replica tiene que encogerse
            // igual; si no, quedarian controles fantasma al final.
            await cliente.query('DELETE FROM proceso_controles WHERE pos >= $1', [
                registros.length,
            ]);
        });

        // El log guarda los controles utiles, que es el numero que ve el
        // dashboard. Los duplicados van aparte para que la diferencia con la
        // hoja sea explicable y no parezca que se perdieron filas.
        const utiles = registros.length - duplicados.length;

        await consultar(
            `UPDATE sync_log SET fin_en = now(), estado = 'ok',
                    controles = $2, mediciones = $3
             WHERE id = $1`,
            [logId, utiles, pesos]
        );

        const seg = ((Date.now() - t0) / 1000).toFixed(1);
        console.log(
            `[sync:proceso] ok en ${seg}s - ${utiles} controles, ${pesos} pesos`
        );

        // Se avisa en cada corrida: los duplicados siguen en la hoja de origen
        // y solo desaparecen del log cuando alguien los borra alla.
        if (duplicados.length) {
            console.warn(
                `[sync:proceso] ${duplicados.length} control(es) duplicado(s), excluidos de la ` +
                `API pero conservados en la base: ` +
                duplicados.map((d) => `fila ${d.pos + 2} = fila ${d.original + 2}`).join(', ') +
                ' — corregir en la hoja de origen'
            );
        }

        return { controles: utiles, pesos, duplicados: duplicados.length };
    } catch (err) {
        await consultar(
            `UPDATE sync_log SET fin_en = now(), estado = 'error', error = $2 WHERE id = $1`,
            [logId, err.message]
        );
        console.error('[sync:proceso] fallo:', err.message);
        throw err;
    }
}

if (esEjecucionDirecta(import.meta.url)) {
    sincronizarProceso()
        .then(() => pool?.end())
        .catch(() => process.exit(1));
}
