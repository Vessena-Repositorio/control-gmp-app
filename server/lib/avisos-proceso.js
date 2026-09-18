/**
 * Aviso de ordenes de envasado sin aprobar (control en proceso).
 *
 * Pedido de Claudia (17/09/2026), junto con la impresion y las firmas: de lunes
 * a viernes a las 8, a quienes aprueban -Antonella, Gloria y Claudia- las
 * ordenes de dias anteriores que siguen sin aprobar. Las del dia no cuentan: la
 * linea puede seguir envasando y avisarlas seria ruido.
 *
 * Los destinatarios estan en notificacion_supervisores (036), no en el codigo.
 */
import { consultar } from '../db.js';
import { hayCorreo, enviar } from './correo.js';
import { supervisoresDe } from './destinatarios.js';
import { correrUnaVezPorDia, comoDia, ZONA } from './tareas.js';

const RECURSO = 'control-en-proceso';
const NOTIFICACION = 'pendientes-aprobacion';
const TAREA = 'avisos_proceso_pendientes';

const HORA = Number(process.env.AVISOS_PROCESO_HORA ?? 8);
const ACTIVOS = ['1', 'true', 'si'].includes(
    String(process.env.AVISOS_PROCESO_ACTIVOS || '').toLowerCase()
);
const BASE = (process.env.URL_PUBLICA || 'http://192.168.30.15:3000').replace(/\/+$/, '');

function esc(s) {
    return String(s ?? '').replace(/[&<>"]/g, (c) =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

const dma = (v) => {
    const d = comoDia(v);
    return d ? `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}` : '—';
};

const plural = (n, uno, varios) => `${n} ${n === 1 ? uno : varios}`;

/** Ordenes de dias anteriores con controles y sin aprobacion. */
export async function ordenesPendientes() {
    const { rows } = await consultar(
        `SELECT c.orden,
                count(*)::int                          AS controles,
                count(*) FILTER (WHERE c.has_dev)::int AS con_desvio,
                min(c.fecha)                           AS desde,
                max(c.fecha)                           AS hasta,
                max(c.lote)                            AS lote,
                max(c.maquina)                         AS maquina,
                max(c.presentacion)                    AS presentacion,
                string_agg(DISTINCT c.analista, ', ')  AS analistas,
                ((now() AT TIME ZONE $1)::date - max(c.fecha)) AS dias
         FROM proceso_controles c
         LEFT JOIN proceso_ordenes o ON o.orden = c.orden
         WHERE c.duplicado_de IS NULL
           AND c.orden IS NOT NULL AND c.orden <> ''
           AND o.orden IS NULL
           AND c.fecha < (now() AT TIME ZONE $1)::date
           -- Solo lo que se cargo desde la app: las ordenes viejas de la
           -- planilla nunca tuvieron aprobacion y serian cientos de avisos.
           AND c.origen = 'app'
         GROUP BY c.orden
         ORDER BY max(c.fecha), c.orden`,
        [ZONA]
    );
    return rows;
}

function cuerpo(filas) {
    const celda = 'padding:6px 10px;border-bottom:1px solid #eee';
    const th = (x) => `<th style="padding:6px 10px;text-align:left">${x}</th>`;
    const filasHtml = filas.map((f) => `<tr>
        <td style="${celda}"><b>${esc(f.orden)}</b></td>
        <td style="${celda}">${esc(f.lote || '—')}</td>
        <td style="${celda}">${esc(f.maquina || '—')} ${esc(f.presentacion || '')}</td>
        <td style="${celda};white-space:nowrap">${dma(f.hasta)}</td>
        <td style="${celda};white-space:nowrap;color:${Number(f.dias) > 3 ? '#b42318' : '#475467'}">${plural(Number(f.dias), 'día', 'días')}</td>
        <td style="${celda}">${f.controles}${Number(f.con_desvio) ? ` · <b style="color:#b42318">${f.con_desvio} con desvío</b>` : ''}</td>
        <td style="${celda}">${esc(f.analistas || '—')}</td>
    </tr>`).join('');

    return `<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;color:#101828">
        <h2 style="margin:0 0 12px">Control en proceso: ${plural(filas.length, 'orden', 'órdenes')} sin aprobar</h2>
        <p style="font-size:13px;color:#475467;margin:0 0 10px">
          Son órdenes de días anteriores con controles cargados y todavía sin la firma del supervisor.
          Al aprobar se puede imprimir el registro <b>REG SOP LCC 200</b> para el dossier.</p>
        <table style="border-collapse:collapse;font-size:13px">
          <thead><tr style="background:#f9fafb">
            ${th('Orden')}${th('Lote')}${th('Máquina')}${th('Último control')}${th('Antigüedad')}${th('Controles')}${th('Analistas')}
          </tr></thead>
          <tbody>${filasHtml}</tbody>
        </table>
        <p style="margin-top:16px;font-size:13px">
          <a href="${BASE}/control-en-proceso.html">Abrir Control en proceso</a> → pestaña <b>Órdenes</b>.
        </p>
      </div>`;
}

function texto(filas) {
    const lineas = filas.map((f) =>
        `- Orden ${f.orden} (lote ${f.lote || '—'}, ${f.maquina || '—'}): ` +
        `${f.controles} control(es), último el ${dma(f.hasta)}, hace ${plural(Number(f.dias), 'día', 'días')}` +
        (Number(f.con_desvio) ? `, ${f.con_desvio} con desvío` : ''));
    return `Control en proceso: ${plural(filas.length, 'orden', 'órdenes')} sin aprobar\n\n` +
        `${lineas.join('\n')}\n\nAprobar e imprimir en ${BASE}/control-en-proceso.html\n`;
}

export async function revisarProcesoPendientes({ forzar = false, soloPrevisualizar = false } = {}) {
    if (!hayCorreo) return { estado: 'sin correo configurado' };

    return correrUnaVezPorDia(
        TAREA,
        { hora: HORA, forzar, activa: ACTIVOS },
        async (reloj) => {
            // De lunes a viernes (Claudia, 18/09/2026): el fin de semana no se
            // aprueba, y lo pendiente del viernes vuelve a salir el lunes.
            if (!forzar && reloj.dia_semana >= 6) {
                return { correos: 0, detalle: 'fin de semana' };
            }
            const filas = await ordenesPendientes();
            if (!filas.length) return { ordenes: 0, correos: 0, detalle: 'sin órdenes pendientes' };

            const para = await supervisoresDe(RECURSO, NOTIFICACION);
            const asunto = `[Calidad] Control en proceso — ${plural(filas.length, 'orden', 'órdenes')} sin aprobar`;

            if (soloPrevisualizar) {
                return {
                    modo: 'previsualizacion', hoy: comoDia(reloj.hoy), asunto, para, correos: 0,
                    ordenes: filas.map((f) => `${f.orden} · ${f.controles} control(es) · ${f.dias} día(s)`),
                };
            }
            if (!para.length) return { ordenes: filas.length, correos: 0, detalle: 'sin destinatarios' };

            await enviar({ para, asunto, texto: texto(filas), html: cuerpo(filas) });
            return {
                ordenes: filas.length, correos: 1,
                detalle: `${filas.length} orden(es) a ${para.join(', ')}`,
            };
        }
    );
}

export function configProceso() {
    return { activos: ACTIVOS, hora: HORA, frecuencia: 'lunes a viernes', base: BASE };
}
