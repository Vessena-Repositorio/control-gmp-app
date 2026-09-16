/**
 * Reporte diario de Control Fabuloso.
 *
 * Transcripcion de sendDailyReport() del Apps Script: todos los dias a las 10
 * (hora de Montevideo), el resumen de los controles del dia anterior agrupados
 * por orden, con cuales siguen sin aprobar. Si el dia anterior no hubo
 * controles, igual sale un correo corto que lo dice: asi lo hacia el script y
 * es la forma de saber que el aviso sigue vivo.
 *
 * Destinatarios en notificacion_supervisores (032): Antonella, Gloria y Claudia,
 * los mismos del script. Arranca apagado con AVISOS_FABULOSO_ACTIVOS: el dia
 * que se prende hay que borrar el activador del Apps Script, o llegan dos.
 */
import { consultar } from '../db.js';
import { hayCorreo, enviar } from './correo.js';
import { supervisoresDe } from './destinatarios.js';
import { correrUnaVezPorDia, comoDia, ZONA } from './tareas.js';

const RECURSO = 'fabuloso-captura';

const HORA = Number(process.env.AVISOS_FABULOSO_HORA ?? 10);
const ACTIVOS = ['1', 'true', 'si'].includes(
    String(process.env.AVISOS_FABULOSO_ACTIVOS || '').toLowerCase()
);
const BASE = (process.env.URL_PUBLICA || 'http://192.168.30.15:3000').replace(/\/+$/, '');

function esc(s) {
    return String(s ?? '').replace(/[&<>"]/g, (c) =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

const hora = (instante) => new Intl.DateTimeFormat('es-UY', {
    timeZone: ZONA, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
}).format(new Date(instante));

const fechaHora = (instante) => new Intl.DateTimeFormat('es-UY', {
    timeZone: ZONA, day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
}).format(new Date(instante));

const dma = (dia) => `${dia.slice(8, 10)}/${dia.slice(5, 7)}/${dia.slice(0, 4)}`;

/** Las fotos nuevas estan en el servidor (con sesion); las viejas, en Drive. */
const enlaceFoto = (url) => (String(url).startsWith('/') ? BASE + url : url);

function tablaOrden(filas) {
    const td = (x) => `<td style="border:1px solid #d0d5dd;padding:4px 8px">${x}</td>`;
    const th = (x) => `<th style="border:1px solid #d0d5dd;padding:4px 8px;background:#eef2ff;text-align:left">${x}</th>`;
    return `<table style="width:100%;border-collapse:collapse;font-size:12px"><thead><tr>` +
        th('Hora') + th('Analista') + th('QR') + th('Estado') + th('Rótulo caja') + th('Lote envase') +
        `</tr></thead><tbody>` +
        filas.map((m) => `<tr>` +
            td(`<b>${hora(m.registrado_en)}</b>`) +
            td(esc(m.analista_nombre || m.analista_usuario || '-')) +
            td(`<b>${esc(Number(m.qr))}</b> <span style="color:#667085">(${esc(m.calidad_rango)})</span>`) +
            td(esc(m.estado)) +
            td(m.foto_rotulo ? `<a href="${esc(enlaceFoto(m.foto_rotulo))}" target="_blank">📦 Ver</a>` : '<span style="color:#d92d20">❌</span>') +
            td(m.foto_lote ? `<a href="${esc(enlaceFoto(m.foto_lote))}" target="_blank">🏷️ Ver</a>` : '<span style="color:#d92d20">❌</span>') +
            `</tr>`).join('') +
        `</tbody></table>`;
}

function cuerpoReporte(dia, grupos, totalControles, pendientes) {
    let html = `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;max-width:820px;margin:0 auto;color:#101828">` +
        `<div style="background:#0b5cff;color:#fff;padding:18px 20px;border-radius:10px 10px 0 0">` +
        `<div style="font-size:12px;opacity:.85;letter-spacing:1px;text-transform:uppercase">Vessena LCC Fabuloso</div>` +
        `<div style="font-size:20px;font-weight:700;margin-top:2px">Reporte del ${dma(dia)}</div>` +
        `<div style="font-size:13px;opacity:.9;margin-top:4px">Órdenes controladas ayer en la línea Fabuloso — para revisar, firmar e imprimir.</div></div>` +
        `<div style="padding:14px 4px;font-size:13px">Controles: <b>${totalControles}</b> · Órdenes: <b>${grupos.length}</b> · ` +
        `Pendientes de aprobación: <b style="color:${pendientes ? '#b54708' : '#027a48'}">${pendientes}</b></div>`;

    for (const g of grupos) {
        const ultimo = g.filas[g.filas.length - 1];
        const color = g.cierre ? '#12b76a' : '#f79009';
        const dc = g.filas.reduce((s, m) => s + m.dc, 0);
        const dm = g.filas.reduce((s, m) => s + m.dm, 0);
        const dl = g.filas.reduce((s, m) => s + m.dl, 0);
        html += `<div style="border:1px solid #d0d5dd;border-radius:10px;margin:10px 0;overflow:hidden;background:#fff">` +
            `<div style="padding:10px 14px;background:#f5f7fb;border-bottom:1px solid #d0d5dd">` +
            `<span style="float:right;border:2px solid ${color};color:${color};padding:4px 10px;border-radius:6px;font-weight:bold;font-size:11px;letter-spacing:1px">${g.cierre ? 'APROBADA' : 'PENDIENTE'}</span>` +
            `<div style="font-weight:600;font-size:15px">Orden ${esc(g.orden)}</div>` +
            `<div style="font-size:12px;color:#667085">Lote <b>${esc(ultimo.lote || '-')}</b> · Cod. <b>${esc(ultimo.codigo_pt || '-')}</b> · Línea ${esc(ultimo.linea || '-')}</div></div>` +
            `<div style="padding:10px 14px">` +
            `<div style="font-size:12px;color:#667085;margin-bottom:6px">Defectos del día · Críticos <b style="color:#b42318">${dc}</b> · ` +
            `Moderados <b style="color:#b54708">${dm}</b> · Leves <b style="color:#027a48">${dl}</b></div>` +
            tablaOrden(g.filas) +
            (g.cierre
                ? `<div style="margin-top:8px;font-size:12px;color:#027a48;padding:8px;background:#ecfdf3;border-radius:6px">` +
                  `✔ Aprobada por <b>${esc(g.cierre.aprobada_por)}</b> el ${fechaHora(g.cierre.aprobada_en)}` +
                  `${g.cierre.notas ? `<br/><b>Notas:</b> ${esc(g.cierre.notas)}` : ''}</div>`
                : `<div style="margin-top:8px;font-size:12px;color:#b54708;padding:8px;background:#fef0c7;border-radius:6px">` +
                  `⚠ <b>Esta orden todavía no fue aprobada.</b> Un supervisor debe ingresar a la app y aprobarla.</div>`) +
            `</div></div>`;
    }

    html += `<div style="margin-top:20px;padding:14px;background:#f5f7fb;border-radius:8px;font-size:12px;color:#667085;text-align:center">` +
        `Este mail se envía automáticamente todos los días a las ${HORA}:00. Para <b>imprimir</b> cada orden y adjuntarla al parte físico, ` +
        `ingresá a <a href="${BASE}/fabuloso.html">Control Fabuloso</a> → <b>Órdenes de hoy</b> → <b>🖨️ Imprimir</b>.</div></div>`;
    return html;
}

export async function revisarReporteFabuloso({ forzar = false, soloPrevisualizar = false } = {}) {
    if (!hayCorreo) return { estado: 'sin correo configurado' };

    return correrUnaVezPorDia(
        'avisos_fabuloso_reporte',
        { hora: HORA, forzar, activa: ACTIVOS },
        async (reloj) => {
            const { rows: diaRows } = await consultar(
                `SELECT ((now() AT TIME ZONE $1)::date - 1)::text AS dia`, [ZONA]
            );
            const dia = diaRows[0].dia;
            const { rows } = await consultar(
                `SELECT * FROM fab_muestreos
                 WHERE (registrado_en AT TIME ZONE $1)::date = $2::date
                 ORDER BY registrado_en`,
                [ZONA, dia]
            );
            const para = await supervisoresDe(RECURSO, 'reporte-diario');

            if (!rows.length) {
                const asunto = `Vessena LCC Fabuloso — Sin controles el ${dma(dia)}`;
                if (soloPrevisualizar) {
                    return { modo: 'previsualizacion', hoy: comoDia(reloj.hoy), dia, asunto, para, correos: 0 };
                }
                if (!para.length) return { controles: 0, correos: 0, detalle: 'sin destinatarios' };
                await enviar({
                    para, asunto, texto: asunto,
                    html: `<p>No se registraron muestreos en la línea Fabuloso el <b>${dma(dia)}</b>.</p>`,
                });
                return { controles: 0, correos: 1, detalle: `sin controles el ${dia}, a ${para.join(', ')}` };
            }

            const ordenes = [...new Set(rows.map((m) => m.orden_envasado))];
            const { rows: cierres } = await consultar(
                'SELECT * FROM fab_ordenes WHERE orden_envasado = ANY($1)', [ordenes]
            );
            const cierrePor = new Map(cierres.map((o) => [o.orden_envasado, o]));
            const grupos = ordenes.map((orden) => ({
                orden,
                filas: rows.filter((m) => m.orden_envasado === orden),
                cierre: cierrePor.get(orden) || null,
            }));
            const pendientes = grupos.filter((g) => !g.cierre).length;
            const asunto = `Vessena LCC Fabuloso — Reporte del ${dma(dia)} · ` +
                `${grupos.length} orden(es) · ${pendientes} pendiente(s)`;

            if (soloPrevisualizar) {
                return {
                    modo: 'previsualizacion', hoy: comoDia(reloj.hoy), dia, asunto, para, correos: 0,
                    ordenes: grupos.map((g) => `${g.orden} · ${g.filas.length} control(es) · ${g.cierre ? 'aprobada' : 'pendiente'}`),
                };
            }
            if (!para.length) return { controles: rows.length, correos: 0, detalle: 'sin destinatarios' };

            await enviar({ para, asunto, texto: asunto, html: cuerpoReporte(dia, grupos, rows.length, pendientes) });
            return {
                controles: rows.length, ordenes: grupos.length, pendientes, correos: 1,
                detalle: `${grupos.length} orden(es), ${pendientes} pendiente(s) a ${para.join(', ')}`,
            };
        }
    );
}

export function configFabuloso() {
    return { activos: ACTIVOS, hora: HORA, frecuencia: 'todos los días', base: BASE };
}
