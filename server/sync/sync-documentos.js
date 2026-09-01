// Replica hacia Postgres los dominios que todavia no alimentan ningun
// dashboard: no conformidades, control de cambios, estabilidad, capacitaciones
// y devoluciones.
//
// Es solo migracion de datos. Estas apps siguen leyendo y escribiendo en su
// hoja, y NO se las apunta a Postgres: si leyeran de una replica que se
// refresca cada 15 minutos, guardar una no conformidad y no verla aparecer se
// veria como una app rota.
//
// Uso:  npm run sync:documentos
import { consultar, enTransaccion, pool } from '../db.js';
import { esEjecucionDirecta } from '../lib/entrypoint.js';
import { descargar } from '../lib/origen.js';

// Campos que se prueban como identidad de un registro, en orden. Si ninguno
// esta, se usa la posicion. Se prefiere un id del origen porque sobrevive a que
// la hoja se reordene.
const CAMPOS_CLAVE = ['id', 'seq', 'numero', 'nombre', 'n'];

const DOMINIOS = [
    {
        dominio: 'no_conformidades',
        env: 'ORIGEN_NC',
        peticiones: [{ query: '?action=getAll', colecciones: ['ncs'] }],
    },
    {
        // Comparte el Apps Script con no conformidades, pero es otra accion y
        // otro dominio: conviene que fallen y se cuenten por separado.
        dominio: 'control_cambios',
        env: 'ORIGEN_NC',
        peticiones: [{ query: '?action=getAll_CC', colecciones: ['ccs'] }],
    },
    {
        dominio: 'estabilidad',
        env: 'ORIGEN_ESTABILIDAD',
        // Este origen manda cada coleccion como texto JSON dentro del JSON.
        anidadas: true,
        // `usuarios` no va aca sino por sync-usuarios.js: son identidades y
        // credenciales, y necesitan sus propias tablas para que el login pueda
        // verificar contra ellas y reescribir el hash a un esquema fuerte.
        peticiones: [{ query: '', colecciones: ['productos', 'studies', 'auditLog'] }],
    },
    {
        dominio: 'capacitaciones',
        env: 'ORIGEN_CAPACITACIONES',
        peticiones: [{ query: '', colecciones: ['R', 'PL', 'PE', 'AUDIT'] }],
    },
    {
        dominio: 'devoluciones',
        env: 'ORIGEN_DEVOLUCIONES',
        peticiones: [
            { query: '?action=getAllSnapshots', colecciones: ['snapshots'] },
            { query: '?action=listMeses', colecciones: ['meses'] },
            { query: '?action=getPersonas', colecciones: ['personas'] },
            { query: '?action=getMotivos', colecciones: ['motivos'] },
        ],
    },
];

/** Identidad del registro: un id del origen si lo tiene, si no su posicion. */
function claveDe(item, pos) {
    if (item && typeof item === 'object' && !Array.isArray(item)) {
        for (const campo of CAMPOS_CLAVE) {
            const v = item[campo];
            if (v !== undefined && v !== null && String(v).trim() !== '') {
                return String(v);
            }
        }
    }
    return `pos:${pos}`;
}

/**
 * Normaliza una coleccion a pares [clave, registro].
 * Puede venir como array (lista de registros) o como objeto (mapa con la clave
 * adentro, por ejemplo los snapshots de devoluciones, indexados por mes).
 */
function aRegistros(valor) {
    if (Array.isArray(valor)) {
        return valor.map((item, i) => [claveDe(item, i), item, i]);
    }
    if (valor && typeof valor === 'object') {
        return Object.entries(valor).map(([k, v], i) => [k, v, i]);
    }
    return [];
}

async function replicarDominio(cfg) {
    const url = process.env[cfg.env];

    const { rows: logRows } = await consultar(
        `INSERT INTO sync_log (dominio) VALUES ($1) RETURNING id`,
        [cfg.dominio]
    );
    const logId = logRows[0].id;
    const t0 = Date.now();

    try {
        if (!url) throw new Error(`Falta ${cfg.env} en las variables de entorno.`);

        let total = 0;
        const detalle = {};

        for (const peticion of cfg.peticiones) {
            const datos = await descargar(url + peticion.query);
            if (datos?.ok === false) {
                throw new Error(`el origen respondio ok=false: ${datos.error || 'sin detalle'}`);
            }

            for (const nombre of peticion.colecciones) {
                let valor = datos?.[nombre];

                // Algunos origenes mandan la coleccion como texto JSON.
                if (cfg.anidadas && typeof valor === 'string') {
                    try {
                        valor = JSON.parse(valor);
                    } catch {
                        throw new Error(`la coleccion '${nombre}' no es JSON valido`);
                    }
                }

                const registros = aRegistros(valor);
                detalle[nombre] = registros.length;
                total += registros.length;

                await enTransaccion(async (cliente) => {
                    for (const [clave, item, pos] of registros) {
                        await cliente.query(
                            `INSERT INTO documentos
                                (dominio, coleccion, clave_natural, pos, raw, sincronizado_en)
                             VALUES ($1,$2,$3,$4,$5, now())
                             ON CONFLICT (dominio, coleccion, clave_natural) DO UPDATE SET
                                pos = EXCLUDED.pos, raw = EXCLUDED.raw,
                                sincronizado_en = now()`,
                            [cfg.dominio, nombre, clave, pos, JSON.stringify(item)]
                        );
                    }

                    // Lo que ya no esta en el origen se va tambien, para que la
                    // replica converja en vez de acumular registros fantasma.
                    // Una coleccion vacia NO borra nada: casi siempre es una
                    // falla del origen, no un borrado real.
                    if (registros.length) {
                        await cliente.query(
                            `DELETE FROM documentos
                             WHERE dominio = $1 AND coleccion = $2
                               AND clave_natural <> ALL($3::text[])`,
                            [cfg.dominio, nombre, registros.map((r) => r[0])]
                        );
                    }
                });
            }
        }

        await consultar(
            `UPDATE sync_log SET fin_en = now(), estado = 'ok', controles = $2 WHERE id = $1`,
            [logId, total]
        );

        const seg = ((Date.now() - t0) / 1000).toFixed(1);
        const resumen = Object.entries(detalle)
            .map(([k, v]) => `${k}=${v}`)
            .join(' ');
        console.log(`[sync:${cfg.dominio}] ok en ${seg}s - ${total} documentos (${resumen})`);
        return { dominio: cfg.dominio, total, detalle };
    } catch (err) {
        await consultar(
            `UPDATE sync_log SET fin_en = now(), estado = 'error', error = $2 WHERE id = $1`,
            [logId, err.message]
        );
        console.error(`[sync:${cfg.dominio}] fallo:`, err.message);
        throw err;
    }
}

/**
 * Replica todos los dominios genericos. Cada uno se intenta por separado: que
 * un Apps Script este caido no puede impedir que se repliquen los demas.
 */
export async function sincronizarDocumentos() {
    const resultados = [];
    const fallos = [];

    for (const cfg of DOMINIOS) {
        try {
            resultados.push(await replicarDominio(cfg));
        } catch (err) {
            fallos.push({ dominio: cfg.dominio, error: err.message });
        }
    }

    if (!resultados.length) {
        throw new Error(
            'ningun dominio replico: ' + fallos.map((f) => `${f.dominio} (${f.error})`).join(', ')
        );
    }

    return { dominios: resultados, fallos };
}

export const DOMINIOS_DOCUMENTOS = DOMINIOS.map((d) => d.dominio);

if (esEjecucionDirecta(import.meta.url)) {
    sincronizarDocumentos()
        .then((r) => {
            if (r.fallos.length) console.warn('[sync:documentos] con fallos:', r.fallos);
            return pool?.end();
        })
        .catch(() => process.exit(1));
}
