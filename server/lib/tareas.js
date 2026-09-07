/**
 * Corrida de tareas diarias y semanales.
 *
 * Todo aviso programado necesita lo mismo: no mandar dos veces el mismo dia, no
 * mandar dos veces si hay dos instancias, y no volver a mandar todo cada vez que
 * se despliega. Esa logica vive aca una sola vez en vez de copiada en cada
 * modulo de avisos.
 *
 * La condicion de "ya corrio" se guarda en la base y no en el proceso: atada al
 * arranque, cada deploy dispararia otra tanda de correos.
 */
import { consultar } from '../db.js';

export const ZONA = process.env.ZONA_HORARIA || 'America/Montevideo';

/** Fecha y hora local, resueltas por Postgres, que tiene la tabla de zonas. */
export async function relojLocal() {
    const { rows } = await consultar(
        `SELECT (now() AT TIME ZONE $1)::date                    AS hoy,
                EXTRACT(hour  FROM now() AT TIME ZONE $1)::int   AS hora,
                EXTRACT(isodow FROM now() AT TIME ZONE $1)::int  AS dia_semana`,
        [ZONA]
    );
    return rows[0];
}

/** 'AAAA-MM-DD' de un Date o de lo que devuelva el driver. */
export function comoDia(v) {
    if (v instanceof Date) {
        // Se formatea con las partes locales del propio valor: toISOString lo
        // pasaria a UTC y en Uruguay eso corre la fecha un dia hacia atras.
        const p = (n) => String(n).padStart(2, '0');
        return `${v.getFullYear()}-${p(v.getMonth() + 1)}-${p(v.getDate())}`;
    }
    return String(v ?? '').slice(0, 10);
}

/**
 * Corre `fn` como maximo una vez al dia.
 *
 * opciones:
 *   hora        — a partir de que hora local puede correr (default 8)
 *   diaSemana   — 1..7 (ISO, lunes=1) para tareas semanales; omitido = diaria
 *   forzar      — ignora hora y "ya corrio hoy"; no marca el dia como corrido
 *   activa      — si es false no hace nada (interruptor de encendido)
 *
 * Si un dia no llega a correr -deploy, corte, contenedor caido- la corrida del
 * dia siguiente igual sucede. Lo unico que se garantiza es no repetir, no que
 * cada dia tenga exactamente una.
 */
export async function correrUnaVezPorDia(nombre, opciones, fn) {
    const { hora = 8, diaSemana = null, forzar = false, activa = true } = opciones || {};

    if (!forzar && !activa) return { estado: 'apagada' };

    // Con dos instancias levantadas, una sola manda.
    const { rows: candado } = await consultar(
        'SELECT pg_try_advisory_lock(hashtext($1)) AS tomado', [nombre]
    );
    if (!candado[0].tomado) return { estado: 'otra instancia lo esta corriendo' };

    try {
        const reloj = await relojLocal();

        if (!forzar) {
            if (diaSemana && reloj.dia_semana !== diaSemana) {
                return { estado: 'no es el dia', diaSemana: reloj.dia_semana };
            }
            if (reloj.hora < hora) return { estado: 'todavia no es la hora', hora: reloj.hora };

            const { rows } = await consultar(
                'SELECT ultimo_dia FROM tarea_diaria WHERE nombre = $1', [nombre]
            );
            const ultimo = rows[0]?.ultimo_dia;
            if (ultimo && comoDia(ultimo) >= comoDia(reloj.hoy)) {
                return { estado: 'ya corrio hoy' };
            }
        }

        const resultado = await fn(reloj);

        // Una corrida forzada es una prueba: si marcara el dia, probar a la
        // mañana cancelaria el envio real de ese mismo dia.
        if (!forzar) await marcar(nombre, resultado?.detalle || '');

        return { estado: 'ok', ...resultado };
    } finally {
        await consultar('SELECT pg_advisory_unlock(hashtext($1))', [nombre]).catch(() => {});
    }
}

async function marcar(nombre, detalle) {
    await consultar(
        `INSERT INTO tarea_diaria (nombre, ultimo_dia, ultima_corrida, detalle)
         VALUES ($1, (now() AT TIME ZONE $2)::date, now(), $3)
         ON CONFLICT (nombre) DO UPDATE
            SET ultimo_dia = EXCLUDED.ultimo_dia,
                ultima_corrida = EXCLUDED.ultima_corrida,
                detalle = EXCLUDED.detalle`,
        [nombre, ZONA, String(detalle).slice(0, 500)]
    );
}

/** Lee una coleccion replicada del store generico de documentos. */
export async function documentosDe(dominio, coleccion) {
    const { rows } = await consultar(
        `SELECT raw FROM documentos
         WHERE dominio = $1 AND coleccion = $2
         ORDER BY pos NULLS LAST, id`,
        [dominio, coleccion]
    );
    return rows.map((r) => r.raw);
}
