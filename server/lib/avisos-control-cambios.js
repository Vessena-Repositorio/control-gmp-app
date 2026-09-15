/**
 * Avisos de tareas de Control de Cambios por vencer o vencidas.
 *
 * Las "acciones" de un cambio son su tabla de Responsables de implementacion:
 * nombre, mail, tarea, plazo y cumplida. La app ya marcaba en pantalla las
 * vencidas, pero nadie recibia un recordatorio: solo salia un mail al asignar.
 *
 * Mismo criterio que los avisos de CAPA:
 *
 *  - Un resumen por persona y por dia, no un correo por tarea. Si cada tarea
 *    manda el suyo, en una semana nadie los abre.
 *  - La copia a supervision (notificacion_supervisores, 'tareas-vencidas') trae
 *    el panorama completo, incluidas las tareas sin mail: esas no le llegan a
 *    nadie mas, y conviene que se vean en vez de desaparecer.
 *  - Arranca apagado (AVISOS_CONTROL_CAMBIOS_ACTIVOS). Antes del corte la tabla
 *    es una copia que se queda vieja: prenderlo ahi avisaria sobre datos viejos.
 */
import { consultar } from '../db.js';
import { hayCorreo, enviar } from './correo.js';
import { supervisoresDe } from './destinatarios.js';
import { correrUnaVezPorDia, comoDia } from './tareas.js';

const RECURSO = 'control-cambios';
const NOTIFICACION = 'tareas-vencidas';
const TAREA = 'avisos_control_cambios';

const HORA = Number(process.env.AVISOS_CONTROL_CAMBIOS_HORA ?? 8);
const DIAS_PREVIOS = Number(process.env.AVISOS_CONTROL_CAMBIOS_DIAS_PREVIOS ?? 7);
const ACTIVOS = ['1', 'true', 'si'].includes(
    String(process.env.AVISOS_CONTROL_CAMBIOS_ACTIVOS || '').toLowerCase()
);

export const BASE = (process.env.URL_PUBLICA || 'http://192.168.30.15:3000').replace(/\/+$/, '');
export const PREFIJO = '[Control de Cambios] ';

/**
 * Una fecha 'AAAA-MM-DD' valida, o null.
 *
 * Se valida aca y no con ::date en SQL: los plazos vienen de una planilla, y un
 * solo valor invalido haria fallar la consulta entera y dejaria sin avisos a
 * todos. Se rechaza tambien lo que tiene forma de fecha pero no existe
 * (2026-02-30), que Date.UTC acomodaria en silencio al mes siguiente.
 */
export function fechaValida(v) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(v ?? '').trim());
    if (!m) return null;
    const y = Number(m[1]);
    const mo = Number(m[2]);
    const d = Number(m[3]);
    const t = Date.UTC(y, mo - 1, d);
    const f = new Date(t);
    if (f.getUTCFullYear() !== y || f.getUTCMonth() !== mo - 1 || f.getUTCDate() !== d) return null;
    return { y, mo, d, t };
}

/** 'DD/MM/AAAA' de una fecha valida, o '' si no lo es. */
export function dma(v) {
    const f = fechaValida(v);
    if (!f) return '';
    return `${String(f.d).padStart(2, '0')}/${String(f.mo).padStart(2, '0')}/${f.y}`;
}

/** Dias de `hoy` a `plazo` (negativo si ya paso), o null si alguna no es valida. */
export function diasHasta(hoy, plazo) {
    const a = fechaValida(hoy);
    const b = fechaValida(plazo);
    if (!a || !b) return null;
    return Math.round((b.t - a.t) / 86400000);
}

export function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/**
 * Las tareas que corresponde avisar, a partir de los cambios abiertos.
 * Separada de la consulta para poder probarla sin base.
 */
export function armarPendientes(cambios, hoy, diasPrevios = DIAS_PREVIOS) {
    const out = [];
    for (const c of cambios || []) {
        const resps = Array.isArray(c.responsables) ? c.responsables : [];
        for (const r of resps) {
            if (!r || typeof r !== 'object') continue;
            const tarea = String(r.tarea || '').trim();
            if (!tarea) continue;
            if (String(r.cumplida || '') === 'Si') continue;
            const dias = diasHasta(hoy, r.plazo);
            if (dias === null || dias > diasPrevios) continue;
            out.push({
                numero: c.numero || '',
                titulo: c.titulo || '',
                estado: c.estado || '',
                nombre: String(r.nombre || '').trim(),
                mail: String(r.mail || '').trim().toLowerCase(),
                tarea,
                vence: dma(r.plazo),
                dias,
            });
        }
    }
    return out.sort((a, b) => a.dias - b.dias || a.numero.localeCompare(b.numero));
}

async function tareasPendientes(hoy) {
    const { rows } = await consultar(
        `SELECT numero, estado, datos->>'titulo' AS titulo, datos->'responsables' AS responsables
         FROM cc_cambios
         WHERE estado NOT IN ('Cerrado', 'Rechazado')`
    );
    return armarPendientes(rows, hoy, DIAS_PREVIOS);
}

function describir(dias) {
    if (dias < 0) return `VENCIDA hace ${Math.abs(dias)} día(s)`;
    if (dias === 0) return 'vence HOY';
    return `vence en ${dias} día(s)`;
}

export function comoHtml(tareas, titulo, conResponsable) {
    const celda = 'padding:6px 10px;border-bottom:1px solid #eee';
    const filas = tareas.map((t) => `<tr>
            <td style="${celda};white-space:nowrap"><b>${esc(t.numero)}</b></td>
            <td style="${celda}">${esc(t.titulo)}</td>
            <td style="${celda}">${esc(t.tarea)}</td>
            ${conResponsable ? `<td style="${celda}">${esc(t.nombre || 'sin asignar')}</td>` : ''}
            <td style="${celda};white-space:nowrap">${esc(t.vence)}</td>
            <td style="${celda};color:${t.dias < 0 ? '#b42318' : '#475467'};white-space:nowrap">${esc(describir(t.dias))}</td>
        </tr>`);
    const th = (x) => `<th style="padding:6px 10px">${x}</th>`;
    return `<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;color:#101828">
        <h2 style="margin:0 0 12px">${esc(titulo)}</h2>
        <table style="border-collapse:collapse;font-size:14px">
          <thead><tr style="text-align:left;background:#f9fafb">
            ${th('Cambio')}${th('Título')}${th('Tarea')}${conResponsable ? th('Responsable') : ''}${th('Vence')}${th('Plazo')}
          </tr></thead>
          <tbody>${filas.join('')}</tbody>
        </table>
        <p style="margin-top:16px;font-size:13px">
          <a href="${BASE}/control_cambios.html">Abrir Control de Cambios</a>
        </p>
      </div>`;
}

export function comoTexto(tareas, titulo, conResponsable) {
    const lineas = tareas.map((t) =>
        `- ${t.numero} (${describir(t.dias)}, vence el ${t.vence})\n` +
        `  ${t.titulo}\n` +
        `  Tarea: ${t.tarea}` +
        (conResponsable ? ` | Responsable: ${t.nombre || 'sin asignar'}` : '')
    );
    return `${titulo}\n\n${lineas.join('\n\n')}\n\n` +
        `Ver el detalle en ${BASE}/control_cambios.html\n`;
}

/**
 * Corre la revision si corresponde. `soloPrevisualizar` arma todos los mensajes
 * y devuelve a quien irian, sin mandar nada.
 */
export async function revisarAvisosControlCambios({ forzar = false, soloPrevisualizar = false } = {}) {
    if (!hayCorreo) return { estado: 'sin correo configurado' };

    return correrUnaVezPorDia(TAREA, { hora: HORA, activa: ACTIVOS, forzar }, async (reloj) => {
        const hoy = comoDia(reloj.hoy);
        const tareas = await tareasPendientes(hoy);
        if (!tareas.length) return { tareas: 0, correos: 0, detalle: 'sin tareas por vencer' };

        const porPersona = new Map();
        const sinMail = [];
        for (const t of tareas) {
            if (!t.mail.includes('@')) { sinMail.push(t); continue; }
            if (!porPersona.has(t.mail)) porPersona.set(t.mail, []);
            porPersona.get(t.mail).push(t);
        }

        const mensajes = [];
        for (const [mail, suyas] of porPersona) {
            const titulo = `Tenés ${suyas.length} tarea(s) de Control de Cambios por vencer`;
            mensajes.push({
                para: mail,
                asunto: PREFIJO + titulo,
                html: comoHtml(suyas, titulo, false),
                texto: comoTexto(suyas, titulo, false),
                tareas: suyas.length,
            });
        }

        const supervision = await supervisoresDe(RECURSO, NOTIFICACION);
        if (supervision.length) {
            const titulo = `Resumen: ${tareas.length} tarea(s) de Control de Cambios por vencer`;
            const nota = sinMail.length
                ? `ATENCIÓN: ${sinMail.length} tarea(s) sin mail de responsable, nadie más recibió aviso por ellas: ` +
                  sinMail.map((t) => `${t.numero} (${t.tarea})`).join('; ')
                : '';
            mensajes.push({
                para: supervision,
                asunto: PREFIJO + titulo,
                html: comoHtml(tareas, titulo, true) +
                    (nota ? `<p style="color:#b42318;font-family:system-ui,sans-serif"><b>${esc(nota)}</b></p>` : ''),
                texto: comoTexto(tareas, titulo, true) + (nota ? `\n${nota}\n` : ''),
                tareas: tareas.length,
            });
        }

        const sinDestinatario = sinMail.map((t) => `${t.numero}: ${t.tarea}`);

        if (soloPrevisualizar) {
            return {
                modo: 'previsualizacion (no se mando nada)',
                tareas: tareas.length,
                correos: 0,
                mensajes: mensajes.map((m) => ({ para: m.para, asunto: m.asunto, tareas: m.tareas })),
                sinDestinatario,
                detalle: 'previsualizacion',
            };
        }

        let correos = 0;
        for (const m of mensajes) {
            try {
                await enviar({ para: m.para, asunto: m.asunto, html: m.html, texto: m.texto });
                correos++;
            } catch (err) {
                // Que rebote una direccion no puede impedir el resto.
                console.error(`[avisos:control-cambios] no se pudo avisar a ${m.para}:`, err.message);
            }
        }

        return {
            tareas: tareas.length,
            correos,
            sinDestinatario,
            detalle: `${tareas.length} tarea(s); ${correos} correo(s)`,
        };
    });
}

/** Configuracion vigente, para GET /api/correo/avisos. */
export function configControlCambios() {
    return { activos: ACTIVOS, hora: HORA, diasPrevios: DIAS_PREVIOS, base: BASE };
}
