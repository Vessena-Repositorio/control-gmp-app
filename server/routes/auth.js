import { Router } from 'express';
import { consultar } from '../db.js';
import { hashear, verificar } from '../lib/claves.js';
import { PERMISOS_POR_ROL } from '../lib/permisos.js';
import {
    crearSesion, cerrarSesion, cerrarSesionesDe, cookieDeSesion, cookieVacia,
    leerCookie, NOMBRE_COOKIE, auditar, exigirSesion, DURACION_HORAS,
} from '../lib/sesiones.js';

export const rutasAuth = Router();

// Freno simple de fuerza bruta: pasados estos intentos fallidos en la ventana,
// el usuario queda bloqueado hasta que la ventana corra. Usa la auditoria, que
// ya se escribe igual, en vez de sumar estado en memoria que se pierde en cada
// deploy.
const INTENTOS_MAX = 10;
const VENTANA_MIN = 15;

async function intentosFallidos(usuarioTxt) {
    const { rows } = await consultar(
        `SELECT count(*)::int AS n FROM auditoria
         WHERE accion = 'login_fallido'
           AND lower(usuario_txt) = lower($1)
           AND ts > now() - ($2 || ' minutes')::interval`,
        [usuarioTxt, String(VENTANA_MIN)]
    );
    return rows[0].n;
}

/**
 * POST /api/auth/login  { usuario, clave }
 *
 * Deja la sesion en una cookie HttpOnly. El token no vuelve en el cuerpo: si
 * volviera, cualquier script de la pagina podria leerlo, que es justo lo que
 * HttpOnly evita.
 */
rutasAuth.post('/login', async (req, res) => {
    const { usuario, clave } = req.body || {};
    if (!usuario || !clave) {
        return res.status(400).json({ error: 'faltan usuario o clave' });
    }

    try {
        if ((await intentosFallidos(usuario)) >= INTENTOS_MAX) {
            await auditar(req, { usuarioTxt: usuario, accion: 'login_bloqueado' });
            return res.status(429).json({
                error: `demasiados intentos fallidos; probá de nuevo en ${VENTANA_MIN} minutos`,
            });
        }

        const { rows } = await consultar(
            `SELECT u.id, u.usuario, u.nombre, c.esquema, c.valor
             FROM usuarios u
             LEFT JOIN credenciales c ON c.usuario_id = u.id
             WHERE lower(u.usuario) = lower($1) AND u.activo
             ORDER BY (u.origen = 'vessena') DESC
             LIMIT 1`,
            [usuario]
        );

        const u = rows[0];
        const resultado = u?.valor
            ? await verificar(clave, u.esquema, u.valor)
            : { ok: false, necesitaRehash: false };

        if (!resultado.ok) {
            await auditar(req, {
                usuarioId: u?.id,
                usuarioTxt: usuario,
                accion: 'login_fallido',
                // No se guarda por que fallo con mas detalle: alcanza para
                // investigar y no deja pistas de si el usuario existe.
                detalle: u ? 'clave incorrecta' : 'usuario inexistente',
            });
            // Misma respuesta en los dos casos: decir cual de los dos fallo
            // permite averiguar que usuarios existen.
            return res.status(401).json({ error: 'usuario o clave incorrectos' });
        }

        // La credencial era valida pero estaba en un esquema viejo: se reescribe
        // ahora, que es el unico momento en que se tiene la clave en claro.
        if (resultado.necesitaRehash) {
            await consultar(
                `UPDATE credenciales SET esquema = 'scrypt', valor = $2,
                        migrado_en = now(), actualizado_en = now()
                 WHERE usuario_id = $1`,
                [u.id, await hashear(clave)]
            );
            await auditar(req, {
                usuarioId: u.id, usuarioTxt: usuario, accion: 'rehash_credencial',
                detalle: `de ${u.esquema} a scrypt`,
            });
        }

        const token = await crearSesion(req, u.id);
        await auditar(req, { usuarioId: u.id, usuarioTxt: usuario, accion: 'login_ok' });

        res.setHeader('Set-Cookie', cookieDeSesion(token));
        res.json({ estado: 'ok', usuario: u.usuario, nombre: u.nombre, horas: DURACION_HORAS });
    } catch (err) {
        console.error('[auth] login:', err.message);
        res.status(500).json({ error: 'no se pudo iniciar sesion' });
    }
});

/** POST /api/auth/logout */
rutasAuth.post('/logout', async (req, res) => {
    const token = leerCookie(req, NOMBRE_COOKIE);
    try {
        if (req.usuario) {
            await auditar(req, {
                usuarioId: req.usuario.id, usuarioTxt: req.usuario.usuario, accion: 'logout',
            });
        }
        await cerrarSesion(token);
    } catch (err) {
        console.error('[auth] logout:', err.message);
    }
    res.setHeader('Set-Cookie', cookieVacia());
    res.json({ estado: 'ok' });
});

/**
 * GET /api/auth/yo
 * Quien esta logueado y que puede hacer en cada app. Es lo que consulta cada
 * pagina para decidir que mostrar.
 */
rutasAuth.get('/yo', async (req, res, next) => {
    if (!req.usuario) return res.status(401).json({ error: 'sesion requerida' });

    try {
        const { rows } = await consultar(
            `SELECT recurso, rol FROM usuario_recursos WHERE usuario_id = $1`,
            [req.usuario.id]
        );

        const recursos = {};
        for (const f of rows) {
            recursos[f.recurso] = { rol: f.rol, permisos: PERMISOS_POR_ROL[f.rol] || [] };
        }

        res.json({
            usuario: req.usuario.usuario,
            nombre: req.usuario.nombre,
            email: req.usuario.email,
            recursos,
        });
    } catch (err) {
        next(err);
    }
});

/**
 * POST /api/auth/clave  { actual, nueva }
 * Cada persona cambia la suya. Exige la actual: sin eso, una sesion robada
 * alcanzaria para quedarse con la cuenta.
 */
rutasAuth.post('/clave', exigirSesion, async (req, res) => {
    const { actual, nueva } = req.body || {};

    if (!actual || !nueva) {
        return res.status(400).json({ error: 'faltan la clave actual y la nueva' });
    }
    if (typeof nueva !== 'string' || nueva.length < 12) {
        return res.status(400).json({ error: 'la clave nueva debe tener al menos 12 caracteres' });
    }
    if (nueva === actual) {
        return res.status(400).json({ error: 'la clave nueva tiene que ser distinta de la actual' });
    }

    try {
        const { rows } = await consultar(
            'SELECT esquema, valor FROM credenciales WHERE usuario_id = $1',
            [req.usuario.id]
        );
        if (!rows.length) {
            return res.status(409).json({ error: 'la cuenta no tiene credencial cargada' });
        }

        const { ok } = await verificar(actual, rows[0].esquema, rows[0].valor);
        if (!ok) {
            await auditar(req, {
                usuarioId: req.usuario.id, usuarioTxt: req.usuario.usuario,
                accion: 'cambio_clave_fallido', detalle: 'clave actual incorrecta',
            });
            return res.status(401).json({ error: 'la clave actual no es correcta' });
        }

        await consultar(
            `UPDATE credenciales SET esquema = 'scrypt', valor = $2,
                    migrado_en = now(), actualizado_en = now()
             WHERE usuario_id = $1`,
            [req.usuario.id, await hashear(nueva)]
        );

        // Se cierran las demas sesiones: si la clave se cambia porque alguien
        // mas la sabia, dejarle la sesion abierta no arregla nada.
        const token = leerCookie(req, NOMBRE_COOKIE);
        await cerrarSesionesDe(req.usuario.id, token);

        await auditar(req, {
            usuarioId: req.usuario.id, usuarioTxt: req.usuario.usuario, accion: 'cambio_clave',
        });

        res.json({ estado: 'ok' });
    } catch (err) {
        console.error('[auth] cambio de clave:', err.message);
        res.status(500).json({ error: err.message });
    }
});
