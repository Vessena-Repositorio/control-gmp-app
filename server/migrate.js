// Aplica los .sql de server/migrations en orden alfabetico, una sola vez cada uno.
// Se ejecuta al arrancar el servidor y tambien a mano con: npm run migrate
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool, consultar, enTransaccion } from './db.js';
import { esEjecucionDirecta } from './lib/entrypoint.js';

const DIR = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

export async function migrar() {
    await consultar(`
        CREATE TABLE IF NOT EXISTS _migraciones (
            nombre      TEXT PRIMARY KEY,
            aplicada_en TIMESTAMPTZ NOT NULL DEFAULT now()
        )
    `);

    const { rows } = await consultar('SELECT nombre FROM _migraciones');
    const aplicadas = new Set(rows.map((r) => r.nombre));

    const archivos = (await readdir(DIR)).filter((f) => f.endsWith('.sql')).sort();
    let nuevas = 0;

    for (const archivo of archivos) {
        if (aplicadas.has(archivo)) continue;
        const sql = await readFile(join(DIR, archivo), 'utf8');
        await enTransaccion(async (c) => {
            await c.query(sql);
            await c.query('INSERT INTO _migraciones (nombre) VALUES ($1)', [archivo]);
        });
        console.log(`[migrate] aplicada ${archivo}`);
        nuevas++;
    }

    console.log(
        nuevas ? `[migrate] ${nuevas} migracion(es) nueva(s)` : '[migrate] sin migraciones pendientes'
    );
    return nuevas;
}

// Ejecutado directamente (npm run migrate), no importado.
if (esEjecucionDirecta(import.meta.url)) {
    migrar()
        .then(() => pool?.end())
        .catch((err) => {
            console.error('[migrate] fallo:', err.message);
            process.exit(1);
        });
}
