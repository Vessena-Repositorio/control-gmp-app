import { Router } from 'express';
import { consultar } from '../db.js';
import { sincronizarUsuarios } from '../sync/sync-usuarios.js';
import { exigirTokenSync } from '../lib/auth.js';

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
