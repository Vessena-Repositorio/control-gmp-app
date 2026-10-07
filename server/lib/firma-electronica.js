/**
 * Firma electronica 21 CFR Part 11 (tabla firmas_electronicas, migracion 054).
 *
 * No es la imagen de firmas.js: esa es como se dibuja la firma en el papel.
 * Esta es el acto de firmar, y es lo que tiene valor legal.
 *
 * Lo que se exige y por que:
 *  - Usuario y clave en cada firma (11.200(a)): la sesion abierta no alcanza,
 *    porque una terminal abierta la puede usar cualquiera.
 *  - El usuario escrito tiene que ser el de la sesion: nadie firma por otro.
 *  - Significado explicito (11.50): elaborado, revisado, aprobado...
 *  - Hash del contenido firmado (11.70): la firma queda atada a ese contenido.
 *  - Clave fijada con la politica actual y no vencida (11.300(b)).
 *  - Intentos fallidos: al tercero en 15 minutos se cierran todas las sesiones
 *    de la persona y se avisa a quien administra (11.300(d)).
 */
import { consultar } from '../db.js';
import { verificar } from './claves.js';
import { auditar, cerrarSesionesDe } from './sesiones.js';
import { enviar, hayCorreo } from './correo.js';
import { supervisoresDe } from './destinatarios.js';

/** Significados posibles y como se imprimen. */
export const SIGNIFICADOS = {
    autor: 'Elaborado por',
    revisor: 'Revisado por',
    aprobador: 'Aprobado por',
    aprobador_calidad: 'Aprobado por Garantía de Calidad',
    rechazo: 'Rechazado por',
    lectura: 'Leído y comprendido por',
    revision_periodica: 'Revisión periódica sin cambios por',
    obsolescencia: 'Dado de baja por',
};

const INTENTOS_MAX = 3;
const VENTANA_MIN = 15;
// Cada cuanto hay que renovar la clave para poder seguir firmando.
// Un año (Claudia, 07/10/2026). Con `||` y no `??`: una variable cargada
// vacia en Coolify daria 0 dias y nadie podria firmar.
const DIAS_CLAVE = Number(process.env.FIRMA_CLAVE_DIAS) || 365;

/** Error con status HTTP, para que la ruta lo devuelva tal cual. */
function fallo(status, mensaje) {
    const e = new Error(mensaje);
    e.status = status;
    return e;
}

async function fallidasRecientes(usuarioId) {
    const { rows } = await consultar(
        `SELECT count(*)::int AS n FROM auditoria
         WHERE accion = 'firma_fallida' AND usuario_id = $1
           AND ts > now() - ($2 || ' minutes')::interval`,
        [usuarioId, String(VENTANA_MIN)]
    );
    return rows[0].n;
}

async function avisarBloqueo(req, recurso) {
    if (!hayCorreo) return;
    try {
        const para = await supervisoresDe(recurso, 'firma-bloqueada');
        if (!para.length) return;
        const quien = req.usuario.nombre || req.usuario.usuario;
        await enviar({
            para: para.join(','),
            asunto: `Firma electrónica bloqueada: ${quien}`,
            texto: `${quien} (${req.usuario.usuario}) falló ${INTENTOS_MAX} veces la clave al firmar ` +
                `en ${recurso} en los últimos ${VENTANA_MIN} minutos. Se cerraron sus sesiones. ` +
                'Si no fue la persona, puede tratarse de un intento de uso indebido de su cuenta.',
        });
    } catch (err) {
        console.error('[firma] no se pudo avisar el bloqueo:', err.message);
    }
}

/**
 * Firma dentro de la transaccion `c`, que ya tiene que tener el autor
 * declarado (audit-trail.js fijarAutor): el INSERT dispara el audit trail.
 *
 * Los intentos fallidos se registran con `auditar`, que va por otra conexion,
 * para que queden aunque la transaccion se revierta.
 *
 * Devuelve la manifestacion de la firma: lo que se imprime junto al registro.
 */
export async function firmar(c, req, {
    usuario, clave, significado, recurso, tabla, registroId, contenidoSha256, comentario,
}) {
    if (!req.usuario) throw fallo(401, 'sesion requerida');
    if (!SIGNIFICADOS[significado]) throw fallo(400, `significado de firma desconocido: ${significado}`);
    if (!usuario || !clave) throw fallo(400, 'para firmar hay que escribir usuario y clave');

    const yo = req.usuario;
    const traza = { usuarioId: yo.id, usuarioTxt: yo.usuario, recurso };

    if (String(usuario).trim().toLowerCase() !== String(yo.usuario).toLowerCase()) {
        await auditar(req, { ...traza, accion: 'firma_fallida', detalle: `usuario escrito distinto: ${usuario}` });
        throw fallo(403, 'la firma es personal: el usuario tiene que ser el de la sesión abierta');
    }

    if ((await fallidasRecientes(yo.id)) >= INTENTOS_MAX) {
        throw fallo(423, `firma bloqueada por intentos fallidos; probá en ${VENTANA_MIN} minutos`);
    }

    const { rows } = await consultar(
        `SELECT esquema, valor, politica_desde,
                politica_desde > now() - ($2 || ' days')::interval AS vigente
         FROM credenciales WHERE usuario_id = $1`,
        [yo.id, String(DIAS_CLAVE)]
    );
    const cred = rows[0];
    const { ok } = cred ? await verificar(clave, cred.esquema, cred.valor) : { ok: false };

    if (!ok) {
        await auditar(req, { ...traza, accion: 'firma_fallida', detalle: `${tabla} ${registroId}` });
        if ((await fallidasRecientes(yo.id)) >= INTENTOS_MAX) {
            await cerrarSesionesDe(yo.id, null);
            await auditar(req, { ...traza, accion: 'firma_bloqueada' });
            await avisarBloqueo(req, recurso);
            throw fallo(423, 'clave incorrecta por tercera vez: se cerró la sesión por seguridad');
        }
        // 403 y no 401: la pantalla trata un 401 como sesion vencida y
        // mandaria al login a quien solo se equivoco de clave al firmar.
        throw fallo(403, 'usuario o clave incorrectos');
    }

    if (cred.esquema !== 'scrypt' || !cred.politica_desde) {
        throw fallo(409, 'para firmar tenés que cambiar la clave por una de al menos 12 caracteres (Cambiar clave)');
    }
    if (!cred.vigente) {
        throw fallo(409, `tu clave tiene más de ${DIAS_CLAVE} días: cambiala para poder firmar`);
    }

    const { rows: [f] } = await c.query(
        `INSERT INTO firmas_electronicas
            (usuario_id, nombre, usuario_txt, significado, recurso, tabla, registro_id,
             contenido_sha256, comentario, ip, user_agent)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         RETURNING id, firmado_en`,
        [yo.id, yo.nombre || yo.usuario, yo.usuario, significado, recurso, tabla, String(registroId),
         contenidoSha256 || null, comentario || null,
         (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').toString().split(',')[0].trim() || null,
         (req.headers['user-agent'] || '').slice(0, 300) || null]
    );

    return manifestacion({ ...f, nombre: yo.nombre || yo.usuario, significado, contenido_sha256: contenidoSha256 });
}

/** Como se muestra e imprime una firma (11.50). */
export function manifestacion(f) {
    return {
        id: f.id,
        nombre: f.nombre,
        significado: f.significado,
        leyenda: SIGNIFICADOS[f.significado] || f.significado,
        firmadoEn: f.firmado_en,
        contenidoSha256: f.contenido_sha256 || null,
    };
}

/** Firmas de un registro, en orden. */
export async function firmasDe(tabla, registroId) {
    const { rows } = await consultar(
        `SELECT id, nombre, significado, firmado_en, contenido_sha256, comentario
         FROM firmas_electronicas WHERE tabla = $1 AND registro_id = $2
         ORDER BY firmado_en`,
        [tabla, String(registroId)]
    );
    return rows.map((f) => ({ ...manifestacion(f), comentario: f.comentario }));
}
