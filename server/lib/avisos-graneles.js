/**
 * Avisos de muestras de granel sin aprobar.
 *
 * Dos correos, pedidos por Claudia el 14/09/2026:
 *
 *   - Diario, a quien aprueba (Antonella): las muestras de dias anteriores que
 *     siguen pendientes. Las del dia no cuentan: todavia se estan analizando, y
 *     avisarlas seria ruido.
 *   - Lunes, a quien sigue el estado (Claudia): el resumen de la semana, con lo
 *     que sigue sin aprobar y lo que se aprobo o rechazo.
 *
 * Los destinatarios estan en notificacion_supervisores (027), no en el codigo.
 */
import { consultar } from '../db.js';
import { hayCorreo, enviar } from './correo.js';
import { supervisoresDe } from './destinatarios.js';
import { correrUnaVezPorDia, comoDia, ZONA } from './tareas.js';
import { bloqueosDeAprobacion } from './graneles-reglas.js';

const RECURSO = 'aprobacion-graneles';

const HORA = Number(process.env.AVISOS_GRANELES_HORA ?? 8);
const ACTIVOS = ['1', 'true', 'si'].includes(
    String(process.env.AVISOS_GRANELES_ACTIVOS || '').toLowerCase()
);
const BASE = (process.env.URL_PUBLICA || 'http://192.168.30.15:3000').replace(/\/+$/, '');

const ROJO = '#B91C1C';
const NEGRO = '#1A1A1A';

function esc(s) {
    return String(s ?? '').replace(/[&<>"]/g, (c) =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

/** 'DD/MM/AAAA', que es como se leen las fechas acá. */
const dma = (v) => {
    const d = comoDia(v);
    return d ? `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}` : '—';
};

const plural = (n, uno, varios) => `${n} ${n === 1 ? uno : varios}`;

/**
 * Muestras sin disposicion. Con `soloAnteriores`, las de dias anteriores a hoy.
 *
 * La situacion se calcula con las mismas reglas que usa la API para aprobar,
 * asi el correo dice lo mismo que va a decir la app: "lista para aprobar"
 * significa que el boton Aprobar esta habilitado.
 */
async function pendientes({ soloAnteriores }) {
    const { rows } = await consultar(
        `SELECT lote, producto_code, especificacion ->> 'name' AS producto, fecha, analista,
                hora_fin, resultados,
                ((now() AT TIME ZONE $1)::date - fecha) AS dias
         FROM gra_muestras
         WHERE estado = 'pending'
           ${soloAnteriores ? 'AND fecha < (now() AT TIME ZONE $1)::date' : ''}
         ORDER BY fecha, creado_en`,
        [ZONA]
    );
    return rows.map((f) => {
        const motivos = bloqueosDeAprobacion(f.resultados, f.hora_fin);
        return { ...f, dias: Number(f.dias ?? 0), lista: !motivos.length, situacion: motivos.join(', ') };
    });
}

/** Lo aprobado o rechazado en los ultimos 7 dias, con quien lo firmo. */
async function resueltasRecientes() {
    const { rows } = await consultar(
        `SELECT lote, producto_code, especificacion ->> 'name' AS producto, estado,
                aprobado_por, aprobado_en
         FROM gra_muestras
         WHERE estado <> 'pending' AND aprobado_en >= now() - interval '7 days'
         ORDER BY aprobado_en DESC`
    );
    return rows;
}

/* ═══ Cuerpos ═══════════════════════════════════════════════════════════════ */

const celda = 'padding:8px 10px;border:1px solid #e5e7eb';
const th = (t, al = 'left') =>
    `<th style="padding:8px 10px;text-align:${al};border:1px solid ${NEGRO}">${t}</th>`;

function tablaPendientes(filas) {
    const cuerpo = filas.map((f) => {
        // El color es lo que hace que una lista larga diga cual urge.
        const color = f.dias >= 3 ? '#dc2626' : f.dias >= 2 ? '#d97706' : '#475467';
        const situacion = f.lista
            ? `<span style="color:#166534;font-weight:700">Lista para aprobar</span>`
            : `<span style="color:#92400e">${esc(f.situacion)}</span>`;
        return `<tr>` +
            `<td style="${celda}"><b>${esc(f.lote)}</b></td>` +
            `<td style="${celda}">${esc(f.producto_code)}<br><span style="color:#6b7280">${esc(f.producto || '')}</span></td>` +
            `<td style="${celda}">${esc(dma(f.fecha))}</td>` +
            `<td style="${celda}">${esc(f.analista || '—')}</td>` +
            `<td style="${celda};text-align:center;color:${color};font-weight:800">${f.dias}</td>` +
            `<td style="${celda}">${situacion}</td>` +
        `</tr>`;
    }).join('');
    return `<table style="width:100%;border-collapse:collapse;font-size:12px">` +
        `<thead style="background:${NEGRO};color:#fff"><tr>` +
        th('Lote') + th('Granel') + th('Fecha') + th('Analista') + th('Días', 'center') + th('Situación') +
        `</tr></thead><tbody>${cuerpo}</tbody></table>`;
}

function marco(titulo, subtitulo, contenido, pie) {
    return `<div style="font-family:Arial,Helvetica,sans-serif;background:#f5f5f5;padding:20px">` +
      `<div style="max-width:820px;margin:auto">` +
        `<div style="background:${NEGRO};color:#fff;padding:20px 24px;border-radius:8px 8px 0 0;border-bottom:3px solid ${ROJO}">` +
          `<div style="font-size:19px;font-weight:800">${titulo}</div>` +
          `<div style="font-size:12px;opacity:.85;margin-top:2px">${subtitulo}</div>` +
        `</div>` +
        `<div style="background:#fff;padding:22px 24px;border-radius:0 0 8px 8px">` +
          contenido +
          `<p style="margin:18px 0"><a href="${BASE}/aprobacion-graneles.html" ` +
          `style="display:inline-block;padding:10px 20px;background:${ROJO};color:#fff;` +
          `text-decoration:none;border-radius:6px;font-weight:bold">Abrir Aprobación de Graneles →</a></p>` +
          `<p style="margin:12px 0 0 0;font-size:11px;color:#666;border-top:1px solid #e5e7eb;padding-top:12px">${pie}</p>` +
        `</div></div></div>`;
}

function cuerpoDiario(filas) {
    const listas = filas.filter((f) => f.lista).length;
    return marco(
        'Muestras de granel sin aprobar',
        'Vessena S.A. — Laboratorio de Control de Calidad',
        `<p style="margin:0 0 10px 0;font-size:14px">Hola, quedaron ` +
        `<b>${plural(filas.length, 'muestra', 'muestras')}</b> de días anteriores sin aprobar ni rechazar` +
        (listas ? `, ${listas === filas.length ? 'todas' : listas} listas para aprobar` : '') + `:</p>` +
        tablaPendientes(filas) +
        `<p style="font-size:11px;color:#666;margin:6px 0 0">Naranja: 2 días esperando · Rojo: 3 o más.</p>`,
        'Sale cada día hábil, y solo cuando quedó algo pendiente de días anteriores.'
    );
}

function cuerpoSemanal(filas, resueltas) {
    const aprobadas = resueltas.filter((r) => r.estado === 'approved');
    const rechazadas = resueltas.filter((r) => r.estado === 'rejected');
    const masVieja = filas.reduce((a, b) => (a && a.dias >= b.dias ? a : b), null);

    const dato = (etiqueta, valor, color) =>
        `<td style="padding:12px;text-align:center;border:1px solid #e5e7eb">` +
        `<div style="font-size:24px;font-weight:800;color:${color}">${valor}</div>` +
        `<div style="font-size:11px;color:#475467;margin-top:2px">${etiqueta}</div></td>`;

    const bloques = [
        `<table style="width:100%;border-collapse:collapse;margin-bottom:6px"><tr>` +
        dato('Sin aprobar', filas.length, filas.length ? '#b45309' : '#166534') +
        dato('Aprobadas en 7 días', aprobadas.length, '#166534') +
        dato('Rechazadas en 7 días', rechazadas.length, rechazadas.length ? ROJO : '#475467') +
        (masVieja ? dato('Días de la más antigua', masVieja.dias, masVieja.dias >= 3 ? '#dc2626' : '#475467') : '') +
        `</tr></table>`,
    ];

    if (filas.length) {
        bloques.push(
            `<h3 style="margin:18px 0 8px;color:#b45309;font-size:15px">⏳ Siguen sin aprobar</h3>` +
            tablaPendientes(filas)
        );
    }

    if (resueltas.length) {
        const cuerpo = resueltas.map((r) => `<tr>` +
            `<td style="${celda}"><b>${esc(r.lote)}</b></td>` +
            `<td style="${celda}">${esc(r.producto_code)} — ${esc(r.producto || '')}</td>` +
            `<td style="${celda};font-weight:700;color:${r.estado === 'approved' ? '#166534' : ROJO}">` +
              `${r.estado === 'approved' ? 'Aprobada' : 'Rechazada'}</td>` +
            `<td style="${celda}">${esc(r.aprobado_por || '—')}</td>` +
            `<td style="${celda}">${esc(dma(r.aprobado_en))}</td>` +
        `</tr>`).join('');
        bloques.push(
            `<h3 style="margin:22px 0 8px;color:#166534;font-size:15px">✓ Resueltas en los últimos 7 días</h3>` +
            `<table style="width:100%;border-collapse:collapse;font-size:12px">` +
            `<thead style="background:${NEGRO};color:#fff"><tr>` +
            th('Lote') + th('Granel') + th('Disposición') + th('Firmó') + th('Fecha') +
            `</tr></thead><tbody>${cuerpo}</tbody></table>`
        );
    }

    return marco(
        'Aprobación de graneles — resumen semanal',
        'Vessena S.A. — Laboratorio de Control de Calidad',
        bloques.join(''),
        'Sale los lunes, y solo cuando hay algo pendiente o resuelto en la semana.'
    );
}

/* ═══ Tareas ════════════════════════════════════════════════════════════════ */

/**
 * Diario, a quien aprueba. `soloPrevisualizar` arma todo y no manda.
 */
export async function revisarGranelesPendientes({ forzar = false, soloPrevisualizar = false } = {}) {
    if (!hayCorreo) return { estado: 'sin correo configurado' };

    return correrUnaVezPorDia(
        'avisos_graneles_pendientes',
        { hora: HORA, forzar, activa: ACTIVOS },
        async (reloj) => {
            // Sabado y domingo no se aprueba: el recordatorio del viernes se
            // repite el lunes si sigue haciendo falta.
            if (!forzar && reloj.dia_semana >= 6) {
                return { correos: 0, detalle: 'fin de semana' };
            }

            const filas = await pendientes({ soloAnteriores: true });
            if (!filas.length) {
                return { pendientes: 0, correos: 0, detalle: 'nada pendiente de dias anteriores' };
            }

            const para = await supervisoresDe(RECURSO, 'pendientes-aprobacion');
            const asunto = `[Calidad] ${plural(filas.length, 'muestra de granel', 'muestras de granel')} sin aprobar`;

            if (soloPrevisualizar) {
                return {
                    modo: 'previsualizacion', hoy: comoDia(reloj.hoy), asunto, para, correos: 0,
                    pendientes: filas.map((f) =>
                        `${f.lote} · ${f.producto_code} · ${dma(f.fecha)} · ${f.dias}d · ${f.lista ? 'lista para aprobar' : f.situacion}`),
                };
            }
            if (!para.length) {
                return { pendientes: filas.length, correos: 0, detalle: 'sin destinatarios' };
            }

            await enviar({ para, asunto, html: cuerpoDiario(filas), texto: asunto });
            return { pendientes: filas.length, correos: 1, detalle: `${filas.length} pendiente(s) a ${para.join(', ')}` };
        }
    );
}

/**
 * Lunes, a quien sigue el estado.
 */
export async function revisarGranelesResumen({ forzar = false, soloPrevisualizar = false } = {}) {
    if (!hayCorreo) return { estado: 'sin correo configurado' };

    return correrUnaVezPorDia(
        'avisos_graneles_resumen',
        { hora: HORA, diaSemana: 1, forzar, activa: ACTIVOS },
        async (reloj) => {
            const filas = await pendientes({ soloAnteriores: false });
            const resueltas = await resueltasRecientes();

            // Un resumen que solo dice "no paso nada" se deja de leer, y despues
            // no se lee el que importa.
            if (!filas.length && !resueltas.length) {
                return { pendientes: 0, resueltas: 0, correos: 0, detalle: 'semana sin movimiento' };
            }

            const para = await supervisoresDe(RECURSO, 'resumen-semanal');
            const asunto = `[Calidad] Graneles: ${plural(filas.length, 'sin aprobar', 'sin aprobar')}, ` +
                `${plural(resueltas.length, 'resuelta', 'resueltas')} en la semana`;

            if (soloPrevisualizar) {
                return {
                    modo: 'previsualizacion', hoy: comoDia(reloj.hoy), asunto, para, correos: 0,
                    pendientes: filas.map((f) => `${f.lote} · ${f.producto_code} · ${f.dias}d`),
                    resueltas: resueltas.map((r) => `${r.lote} · ${r.estado} · ${r.aprobado_por}`),
                };
            }
            if (!para.length) {
                return { pendientes: filas.length, resueltas: resueltas.length, correos: 0, detalle: 'sin destinatarios' };
            }

            await enviar({ para, asunto, html: cuerpoSemanal(filas, resueltas), texto: asunto });
            return {
                pendientes: filas.length, resueltas: resueltas.length, correos: 1,
                detalle: `${filas.length} pendiente(s), ${resueltas.length} resuelta(s) a ${para.join(', ')}`,
            };
        }
    );
}

export function configGraneles() {
    return { activos: ACTIVOS, hora: HORA, diario: 'lunes a viernes', resumen: 'lunes', base: BASE };
}
