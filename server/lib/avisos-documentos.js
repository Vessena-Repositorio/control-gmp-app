/**
 * Avisos del control de documentos (migraciones 054 y 056).
 *
 *   - Al momento: tarea asignada (revisar o aprobar), rechazo al autor, y
 *     version aprobada o vigente al autor y a Calidad. Los manda la ruta
 *     despues del COMMIT, con avisarCiclo().
 *   - Diario 8:00: a cada persona, sus tareas que vencen mañana o ya vencieron.
 *   - Diario 8:00: vencimiento de documentos a 60, 30 y 7 dias, el dia que
 *     vencen, y el primer aviso de los que entraron vencidos (escalonado con
 *     avisar_desde). Va a quien aprobo la vigente; si no tiene usuario, a
 *     Calidad.
 *   - Lunes 8:00: resumen a Calidad (vencidos, por vencer en 60 dias, tareas
 *     atrasadas).
 *   - Cada 10 minutos: las versiones aprobadas cuya fecha de vigencia llego
 *     pasan a vigentes. No depende del correo.
 */
import { consultar } from '../db.js';
import { hayCorreo, enviar } from './correo.js';
import { supervisoresDe } from './destinatarios.js';
import { correrUnaVezPorDia, ZONA } from './tareas.js';
import { enTransaccionSistema } from './audit-trail.js';
import { activarVigencias } from './ciclo-documentos.js';

const RECURSO = 'control-documentos';
const HORA = Number(process.env.AVISOS_DOCUMENTOS_HORA ?? 8);
const BASE = (process.env.URL_PUBLICA || 'http://192.168.30.15:3000').replace(/\/+$/, '');
const AZUL = '#1F5FB0';

function esc(s) {
    return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
const dma = (f) => {
    const s = f instanceof Date
        ? `${f.getFullYear()}-${String(f.getMonth() + 1).padStart(2, '0')}-${String(f.getDate()).padStart(2, '0')}`
        : String(f || '').slice(0, 10);
    return s ? `${s.slice(8, 10)}/${s.slice(5, 7)}/${s.slice(0, 4)}` : '—';
};
const ver = (n) => (Number.isInteger(Number(n)) ? Number(n).toFixed(1) : String(n));

function marco(titulo, subtitulo, cuerpo, color = AZUL, boton = 'Abrir Control de Documentos') {
    return `<div style="font-family:system-ui,-apple-system,Segoe UI,Arial,sans-serif;background:#F5F6F8;padding:20px">
      <div style="max-width:720px;margin:auto">
        <div style="background:${color};color:#fff;padding:18px 22px;border-radius:10px 10px 0 0">
          <div style="font-size:19px;font-weight:700">${titulo}</div>
          <div style="font-size:12px;opacity:.85;margin-top:2px">${subtitulo}</div>
        </div>
        <div style="background:#fff;padding:20px 22px;border:1px solid #E5E7EB;border-top:0;border-radius:0 0 10px 10px">
          ${cuerpo}
          <p style="margin:18px 0 0"><a href="${BASE}/control-documentos.html" style="display:inline-block;padding:10px 20px;background:${AZUL};color:#fff;text-decoration:none;border-radius:8px;font-weight:600">${boton}</a></p>
        </div></div></div>`;
}

const celda = 'padding:7px 9px;border:1px solid #E5E7EB;font-size:13px';
function tabla(encabezados, filas) {
    return `<table style="width:100%;border-collapse:collapse;margin-top:10px">
      <thead><tr style="background:#F1F3F7">${encabezados.map((h) => `<th style="${celda};text-align:left">${h}</th>`).join('')}</tr></thead>
      <tbody>${filas.map((f) => `<tr>${f.map((v) => `<td style="${celda}">${v}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
}

async function mandar(para, asunto, html) {
    const destino = (Array.isArray(para) ? para : [para]).filter((x) => String(x || '').includes('@'));
    if (!hayCorreo || !destino.length) return false;
    try {
        await enviar({ para: destino, asunto, html, texto: asunto });
        return true;
    } catch (err) {
        console.error('[avisos:documentos]', asunto, err.message);
        return false;
    }
}

/* ── Al momento ─────────────────────────────────────────────────────────── */

/**
 * Manda los avisos que devolvio ciclo-documentos.js. Nunca hace fallar el
 * pedido: la firma ya quedo guardada.
 */
export async function avisarCiclo(r) {
    const d = r.doc || {};
    const ref = `${esc(d.codigo)} v${ver(d.numero)} · ${esc(d.titulo)}`;
    for (const a of r.avisos || []) {
        const para = (a.para || []).map((p) => p?.correo);
        if (a.tipo === 'revision' || a.tipo === 'aprobacion') {
            const que = a.tipo === 'revision' ? 'revisar' : 'aprobar';
            await mandar(para, `[Vessena · Documentos] Tenés para ${que}: ${d.codigo} v${ver(d.numero)}`,
                marco(`Documento para ${que}`, ref,
                    `<p style="font-size:14px;margin:0 0 8px">Se te asignó ${que} <b>${ref}</b>.</p>` +
                    (d.resumen ? `<p style="font-size:13px;color:#475467;margin:0 0 8px"><b>Qué cambia:</b> ${esc(d.resumen)}</p>` : '') +
                    (a.plazo ? `<p style="font-size:14px;margin:0"><b>Plazo:</b> ${dma(a.plazo)}</p>` : '') +
                    '<p style="font-size:13px;color:#475467;margin:10px 0 0">Entrá a <b>Mis tareas</b>, leé el documento y firmá con tu usuario y clave para aprobarlo o rechazarlo con un comentario.</p>',
                    AZUL, 'Ir a Mis tareas'));
        } else if (a.tipo === 'rechazo') {
            await mandar(para, `[Vessena · Documentos] Rechazado: ${d.codigo} v${ver(d.numero)}`,
                marco('Documento rechazado', ref,
                    `<p style="font-size:14px;margin:0 0 8px"><b>${esc(a.quien)}</b> rechazó la versión y volvió a borrador.</p>
                     <p style="font-size:14px;margin:0;padding:10px 12px;background:#FBE9E9;border-radius:8px">${esc(a.comentario)}</p>
                     <p style="font-size:13px;color:#475467;margin:10px 0 0">Corregí el documento y volvé a enviarlo: empieza una ronda nueva.</p>`,
                    '#B23636'));
        } else if (a.tipo === 'vigente' || a.tipo === 'aprobada') {
            const vigente = a.tipo === 'vigente';
            await mandar(para, `[Vessena · Documentos] ${vigente ? 'Vigente' : 'Aprobado'}: ${d.codigo} v${ver(d.numero)}`,
                marco(vigente ? 'Documento vigente' : 'Documento aprobado', ref,
                    vigente
                        ? '<p style="font-size:14px;margin:0">La versión quedó vigente desde hoy y la anterior pasó a obsoleta.</p>'
                        : `<p style="font-size:14px;margin:0">Quedó aprobada y entra en vigencia el <b>${dma(d.fechaVigencia)}</b>. Hasta esa fecha sigue en uso la versión anterior.</p>`,
                    '#1A7F3F'));
        }
    }
}

/* ── Cada 10 minutos: vigencias ─────────────────────────────────────────── */

export async function revisarVigenciasDocumentos() {
    const activadas = await enTransaccionSistema('vigencia programada',
        'la versión aprobada llegó a su fecha de vigencia', (c) => activarVigencias(c));
    if (!activadas.length) return { estado: 'sin cambios' };
    return { estado: 'ok', vigentes: activadas.map((v) => `${v.codigo} v${ver(v.numero)}`) };
}

/* ── Diario: tareas que vencen ──────────────────────────────────────────── */

export async function revisarTareasDocumentos({ forzar = false } = {}) {
    if (!hayCorreo) return { estado: 'sin correo configurado' };
    return correrUnaVezPorDia('avisos_documentos_tareas', { hora: HORA, forzar }, async () => {
        const { rows } = await consultar(
            `SELECT t.id, t.tipo, t.vence_el, (t.vence_el - (now() AT TIME ZONE $1)::date) AS faltan,
                    d.codigo, d.titulo, v.numero, u.id AS usuario_id, coalesce(u.email, u.usuario) AS correo
             FROM dc_tareas t
             JOIN dc_versiones v ON v.id = t.version_id
             JOIN dc_documentos d ON d.id = v.documento_id
             JOIN usuarios u ON u.id = t.usuario_id AND u.activo
             WHERE t.estado = 'pendiente' AND t.vence_el <= (now() AT TIME ZONE $1)::date + 1
             ORDER BY t.vence_el`, [ZONA]);
        const porPersona = new Map();
        for (const r of rows) (porPersona.get(r.correo) || porPersona.set(r.correo, []).get(r.correo)).push(r);
        let correos = 0;
        for (const [correo, tareas] of porPersona) {
            const atrasadas = tareas.filter((t) => t.faltan < 0).length;
            const ok = await mandar(correo,
                `[Vessena · Documentos] ${tareas.length} tarea(s) de documentos ${atrasadas ? 'atrasada(s)' : 'por vencer'}`,
                marco('Tus tareas de documentos', 'Revisión y aprobación',
                    tabla(['Documento', 'Tarea', 'Vence', ''], tareas.map((t) => [
                        `<b>${esc(t.codigo)}</b> v${ver(t.numero)}<br><span style="color:#6B7280">${esc(t.titulo)}</span>`,
                        t.tipo === 'revision' ? 'Revisar' : 'Aprobar',
                        dma(t.vence_el),
                        t.faltan < 0 ? `<b style="color:#B91C1C">${-t.faltan} d de atraso</b>` : (t.faltan === 0 ? 'hoy' : 'mañana'),
                    ])), AZUL, 'Ir a Mis tareas'));
            if (ok) correos++;
        }
        return { correos, tareas: rows.length };
    });
}

/* ── Diario: vencimiento de documentos ──────────────────────────────────── */

export async function revisarVencimientosDocumentos({ forzar = false } = {}) {
    if (!hayCorreo) return { estado: 'sin correo configurado' };
    return correrUnaVezPorDia('avisos_documentos_vencimientos', { hora: HORA, forzar }, async () => {
        const { rows } = await consultar(
            `WITH hoy AS (SELECT (now() AT TIME ZONE $1)::date AS d)
             SELECT doc.codigo, doc.titulo, doc.proxima_revision, v.numero,
                    (doc.proxima_revision - hoy.d) AS faltan,
                    u.id AS aprobador_id, coalesce(u.email, u.usuario) AS correo, v.aprobado_por_nombre
             FROM dc_documentos doc CROSS JOIN hoy
             JOIN dc_versiones v ON v.documento_id = doc.id AND v.estado = 'vigente'
             LEFT JOIN usuarios u ON u.id = v.aprobado_por_id AND u.activo
             WHERE (doc.proxima_revision - hoy.d) IN (60, 30, 7, 0)
                OR (doc.proxima_revision < hoy.d AND doc.avisar_desde = hoy.d)
             ORDER BY doc.proxima_revision`, [ZONA]);
        if (!rows.length) return { correos: 0, detalle: 'nada vence en 60/30/7 días ni hoy' };

        const calidad = await supervisoresDe(RECURSO, 'vencimientos');
        const grupos = new Map();
        for (const r of rows) {
            const destino = r.correo && r.correo.includes('@') ? [r.correo] : calidad;
            const k = destino.join(',');
            (grupos.get(k) || grupos.set(k, { para: destino, docs: [] }).get(k)).docs.push(r);
        }
        let correos = 0;
        for (const { para, docs } of grupos.values()) {
            const ok = await mandar(para,
                `[Vessena · Documentos] ${docs.length} documento(s) por vencer o vencidos`,
                marco('Revisión periódica de documentos', 'Vencen cada 3 años',
                    `<p style="font-size:14px;margin:0">Revisalos: si no necesitan cambios, renovalos con tu firma (Revisión periódica sin cambios); si los necesitan, iniciá una versión nueva.</p>` +
                    tabla(['Documento', 'Versión', 'Vence', ''], docs.map((d) => [
                        `<b>${esc(d.codigo)}</b><br><span style="color:#6B7280">${esc(d.titulo)}</span>`,
                        ver(d.numero), dma(d.proxima_revision),
                        d.faltan < 0 ? `<b style="color:#B91C1C">vencido hace ${-d.faltan} d</b>` : (d.faltan === 0 ? '<b>vence hoy</b>' : `en ${d.faltan} d`),
                    ])), '#B45309'));
            if (ok) correos++;
        }
        return { correos, documentos: rows.length };
    });
}

/* ── Lunes: resumen para Calidad ────────────────────────────────────────── */

export async function revisarResumenDocumentos({ forzar = false } = {}) {
    if (!hayCorreo) return { estado: 'sin correo configurado' };
    return correrUnaVezPorDia('avisos_documentos_resumen', { hora: HORA, diaSemana: 1, forzar }, async () => {
        const para = await supervisoresDe(RECURSO, 'resumen-semanal');
        if (!para.length) return { correos: 0, detalle: 'sin destinatarios' };
        const { rows: docs } = await consultar(
            `WITH hoy AS (SELECT (now() AT TIME ZONE $1)::date AS d)
             SELECT doc.codigo, doc.titulo, doc.proxima_revision, (doc.proxima_revision - hoy.d) AS faltan
             FROM dc_documentos doc CROSS JOIN hoy
             JOIN dc_versiones v ON v.documento_id = doc.id AND v.estado = 'vigente'
             WHERE doc.proxima_revision <= hoy.d + 60
               AND (doc.avisar_desde IS NULL OR doc.avisar_desde <= hoy.d)
             ORDER BY doc.proxima_revision`, [ZONA]);
        const { rows: tareas } = await consultar(
            `SELECT d.codigo, v.numero, t.tipo, t.vence_el, u.nombre,
                    ((now() AT TIME ZONE $1)::date - t.vence_el) AS atraso
             FROM dc_tareas t JOIN dc_versiones v ON v.id = t.version_id
             JOIN dc_documentos d ON d.id = v.documento_id JOIN usuarios u ON u.id = t.usuario_id
             WHERE t.estado = 'pendiente' AND t.vence_el < (now() AT TIME ZONE $1)::date
             ORDER BY t.vence_el`, [ZONA]);
        const { rows: [ocultos] } = await consultar(
            `SELECT count(*)::int AS n FROM dc_documentos
             WHERE avisar_desde > (now() AT TIME ZONE $1)::date`, [ZONA]);
        const vencidos = docs.filter((d) => d.faltan < 0);
        const porVencer = docs.filter((d) => d.faltan >= 0);
        if (!docs.length && !tareas.length) return { correos: 0, detalle: 'nada para informar' };

        const filaDoc = (d) => [`<b>${esc(d.codigo)}</b> · ${esc(d.titulo)}`, dma(d.proxima_revision),
            d.faltan < 0 ? `<b style="color:#B91C1C">${-d.faltan} d</b>` : `en ${d.faltan} d`];
        const cuerpo =
            (tareas.length ? `<h3 style="margin:4px 0;color:#B91C1C;font-size:15px">Tareas atrasadas (${tareas.length})</h3>` +
                tabla(['Documento', 'Tarea', 'Quién', 'Venció', 'Atraso'], tareas.map((t) => [
                    `<b>${esc(t.codigo)}</b> v${ver(t.numero)}`, t.tipo === 'revision' ? 'Revisar' : 'Aprobar',
                    esc(t.nombre), dma(t.vence_el), `<b>${t.atraso} d</b>`])) : '') +
            (vencidos.length ? `<h3 style="margin:16px 0 4px;color:#B91C1C;font-size:15px">Vencidos (${vencidos.length})</h3>` +
                tabla(['Documento', 'Venció', 'Atraso'], vencidos.map(filaDoc)) : '') +
            (porVencer.length ? `<h3 style="margin:16px 0 4px;color:#B45309;font-size:15px">Vencen en los próximos 60 días (${porVencer.length})</h3>` +
                tabla(['Documento', 'Vence', 'Faltan'], porVencer.map(filaDoc)) : '') +
            (ocultos.n ? `<p style="font-size:13px;color:#6B7280;margin:14px 0 0">Hay ${ocultos.n} documento(s) importados vencidos cuyo aviso todavía no empezó (se escalonan en 6 meses).</p>` : '');
        const asunto = `[Vessena · Documentos] Resumen: ${vencidos.length} vencido(s), ${porVencer.length} por vencer, ${tareas.length} tarea(s) atrasada(s)`;
        const ok = await mandar(para, asunto, marco('Documentos — resumen semanal', 'Control de documentos', cuerpo));
        return { correos: ok ? 1 : 0, vencidos: vencidos.length, porVencer: porVencer.length, tareas: tareas.length };
    });
}
