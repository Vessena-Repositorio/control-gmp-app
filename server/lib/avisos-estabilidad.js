/**
 * Avisos programados del Programa de Estabilidad.
 *
 * Reemplaza a `enviarRecordatorios` del Apps Script: los avisos 06, 07 y 08 del
 * inventario. Los otros cinco los dispara la app al aprobar, rechazar o asignar,
 * asi que llegan con el corte de escritura, no con esto.
 *
 * Los textos y asuntos se replican tal cual. El requisito es que cada aviso siga
 * llegando igual y a las mismas personas; esto no es una oportunidad para
 * rediseñarlos.
 *
 * Una diferencia deliberada: los botones apuntan al servidor interno y no a
 * GitHub Pages, que se va a apagar y dejaria los enlaces muertos.
 */
import { hayCorreo, enviar } from './correo.js';
import { supervisoresDe, unir } from './destinatarios.js';
import { correrUnaVezPorDia, documentosDe, relojLocal, comoDia } from './tareas.js';

const RECURSO = 'estabilidad';
const TAREA = 'avisos_estabilidad';

const HORA = Number(process.env.AVISOS_ESTABILIDAD_HORA ?? 8);
const ACTIVOS = ['1', 'true', 'si'].includes(
    String(process.env.AVISOS_ESTABILIDAD_ACTIVOS || '').toLowerCase()
);

const BASE = (process.env.URL_PUBLICA || 'http://192.168.30.15:3000').replace(/\/+$/, '');
const PREFIJO = '[LCC Estabilidad] ';

const CONDICIONES = [
    { k: 'estufa',   l: 'Estufa 40°C' },
    { k: 'heladera', l: 'Heladera 4°C' },
    { k: 'luz',      l: 'Luz' },
    { k: 'patron',   l: 'Patrón' },
];

const cumpleCargado = (v) => v === 'si' || v === 'no';

/**
 * Un checkpoint muestreado al que le faltan resultados.
 *
 * Se replica la regla del Apps Script tal cual, incluida una asimetria suya: en
 * los checkpoints planos el pH NO decide si esta incompleto, pero si aparece en
 * la lista de campos faltantes cuando el checkpoint ya quedo marcado por otra
 * razon. Cambiarlo alteraria que estudios se reportan.
 */
function incompleto(cp) {
    if (!cp.fechaReal) return false; // sin fecha real no esta muestreado

    if (cp.condiciones) {
        return CONDICIONES.some(({ k }) => !cumpleCargado((cp.condiciones[k] || {}).cumple));
    }
    if (!cp.organoleptico) return true;
    return !cumpleCargado(cp.cumple);
}

function camposFaltantes(cp) {
    if (cp.condiciones) {
        const f = [];
        for (const { k, l } of CONDICIONES) {
            const c = cp.condiciones[k] || {};
            const falta = [];
            if (!c.organoleptico) falta.push('organoléptico');
            if (!cumpleCargado(c.cumple)) falta.push('cumple');
            if (falta.length) f.push(`${l}: ${falta.join(', ')}`);
        }
        return f;
    }
    const f = [];
    if (!cp.organoleptico) f.push('organoléptico');
    if (!cp.ph) f.push('pH');
    if (!cumpleCargado(cp.cumple)) f.push('cumple');
    return f;
}

function esc(s) {
    return String(s ?? '').replace(/[&<>"]/g, (c) =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function boton(id, texto, color) {
    return `<a href="${BASE}/estabilidad.html#study=${encodeURIComponent(id)}" ` +
        `style="display:inline-block;margin:12px 0;padding:10px 20px;background:${color};` +
        `color:#fff;text-decoration:none;border-radius:6px;font-weight:bold">${texto}</a>`;
}

function cuerpoCheckpoints(s, cps, titulo, color, etiquetaFecha, textoBoton, colorBoton) {
    const filas = cps.map((cp) =>
        `<li><strong>${esc(cp.codigo)}</strong> (Mes ${esc(cp.mes)}) — ` +
        `${etiquetaFecha}${esc(cp.fechaProgramada)}</li>`).join('');
    return `<div style="font-family:Arial;max-width:600px">` +
        `<h2 style="color:${color}">${titulo}</h2>` +
        `<p><strong>${esc(s.producto)}</strong> — Lote: <strong>${esc(s.lote)}</strong></p>` +
        `<ul>${filas}</ul>${boton(s.id, textoBoton, colorBoton)}` +
        `<p style="color:#5B6B6E;font-size:12px">LCC / Vessena S.A.</p></div>`;
}

function cuerpoIncompletos(lista) {
    const bloques = lista.map(({ s, cps }) => {
        const filas = cps.map((cp) =>
            `<tr>` +
            `<td style="padding:6px;border:1px solid #fde68a"><strong>${esc(cp.codigo)}</strong> (Mes ${esc(cp.mes)})</td>` +
            `<td style="padding:6px;border:1px solid #fde68a">${esc(cp.fechaReal)}</td>` +
            `<td style="padding:6px;border:1px solid #fde68a;color:#dc2626">${esc(camposFaltantes(cp).join(' · '))}</td>` +
            `</tr>`).join('');
        return `<div style="background:#fff7ed;border-left:4px solid #f59e0b;padding:12px;margin:12px 0;border-radius:6px">` +
            `<h3 style="margin:0 0 8px 0;color:#78350f">${esc(s.producto)} — Lote ${esc(s.lote)}</h3>` +
            `<table style="width:100%;font-size:13px;border-collapse:collapse">` +
            `<thead><tr style="background:#fef3c7">` +
            `<th style="text-align:left;padding:6px;border:1px solid #fde68a">Checkpoint</th>` +
            `<th style="text-align:left;padding:6px;border:1px solid #fde68a">Fecha muestreo</th>` +
            `<th style="text-align:left;padding:6px;border:1px solid #fde68a">Campos faltantes</th>` +
            `</tr></thead><tbody>${filas}</tbody></table>` +
            boton(s.id, 'Completar en la plataforma →', '#0E6B67') + `</div>`;
    }).join('');

    return `<div style="font-family:Arial;max-width:700px">` +
        `<h2 style="color:#B45309">📝 Muestreos pendientes de carga de resultados</h2>` +
        `<p>Los siguientes checkpoints tienen fecha de muestreo cargada pero les faltan ` +
        `resultados. Por favor completá los datos:</p>${bloques}` +
        `<p style="color:#5B6B6E;font-size:11px;margin-top:20px">Este recordatorio se enviará ` +
        `todos los días hasta que se completen los datos.<br>Programa de Estabilidad · LCC · ` +
        `Vessena S.A.</p></div>`;
}

/**
 * Revisa los estudios y manda los tres avisos programados.
 * `soloPrevisualizar` arma todo y no manda nada: devuelve que saldria y a quien.
 */
export async function revisarAvisosEstabilidad({ forzar = false, soloPrevisualizar = false } = {}) {
    if (!hayCorreo) return { estado: 'sin correo configurado' };

    return correrUnaVezPorDia(TAREA, { hora: HORA, forzar, activa: ACTIVOS }, async () => {
        const reloj = await relojLocal();
        const hoy = comoDia(reloj.hoy);
        const manana = comoDia(new Date(new Date(hoy + 'T12:00:00').getTime() + 86400000));

        const estudios = await documentosDe('estabilidad', 'studies');
        const supervision = await supervisoresDe(RECURSO, 'incompletos');

        const planeados = [];
        const incompletosPorEstudio = [];

        for (const s of estudios) {
            if (!s || s.rechazado || Number(s.stage) >= 5) continue;
            const cps = Array.isArray(s.checkpoints) ? s.checkpoints : [];

            if (s.emailAnalista) {
                const proximos = cps.filter((cp) => !cp.fechaReal && cp.fechaProgramada === manana);
                const atrasados = cps.filter((cp) => !cp.fechaReal && cp.fechaProgramada && cp.fechaProgramada < hoy);

                if (proximos.length) {
                    planeados.push({
                        aviso: 'muestreo-manana',
                        para: unir(s.emailAnalista, supervision),
                        asunto: `${PREFIJO}Muestreo mañana: ${s.producto} (${s.lote})`,
                        html: cuerpoCheckpoints(s, proximos, '📅 Muestreo mañana', '#0A4F4C',
                            '', 'Abrir estudio →', '#0E6B67'),
                    });
                }
                if (atrasados.length) {
                    planeados.push({
                        aviso: 'atrasado',
                        para: unir(s.emailAnalista, supervision),
                        asunto: `${PREFIJO}⚠ ATRASADO: ${s.producto} (${s.lote})`,
                        html: cuerpoCheckpoints(s, atrasados, '⚠ Atrasados', '#B03A2E',
                            'prog: ', 'Ver estudio atrasado →', '#B03A2E'),
                    });
                }
            }

            const cpsIncompletos = cps.filter(incompleto);
            if (cpsIncompletos.length) incompletosPorEstudio.push({ s, cps: cpsIncompletos });
        }

        // El consolidado va a la supervision del proceso. En el Apps Script sus
        // dos destinatarios estaban escritos aparte, por fuera de sendEmail_;
        // aca es la misma regla que los demas y no un mecanismo separado.
        if (incompletosPorEstudio.length && supervision.length) {
            planeados.push({
                aviso: 'incompletos',
                para: supervision,
                asunto: `${PREFIJO}📝 Muestreos con resultados pendientes (${incompletosPorEstudio.length} estudios)`,
                html: cuerpoIncompletos(incompletosPorEstudio),
            });
        }

        if (soloPrevisualizar) {
            return {
                modo: 'previsualizacion',
                estudiosRevisados: estudios.length,
                correos: 0,
                saldrian: planeados.map((p) => ({ aviso: p.aviso, asunto: p.asunto, para: p.para })),
            };
        }

        let enviados = 0;
        for (const p of planeados) {
            try {
                await enviar({ para: p.para, asunto: p.asunto, html: p.html, texto: sinHtml(p.html) });
                enviados++;
            } catch (err) {
                // Un rebote no puede frenar los demas avisos del dia.
                console.error(`[avisos:estabilidad] ${p.aviso} fallo:`, err.message);
            }
        }

        console.log(`[avisos:estabilidad] ${enviados}/${planeados.length} correo(s)`);
        return {
            estudiosRevisados: estudios.length,
            correos: enviados,
            planeados: planeados.length,
            detalle: `${enviados} de ${planeados.length} correo(s)`,
        };
    });
}

/** Version en texto plano, para los clientes que no muestran HTML. */
function sinHtml(html) {
    return String(html)
        .replace(/<li>/g, '\n- ')
        .replace(/<\/(p|h2|h3|div|tr)>/g, '\n')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
        .replace(/[ \t]+/g, ' ')
        .replace(/\n\s+/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

export function configEstabilidad() {
    return { activos: ACTIVOS, hora: HORA, base: BASE };
}
