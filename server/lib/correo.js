/**
 * Envio de correo por SMTP.
 *
 * Reemplaza al `MailApp` de Apps Script. Mientras las notificaciones salgan de
 * Google, ninguna app de captura puede cortarse a Postgres sin que sus avisos
 * dejen de mandarse en silencio -que en GMP es peor que un error visible,
 * porque nadie se entera de que falto un aviso-.
 *
 * La configuracion entra por variables de entorno. La clave no vive en el repo
 * ni en un archivo del proyecto: el repositorio es publico.
 */
import nodemailer from 'nodemailer';

const HOST = process.env.SMTP_HOST;
const PUERTO = Number(process.env.SMTP_PUERTO ?? 587);
const CLAVE = process.env.SMTP_CLAVE;
const REMITENTE = process.env.SMTP_REMITENTE;

// Muchos proveedores autentican con la misma casilla que firma el mensaje, asi
// que si no se declara usuario se asume el remitente. Tenerlo separado permite
// el caso contrario, que existe: una cuenta de servicio que manda "en nombre de".
const USUARIO = process.env.SMTP_USUARIO || REMITENTE;

const NOMBRE = process.env.SMTP_NOMBRE || 'Calidad Vessena';

/**
 * Igual que `hayBase` en db.js: el resto del sistema pregunta antes de usarlo y
 * sigue funcionando sin correo, en vez de caerse al arrancar.
 */
export const hayCorreo = Boolean(HOST && USUARIO && CLAVE && REMITENTE);

/** Que falta, para poder decirlo sin exponer ningun valor. */
export function faltantes() {
    return [
        ['SMTP_HOST', HOST],
        ['SMTP_CLAVE', CLAVE],
        ['SMTP_REMITENTE', REMITENTE],
    ].filter(([, v]) => !v).map(([k]) => k);
}

let transporte = null;

function obtenerTransporte() {
    if (!hayCorreo) {
        throw new Error(`falta configurar el correo: ${faltantes().join(', ')}`);
    }
    transporte ??= nodemailer.createTransport({
        host: HOST,
        port: PUERTO,
        // `secure` es TLS desde el saludo, que es el puerto 465. En 587 la
        // conexion empieza en claro y se sube a TLS con STARTTLS.
        secure: PUERTO === 465,
        // Sin esto, si el servidor no ofreciera STARTTLS nodemailer seguiria en
        // claro y mandaria usuario y clave a la vista. Con requireTLS falla en
        // vez de degradar: preferimos no mandar el mensaje antes que filtrar la
        // credencial.
        requireTLS: PUERTO !== 465,
        auth: { user: USUARIO, pass: CLAVE },
    });
    return transporte;
}

/**
 * Comprueba que el servidor responda y que la credencial sirva, sin mandar
 * ningun mensaje. Es lo que conviene correr despues de un deploy.
 */
export async function verificar() {
    await obtenerTransporte().verify();
    return { host: HOST, puerto: PUERTO, usuario: USUARIO, remitente: REMITENTE };
}

/**
 * Manda un correo. `para` acepta una direccion o una lista.
 * Devuelve el messageId, que es lo unico util para rastrear un envio despues.
 */
export async function enviar({ para, asunto, texto, html, responderA }) {
    if (!para || (Array.isArray(para) && !para.length)) {
        throw new Error('falta el destinatario');
    }
    if (!asunto) throw new Error('falta el asunto');

    const destino = Array.isArray(para) ? para.join(', ') : para;

    const info = await obtenerTransporte().sendMail({
        from: `"${NOMBRE}" <${REMITENTE}>`,
        to: destino,
        subject: asunto,
        text: texto,
        html,
        replyTo: responderA,
    });

    console.log(`[correo] enviado a ${destino}: ${asunto} (${info.messageId})`);
    return { messageId: info.messageId, aceptados: info.accepted, rechazados: info.rejected };
}
