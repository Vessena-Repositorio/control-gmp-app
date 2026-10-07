/**
 * Audit trail Part 11 (tabla audit_trail, migracion 054).
 *
 * Las filas no las escribe este modulo: las escribe un trigger en cada tabla
 * auditada, asi ningun camino del codigo puede cambiar un registro sin dejar
 * rastro. Lo que hace este modulo es decirle a la base QUIEN cambia y POR QUE,
 * dentro de la misma transaccion. Sin eso el trigger rechaza el cambio.
 *
 * No confundir con `auditar()` de sesiones.js, que es el registro de accesos
 * (logins, permisos denegados) y no lleva cadena de hashes.
 */
import { consultar, enTransaccion } from '../db.js';

function ipDe(req) {
    return (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '')
        .toString().split(',')[0].trim();
}

/**
 * Declara el autor y el motivo para el resto de la transaccion `c`.
 * set_config(..., true) vale solo hasta el COMMIT: no se filtra a otro pedido
 * que reuse la conexion del pool.
 */
export async function fijarAutor(c, req, motivo) {
    const nombre = req.usuario?.nombre || req.usuario?.usuario;
    if (!nombre) throw new Error('no hay usuario identificado para el audit trail');
    await c.query(
        `SELECT set_config('app.usuario_id', $1, true),
                set_config('app.usuario_nombre', $2, true),
                set_config('app.motivo', $3, true),
                set_config('app.ip', $4, true)`,
        [String(req.usuario.id ?? ''), nombre, String(motivo || '').trim(), ipDe(req)]
    );
}

/** enTransaccion() con el autor y el motivo ya declarados. */
export function enTransaccionAuditada(req, motivo, fn) {
    return enTransaccion(async (c) => {
        await fijarAutor(c, req, motivo);
        return fn(c);
    });
}

/**
 * Para las tareas programadas, que no tienen persona detras: quedan en el
 * audit trail como "Sistema (<que>)", sin usuario_id. La decision que las
 * origina (la aprobacion con su fecha de vigencia) ya tiene su firma.
 */
export function enTransaccionSistema(que, motivo, fn) {
    return enTransaccion(async (c) => {
        await c.query(
            `SELECT set_config('app.usuario_id', '', true),
                    set_config('app.usuario_nombre', $1, true),
                    set_config('app.motivo', $2, true),
                    set_config('app.ip', '', true)`,
            [`Sistema (${que})`, motivo]
        );
        return fn(c);
    });
}

/** Historia de un registro, de la mas vieja a la mas nueva. */
export async function historial(tabla, registroId) {
    const { rows } = await consultar(
        `SELECT seq, ts, usuario_nombre, accion, cambios, despues, motivo
         FROM audit_trail
         WHERE tabla = $1 AND registro_id = $2
         ORDER BY seq`,
        [tabla, String(registroId)]
    );
    return rows;
}

/**
 * Recorre la cadena completa. Devuelve { integro, problemas, registros }.
 * Si alguien con acceso a la base retoca o borra una fila, aca aparece.
 */
export async function verificarIntegridad() {
    const [{ rows: problemas }, { rows: [{ n }] }] = await Promise.all([
        consultar('SELECT seq, problema FROM verificar_audit_trail()'),
        consultar('SELECT count(*)::int AS n FROM audit_trail'),
    ]);
    return { integro: problemas.length === 0, problemas, registros: n };
}
