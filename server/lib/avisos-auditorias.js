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

/* ── Autoinspecciones del trimestre ──────────────────────────────────────────
 *
 * Las autoinspecciones se hacen cuatro veces al año -febrero, mayo, agosto y
 * noviembre- y cada sector tiene su día dentro del mes ("1er lunes", "2do
 * jueves"). El aviso sale el primer día hábil de esos meses con la lista
 * completa, y vuelve a salir los lunes mientras queden sectores sin hacer, que
 * es cuando sirve: a mitad de mes, para los que quedaron.
 *
 * Los meses y los sectores salen de la configuración de la app, no de acá, para
 * que se cambien sin tocar código.
 */
const MES_NUMERO = {
    enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6,
    julio: 7, agosto: 8, septiembre: 9, setiembre: 9, octubre: 10, noviembre: 11, diciembre: 12,
};
const sinTildes = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

async function configApp() {
    const { rows } = await consultar("SELECT datos FROM aud_colecciones WHERE nombre = 'config'");
    const d = rows[0]?.datos;
    return d && typeof d === 'object' && !Array.isArray(d) ? d : {};
}

export async function revisarAutoinspecciones({ forzar = false, soloPrevisualizar = false } = {}) {
    if (!hayCorreo) return { estado: 'sin correo configurado' };
    const activa = await estaActivo();
    return correrUnaVezPorDia('avisos_auditorias_autoinsp', { hora: HORA, forzar, activa }, async () => {
        const hoy = await hoyISO();
        const anio = Number(hoy.slice(0, 4));
        const mesNumero = Number(hoy.slice(5, 7));
        const diaDelMes = Number(hoy.slice(8, 10));
        const diaSemana = new Date(`${hoy}T12:00:00Z`).getUTCDay();

        const cfg = await configApp();
        const meses = (Array.isArray(cfg.aiMonths) && cfg.aiMonths.length ? cfg.aiMonths : ['Febrero', 'Mayo', 'Agosto', 'Noviembre'])
            .map((m) => MES_NUMERO[sinTildes(m)]).filter(Boolean);
        const cual = meses.indexOf(mesNumero);
        if (cual < 0 && !forzar) return { correos: 0, detalle: 'este mes no toca autoinspección' };
        const trimestre = `Q${(cual < 0 ? 0 : cual) + 1}`;

        const sectores = Array.isArray(cfg.aiSectors) && cfg.aiSectors.length
            ? cfg.aiSectors : [];
        const hechas = (await coleccion('autoinspecciones')).filter((i) => i.year === anio && i.quarter === trimestre);
        const estadoDe = (nombre) => {
            const i = hechas.find((x) => sinTildes(x.sector) === sinTildes(nombre));
            if (!i) return { hecha: false, estado: 'Sin empezar', fecha: '' };
            const cerrada = /complet|cerrad|realiz/i.test(String(i.status || '')) || Boolean(i.date);
            return { hecha: cerrada, estado: i.status || 'En proceso', fecha: i.date || '' };
        };
        const filas = sectores.map((s) => ({ sector: s.name || String(s), dia: s.day || '', ...estadoDe(s.name || String(s)) }));
        const pendientes = filas.filter((f) => !f.hecha);

        // Primer dia habil: la lista completa. Lunes: solo si falta alguna.
        const esPrimerDiaHabil = diaDelMes === 1
            || (diaDelMes === 2 && diaSemana === 1) || (diaDelMes === 3 && diaSemana === 1);
        const esLunes = diaSemana === 1;
        const motivo = esPrimerDiaHabil ? 'inicio' : (esLunes && pendientes.length ? 'recordatorio' : null);
        if (!motivo && !forzar) return { correos: 0, detalle: 'no es el primer día hábil ni un lunes con pendientes' };

        const para = await supervisoresDe(RECURSO, 'autoinspecciones');
        const asunto = motivo === 'recordatorio'
            ? `[Vessena · Autoinspecciones] ${pendientes.length} sector(es) sin autoinspeccionar este mes`
            : `[Vessena · Autoinspecciones] ${filas.length} sector(es) a autoinspeccionar en ${MESES[mesNumero - 1]} ${anio}`;
        if (soloPrevisualizar) {
            return { modo: 'previsualizacion', para, asunto, correos: 0, trimestre, motivo: motivo || 'fuera de fecha',
                sectores: filas.map((f) => `${f.sector} · ${f.dia || 'sin día'} · ${f.estado}`) };
        }
        if (!filas.length) return { correos: 0, detalle: 'sin sectores configurados' };
        if (!para.length) return { correos: 0, detalle: 'sin destinatarios' };

        const lista = motivo === 'recordatorio' ? pendientes : filas;
        const intro = motivo === 'recordatorio'
            ? `<p style="margin:0;font-size:14px">Estos sectores todavía no tienen la autoinspección de ${esc(MESES[mesNumero - 1])}:</p>`
            : `<p style="margin:0;font-size:14px">Este mes toca la autoinspección del trimestre (${esc(trimestre)}). Cada sector tiene su día:</p>`;
        const cuerpo = intro + tabla(['Sector', 'Día', 'Estado', 'Fecha'],
            lista.map((f) => [`<b>${esc(f.sector)}</b>`, esc(f.dia || '—'),
                f.hecha ? '✔ Hecha' : esc(f.estado), esc(f.fecha || '—')]));
        try {
            await enviar({
                para, asunto,
                html: marco(motivo === 'recordatorio' ? 'Autoinspecciones pendientes' : `Autoinspecciones de ${MESES[mesNumero - 1]}`,
                    `${trimestre} ${anio} · SOP-AC-035`, cuerpo, motivo === 'recordatorio' ? '#B45309' : '#0891B2'),
                texto: asunto,
            });
            return { correos: 1, motivo, sectores: lista.length, pendientes: pendientes.length };
        } catch (err) {
            console.error('[avisos:auditorias] autoinspecciones fallo:', err.message);
            return { correos: 0, detalle: err.message };
        }
    });
}

export function configAuditorias() {
    return { hora: HORA, diasSinInforme: DIAS_SIN_INFORME, acciones: 'lunes', mes: 'primer día hábil',
        informes: 'lunes', autoinspecciones: 'primer día hábil de feb/may/ago/nov y los lunes con pendientes' };
}
