// Replica los KPIs de Fabuloso hacia Postgres.
//
// Es el unico origen que no pasa por Apps Script: el dashboard lee la hoja de
// Google directo por gviz, en CSV. Se guarda el texto literal para devolverselo
// tal cual, y se parsea a tablas para poder consultarlo.
//
// Uso:  npm run sync:fabuloso
import { consultar, enTransaccion, pool } from '../db.js';
import { esEjecucionDirecta } from '../lib/entrypoint.js';
import { parsearCsv, indicesPorEncabezado, celda, celdaNumero, celdaFecha } from '../lib/csv.js';
import { descargarTexto } from '../lib/origen.js';

// Columnas que identifican la fila; el resto pasa a fabuloso_valores.
const IDENTIFICADORAS = new Set(['v', 'código', 'codigo', 'descripcion', 'descripción', 'lote']);

export async function sincronizarFabuloso() {
    // El log se abre antes de validar la configuracion: si falta la variable,
    // el fallo tiene que quedar registrado y visible en /estado, no solo en los
    // logs del contenedor.
    const { rows: logRows } = await consultar(
        `INSERT INTO sync_log (dominio) VALUES ('fabuloso') RETURNING id`
    );
    const logId = logRows[0].id;
    const t0 = Date.now();

    try {
        const url = process.env.ORIGEN_FABULOSO;
        if (!url) throw new Error('Falta ORIGEN_FABULOSO en las variables de entorno.');

        const csv = await descargarTexto(url);
        const filas = parsearCsv(csv);
        if (filas.length < 2) {
            throw new Error('el CSV no trae filas de datos; no se toca la base');
        }

        const encabezado = filas[0];
        const datos = filas.slice(1);
        const idx = indicesPorEncabezado(encabezado);

        const iFechaEnv = Object.keys(idx).find((k) => k.startsWith('fecha envasado'));
        let valores = 0;

        await enTransaccion(async (cliente) => {
            await cliente.query('DELETE FROM fabuloso_snapshot');
            await cliente.query(
                'INSERT INTO fabuloso_snapshot (csv, filas, bytes) VALUES ($1,$2,$3)',
                [csv, datos.length, Buffer.byteLength(csv, 'utf8')]
            );

            for (const [pos, fila] of datos.entries()) {
                // El raw de la fila se guarda como objeto columna->valor, que se
                // lee mucho mejor que un array posicional al depurar.
                const objeto = {};
                encabezado.forEach((nombre, i) => {
                    const clave = (nombre || '').trim() || `col_${i}`;
                    objeto[clave] = fila[i] ?? '';
                });

                const { rows } = await cliente.query(
                    `INSERT INTO fabuloso_lotes
                        (pos, clave, codigo, descripcion, lote, fecha_envasado, raw_fila)
                     VALUES ($1,$2,$3,$4,$5,$6,$7)
                     ON CONFLICT (pos) DO UPDATE SET
                        clave = EXCLUDED.clave, codigo = EXCLUDED.codigo,
                        descripcion = EXCLUDED.descripcion, lote = EXCLUDED.lote,
                        fecha_envasado = EXCLUDED.fecha_envasado,
                        raw_fila = EXCLUDED.raw_fila
                     RETURNING id`,
                    [
                        pos,
                        celda(fila, idx['v']),
                        celda(fila, idx['código'] ?? idx['codigo']),
                        celda(fila, idx['descripcion'] ?? idx['descripción']),
                        celda(fila, idx['lote']),
                        iFechaEnv ? celdaFecha(fila, idx[iFechaEnv]) : null,
                        JSON.stringify(objeto),
                    ]
                );

                const loteId = rows[0].id;
                await cliente.query('DELETE FROM fabuloso_valores WHERE lote_id = $1', [loteId]);

                // Todo lo que no identifica la fila entra como clave/valor. La
                // hoja tiene 6 columnas sin encabezado al final: se saltean,
                // porque sin nombre no hay forma de consultarlas despues.
                const yaVisto = new Set();
                for (let i = 0; i < encabezado.length; i++) {
                    const nombre = (encabezado[i] || '').trim();
                    if (!nombre) continue;

                    const clave = nombre.toLowerCase();
                    if (IDENTIFICADORAS.has(clave)) continue;
                    if (yaVisto.has(nombre)) continue; // encabezados repetidos
                    yaVisto.add(nombre);

                    const texto = celda(fila, i);
                    if (texto === null) continue;

                    await cliente.query(
                        `INSERT INTO fabuloso_valores (lote_id, columna, valor_num, valor_texto)
                         VALUES ($1,$2,$3,$4)
                         ON CONFLICT (lote_id, columna) DO UPDATE SET
                            valor_num = EXCLUDED.valor_num, valor_texto = EXCLUDED.valor_texto`,
                        [loteId, nombre, celdaNumero(fila, i), texto]
                    );
                    valores++;
                }
            }

            // Si la hoja encogio, la replica tiene que encoger igual.
            await cliente.query('DELETE FROM fabuloso_lotes WHERE pos >= $1', [datos.length]);
        });

        await consultar(
            `UPDATE sync_log SET fin_en = now(), estado = 'ok',
                    controles = $2, mediciones = $3
             WHERE id = $1`,
            [logId, datos.length, valores]
        );

        const seg = ((Date.now() - t0) / 1000).toFixed(1);
        console.log(`[sync:fabuloso] ok en ${seg}s - ${datos.length} lotes, ${valores} valores`);
        return { lotes: datos.length, valores };
    } catch (err) {
        await consultar(
            `UPDATE sync_log SET fin_en = now(), estado = 'error', error = $2 WHERE id = $1`,
            [logId, err.message]
        );
        console.error('[sync:fabuloso] fallo:', err.message);
        throw err;
    }
}

if (esEjecucionDirecta(import.meta.url)) {
    sincronizarFabuloso()
        .then(() => pool?.end())
        .catch(() => process.exit(1));
}
