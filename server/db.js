import pg from 'pg';

const { Pool } = pg;

// Postgres devuelve NUMERIC como string para no perder precision. En este
// dominio son medidas de laboratorio que caben de sobra en un double, y los
// dashboards esperan numeros, asi que se convierten al leer.
pg.types.setTypeParser(pg.types.builtins.NUMERIC, (v) => (v === null ? null : parseFloat(v)));
// INT8 (bigserial / bigint): los ids son epoch en ms, muy por debajo del limite seguro.
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => (v === null ? null : parseInt(v, 10)));

// Sin DATABASE_URL no se crea pool y `pool` queda en null. Es deliberado: este
// mismo proceso sirve las 21 apps que todavia no dependen de Postgres, y un
// problema de base no puede voltearlas. Todo lo que necesite la base falla
// aparte, con un mensaje claro, y el resto del sitio sigue en pie.
export const hayBase = Boolean(process.env.DATABASE_URL);

export const pool = hayBase
    ? new Pool({
          connectionString: process.env.DATABASE_URL,
          max: 10,
          idleTimeoutMillis: 30_000,
          connectionTimeoutMillis: 10_000,
          // Coolify suele exponer Postgres en la red interna sin TLS. Si tu
          // instancia exige TLS, agrega ?sslmode=require al DATABASE_URL.
          ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
      })
    : null;

if (pool) {
    pool.on('error', (err) => {
        console.error('[db] error en cliente inactivo del pool:', err.message);
    });
} else {
    console.warn(
        '[db] DATABASE_URL no configurada: la API respondera 503 y el sitio ' +
            'servira solo los .html. Esto es lo esperable antes de migrar.'
    );
}

class SinBaseError extends Error {
    constructor() {
        super('DATABASE_URL no esta configurada en este servicio');
        this.name = 'SinBaseError';
        this.sinBase = true;
    }
}

export function consultar(texto, valores) {
    if (!pool) return Promise.reject(new SinBaseError());
    return pool.query(texto, valores);
}

/** Ejecuta fn dentro de una transaccion; revierte todo si algo falla. */
export async function enTransaccion(fn) {
    if (!pool) throw new SinBaseError();

    const cliente = await pool.connect();
    try {
        await cliente.query('BEGIN');
        const resultado = await fn(cliente);
        await cliente.query('COMMIT');
        return resultado;
    } catch (err) {
        await cliente.query('ROLLBACK');
        throw err;
    } finally {
        cliente.release();
    }
}
