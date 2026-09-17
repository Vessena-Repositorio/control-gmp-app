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
 *
 * Las semanales corren una vez por semana a partir de `diaSemana`: si el lunes
 * el contenedor estaba caido, sale el martes. Esa recuperacion es solo para
 * tareas que ya corrieron alguna vez; una recien encendida espera a su dia, para
 * que prender un aviso un jueves no mande un resumen semanal ese mismo jueves.
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
            const { rows } = await consultar(
                'SELECT ultimo_dia FROM tarea_diaria WHERE nombre = $1', [nombre]
            );
            const ultimo = rows[0]?.ultimo_dia;
            const hoy = comoDia(reloj.hoy);

            if (diaSemana) {
                const esElDia = reloj.dia_semana === diaSemana;
                const recupera = ultimo && reloj.dia_semana > diaSemana;
                if (!esElDia && !recupera) {
                    return { estado: 'no es el dia', diaSemana: reloj.dia_semana };
                }
            }
            if (reloj.hora < hora) return { estado: 'todavia no es la hora', hora: reloj.hora };

            // Diaria: ya corrio hoy. Semanal: ya corrio desde el dia que le toca
            // esta semana.
            const desde = diaSemana ? sumarDias(hoy, diaSemana - reloj.dia_semana) : hoy;
            if (ultimo && comoDia(ultimo) >= desde) {
                return { estado: diaSemana ? 'ya corrio esta semana' : 'ya corrio hoy' };
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

/** 'AAAA-MM-DD' corrido `n` dias (n puede ser negativo). */
export function sumarDias(dia, n) {
    const [y, m, d] = String(dia).split('-').map(Number);
    const f = new Date(Date.UTC(y, m - 1, d + n));
    const p = (x) => String(x).padStart(2, '0');
    return `${f.getUTCFullYear()}-${p(f.getUTCMonth() + 1)}-${p(f.getUTCDate())}`;
}

const DIAS = { lunes: 1, martes: 2, miercoles: 3, jueves: 4, viernes: 5, sabado: 6, domingo: 7 };

/**
 * Dia de la semana de una variable de entorno: 1..7 (lunes=1) o el nombre del
 * dia. "diario" o 0 devuelven null, que es correr todos los dias. Un valor que
 * no se entiende usa el de por defecto y lo avisa, en vez de apagar el aviso.
 */
export function diaDeEntorno(variable, porDefecto) {
    const v = String(process.env[variable] ?? '').trim().toLowerCase()
        .normalize('NFD').replace(/[̀-ͯ]/g, '');
    if (!v) return porDefecto;
    if (v === 'diario' || v === '0') return null;
    const n = DIAS[v] ?? Number(v);
    if (Number.isInteger(n) && n >= 1 && n <= 7) return n;
    console.warn(`[tareas] ${variable}="${process.env[variable]}" no es un dia valido; se usa ${porDefecto ?? 'diario'}`);
    return porDefecto;
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

/**
 * Una coleccion de capacitaciones, desde donde hoy sea la fuente de verdad.
 *
 * Hasta el corte los avisos leian de `documentos`, o sea de lo que la replica
 * bajaba de la hoja. Despues del corte la app escribe en `capacitaciones_datos`
 * y la hoja queda congelada: seguir leyendo la replica habria dejado los
 * correos mirando una foto vieja, avisando de inducciones ya hechas y callando
 * las nuevas. Y no se habria notado, porque los correos igual salen.
 *
 * Se prefiere la tabla nueva y se cae a la replica solo si esa tabla todavia no
 * existe -por ejemplo si la migracion no corrio-, para que un despliegue a
 * medias no deje los avisos sin datos.
 */
export async function coleccionCapacitaciones(clave) {
    try {
        const { rows } = await consultar(
            'SELECT valor FROM capacitaciones_datos WHERE clave = $1',
            [clave]
        );
        if (rows.length) {
            const datos = JSON.parse(rows[0].valor);
            if (Array.isArray(datos)) return datos;
        }
    } catch (err) {
        console.warn(`[capacitaciones] no se pudo leer ${clave} de capacitaciones_datos:`, err.message);
    }
    return documentosDe('capacitaciones', clave);
}
