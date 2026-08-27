// Aplica los .sql de server/migrations en orden alfabetico, una sola vez cada uno.
// Corre solo al arrancar el servidor; tambien a mano con: npm run migrate
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from './db.js';
import { esEjecucionDirecta } from './lib/entrypoint.js';

const DIR = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

// Clave fija del advisory lock. Cualquier numero sirve mientras no cambie.
const CLAVE_LOCK = 4210771;

// Una migracion se aplica sola en el deploy, sin que nadie la revise en ese
// momento. Para cambios aditivos (crear tablas, agregar columnas) es lo que
// queremos. Para los que destruyen datos, no: en un sistema GMP el historico es
// el activo. Estas se bloquean salvo que se declare la intencion con
// MIGRACIONES_DESTRUCTIVAS=true en el entorno.
const PATRONES_DESTRUCTIVOS =
    /\b(DROP\s+(TABLE|COLUMN|DATABASE|SCHEMA)|TRUNCATE|DELETE\s+FROM|ALTER\s+COLUMN\s+\w+\s+TYPE)\b/i;

/** Quita comentarios para no marcar una migracion por lo que dice su texto. */
function sinComentarios(sql) {
    return sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');
}

function revisarDestructiva(archivo, sql) {
    if (process.env.MIGRACIONES_DESTRUCTIVAS === 'true') return;

    const golpe = sinComentarios(sql).match(PATRONES_DESTRUCTIVOS);
    if (!golpe) return;

    throw new Error(
        `la migracion ${archivo} contiene una sentencia destructiva (${golpe[0].trim()}) ` +
            'y no se aplica automaticamente. Si es intencional, hace backup y ' +
            'levanta el deploy con MIGRACIONES_DESTRUCTIVAS=true'
    );
}

export async function migrar() {
    if (!pool) throw new Error('No hay DATABASE_URL: no se puede migrar.');

    const cliente = await pool.connect();
    let nuevas = 0;

    try {
        // Lock de sesion: si Coolify levanta dos contenedores a la vez, o un
        // redeploy se superpone con el anterior, ambos entrarian aca al mismo
        // tiempo, verian _migraciones vacia y aplicarian el mismo .sql dos
        // veces. El segundo espera y despues las encuentra ya aplicadas.
        await cliente.query('SELECT pg_advisory_lock($1)', [CLAVE_LOCK]);

        await cliente.query(`
            CREATE TABLE IF NOT EXISTS _migraciones (
                nombre      TEXT PRIMARY KEY,
                aplicada_en TIMESTAMPTZ NOT NULL DEFAULT now()
            )
        `);

        const { rows } = await cliente.query('SELECT nombre FROM _migraciones');
        const aplicadas = new Set(rows.map((r) => r.nombre));

        const archivos = (await readdir(DIR)).filter((f) => f.endsWith('.sql')).sort();

        for (const archivo of archivos) {
            if (aplicadas.has(archivo)) continue;

            const sql = await readFile(join(DIR, archivo), 'utf8');
            revisarDestructiva(archivo, sql);

            // Cada migracion en su propia transaccion: si la tercera falla, las
            // dos primeras quedan aplicadas y registradas.
            await cliente.query('BEGIN');
            try {
                await cliente.query(sql);
                await cliente.query('INSERT INTO _migraciones (nombre) VALUES ($1)', [archivo]);
                await cliente.query('COMMIT');
            } catch (err) {
                await cliente.query('ROLLBACK');
                throw new Error(`la migracion ${archivo} fallo: ${err.message}`);
            }

            console.log(`[migrate] aplicada ${archivo}`);
            nuevas++;
        }

        console.log(
            nuevas
                ? `[migrate] ${nuevas} migracion(es) nueva(s)`
                : '[migrate] sin migraciones pendientes'
        );
        return nuevas;
    } finally {
        await cliente.query('SELECT pg_advisory_unlock($1)', [CLAVE_LOCK]).catch(() => {});
        cliente.release();
    }
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
