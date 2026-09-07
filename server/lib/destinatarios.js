/**
 * Quien recibe cada notificacion.
 *
 * Dos fuentes que se suman:
 *
 *  - El propio registro: el analista del estudio, el responsable del item del
 *    plan. Esos viajan con el dato y no hay lista que mantener.
 *  - La tabla `notificacion_supervisores`: quien supervisa el proceso. Antes
 *    esto vivia escrito en el codigo, y en estabilidad escrito dos veces.
 *
 * Se resuelve siempre en el servidor. Que lo armara el navegador es la razon
 * por la que la lista estaba duplicada: dos capas decidiendo necesitan cada una
 * su copia.
 */
import { consultar } from '../db.js';

/**
 * Direcciones de quienes supervisan `recurso`. Incluye a los que estan
 * declarados para todas sus notificaciones ('*') y a los declarados para esta
 * en particular.
 *
 * Solo devuelve usuarios activos: dar de baja a alguien tiene que alcanzar para
 * que deje de recibir, sin que nadie se acuerde de tocar una lista.
 */
export async function supervisoresDe(recurso, notificacion) {
    const { rows } = await consultar(
        `SELECT DISTINCT lower(coalesce(u.email, u.usuario)) AS correo
         FROM notificacion_supervisores s
         JOIN usuarios u ON u.id = s.usuario_id
         WHERE s.recurso = $1
           AND s.notificacion IN ('*', $2)
           AND u.activo
           AND coalesce(u.email, u.usuario) LIKE '%@%'
         ORDER BY 1`,
        [recurso, notificacion || '*']
    );
    return rows.map((r) => r.correo);
}

/**
 * Junta el destinatario propio del registro con la supervision, sin repetidos.
 * `propio` acepta una direccion, varias separadas por coma, o nada.
 */
export function unir(propio, supervisores) {
    const set = new Set();
    String(propio || '')
        .split(/[,;]/)
        .map((d) => d.trim().toLowerCase())
        .filter((d) => d.includes('@'))
        .forEach((d) => set.add(d));
    (supervisores || []).forEach((d) => set.add(d));
    return [...set];
}
