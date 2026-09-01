// Replica los padrones de usuarios hacia Postgres, para no tener que recrear
// la gente cuando el login deje de correr contra Apps Script.
//
// Solo trae los padrones que son legibles. El del portal y el de la app de
// captura de fabuloso no exponen su lista sin credenciales: ver README de la
// migracion.
//
// Uso:  npm run sync:usuarios
import { consultar, enTransaccion, pool } from '../db.js';
import { esEjecucionDirecta } from '../lib/entrypoint.js';
import { descargar, aFecha, aTexto, aBooleano } from '../lib/origen.js';

const PADRONES = [
    {
        origen: 'estabilidad',
        env: 'ORIGEN_ESTABILIDAD',
        coleccion: 'usuarios',
        anidada: true, // este origen manda la coleccion como texto JSON
        // El PIN se guarda con djb2, que no es un hash de contraseñas.
        esquema: 'djb2',
        campos: {
            usuario: (u) => aTexto(u.email),
            email: (u) => aTexto(u.email),
            nombre: (u) => aTexto(u.nombre),
            rol: (u) => aTexto(u.rol),
            activo: (u) => aBooleano(u.activo) ?? true,
            creado: (u) => aFecha(u.creado),
            credencial: (u) => aTexto(u.pinHash),
        },
    },
];

async function replicarPadron(cfg) {
    const url = process.env[cfg.env];
    if (!url) throw new Error(`Falta ${cfg.env} en las variables de entorno.`);

    const datos = await descargar(url);
    let valor = datos?.[cfg.coleccion];

    if (cfg.anidada && typeof valor === 'string') {
        try {
            valor = JSON.parse(valor);
        } catch {
            throw new Error(`la coleccion '${cfg.coleccion}' no es JSON valido`);
        }
    }

    const lista = Array.isArray(valor) ? valor : [];
    if (!lista.length) {
        throw new Error(`el origen no devolvio usuarios para ${cfg.origen}; no se toca la base`);
    }

    let conCredencial = 0;

    await enTransaccion(async (cliente) => {
        for (const u of lista) {
            const usuario = cfg.campos.usuario(u);
            if (!usuario) continue;

            const { rows } = await cliente.query(
                `INSERT INTO usuarios (origen, usuario, email, nombre, rol, activo, creado_en,
                                       sincronizado_en)
                 VALUES ($1,$2,$3,$4,$5,$6,$7, now())
                 ON CONFLICT (origen, usuario) DO UPDATE SET
                    email = EXCLUDED.email, nombre = EXCLUDED.nombre, rol = EXCLUDED.rol,
                    activo = EXCLUDED.activo, creado_en = EXCLUDED.creado_en,
                    sincronizado_en = now()
                 RETURNING id`,
                [
                    cfg.origen,
                    usuario,
                    cfg.campos.email(u),
                    cfg.campos.nombre(u),
                    cfg.campos.rol(u),
                    cfg.campos.activo(u),
                    cfg.campos.creado(u),
                ]
            );

            const credencial = cfg.campos.credencial(u);
            if (!credencial) continue;

            // El WHERE es lo que impide que el sync pise una credencial ya
            // reescrita a scrypt. Sin el, cada corrida devolveria al usuario a
            // su hash debil de origen y la mejora nunca quedaria firme.
            await cliente.query(
                `INSERT INTO credenciales (usuario_id, esquema, valor)
                 VALUES ($1,$2,$3)
                 ON CONFLICT (usuario_id) DO UPDATE SET
                    esquema = EXCLUDED.esquema, valor = EXCLUDED.valor,
                    actualizado_en = now()
                 WHERE credenciales.esquema <> 'scrypt'`,
                [rows[0].id, cfg.esquema, credencial]
            );
            conCredencial++;
        }
    });

    return { origen: cfg.origen, usuarios: lista.length, conCredencial };
}

export async function sincronizarUsuarios() {
    const { rows: logRows } = await consultar(
        `INSERT INTO sync_log (dominio) VALUES ('usuarios') RETURNING id`
    );
    const logId = logRows[0].id;
    const t0 = Date.now();

    try {
        const resultados = [];
        for (const cfg of PADRONES) {
            resultados.push(await replicarPadron(cfg));
        }

        const total = resultados.reduce((a, r) => a + r.usuarios, 0);

        await consultar(
            `UPDATE sync_log SET fin_en = now(), estado = 'ok', controles = $2 WHERE id = $1`,
            [logId, total]
        );

        const seg = ((Date.now() - t0) / 1000).toFixed(1);
        console.log(
            `[sync:usuarios] ok en ${seg}s - ` +
            resultados.map((r) => `${r.origen}=${r.usuarios}`).join(' ')
        );

        // Se avisa en cada corrida: mientras queden credenciales en un esquema
        // debil, hay cuentas cuya clave se puede revertir.
        const { rows: debiles } = await consultar(
            `SELECT esquema, count(*)::int AS n FROM credenciales
             WHERE esquema <> 'scrypt' GROUP BY esquema`
        );
        if (debiles.length) {
            console.warn(
                '[sync:usuarios] credenciales en esquema debil: ' +
                debiles.map((d) => `${d.esquema}=${d.n}`).join(' ') +
                ' — se reescriben a scrypt en el primer login exitoso'
            );
        }

        return { padrones: resultados, total };
    } catch (err) {
        await consultar(
            `UPDATE sync_log SET fin_en = now(), estado = 'error', error = $2 WHERE id = $1`,
            [logId, err.message]
        );
        console.error('[sync:usuarios] fallo:', err.message);
        throw err;
    }
}

if (esEjecucionDirecta(import.meta.url)) {
    sincronizarUsuarios()
        .then(() => pool?.end())
        .catch(() => process.exit(1));
}
