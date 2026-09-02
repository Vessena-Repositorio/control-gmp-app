import { randomBytes, createHash } from 'node:crypto';
import { consultar } from '../db.js';

export const NOMBRE_COOKIE = 'sesion';

/** Diez horas: cubre un turno con margen, sin dejar terminales abiertas de un dia al otro. */
export const DURACION_HORAS = Number(process.env.SESION_HORAS ?? 10);

const huella = (token) => createHash('sha256').update(token).digest('hex');

/** Lee una cookie sin sumar dependencia: el header es una lista `k=v; k=v`. */
export function leerCookie(req, nombre) {
    const crudo = req.headers.cookie;
    if (!crudo) return null;

    for (const parte of crudo.split(';')) {
        const i = parte.indexOf('=');
        if (i < 0) continue;
        if (parte.slice(0, i).trim() === nombre) {
            return decodeURIComponent(parte.slice(i + 1).trim());
        }
    }
    return null;
}

function datosPedido(req) {
    return {
        ip: (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '')
            .toString()
            .split(',')[0]
            .trim() || null,
        userAgent: (req.headers['user-agent'] || '').slice(0, 300) || null,
    };
}

/** Deja constancia en la auditoria. Nunca hace fallar la operacion que la genero. */
export async function auditar(req, { usuarioId, usuarioTxt, accion, recurso, detalle }) {
    const { ip, userAgent } = datosPedido(req);
    try {
        await consultar(
            `INSERT INTO auditoria (usuario_id, usuario_txt, accion, recurso, detalle, ip, user_agent)
             VALUES ($1,$2,$3,$4,$5,$6,$7)`,
            [usuarioId ?? null, usuarioTxt ?? null, accion, recurso ?? null, detalle ?? null, ip, userAgent]
        );
    } catch (err) {
        // Que falle la traza no puede tumbar un login. Se avisa y se sigue.
        console.error('[auditoria] no se pudo registrar:', err.message);
    }
}

export async function crearSesion(req, usuarioId) {
    const token = randomBytes(32).toString('base64url');
    const { ip, userAgent } = datosPedido(req);

    await consultar(
        `INSERT INTO sesiones (token_hash, usuario_id, expira_en, ip, user_agent)
         VALUES ($1, $2, now() + ($3 || ' hours')::interval, $4, $5)`,
        [huella(token), usuarioId, String(DURACION_HORAS), ip, userAgent]
    );

    return token;
}

/** Devuelve el usuario de la sesion, o null si no hay, expiro o se cerro. */
export async function usuarioDeSesion(token) {
    if (!token) return null;

    const { rows } = await consultar(
        `SELECT u.id, u.usuario, u.nombre, u.email
         FROM sesiones s
         JOIN usuarios u ON u.id = s.usuario_id
         WHERE s.token_hash = $1
           AND s.cerrada_en IS NULL
           AND s.expira_en > now()
           AND u.activo`,
        [huella(token)]
    );
    return rows[0] || null;
}

export async function cerrarSesion(token) {
    if (!token) return;
    await consultar(
        `UPDATE sesiones SET cerrada_en = now()
         WHERE token_hash = $1 AND cerrada_en IS NULL`,
        [huella(token)]
    );
}

/** Cierra todas las sesiones de un usuario. Se usa al cambiar la clave. */
export async function cerrarSesionesDe(usuarioId, exceptoToken) {
    await consultar(
        `UPDATE sesiones SET cerrada_en = now()
         WHERE usuario_id = $1 AND cerrada_en IS NULL
           AND ($2::text IS NULL OR token_hash <> $2)`,
        [usuarioId, exceptoToken ? huella(exceptoToken) : null]
    );
}

/**
 * Cookie de sesion. Sin `Secure` porque el servicio se sirve por HTTP en la red
 * interna: marcarla Secure haria que el navegador no la mande y nadie podria
 * entrar. La contrapartida es que la cookie viaja en claro por la LAN; el dia
 * que haya TLS hay que agregar Secure.
 */
export function cookieDeSesion(token) {
    return [
        `${NOMBRE_COOKIE}=${encodeURIComponent(token)}`,
        'HttpOnly',
        'SameSite=Lax',
        'Path=/',
        `Max-Age=${DURACION_HORAS * 3600}`,
    ].join('; ');
}

export function cookieVacia() {
    return `${NOMBRE_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`;
}

/** Middleware: deja la sesion en req.usuario si la hay. No corta el pedido. */
export async function cargarSesion(req, _res, next) {
    try {
        req.usuario = await usuarioDeSesion(leerCookie(req, NOMBRE_COOKIE));
    } catch {
        req.usuario = null;
    }
    next();
}

/** Middleware: exige sesion valida. */
export function exigirSesion(req, res, next) {
    if (!req.usuario) return res.status(401).json({ error: 'sesion requerida' });
    next();
}
