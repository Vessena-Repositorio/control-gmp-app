import { Router } from 'express';
import { consultar } from '../db.js';
import { sincronizarUsuarios } from '../sync/sync-usuarios.js';
import { exigirTokenSync } from '../lib/auth.js';
import { hashear, generarClave } from '../lib/claves.js';
import { PERMISOS_POR_ROL } from '../lib/permisos.js';

export const rutasUsuarios = Router();

/**
 * GET /api/usuarios/estado
 *
 * Solo conteos: cuantas identidades hay por origen y cuantas credenciales
 * quedan en cada esquema. Nunca nombres, mails ni hashes.
 *
 * Va detras del token aunque no devuelva datos personales: saber que hay N
 * credenciales en un esquema debil le dice a quien mire por donde entrar, y la
 * API todavia no tiene autenticacion propia. Cuando la tenga, esto pasa a ser
 * un endpoint de administracion normal.
 */
rutasUsuarios.get('/estado', exigirTokenSync, async (_req, res, next) => {
    try {
        const [porOrigen, porEsquema] = await Promise.all([
            consultar(
                `SELECT origen,
                        count(*)::int                              AS usuarios,
                        count(*) FILTER (WHERE activo)::int        AS activos
                 FROM usuarios
                 GROUP BY origen
                 ORDER BY origen`
            ),
            consultar(
                `SELECT c.esquema, count(*)::int AS n
                 FROM credenciales c
                 GROUP BY c.esquema
                 ORDER BY c.esquema`
            ),
        ]);

        const esquemas = Object.fromEntries(porEsquema.rows.map((f) => [f.esquema, f.n]));
        const debiles = Object.entries(esquemas)
            .filter(([e]) => e !== 'scrypt')
            .reduce((a, [, n]) => a + n, 0);

        res.json({
            porOrigen: porOrigen.rows,
            credenciales: esquemas,
            // Lo que hay que ver bajar hasta cero a medida que la gente entra.
            pendientesDeRehash: debiles,
        });
    } catch (err) {
        next(err);
    }
});

/**
 * GET /api/usuarios/roles
 * Quien tiene que rol en que app, y que habilita cada rol. Sin credenciales.
 * Es la vista que permite auditar los permisos sin entrar a la base.
 */
rutasUsuarios.get('/roles', exigirTokenSync, async (_req, res, next) => {
    try {
        const { rows } = await consultar(
            `SELECT u.usuario, u.nombre, ur.recurso, ur.rol
             FROM usuarios u
             JOIN usuario_recursos ur ON ur.usuario_id = u.id
             WHERE u.activo
             ORDER BY u.nombre, ur.recurso`
        );

        const porUsuario = {};
        for (const f of rows) {
            porUsuario[f.nombre] ??= { usuario: f.usuario, recursos: {} };
            porUsuario[f.nombre].recursos[f.recurso] = f.rol;
        }

        res.json({ permisosPorRol: PERMISOS_POR_ROL, usuarios: porUsuario });
    } catch (err) {
        next(err);
    }
});

/**
 * POST /api/usuarios/clave  { usuario, clave }
 *
 * Fija la clave de un usuario. Es el camino de alta inicial y de reseteo
 * administrativo: la clave llega en texto, el servidor la hashea con scrypt y
 * guarda solo el hash. Nunca se escribe una clave en el repositorio ni en una
 * migracion.
 *
 * Si no se manda `clave`, se genera una y se devuelve UNA sola vez. Es la unica
 * respuesta de toda la API que contiene una credencial en texto.
 */
rutasUsuarios.post('/clave', exigirTokenSync, async (req, res) => {
    const { usuario, clave } = req.body || {};
    if (!usuario) {
        return res.status(400).json({ error: 'falta `usuario`' });
    }
    if (clave !== undefined && (typeof clave !== 'string' || clave.length < 12)) {
        return res.status(400).json({ error: 'la clave debe tener al menos 12 caracteres' });
    }

    try {
        const { rows } = await consultar(
            `SELECT id, nombre FROM usuarios WHERE origen = 'vessena' AND lower(usuario) = lower($1)`,
            [usuario]
        );
        if (!rows.length) {
            return res.status(404).json({ error: `no existe el usuario ${usuario}` });
        }

        const generada = clave ?? generarClave();
        const hash = await hashear(generada);

        await consultar(
            `INSERT INTO credenciales (usuario_id, esquema, valor, migrado_en)
             VALUES ($1, 'scrypt', $2, now())
             ON CONFLICT (usuario_id) DO UPDATE SET
                esquema = 'scrypt', valor = EXCLUDED.valor,
                migrado_en = now(), actualizado_en = now()`,
            [rows[0].id, hash]
        );

        res.json({
            estado: 'ok',
            usuario,
            nombre: rows[0].nombre,
            // Solo se devuelve si la genero el servidor: si la mando quien
            // llama, repetirla no agrega nada y la deja en un log de mas.
            clave: clave ? undefined : generada,
        });
    } catch (err) {
        // Endpoint autenticado y de administracion: se devuelve el motivo real.
        // Con el mensaje generico, un fallo de parametros de scrypt se veia
        // igual que uno de base y hubo que deducirlo desde afuera.
        console.error('[usuarios] fallo al fijar clave:', err.message);
        res.status(500).json({ error: err.message });
    }
});

/** POST /api/usuarios/sync — dispara la replica del padron a mano. */
rutasUsuarios.post('/sync', exigirTokenSync, async (_req, res) => {
    try {
        const r = await sincronizarUsuarios();
        res.json({ estado: 'ok', ...r });
    } catch (err) {
        console.error('[sync] fallo por HTTP:', err.message);
        res.status(500).json({ estado: 'error', error: err.message });
    }
});
