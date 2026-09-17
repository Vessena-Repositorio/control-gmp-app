/**
 * Avisos de vencimiento de acciones CAPA.
 *
 * Primera notificacion que corre entera del lado nuestro: los datos ya estan en
 * Postgres y no hace falta ningun Apps Script.
 *
 * Dos decisiones que valen mas que el codigo:
 *
 *  - Un resumen por persona y por semana (los lunes, AVISOS_CAPA_DIA), no un
 *    correo por accion. Si cada accion manda el suyo, nadie los abre y el aviso
 *    deja de servir. Hasta el 17/09/2026 salia todos los dias y era demasiado.
 *  - La corrida se ancla al dia en la tabla `tarea_diaria`. Atarla al arranque
 *    haria que cada deploy dispare otra tanda de correos.
 */
import { consultar } from '../db.js';
import { hayCorreo, enviar } from './correo.js';
import { correrUnaVezPorDia, diaDeEntorno } from './tareas.js';

const TAREA = 'avisos_capa';

// Las variables llevan CAPA en el nombre a proposito. Cuando se sume la
// segunda notificacion -estabilidad, capacitaciones- un `AVISOS_ACTIVOS` a
// secas seria ambiguo: nadie sabria que apaga, y eso termina en que nadie lo
// toca. La zona horaria y el SMTP si son transversales y quedan sin prefijo.
const ZONA = process.env.ZONA_HORARIA || 'America/Montevideo';
const HORA = Number(process.env.AVISOS_CAPA_HORA ?? 8);
const DIAS_PREVIOS = Number(process.env.AVISOS_CAPA_DIAS_PREVIOS ?? 7);
// Semanal, los lunes. "diario" vuelve al envio de todos los dias.
const DIA = diaDeEntorno('AVISOS_CAPA_DIA', 1);
const CADA = DIA ? 'semanal' : 'diario';

// Quienes reciben el resumen consolidado. Acepta varias direcciones separadas
// por coma: que dependa de una sola persona es fragil, porque el resumen deja
// de leerlo alguien justo cuando esa persona esta de licencia, que es cuando
// mas falta hace.
//
// Si no se declara ninguna se usa la casilla que firma los mensajes, que es de
// QA: mejor que llegue a una casilla de la organizacion antes que a nadie.
const CALIDAD = String(process.env.CORREO_CALIDAD || process.env.SMTP_REMITENTE || '')
    .split(/[,;]/)
    .map((d) => d.trim())
    .filter(Boolean);

// El envio automatico arranca apagado y hay que encenderlo a mano. Sin esto, el
// primer deploy mandaria correos a gente real apenas levanta el contenedor, sin
// que nadie haya podido ver antes que dice el mensaje ni a quienes les llega.
// La corrida manual (POST /api/correo/avisos) no mira esta variable: sirve
// justamente para probar el circuito antes de encenderlo.
const ACTIVOS = ['1', 'true', 'si'].includes(String(process.env.AVISOS_CAPA_ACTIVOS || '').toLowerCase());

// Red de contencion para el renombre: si quedo cargado el nombre viejo y no el
// nuevo, los avisos no saldrian y no habria ningun error que lo delate. Un
// aviso que no sale no se nota, asi que conviene gritarlo en el arranque.
for (const [viejo, nuevo] of [
    ['AVISOS_ACTIVOS', 'AVISOS_CAPA_ACTIVOS'],
    ['AVISOS_HORA', 'AVISOS_CAPA_HORA'],
    ['AVISOS_DIAS_PREVIOS', 'AVISOS_CAPA_DIAS_PREVIOS'],
]) {
    if (process.env[viejo] && !process.env[nuevo]) {
        console.warn(`[avisos] ${viejo} ya no se usa: renombrala a ${nuevo} o el valor se ignora`);
    }
}

/** Acciones sin cerrar que vencen dentro de la ventana, o que ya vencieron. */
async function accionesPendientes() {
    const { rows } = await consultar(
        `SELECT c.code, c.descripcion, c.responsable, c.responsable_email,
                c.due_date, c.estado,
                -- La fecha que se muestra sale formateada de la base y no de
                -- JavaScript: el driver entrega un DATE como Date a medianoche
                -- de la zona del contenedor, y pasarlo por toISOString puede
                -- correrlo un dia. En un aviso de vencimiento eso no es cosmetico.
                to_char(c.due_date, 'DD/MM/YYYY') AS vence,
                (c.due_date - (now() AT TIME ZONE $1)::date) AS dias,
                COALESCE(nc.code, d.code) AS origen
         FROM ncd_capa c
         LEFT JOIN ncd_nc      nc ON nc.id = c.nc_id
         LEFT JOIN ncd_desvios d  ON d.id  = c.dev_id
         WHERE c.estado <> 'Cerrado'
           AND c.due_date IS NOT NULL
           AND c.due_date <= (now() AT TIME ZONE $1)::date + $2::int
         ORDER BY c.due_date, c.code`,
        [ZONA, DIAS_PREVIOS]
    );
    return rows;
}

function describir(a) {
    const d = Number(a.dias);
    if (d < 0) return `VENCIDA hace ${Math.abs(d)} dia(s)`;
    if (d === 0) return 'vence HOY';
    return `vence en ${d} dia(s)`;
}

function comoTexto(acciones, titulo) {
    const lineas = acciones.map((a) =>
        `- ${a.code} (${describir(a)}, vence el ${a.vence || 'sin fecha'})\n` +
        `  ${a.descripcion || ''}\n` +
        `  Responsable: ${a.responsable || 'sin asignar'}` +
        (a.origen ? ` | Origen: ${a.origen}` : '') +
        ` | Estado: ${a.estado}`
    );
    return `${titulo}\n\n${lineas.join('\n\n')}\n\n` +
        `Ver el detalle en http://192.168.30.15:3000/no-conformidades-desvios.html\n`;
}

function esc(s) {
    return String(s ?? '').replace(/[&<>"]/g, (c) =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function comoHtml(acciones, titulo) {
    const celda = 'padding:6px 10px;border-bottom:1px solid #eee';
    const filas = acciones.map((a) => {
        const color = Number(a.dias) < 0 ? '#b42318' : '#475467';
        return `<tr>
            <td style="${celda}"><b>${esc(a.code)}</b></td>
            <td style="${celda};white-space:nowrap">${esc(a.vence || 'sin fecha')}</td>
            <td style="${celda};color:${color}">${esc(describir(a))}</td>
            <td style="${celda}">${esc(a.descripcion)}</td>
            <td style="${celda}">${esc(a.responsable || 'sin asignar')}</td>
            <td style="${celda}">${esc(a.estado)}</td>
        </tr>`;
    });
    return `<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;color:#101828">
        <h2 style="margin:0 0 12px">${esc(titulo)}</h2>
        <table style="border-collapse:collapse;font-size:14px">
          <thead><tr style="text-align:left;background:#f9fafb">
            <th style="padding:6px 10px">Codigo</th><th style="padding:6px 10px">Vence</th>
            <th style="padding:6px 10px">Plazo</th>
            <th style="padding:6px 10px">Accion</th><th style="padding:6px 10px">Responsable</th>
            <th style="padding:6px 10px">Estado</th>
          </tr></thead>
          <tbody>${filas.join('')}</tbody>
        </table>
        <p style="margin-top:16px;font-size:13px">
          <a href="http://192.168.30.15:3000/no-conformidades-desvios.html">Abrir el sistema</a>
        </p>
      </div>`;
}

/**
 * Corre la revision si corresponde. `forzar` saltea el dia, el horario y el "ya
 * corrio": es lo que usa el endpoint de prueba para no esperar al lunes.
 */
export async function revisarAvisosCapa({ forzar = false, soloCalidad = false } = {}) {
    if (!hayCorreo) return { estado: 'sin correo configurado' };

    return correrUnaVezPorDia(TAREA, { hora: HORA, diaSemana: DIA, forzar, activa: ACTIVOS }, async () => {
        const acciones = await accionesPendientes();

        // Sin nada que avisar igual cuenta como corrida: no tiene sentido
        // reintentar cada diez minutos.
        if (!acciones.length) {
            // Un cero puede ser "no hay nada por vencer" o "la tabla esta
            // vacia", y no son lo mismo: del silencio del segundo caso no hay
            // que fiarse. El proximo plazo dice cuando volveria a haber algo.
            const { rows } = await consultar(
                `SELECT count(*)::int                                              AS total,
                        count(*) FILTER (WHERE estado <> 'Cerrado')::int            AS abiertas,
                        count(*) FILTER (WHERE estado <> 'Cerrado'
                                           AND due_date IS NOT NULL)::int           AS con_plazo,
                        min(due_date) FILTER (WHERE estado <> 'Cerrado')            AS proximo_plazo
                 FROM ncd_capa`
            );
            return { acciones: 0, correos: 0, conteo: rows[0], detalle: '0 accion(es); sin acciones por vencer' };
        }

        const porPersona = new Map();
        const sinDestinatario = [];
        for (const a of acciones) {
            const mail = (a.responsable_email || '').trim().toLowerCase();
            if (!mail) { sinDestinatario.push(a); continue; }
            if (!porPersona.has(mail)) porPersona.set(mail, []);
            porPersona.get(mail).push(a);
        }

        let correos = 0;
        // `soloCalidad` es el modo previsualizacion: arma todo igual pero no le
        // escribe a nadie mas que a Calidad. Es la unica forma de ver como queda
        // el mensaje sin mandarselo a los responsables de verdad.
        for (const [mail, suyas] of (soloCalidad ? [] : porPersona)) {
            const titulo = `Resumen ${CADA}: tenés ${suyas.length} acción(es) CAPA vencidas o por vencer`;
            try {
                await enviar({
                    para: mail,
                    asunto: `[Calidad] ${titulo}`,
                    texto: comoTexto(suyas, titulo),
                    html: comoHtml(suyas, titulo),
                });
                correos++;
            } catch (err) {
                // Que rebote una direccion no puede impedir el resto de los
                // avisos ni el resumen de Calidad.
                console.error(`[avisos] no se pudo avisar a ${mail}:`, err.message);
            }
        }

        // Copia a Calidad con el panorama completo, incluidas las que quedaron
        // sin destinatario: son datos cargados antes de que el email fuera
        // obligatorio, y conviene que se vean en vez de desaparecer.
        if (CALIDAD.length) {
            const titulo = (soloCalidad ? '[PRUEBA] ' : '') +
                `Resumen ${CADA} CAPA: ${acciones.length} acción(es) vencidas o por vencer`;
            const nota = sinDestinatario.length
                ? `\nATENCION: ${sinDestinatario.length} accion(es) sin email de responsable. ` +
                  `Nadie recibio aviso por ellas: ${sinDestinatario.map((a) => a.code).join(', ')}\n`
                : '';
            try {
                await enviar({
                    para: CALIDAD,
                    asunto: `[Calidad] ${titulo}`,
                    texto: comoTexto(acciones, titulo) + nota,
                    html: comoHtml(acciones, titulo) +
                        (nota ? `<p style="color:#b42318"><b>${esc(nota)}</b></p>` : ''),
                });
                correos++;
            } catch (err) {
                console.error('[avisos] no se pudo mandar el resumen a Calidad:', err.message);
            }
        }

        console.log(`[avisos] ${acciones.length} accion(es), ${correos} correo(s)` +
            (soloCalidad ? ' (previsualizacion)' : ''));
        return {
            modo: soloCalidad ? 'previsualizacion (solo a Calidad)' : 'envio real',
            acciones: acciones.length,
            correos,
            personasQueRecibirian: soloCalidad ? [...porPersona.keys()] : undefined,
            sinDestinatario: sinDestinatario.map((a) => a.code),
            detalle: `${acciones.length} accion(es); ${correos} correo(s)`,
        };
    });
}

/** Configuracion vigente, para el endpoint de diagnostico. */
export function configAvisos() {
    return {
        activos: ACTIVOS, zona: ZONA, hora: HORA, diasPrevios: DIAS_PREVIOS, copiaCalidad: CALIDAD,
        frecuencia: DIA ? 'semanal, dia ' + DIA + ' (lunes=1)' : 'diaria',
    };
}
