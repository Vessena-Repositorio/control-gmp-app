// Replica el dominio SAO-001 (validacion del sistema de agua) hacia Postgres.
//
// A diferencia de los otros, este origen devuelve CSV. Se guarda el texto
// literal para poder devolverselo al dashboard tal cual, y ademas se parsea a
// tablas para poder consultarlo por SQL.
//
// Uso:  npm run sync:sao001
import { consultar, enTransaccion, pool } from '../db.js';
import { esEjecucionDirecta } from '../lib/entrypoint.js';
import { parsearCsv, indicesPorEncabezado, celda, celdaNumero, celdaFecha } from '../lib/csv.js';
import { descargarTexto } from '../lib/origen.js';

// Cada parametro sale de hasta tres columnas del CSV: el valor y sus limites.
// Los nombres van en minuscula porque el indice de encabezados normaliza asi.
const PARAMETROS = [
    { nombre: 'ph', valor: 'ph', min: 'min ph', max: 'max. ph' },
    { nombre: 'conductividad', valor: 'cond', max: 'max cond' },
    { nombre: 'cloro', valor: 'cloro', min: 'min cloro', max: 'max cloro' },
    { nombre: 'ozono', valor: 'ozono', min: 'min ozono', max: 'max ozono' },
    { nombre: 'micro', valor: 'micro', max: 'max micro' },
    { nombre: 'toc', valor: 'toc', max: 'max toc' },
    { nombre: 'dureza', valor: 'dureza', max: 'max dureza' },
];

export async function sincronizarSao001() {
    const url = process.env.ORIGEN_SAO001;
    if (!url) throw new Error('Falta ORIGEN_SAO001 en las variables de entorno.');

    const { rows: logRows } = await consultar(
        `INSERT INTO sync_log (dominio) VALUES ('sao001') RETURNING id`
    );
    const logId = logRows[0].id;
    const t0 = Date.now();

    try {
        const csv = await descargarTexto(url);
        const filas = parsearCsv(csv);
        if (filas.length < 2) {
            throw new Error('el CSV no trae filas de datos; no se toca la base');
        }

        const encabezado = filas[0];
        const datos = filas.slice(1);
        const idx = indicesPorEncabezado(encabezado);

        // La columna del punto de muestreo se llama '*' en la hoja.
        const iPunto = idx['*'] ?? 0;
        const iFecha = Object.keys(idx).find((k) => k.startsWith('fecha'));

        let parametros = 0;
        const fechasSaneadas = [];

        await enTransaccion(async (cliente) => {
            await cliente.query('DELETE FROM sao001_snapshot');
            await cliente.query(
                'INSERT INTO sao001_snapshot (csv, filas, bytes) VALUES ($1,$2,$3)',
                [csv, datos.length, Buffer.byteLength(csv, 'utf8')]
            );

            for (const [pos, fila] of datos.entries()) {
                const { rows } = await cliente.query(
                    `INSERT INTO sao001_muestras
                        (pos, punto, comentarios, sistema, fecha, fases, observaciones)
                     VALUES ($1,$2,$3,$4,$5,$6,$7)
                     ON CONFLICT (pos) DO UPDATE SET
                        punto = EXCLUDED.punto, comentarios = EXCLUDED.comentarios,
                        sistema = EXCLUDED.sistema, fecha = EXCLUDED.fecha,
                        fases = EXCLUDED.fases, observaciones = EXCLUDED.observaciones
                     RETURNING id`,
                    [
                        pos,
                        celda(fila, iPunto),
                        celda(fila, idx['comentarios']),
                        celda(fila, idx['sistema']),
                        iFecha ? celdaFecha(fila, idx[iFecha], fechasSaneadas) : null,
                        celda(fila, idx['fases']),
                        celda(fila, idx['observaciones']),
                    ]
                );

                const muestraId = rows[0].id;
                await cliente.query('DELETE FROM sao001_parametros WHERE muestra_id = $1', [
                    muestraId,
                ]);

                for (const p of PARAMETROS) {
                    const texto = celda(fila, idx[p.valor]);
                    const num = celdaNumero(fila, idx[p.valor]);
                    // Sin valor no se guarda fila: los limites solos no dicen nada.
                    if (texto === null && num === null) continue;

                    await cliente.query(
                        `INSERT INTO sao001_parametros
                            (muestra_id, parametro, valor_num, valor_texto, limite_min, limite_max)
                         VALUES ($1,$2,$3,$4,$5,$6)
                         ON CONFLICT (muestra_id, parametro) DO UPDATE SET
                            valor_num = EXCLUDED.valor_num, valor_texto = EXCLUDED.valor_texto,
                            limite_min = EXCLUDED.limite_min, limite_max = EXCLUDED.limite_max`,
                        [
                            muestraId,
                            p.nombre,
                            num,
                            texto,
                            p.min ? celdaNumero(fila, idx[p.min]) : null,
                            p.max ? celdaNumero(fila, idx[p.max]) : null,
                        ]
                    );
                    parametros++;
                }
            }

            // Si la hoja encogio, la replica tiene que encoger igual.
            await cliente.query('DELETE FROM sao001_muestras WHERE pos >= $1', [datos.length]);
        });

        await consultar(
            `UPDATE sync_log SET fin_en = now(), estado = 'ok',
                    controles = $2, mediciones = $3
             WHERE id = $1`,
            [logId, datos.length, parametros]
        );

        const seg = ((Date.now() - t0) / 1000).toFixed(1);
        console.log(
            `[sync:sao001] ok en ${seg}s - ${datos.length} muestras, ${parametros} parametros`
        );

        // Se avisa en cada corrida, no una sola vez: el error sigue en la hoja
        // y solo desaparece del log cuando alguien lo corrige alla.
        if (fechasSaneadas.length) {
            const unicas = [...new Set(fechasSaneadas)];
            console.warn(
                `[sync:sao001] ${fechasSaneadas.length} fecha(s) con separadores repetidos, ` +
                `interpretadas igual: ${unicas.join(', ')} — corregir en la hoja de origen`
            );
        }

        return { muestras: datos.length, parametros, fechasSaneadas: fechasSaneadas.length };
    } catch (err) {
        await consultar(
            `UPDATE sync_log SET fin_en = now(), estado = 'error', error = $2 WHERE id = $1`,
            [logId, err.message]
        );
        console.error('[sync:sao001] fallo:', err.message);
        throw err;
    }
}

if (esEjecucionDirecta(import.meta.url)) {
    sincronizarSao001()
        .then(() => pool?.end())
        .catch(() => process.exit(1));
}
