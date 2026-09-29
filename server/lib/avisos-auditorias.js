/**
 * Avisos de Auditorías (SOP-AC-035), migracion 051.
 *
 * Los tres que pidio Claudia el 29/09/2026:
 *   - Lunes 8:00: acciones de auditoria vencidas o que vencen esta semana.
 *   - Primer dia habil del mes, 8:00: las auditorias planificadas para ese mes.
 *   - Lunes 8:00: auditorias ejecutadas que siguen sin informe.
 *
 * Los datos son las colecciones de aud_colecciones: son listas chicas -siete
 * auditorias, veintiseis hallazgos- asi que se leen enteras y se filtran aca,
 * en vez de inventar consultas sobre el JSON.
 */
import { consultar } from '../db.js';
import { hayCorreo, enviar } from './correo.js';
import { supervisoresDe } from './destinatarios.js';
import { correrUnaVezPorDia, relojLocal, comoDia, ZONA } from './tareas.js';

const RECURSO = 'auditorias';
const HORA = Number(process.env.AVISOS_AUDITORIAS_HORA ?? 8);
const DIAS_SIN_INFORME = Number(process.env.AUDITORIAS_DIAS_INFORME ?? 15);
const BASE = (process.env.URL_PUBLICA || 'http://192.168.30.15:3000').replace(/\/+$/, '');
const NAV = '#1B1E25';
const MESES = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Set', 'Oct', 'Nov', 'Dic'];
const CERRADOS = ['cerrado', 'no aplica', 'evaluada — no implementar', 'evaluada - no implementar'];

function esc(s) {
    return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

async function coleccion(nombre) {
    const { rows } = await consultar('SELECT datos FROM aud_colecciones WHERE nombre = $1', [nombre]);
    const d = rows[0]?.datos;
    return Array.isArray(d) ? d : [];
}

/** Con la app vacia no hay nada que avisar. */
async function estaActivo() {
    const { rows } = await consultar(
        `SELECT count(*)::int AS n FROM aud_colecciones WHERE nombre = 'auditorias' AND jsonb_array_length(datos) > 0`
    );
    return rows[0].n > 0;
}

const hoyISO = async () => {
    const { rows } = await consultar('SELECT (now() AT TIME ZONE $1)::date::text AS hoy', [ZONA]);
    return rows[0].hoy;
};
const dias = (a, b) => Math.round((new Date(`${b}T12:00:00Z`) - new Date(`${a}T12:00:00Z`)) / 86400000);

function marco(titulo, subtitulo, cuerpo, color = NAV) {
    return `<div style="font-family:system-ui,-apple-system,Segoe UI,Arial,sans-serif;background:#F5F6F8;padding:20px">
      <div style="max-width:720px;margin:auto">
        <div style="background:${color};color:#fff;padding:18px 22px;border-radius:10px 10px 0 0">
          <div style="font-size:19px;font-weight:700">${titulo}</div>
          <div style="font-size:12px;opacity:.85;margin-top:2px">${subtitulo}</div>
        </div>
        <div style="background:#fff;padding:20px 22px;border:1px solid #E5E7EB;border-top:0;border-radius:0 0 10px 10px">
          ${cuerpo}
          <p style="margin:18px 0 0"><a href="${BASE}/auditorias.html" style="display:inline-block;padding:10px 20px;background:#1E40AF;color:#fff;text-decoration:none;border-radius:8px;font-weight:600">Abrir Auditorías</a></p>
        </div></div></div>`;
}

const celda = 'padding:7px 9px;border:1px solid #E5E7EB;font-size:13px';
function tabla(encabezados, filas) {
    return `<table style="width:100%;border-collapse:collapse;margin-top:10px">
      <thead><tr style="background:#F1F3F7">${encabezados.map((h) => `<th style="${celda};text-align:left">${h}</th>`).join('')}</tr></thead>
      <tbody>${filas.map((f) => `<tr>${f.map((v) => `<td style="${celda}">${v}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
}

/* ── Acciones vencidas ───────────────────────────────────────────────────── */

export async function revisarAccionesAuditoria({ forzar = false, soloPrevisualizar = false } = {}) {
    if (!hayCorreo) return { estado: 'sin correo configurado' };
    const activa = await estaActivo();
    return correrUnaVezPorDia('avisos_auditorias_acciones', { hora: HORA, diaSemana: 1, forzar, activa }, async () => {
        const hoy = await hoyISO();
        const acciones = await coleccion('acciones');
        const hallazgos = await coleccion('hallazgos');
        const auditorias = await coleccion('auditorias');
        const audDe = (h) => auditorias.find((a) => a.id === h?.auditId);

        const abiertas = acciones.filter((a) => !CERRADOS.includes(String(a.status || '').toLowerCase()));
        const conFecha = abiertas.filter((a) => /^\d{4}-\d{2}-\d{2}$/.test(String(a.dueDate || '')));
        const vencidas = conFecha.filter((a) => a.dueDate < hoy)
            .sort((x, y) => (x.dueDate < y.dueDate ? -1 : 1));
        const porVencer = conFecha.filter((a) => a.dueDate >= hoy && dias(hoy, a.dueDate) <= 7);
        const sinFecha = abiertas.length - conFecha.length;

        const para = await supervisoresDe(RECURSO, 'acciones-vencidas');
        const asunto = `[Vessena · Auditorías] ${vencidas.length} acción(es) vencida(s)` +
            (porVencer.length ? `, ${porVencer.length} vence(n) esta semana` : '');
        if (soloPrevisualizar) {
            return { modo: 'previsualizacion', para, asunto, correos: 0,
                vencidas: vencidas.map((a) => `${a.code} · ${a.responsible || '—'} · vencía ${a.dueDate}`),
                porVencer: porVencer.length, sinFecha };
        }
        if (!vencidas.length && !porVencer.length) return { correos: 0, detalle: 'nada vencido ni por vencer' };
        if (!para.length) return { correos: 0, detalle: 'sin destinatarios' };

        const fila = (a) => {
            const h = hallazgos.find((x) => x.id === a.findingId);
            const aud = audDe(h);
            const atraso = dias(a.dueDate, hoy);
            return [
                `<b>${esc(a.code || '')}</b>`,
                esc(aud ? `${aud.code} · ${aud.name}` : '—'),
                esc(h?.classification || '—'),
                esc(String(a.description || '').slice(0, 120)),
                esc(a.responsible || '—'),
                esc(a.dueDate),
                atraso > 0 ? `<b style="color:#B91C1C">${atraso} d</b>` : `en ${Math.abs(atraso)} d`,
            ];
        };
        const cuerpo =
            (vencidas.length ? `<h3 style="margin:14px 0 4px;color:#B91C1C;font-size:15px">Vencidas (${vencidas.length})</h3>` +
                tabla(['Acción', 'Auditoría', 'Clasif.', 'Qué', 'Responsable', 'Vencía', 'Atraso'], vencidas.map(fila)) : '') +
            (porVencer.length ? `<h3 style="margin:18px 0 4px;color:#B45309;font-size:15px">Vencen esta semana (${porVencer.length})</h3>` +
                tabla(['Acción', 'Auditoría', 'Clasif.', 'Qué', 'Responsable', 'Vence', 'Faltan'], porVencer.map(fila)) : '') +
            (sinFecha ? `<p style="margin:14px 0 0;font-size:13px;color:#6B7280">Hay ${sinFecha} acción(es) abiertas sin fecha de compromiso.</p>` : '');

        try {
            await enviar({ para, asunto, html: marco('Auditorías — acciones pendientes', `SOP-AC-035 · ${comoDia(hoy)}`, cuerpo, '#B91C1C'), texto: asunto });
            return { correos: 1, vencidas: vencidas.length, porVencer: porVencer.length };
        } catch (err) {
            console.error('[avisos:auditorias] acciones fallo:', err.message);
            return { correos: 0, detalle: err.message };
        }
    });
}

/* ── Auditorías del mes ──────────────────────────────────────────────────── */

export async function revisarAuditoriasDelMes({ forzar = false, soloPrevisualizar = false } = {}) {
    if (!hayCorreo) return { estado: 'sin correo configurado' };
    const activa = await estaActivo();
    return correrUnaVezPorDia('avisos_auditorias_mes', { hora: HORA, forzar, activa }, async (reloj) => {
        const hoy = await hoyISO();
        const diaDelMes = Number(hoy.slice(8, 10));
        // Sale una vez al mes: el primer dia habil. Si el 1 cae sabado o
        // domingo, el lunes siguiente (la tarea corre igual todos los dias).
        const diaSemana = new Date(`${hoy}T12:00:00Z`).getUTCDay();
        const esPrimerDiaHabil = diaDelMes === 1
            || (diaDelMes === 2 && diaSemana === 1) || (diaDelMes === 3 && diaSemana === 1);
        if (!esPrimerDiaHabil && !forzar) return { correos: 0, detalle: 'no es el primer día hábil del mes' };

        const mes = MESES[Number(hoy.slice(5, 7)) - 1];
        const anio = Number(hoy.slice(0, 4));
        const auditorias = await coleccion('auditorias');
        const delMes = auditorias.filter((a) => a.year === anio && a.progMonth === mes
            && !['cerrada', 'ext_cerrada'].includes(a.phase));

        const para = await supervisoresDe(RECURSO, 'auditorias-del-mes');
        const asunto = `[Vessena · Auditorías] ${delMes.length} auditoría(s) planificada(s) para ${mes} ${anio}`;
        if (soloPrevisualizar) {
            return { modo: 'previsualizacion', para, asunto, correos: 0, mes,
                auditorias: delMes.map((a) => `${a.code} · ${a.name} · ${a.phase}`) };
        }
        if (!delMes.length) return { correos: 0, detalle: `sin auditorías para ${mes}` };
        if (!para.length) return { correos: 0, detalle: 'sin destinatarios' };

        const cuerpo = `<p style="margin:0;font-size:14px">Para este mes están previstas estas auditorías del programa anual:</p>` +
            tabla(['Código', 'Auditoría', 'Tipo', 'Sector / proveedor', 'Estado', 'Fecha'],
                delMes.map((a) => [`<b>${esc(a.code)}</b>`, esc(a.name), esc(a.type || '—'),
                    esc(a.progSector || '—'), esc(a.phase || '—'), esc(a.date || 'sin fecha')]));
        try {
            await enviar({ para, asunto, html: marco(`Auditorías de ${mes}`, `Programa anual ${anio} · SOP-AC-035`, cuerpo, '#1E40AF'), texto: asunto });
            return { correos: 1, auditorias: delMes.length, hoy: comoDia(reloj.hoy) };
        } catch (err) {
            console.error('[avisos:auditorias] mes fallo:', err.message);
            return { correos: 0, detalle: err.message };
        }
    });
}

/* ── Informes pendientes ─────────────────────────────────────────────────── */

export async function revisarInformesPendientes({ forzar = false, soloPrevisualizar = false } = {}) {
    if (!hayCorreo) return { estado: 'sin correo configurado' };
    const activa = await estaActivo();
    return correrUnaVezPorDia('avisos_auditorias_informe', { hora: HORA, diaSemana: 1, forzar, activa }, async () => {
        const hoy = await hoyISO();
        const auditorias = await coleccion('auditorias');
        // Ejecutada y sin informe: la fase lo dice. Se cuenta desde la fecha de
        // ejecucion, o desde la fecha de la auditoria si no hay otra.
        const pendientes = auditorias
            .filter((a) => ['en_ejecucion', 'ext_recibida'].includes(a.phase))
            .map((a) => {
                const desde = [a.execDate, a.date].find((f) => /^\d{4}-\d{2}-\d{2}$/.test(String(f || '')));
                return { ...a, desde, dias: desde ? dias(desde, hoy) : null };
            })
            .filter((a) => a.dias === null || a.dias >= DIAS_SIN_INFORME);

        const para = await supervisoresDe(RECURSO, 'informe-pendiente');
        const asunto = `[Vessena · Auditorías] ${pendientes.length} auditoría(s) ejecutada(s) sin informe`;
        if (soloPrevisualizar) {
            return { modo: 'previsualizacion', para, asunto, correos: 0, umbralDias: DIAS_SIN_INFORME,
                auditorias: pendientes.map((a) => `${a.code} · ${a.name} · ${a.dias ?? '?'} días`) };
        }
        if (!pendientes.length) return { correos: 0, detalle: 'sin informes atrasados' };
        if (!para.length) return { correos: 0, detalle: 'sin destinatarios' };

        const cuerpo = `<p style="margin:0;font-size:14px">Estas auditorías ya se hicieron y todavía no tienen el informe (REG-035-C) emitido:</p>` +
            tabla(['Código', 'Auditoría', 'Tipo', 'Ejecutada', 'Hace'],
                pendientes.map((a) => [`<b>${esc(a.code)}</b>`, esc(a.name), esc(a.type || '—'),
                    esc(a.desde || 'sin fecha'), a.dias === null ? '—' : `<b>${a.dias} días</b>`])) +
            `<p style="margin:14px 0 0;font-size:12px;color:#6B7280">Se avisa a partir de ${DIAS_SIN_INFORME} días desde la ejecución.</p>`;
        try {
            await enviar({ para, asunto, html: marco('Informes de auditoría pendientes', `SOP-AC-035 · ${comoDia(hoy)}`, cuerpo, '#B45309'), texto: asunto });
            return { correos: 1, pendientes: pendientes.length };
        } catch (err) {
            console.error('[avisos:auditorias] informes fallo:', err.message);
            return { correos: 0, detalle: err.message };
        }
    });
}

export function configAuditorias() {
    return { hora: HORA, diasSinInforme: DIAS_SIN_INFORME, acciones: 'lunes', mes: 'primer día hábil', informes: 'lunes' };
}
