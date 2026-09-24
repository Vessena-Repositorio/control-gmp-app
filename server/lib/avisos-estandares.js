/**
 * Avisos de Gestión de Estándares (SOP-LCC-071), migracion 045.
 *
 * Los mismos dos correos que mandaba el Apps Script:
 *   - Diario a las 8: cada estandar que cruza un umbral -30, 15, 7, 1 dia y
 *     vencido- a quienes reponen (notificacion 'vencimientos'). Una sola vez
 *     por umbral: `aviso_umbral` guarda el ultimo avisado.
 *   - Lunes a las 8: resumen de vencidos y proximos a vencer ('resumen-semanal').
 *
 * Se prenden solos cuando la app ya tiene estandares cargados: hasta entonces
 * el que avisa es el Apps Script viejo y serian dos correos.
 * AVISOS_ESTANDARES_ACTIVOS=1 los fuerza antes, para probar.
 */
import { consultar } from '../db.js';
import { hayCorreo, enviar } from './correo.js';
import { supervisoresDe } from './destinatarios.js';
import { correrUnaVezPorDia, comoDia, ZONA } from './tareas.js';

const RECURSO = 'estandares';
const HORA = Number(process.env.AVISOS_ESTANDARES_HORA ?? 8);
const FORZADO = ['1', 'true', 'si'].includes(
    String(process.env.AVISOS_ESTANDARES_ACTIVOS || '').toLowerCase()
);
const BASE = (process.env.URL_PUBLICA || 'http://192.168.30.15:3000').replace(/\/+$/, '');
const NAV = '#142f5c';
const UMBRALES = [30, 15, 7, 1, 0];

const TIPOS = { mp: 'Materia prima', granel: 'Granel / en proceso',
    pt: 'Producto terminado', certificado: 'Certificado (CRS)' };

function esc(s) {
    return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

async function estaActivo() {
    if (FORZADO) return true;
    // Con la app vacia no hay nada que avisar, y el Apps Script viejo todavia
    // podria estar avisando: dos correos por el mismo vencimiento.
    const { rows } = await consultar(
        'SELECT (SELECT count(*) FROM est_estandares) + (SELECT count(*) FROM est_importacion) AS n'
    );
    return Number(rows[0].n) > 0;
}

/**
 * Los que cruzaron un umbral nuevo. Los estados definitivos -alterado,
 * obsoleto, fuera de stock- no se avisan: ya no se usan.
 */
async function porAvisar() {
    const { rows } = await consultar(
        `SELECT id, codigo, nombre, tipo, proveedor, lote_proveedor, lote_interno, cantidad,
                ubicacion, vencimiento::text AS vencimiento, aviso_umbral,
                (vencimiento - (now() AT TIME ZONE $1)::date) AS dias
         FROM est_estandares
         WHERE estado = 'vigente'
         ORDER BY vencimiento`,
        [ZONA]
    );
    const salida = [];
    for (const f of rows) {
        const dias = Number(f.dias);
        const umbral = UMBRALES.find((u) => (u === 0 ? dias < 0 : dias <= u && dias >= 0));
        if (umbral === undefined) continue;
        // Solo se avisa al bajar de umbral: 30 -> 15 -> 7 -> 1 -> vencido.
        if (f.aviso_umbral !== null && umbral >= Number(f.aviso_umbral)) continue;
        salida.push({ ...f, dias, umbral });
    }
    return salida;
}

function cuerpoAviso(e) {
    const vencido = e.umbral === 0;
    const estado = vencido
        ? `<b style="color:#b23636">VENCIDO hace ${Math.abs(e.dias)} día(s)</b>`
        : `<b style="color:#b8730b">vence en ${e.dias} día(s)</b>`;
    const fila = (k, v) => `<tr><td style="padding:5px 8px;color:#6b7382">${k}</td><td style="padding:5px 8px"><b>${esc(v || '—')}</b></td></tr>`;
    return `<div style="font-family:Arial,Helvetica,sans-serif;background:#f6f7f9;padding:20px">
      <div style="max-width:620px;margin:auto">
        <div style="background:${NAV};color:#fff;padding:20px 22px;border-radius:8px 8px 0 0">
          <div style="font-size:19px;font-weight:800">Vessena S.A. — Gestión de Estándares</div>
          <div style="font-size:12px;opacity:.85;margin-top:2px">SOP-LCC-071 · ${vencido ? 'Estándar vencido' : 'Próximo a vencer'}</div>
        </div>
        <div style="background:#fff;padding:22px;border-radius:0 0 8px 8px">
          <p style="margin:0 0 12px">El estándar <b>${esc(e.codigo)} — ${esc(e.nombre)}</b> ${estado}.</p>
          <table style="width:100%;border-collapse:collapse;font-size:13px;background:#fafbfd;border:1px solid #e3e6ec;border-radius:6px">
            ${fila('Tipo', TIPOS[e.tipo] || e.tipo)}${fila('Proveedor', e.proveedor)}
            ${fila('Lote proveedor', e.lote_proveedor)}${fila('Lote interno Vessena', e.lote_interno)}
            ${fila('Cantidad', e.cantidad)}${fila('Ubicación', e.ubicacion)}
            ${fila('Vencimiento', e.vencimiento)}
          </table>
          <p style="margin:16px 0 6px;font-size:13px"><b>Qué corresponde (SOP-LCC-071):</b></p>
          <p style="margin:0;font-size:13px">${vencido
            ? 'Retirarlo del uso y disponer según SOP-GEN-092. Si tiene fecha de reanálisis y el retest da conforme, se pueden extender las fechas desde la app; si no, marcarlo obsoleto y preparar uno nuevo.'
            : 'Preparar o pedir el reemplazo antes del vencimiento, y verificar la cantidad disponible.'}</p>
          <p style="margin:20px 0"><a href="${BASE}/estandares.html" style="display:inline-block;padding:11px 22px;background:#1f5fb0;color:#fff;text-decoration:none;border-radius:6px;font-weight:bold">Abrir Gestión de Estándares</a></p>
        </div>
      </div></div>`;
}

export async function revisarVencimientosEstandares({ forzar = false, soloPrevisualizar = false } = {}) {
    if (!hayCorreo) return { estado: 'sin correo configurado' };
    const activa = await estaActivo();
    return correrUnaVezPorDia('avisos_estandares', { hora: HORA, forzar, activa }, async (reloj) => {
        const lista = await porAvisar();
        const para = await supervisoresDe(RECURSO, 'vencimientos');
        if (soloPrevisualizar) {
            return { modo: 'previsualizacion', hoy: comoDia(reloj.hoy), para, correos: 0,
                avisos: lista.map((e) => `${e.codigo} · ${e.nombre} · vence ${e.vencimiento} (umbral ${e.umbral})`) };
        }
        if (!lista.length) return { correos: 0, detalle: 'sin estándares por vencer' };
        if (!para.length) return { correos: 0, detalle: 'sin destinatarios' };
        let correos = 0;
        for (const e of lista) {
            const asunto = e.umbral === 0
                ? `[Vessena · Estándares] VENCIDO · ${e.codigo} — ${e.nombre}`
                : `[Vessena · Estándares] Vence en ${e.dias} día(s) · ${e.codigo} — ${e.nombre}`;
            try {
                await enviar({ para, asunto, html: cuerpoAviso(e),
                    texto: `${e.codigo} — ${e.nombre}: vencimiento ${e.vencimiento}. ${BASE}/estandares.html` });
                await consultar(
                    'UPDATE est_estandares SET aviso_umbral = $2, aviso_en = now() WHERE id = $1',
                    [e.id, e.umbral]
                );
                correos++;
            } catch (err) {
                console.error('[avisos:estandares] no se pudo avisar:', err.message);
            }
        }
        return { correos, detalle: `${correos} aviso(s) de vencimiento` };
    });
}

export async function revisarResumenEstandares({ forzar = false, soloPrevisualizar = false } = {}) {
    if (!hayCorreo) return { estado: 'sin correo configurado' };
    const activa = await estaActivo();
    return correrUnaVezPorDia('avisos_estandares_resumen', { hora: HORA, diaSemana: 1, forzar, activa }, async (reloj) => {
        const { rows } = await consultar(
            `SELECT codigo, nombre, ubicacion, vencimiento::text AS vencimiento,
                    (vencimiento - (now() AT TIME ZONE $1)::date) AS dias
             FROM est_estandares
             WHERE estado = 'vigente'
               AND vencimiento <= (now() AT TIME ZONE $1)::date + 30
             ORDER BY vencimiento`,
            [ZONA]
        );
        const vencidos = rows.filter((r) => Number(r.dias) < 0);
        const proximos = rows.filter((r) => Number(r.dias) >= 0);
        const { rows: total } = await consultar(
            `SELECT count(*)::int AS n FROM est_estandares WHERE estado = 'vigente'`
        );
        const para = await supervisoresDe(RECURSO, 'resumen-semanal');
        const asunto = `[Vessena · Estándares] Resumen: ${vencidos.length} vencido(s), ${proximos.length} por vencer`;
        if (soloPrevisualizar) {
            return { modo: 'previsualizacion', hoy: comoDia(reloj.hoy), para, asunto, correos: 0,
                vencidos: vencidos.length, proximos: proximos.length, enStock: total[0].n };
        }
        if (!vencidos.length && !proximos.length) return { correos: 0, detalle: 'nada vencido ni por vencer' };
        if (!para.length) return { correos: 0, detalle: 'sin destinatarios' };

        const celda = 'padding:7px 9px;border:1px solid #e3e6ec';
        const tabla = (titulo, filas, color) => filas.length ? `
            <h3 style="margin:18px 0 6px;color:${color};font-size:15px">${titulo} (${filas.length})</h3>
            <table style="width:100%;border-collapse:collapse;font-size:12.5px">
              ${filas.map((r) => `<tr><td style="${celda}"><b>${esc(r.codigo)}</b></td>` +
                `<td style="${celda}">${esc(r.nombre)}</td>` +
                `<td style="${celda}">${esc(r.vencimiento)}</td>` +
                `<td style="${celda}">${Number(r.dias) < 0 ? `vencido hace ${Math.abs(Number(r.dias))} d` : `en ${r.dias} d`}</td>` +
                `<td style="${celda}">${esc(r.ubicacion || '—')}</td></tr>`).join('')}
            </table>` : '';
        const html = `<div style="font-family:Arial,Helvetica,sans-serif;background:#f6f7f9;padding:20px">
          <div style="max-width:720px;margin:auto">
            <div style="background:${NAV};color:#fff;padding:20px 22px;border-radius:8px 8px 0 0">
              <div style="font-size:19px;font-weight:800">Estándares — resumen semanal</div>
              <div style="font-size:12px;opacity:.85;margin-top:2px">SOP-LCC-071 · ${comoDia(reloj.hoy)}</div>
            </div>
            <div style="background:#fff;padding:22px;border-radius:0 0 8px 8px">
              ${tabla('Vencidos', vencidos, '#b23636')}
              ${tabla('Vencen dentro de 30 días', proximos, '#b8730b')}
              <p style="margin:18px 0 0;font-size:13px">En stock y vigentes: <b>${total[0].n}</b>.</p>
              <p style="margin:16px 0"><a href="${BASE}/estandares.html" style="display:inline-block;padding:10px 20px;background:#1f5fb0;color:#fff;text-decoration:none;border-radius:6px;font-weight:bold">Abrir Gestión de Estándares</a></p>
            </div>
          </div></div>`;
        try {
            await enviar({ para, asunto, html, texto: asunto });
            return { correos: 1, vencidos: vencidos.length, proximos: proximos.length };
        } catch (err) {
            console.error('[avisos:estandares] resumen fallo:', err.message);
            return { correos: 0, detalle: err.message };
        }
    });
}

export function configEstandares() {
    return { forzado: FORZADO, hora: HORA, umbrales: UMBRALES, resumen: 'lunes' };
}
