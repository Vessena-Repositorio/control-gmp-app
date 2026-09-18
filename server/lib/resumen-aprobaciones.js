/**
 * Resumen mensual de ordenes sin aprobar — Control en proceso y Fabuloso.
 *
 * Pedido de Claudia (18/09/2026): el primer lunes de cada mes, a ella sola
 * (notificacion_supervisores 'aprobaciones' / 'resumen-mensual'), las ordenes
 * que siguen sin la aprobacion final del supervisor, con sus fechas. Es para
 * controlar que las supervisoras hayan aprobado todo y que ninguna orden quede
 * sin firmar.
 *
 * Entra todo lo pendiente cuyo ultimo control es anterior a hoy, no solo lo del
 * mes pasado: una orden olvidada de hace dos meses es justamente lo que hay que
 * ver. En Control en proceso solo cuentan las ordenes cargadas desde la app: las
 * de la planilla anterior nunca tuvieron aprobacion. Si no hay nada pendiente
 * igual sale un correo corto que lo dice, para saber que el control corrio.
 */
import { consultar } from '../db.js';
import { hayCorreo, enviar } from './correo.js';
import { supervisoresDe } from './destinatarios.js';
import { correrUnaVezPorDia, comoDia, ZONA } from './tareas.js';

const BASE = (process.env.URL_PUBLICA || 'http://192.168.30.15:3000').replace(/\/+$/, '');
const HORA = Number(process.env.RESUMEN_APROBACIONES_HORA ?? 8);

function esc(s) {
    return String(s ?? '').replace(/[&<>"]/g, (c) =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

const dma = (v) => {
    const d = comoDia(v);
    return d ? `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}` : '—';
};

const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto',
    'septiembre', 'octubre', 'noviembre', 'diciembre'];

/** Ordenes sin aprobacion final de las dos apps, de la mas vieja a la mas nueva. */
export async function ordenesSinAprobar() {
    const { rows: proceso } = await consultar(
        `SELECT 'Control en proceso' AS app, c.orden,
                min(c.fecha) AS desde, max(c.fecha) AS hasta,
                count(*)::int AS controles,
                max(c.lote) AS lote,
                concat_ws(' · ', max(c.maquina), max(c.presentacion)) AS producto,
                string_agg(DISTINCT c.analista, ', ') AS analistas,
                ((now() AT TIME ZONE $1)::date - max(c.fecha)) AS dias
         FROM proceso_controles c
         LEFT JOIN proceso_ordenes o ON o.orden = c.orden
         WHERE c.duplicado_de IS NULL AND c.origen = 'app'
           AND c.orden IS NOT NULL AND c.orden <> ''
           AND o.orden IS NULL
         GROUP BY c.orden
         HAVING max(c.fecha) < (now() AT TIME ZONE $1)::date`,
        [ZONA]
    );
    const { rows: fabuloso } = await consultar(
        `SELECT 'Control Fabuloso' AS app, m.orden_envasado AS orden,
                min((m.registrado_en AT TIME ZONE $1)::date) AS desde,
                max((m.registrado_en AT TIME ZONE $1)::date) AS hasta,
                count(*)::int AS controles,
                max(m.lote) AS lote,
                concat_ws(' · ', max(m.linea), max(m.codigo_pt)) AS producto,
                string_agg(DISTINCT m.analista_nombre, ', ') AS analistas,
                ((now() AT TIME ZONE $1)::date - max((m.registrado_en AT TIME ZONE $1)::date)) AS dias
         FROM fab_muestreos m
         LEFT JOIN fab_ordenes o ON o.orden_envasado = m.orden_envasado
         WHERE o.orden_envasado IS NULL
         GROUP BY m.orden_envasado
         HAVING max((m.registrado_en AT TIME ZONE $1)::date) < (now() AT TIME ZONE $1)::date`,
        [ZONA]
    );
    return [...proceso, ...fabuloso].sort((a, b) =>
        comoDia(a.hasta).localeCompare(comoDia(b.hasta)) || String(a.orden).localeCompare(String(b.orden)));
}

function tabla(filas) {
    const celda = 'padding:6px 10px;border-bottom:1px solid #eee;font-size:13px';
    const th = (x) => `<th style="padding:6px 10px;text-align:left;font-size:13px">${x}</th>`;
    return `<table style="border-collapse:collapse;width:100%">
        <thead><tr style="background:#f9fafb">${th('Orden')}${th('Fechas')}${th('Producto')}${th('Lote')}${th('Controles')}${th('Analistas')}${th('Sin aprobar')}</tr></thead>
        <tbody>${filas.map((f) => `<tr>
            <td style="${celda}"><b>${esc(f.orden)}</b></td>
            <td style="${celda};white-space:nowrap">${dma(f.desde)}${comoDia(f.desde) !== comoDia(f.hasta) ? ` al ${dma(f.hasta)}` : ''}</td>
            <td style="${celda}">${esc(f.producto || '—')}</td>
            <td style="${celda}">${esc(f.lote || '—')}</td>
            <td style="${celda}">${f.controles}</td>
            <td style="${celda}">${esc(f.analistas || '—')}</td>
            <td style="${celda};white-space:nowrap;color:${Number(f.dias) > 7 ? '#b42318' : '#475467'}"><b>${f.dias} día(s)</b></td>
        </tr>`).join('')}</tbody></table>`;
}

function cuerpo(filas, mesAnterior) {
    const porApp = (app) => filas.filter((f) => f.app === app);
    const bloque = (app, pagina) => {
        const f = porApp(app);
        return `<h3 style="margin:18px 0 6px">${esc(app)}: ${f.length ? `${f.length} orden(es) sin aprobar` : 'todo aprobado ✅'}</h3>` +
            (f.length ? tabla(f) + `<p style="font-size:13px"><a href="${BASE}${pagina}">Abrir ${esc(app)}</a></p>` : '');
    };
    return `<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;color:#101828;max-width:860px">
        <h2 style="margin:0 0 6px">Control de aprobaciones — ${esc(mesAnterior)}</h2>
        <p style="font-size:14px;color:#475467;margin:0">Órdenes con controles cargados que todavía no tienen la aprobación final del supervisor.
        Entra todo lo pendiente hasta ayer, no solo lo del mes pasado.</p>
        ${bloque('Control en proceso', '/control-en-proceso.html')}
        ${bloque('Control Fabuloso', '/fabuloso.html')}
      </div>`;
}

/** Primer lunes de cada mes, a las 8. */
export async function revisarResumenAprobaciones({ forzar = false, soloPrevisualizar = false } = {}) {
    if (!hayCorreo) return { estado: 'sin correo configurado' };
    return correrUnaVezPorDia('resumen_aprobaciones_mensual', { hora: HORA, diaSemana: 1, forzar, activa: true }, async (reloj) => {
        const hoy = comoDia(reloj.hoy);
        // Semanal por el lunes, pero solo manda la primera semana del mes
        if (!forzar && Number(hoy.slice(8, 10)) > 7) {
            return { correos: 0, detalle: 'no es el primer lunes del mes' };
        }
        const mes = Number(hoy.slice(5, 7));
        const mesAnterior = `${MESES[(mes + 10) % 12]} ${mes === 1 ? Number(hoy.slice(0, 4)) - 1 : hoy.slice(0, 4)}`;
        const filas = await ordenesSinAprobar();
        const para = await supervisoresDe('aprobaciones', 'resumen-mensual');
        const asunto = filas.length
            ? `[Calidad] Control de aprobaciones: ${filas.length} orden(es) sin aprobar`
            : '[Calidad] Control de aprobaciones: todas las órdenes aprobadas';
        if (soloPrevisualizar) {
            return { modo: 'previsualizacion', asunto, para, correos: 0, ordenes: filas.map((f) => `${f.app} ${f.orden} · ${f.dias} día(s)`) };
        }
        if (!para.length) return { ordenes: filas.length, correos: 0, detalle: 'sin destinatarios' };
        const texto = `${asunto}\n\n${filas.map((f) => `- ${f.app} orden ${f.orden}: ${dma(f.desde)} a ${dma(f.hasta)}, ${f.controles} control(es), ${f.dias} día(s) sin aprobar`).join('\n')}\n`;
        await enviar({ para, asunto, texto, html: cuerpo(filas, mesAnterior) });
        return { ordenes: filas.length, correos: 1, detalle: `${filas.length} orden(es) sin aprobar a ${para.join(', ')}` };
    });
}
