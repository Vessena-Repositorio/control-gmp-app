/**
 * Recordatorio diario de controles LCC de envases (FAB-1L y FAB-2L).
 *
 * Transcripcion de ejecutarRecordatoriosLCC() del Apps Script (Code.gs v4):
 * todos los dias a las 8, un correo por tipo -semanal cada 7 dias, quincenal
 * cada 15- con los envases a los que les toca hoy o estan atrasados, a Antonella
 * y Claudia (notificacion_supervisores 'control-calidad-envases' /
 * 'recordatorio-lcc'). Los borradores no cuentan como control hecho.
 *
 * Apagado desde el 18/09/2026 (migracion 041): Claudia pidio que los correos
 * de LCC sean solo la aprobacion (Antonella) y el resumen de los lunes; lo
 * atrasado va en ese resumen (avisos-envases.js usa pendientesLcc).
 */
import { consultar } from '../db.js';
import { hayCorreo, enviar } from './correo.js';
import { supervisoresDe } from './destinatarios.js';
import { correrUnaVezPorDia, comoDia, ZONA } from './tareas.js';

const ENVASES = ['FAB-1L', 'FAB-2L'];
const TIPOS = [
    { tipo: 'semanal', dias: 7, titulo: 'Semanal (7 días)' },
    { tipo: 'quincenal', dias: 15, titulo: 'Quincenal (15 días)' },
];

function esc(s) {
    return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

/** Ultimo control completo por envase y tipo, y cuantos dias pasaron. */
export async function pendientesLcc() {
    const { rows } = await consultar(
        `SELECT envase, tipo, max(fecha)::text AS ultimo,
                ((now() AT TIME ZONE $1)::date - max(fecha)) AS dias
         FROM controles
         WHERE origen = 'lcc' AND producto = 'envases' AND eliminado_en IS NULL
           AND COALESCE(raw -> 'mediciones' ->> '_estado', 'completo') <> 'borrador'
           AND fecha IS NOT NULL
         GROUP BY envase, tipo`,
        [ZONA]
    );
    const ultimo = new Map(rows.map((r) => [`${r.envase}|${r.tipo}`, r]));
    return TIPOS.map((t) => ({
        ...t,
        envases: ENVASES.map((env) => {
            const u = ultimo.get(`${env}|${t.tipo}`);
            if (!u) return { envase: env, ultimo: null, dias: null, atraso: 999 };
            return { envase: env, ultimo: u.ultimo, dias: Number(u.dias), atraso: Number(u.dias) - t.dias };
        }).filter((p) => p.atraso >= 0),
    }));
}

export async function revisarRecordatoriosLcc({ forzar = false, soloPrevisualizar = false } = {}) {
    if (!hayCorreo) return { estado: 'sin correo configurado' };
    return correrUnaVezPorDia('recordatorios_lcc_envases', { hora: 8, forzar, activa: false }, async (reloj) => {
        const { rows: corte } = await consultar('SELECT 1 FROM envases_corte');
        if (!corte.length && !forzar) return { correos: 0, detalle: 'planilla abierta: lo manda el Apps Script' };
        const para = await supervisoresDe('control-calidad-envases', 'recordatorio-lcc');
        const grupos = (await pendientesLcc()).filter((g) => g.envases.length);
        if (soloPrevisualizar) {
            return { modo: 'previsualizacion', hoy: comoDia(reloj.hoy), para, correos: 0, grupos };
        }
        if (!grupos.length) return { correos: 0, detalle: 'sin LCC pendientes' };
        if (!para.length) return { correos: 0, detalle: 'sin destinatarios' };
        let correos = 0;
        for (const g of grupos) {
            const filas = g.envases.map((p) => {
                const estado = p.ultimo === null
                    ? '<span style="color:#e53e3e;font-weight:bold">Sin control previo</span>'
                    : p.atraso > 0
                        ? `<span style="color:#e53e3e;font-weight:bold">Atrasado ${p.atraso} día${p.atraso === 1 ? '' : 's'}</span>`
                        : '<span style="color:#d69e2e;font-weight:bold">Corresponde HOY</span>';
                const td = (x) => `<td style="padding:8px;border:1px solid #e2e8f0">${x}</td>`;
                return `<tr>${td(`<b>${esc(p.envase)}</b>`)}${td(esc(p.ultimo || '—'))}${td(p.dias ?? '—')}${td(estado)}</tr>`;
            }).join('');
            const th = (x) => `<th style="padding:8px;border:1px solid #cbd5e0;text-align:left">${x}</th>`;
            const html = `<div style="font-family:Arial,sans-serif;max-width:640px;margin:0 auto">
                <div style="background:#028090;color:#fff;padding:20px;border-radius:8px 8px 0 0"><h2 style="margin:0">Vessena · Recordatorio LCC ${g.titulo}</h2></div>
                <div style="background:#f7fafc;padding:20px;border:1px solid #e2e8f0;border-top:none">
                  <p>Hay ${g.envases.length} envase${g.envases.length === 1 ? '' : 's'} que requieren control LCC ${g.tipo}:</p>
                  <table style="width:100%;border-collapse:collapse;margin:16px 0"><thead><tr style="background:#e2e8f0">${th('Envase')}${th('Último control')}${th('Días desde')}${th('Estado')}</tr></thead><tbody>${filas}</tbody></table>
                  <p style="font-size:12px;color:#718096">Este recordatorio se envía automáticamente todos los días desde el sistema de Control de Calidad.</p>
                </div></div>`;
            try {
                await enviar({
                    para, html,
                    asunto: `[Vessena · LCC] Recordatorio ${g.titulo} · ${g.envases.length} envase(s) pendiente(s)`,
                    texto: `Recordatorio LCC ${g.tipo}: ${g.envases.map((p) => p.envase).join(', ')}`,
                });
                correos++;
            } catch (err) {
                console.error('[avisos:lcc-envases] no se pudo mandar:', err.message);
            }
        }
        return { correos, detalle: `${correos} recordatorio(s) LCC` };
    });
}
