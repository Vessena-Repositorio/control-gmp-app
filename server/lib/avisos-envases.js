/**
 * Aviso semanal de analisis pendientes de aprobacion — control de calidad de
 * envases.
 *
 * Cuando una analista termina un control semanal o quincenal, queda en estado
 * 'pendiente' esperando que alguien lo apruebe. La app no avisa a nadie: el
 * pendiente aparece si alguien entra a mirar. Este correo lo pone en la bandeja
 * de quien aprueba, los lunes.
 *
 * Sale de la replica: esta app todavia escribe en Apps Script, asi que el dato
 * viaja a Postgres con el sync -cada 15 minutos- y de ahi se lee. Cuando se
 * corte la escritura, esto sigue funcionando sin cambios.
 */
import { consultar } from '../db.js';
import { hayCorreo, enviar } from './correo.js';
import { supervisoresDe } from './destinatarios.js';
import { correrUnaVezPorDia, relojLocal, comoDia, ZONA } from './tareas.js';
import { pendientesLcc } from './avisos-lcc-envases.js';

const RECURSO = 'control-calidad-envases';
const NOTIFICACION = 'pendientes-aprobacion';
const TAREA = 'avisos_envases_aprobacion';

const HORA = Number(process.env.AVISOS_ENVASES_HORA ?? 8);
const ACTIVOS = ['1', 'true', 'si'].includes(
    String(process.env.AVISOS_ENVASES_ACTIVOS || '').toLowerCase()
);
const BASE = (process.env.URL_PUBLICA || 'http://192.168.30.15:3000').replace(/\/+$/, '');

const NAV = '#1a3352';

function esc(s) {
    return String(s ?? '').replace(/[&<>"]/g, (c) =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

/**
 * Controles semanales y quincenales terminados que siguen sin aprobar.
 *
 * El estado vive dentro del control original: `_estado` pasa a 'completo' al
 * enviarlo, y ahi mismo `_aprobado` se pone en 'pendiente'. Un borrador no
 * cuenta: todavia lo esta cargando alguien.
 */
async function pendientes() {
    const { rows } = await consultar(
        `SELECT c.clave_natural, c.tipo, c.fecha, c.analista, c.envase, c.origen,
                NULL::text AS orden,
                ((now() AT TIME ZONE $1)::date - c.fecha) AS dias
         FROM controles c
         LEFT JOIN envases_aprobaciones a ON a.control_clave = c.clave_natural
         -- Solo los LCC se aprueban (validacion, quincenal y semanal): la
         -- aprobacion se guarda con clave 'lcc:<id>'.
         WHERE c.origen = 'lcc' AND c.producto = 'envases'
           -- Los LCC viejos de la planilla no traen _estado: estaban completos.
           AND COALESCE(c.raw -> 'mediciones' ->> '_estado', 'completo') = 'completo'
           AND c.eliminado_en IS NULL
           -- La aprobacion vive en su tabla, no en el control: el Apps Script
           -- descarta lo que se le escriba en mediciones.
           AND a.control_clave IS NULL
         ORDER BY c.fecha, c.tipo`,
        [ZONA]
    );
    return rows;
}


/**
 * Lo aprobado en los ultimos 7 dias. Es la otra mitad del estado: saber que
 * quedo pendiente sirve poco si no se ve tambien lo que se resolvio.
 */
async function aprobadosRecientes() {
    const { rows } = await consultar(
        `SELECT c.tipo, c.fecha, c.analista, c.envase,
                a.aprobado_por, a.aprobado_en
         FROM envases_aprobaciones a
         JOIN controles c ON c.clave_natural = a.control_clave
         WHERE a.aprobado_en >= now() - interval '7 days'
         ORDER BY a.aprobado_en DESC`
    );
    return rows;
}

/** Contadores para poder verificar un cero, en vez de tener que creerlo. */
async function diagnostico() {
    const { rows } = await consultar(
        `SELECT count(*)::int AS semanales_quincenales,
                count(*) FILTER (
                    WHERE raw -> 'mediciones' ->> '_estado' = 'completo')::int AS completos,
                count(*) FILTER (
                    WHERE raw -> 'mediciones' ->> '_aprobado' = 'aprobado')::int AS aprobados,
                count(*) FILTER (
                    WHERE raw -> 'mediciones' ->> '_estado' IS NULL)::int AS sin_estado
         FROM controles
         WHERE tipo IN ('semanal', 'quincenal')`
    );
    return rows[0];
}

/**
 * Un solo correo con las dos mitades del estado: lo que falta aprobar y lo que
 * se aprobó. Separarlas en dos mensajes haría que el de "todo bien" se lea
 * primero y el otro se postergue.
 */
function cuerpo(pendientes, aprobados) {
    const celda = 'padding:8px 10px;border:1px solid #e5e7eb';
    const th = (t, al) => `<th style="padding:8px 10px;text-align:${al};border:1px solid ${NAV}">${t}</th>`;
    const bloques = [];

    if (pendientes.length) {
        const filas = pendientes.map((f) => {
            const dias = Number(f.dias ?? 0);
            // El color es la única forma de que una lista larga diga cuál urge.
            const color = dias >= 14 ? '#dc2626' : dias >= 7 ? '#d97706' : '#475467';
            return `<tr>` +
                `<td style="${celda}"><b>${esc(f.tipo)}</b></td>` +
                `<td style="${celda}">${esc(f.envase || '—')}</td>` +
                `<td style="${celda}">${esc(f.orden || (f.origen === 'lcc' ? 'LCC' : '—'))}</td>` +
                `<td style="${celda}">${esc(comoDia(f.fecha))}</td>` +
                `<td style="${celda}">${esc(f.analista || '—')}</td>` +
                `<td style="${celda};color:${color};font-weight:800">${dias}</td>` +
            `</tr>`;
        }).join('');
        const p = pendientes.length === 1 ? '' : 's';
        bloques.push(
            `<h3 style="margin:18px 0 8px;color:#b45309;font-size:16px">⏳ Esperando aprobación` +
            ` (${pendientes.length})</h3>` +
            `<p style="margin:0 0 8px 0;font-size:13px">Terminado${p} por las analistas, sin aprobar todavía:</p>` +
            `<table style="width:100%;border-collapse:collapse;font-size:12px">` +
            `<thead style="background:${NAV};color:#fff"><tr>` +
              th('Tipo', 'left') + th('Envase', 'left') + th('Orden', 'left') +
              th('Fecha', 'left') + th('Analista', 'left') + th('Días esperando', 'center') +
            `</tr></thead><tbody>${filas}</tbody></table>` +
            `<p style="font-size:11px;color:#666;margin:6px 0 0">Naranja: más de una semana · Rojo: más de dos.</p>`
        );
    }

    if (aprobados.length) {
        const filas = aprobados.map((f) => `<tr>` +
            `<td style="${celda}"><b>${esc(f.tipo)}</b></td>` +
            `<td style="${celda}">${esc(f.envase || '—')}</td>` +
            `<td style="${celda}">${esc(comoDia(f.fecha))}</td>` +
            `<td style="${celda}">${esc(f.analista || '—')}</td>` +
            `<td style="${celda};color:#1d6f52;font-weight:700">${esc(f.aprobado_por)}</td>` +
            `<td style="${celda}">${esc(comoDia(f.aprobado_en))}</td>` +
        `</tr>`).join('');
        bloques.push(
            `<h3 style="margin:22px 0 8px;color:#1d6f52;font-size:16px">✓ Aprobados esta semana` +
            ` (${aprobados.length})</h3>` +
            `<table style="width:100%;border-collapse:collapse;font-size:12px">` +
            `<thead style="background:${NAV};color:#fff"><tr>` +
              th('Tipo', 'left') + th('Envase', 'left') + th('Fecha', 'left') +
              th('Analista', 'left') + th('Aprobó', 'left') + th('Cuándo', 'left') +
            `</tr></thead><tbody>${filas}</tbody></table>`
        );
    }

    return `<div style="font-family:Arial,Helvetica,sans-serif;background:#f5f5f5;padding:20px">` +
      `<div style="max-width:840px;margin:auto">` +
        `<div style="background:${NAV};color:#fff;padding:22px 24px;border-radius:8px 8px 0 0">` +
          `<div style="font-size:20px;font-weight:800">Vessena S.A. — Estado de aprobaciones</div>` +
          `<div style="font-size:12px;opacity:.85;margin-top:2px">Control de calidad de envases · SOP-PR-138</div>` +
        `</div>` +
        `<div style="background:#fff;padding:24px;border-radius:0 0 8px 8px">` +
          `<p style="margin:0 0 4px 0">Hola,</p>` +
          bloques.join('') +
          `<p style="margin:18px 0"><a href="${BASE}/control-calidad-envases.html" ` +
          `style="display:inline-block;padding:10px 20px;background:#0E6B67;color:#fff;` +
          `text-decoration:none;border-radius:6px;font-weight:bold">Abrir la aplicación →</a></p>` +
          `<p style="margin:12px 0 0 0;font-size:11px;color:#666;border-top:1px solid #e5e7eb;padding-top:12px">` +
            `Sale los lunes, y solo cuando hay algo que contar.` +
          `</p>` +
        `</div></div></div>`;
}


/**
 * El resumen de los lunes para Claudia: lo que Antonella o Gloria tienen
 * pendiente de aprobar, y los LCC que ya tendrian que haberse hecho (el
 * recordatorio diario se apago en la 041 y lo atrasado vive aca).
 */
function cuerpoResumen(pendientes, aprobados, atrasados = []) {
    const celda = 'padding:6px 8px;border:1px solid #e5e7eb';
    const lista = pendientes.length
        ? `<h3 style="margin:18px 0 6px;font-size:14px;color:#b45309">Pendientes de Antonella o Gloria</h3>` +
          `<table style="width:100%;border-collapse:collapse;font-size:12px">` +
          pendientes.map((f) => `<tr>` +
            `<td style="${celda}"><b>${esc(f.tipo)}</b></td>` +
            `<td style="${celda}">${esc(f.envase || '—')}</td>` +
            `<td style="${celda}">${esc(comoDia(f.fecha))}</td>` +
            `<td style="${celda}">${esc(f.analista || '—')}</td>` +
            `<td style="${celda};text-align:right;font-weight:700;color:${Number(f.dias) >= 14 ? '#dc2626' : '#475467'}">${f.dias} d</td>` +
          `</tr>`).join('') + `</table>`
        : '';
    const porHacer = atrasados.length
        ? `<h3 style="margin:18px 0 6px;font-size:14px;color:#dc2626">LCC que ya corresponde hacer</h3>` +
          `<table style="width:100%;border-collapse:collapse;font-size:12px">` +
          atrasados.map((p) => `<tr>` +
            `<td style="${celda}"><b>${esc(p.tipo)}</b></td>` +
            `<td style="${celda}">${esc(p.envase)}</td>` +
            `<td style="${celda}">${p.ultimo ? 'último ' + esc(comoDia(p.ultimo)) : 'sin control previo'}</td>` +
            `<td style="${celda};text-align:right;font-weight:700;color:#dc2626">${p.ultimo ? (p.atraso > 0 ? `${p.atraso} d atrasado` : 'toca hoy') : '—'}</td>` +
          `</tr>`).join('') + `</table>`
        : '';
    return cuerpoCorto(pendientes, aprobados, lista + porHacer);
}

function cuerpoCorto(pendientes, aprobados, extra) {
    const masViejo = pendientes.length
        ? pendientes.reduce((a, b) => (Number(a.dias) > Number(b.dias) ? a : b))
        : null;

    const dato = (etiqueta, valor, color) =>
        `<tr>` +
        `<td style="padding:9px 4px;color:#475467">${etiqueta}</td>` +
        `<td style="padding:9px 4px;text-align:right;font-weight:800;font-size:17px;color:${color}">${valor}</td>` +
        `</tr>`;

    const quienes = aprobados.length
        ? `<p style="margin:14px 0 0 0;font-size:13px;color:#475467">Aprobó: ` +
          esc([...new Set(aprobados.map((a) => a.aprobado_por))].join(', ')) + `.</p>`
        : '';

    const alerta = masViejo && Number(masViejo.dias) >= 14
        ? `<p style="margin:14px 0 0 0;padding:10px 12px;background:#fef2f2;border-left:3px solid #dc2626;` +
          `font-size:13px;color:#7f1d1d">El más antiguo lleva ${masViejo.dias} días esperando.</p>`
        : '';

    return `<div style="font-family:Arial,Helvetica,sans-serif;background:#f5f5f5;padding:20px">` +
      `<div style="max-width:520px;margin:auto">` +
        `<div style="background:${NAV};color:#fff;padding:20px 22px;border-radius:8px 8px 0 0">` +
          `<div style="font-size:18px;font-weight:800">Aprobaciones — estado semanal</div>` +
          `<div style="font-size:12px;opacity:.85;margin-top:2px">Control de calidad de envases</div>` +
        `</div>` +
        `<div style="background:#fff;padding:22px;border-radius:0 0 8px 8px">` +
          `<table style="width:100%;border-collapse:collapse;font-size:14px">` +
            dato('Esperando aprobación', pendientes.length, pendientes.length ? '#b45309' : '#1d6f52') +
            dato('Aprobados esta semana', aprobados.length, '#1d6f52') +
            (masViejo ? dato('Días del más antiguo', masViejo.dias,
                Number(masViejo.dias) >= 14 ? '#dc2626' : '#475467') : '') +
          `</table>` +
          quienes + alerta + extra +
          `<p style="margin:16px 0 0 0;font-size:11px;color:#666;border-top:1px solid #e5e7eb;padding-top:12px">` +
            `Resumen de los lunes. Aprueban y firman Antonella o Gloria en la app; aprobado, se imprime.` +
          `</p>` +
        `</div></div></div>`;
}

/**
 * Corre el aviso si corresponde. Lunes, una vez por semana.
 * `soloPrevisualizar` arma todo y no manda: devuelve que saldria y a quien.
 */
export async function revisarPendientesAprobacion({ forzar = false, soloPrevisualizar = false } = {}) {
    if (!hayCorreo) return { estado: 'sin correo configurado' };

    // Con la planilla cerrada (040) la aprobacion es de la app: el aviso queda
    // prendido sin tener que tocar la variable en Coolify.
    const { rows: corte } = await consultar('SELECT 1 FROM envases_corte');
    const activa = ACTIVOS || corte.length > 0;

    return correrUnaVezPorDia(
        TAREA,
        { hora: HORA, diaSemana: 1, forzar, activa },
        async () => {
            const reloj = await relojLocal();
            const filas = await pendientes();
            const aprobados = await aprobadosRecientes();
            const conteo = await diagnostico();
            const atrasados = (await pendientesLcc()).flatMap((g) => g.envases.map((p) => ({ ...p, tipo: g.tipo })));

            // Antonella: la lista para aprobar, solo si hay algo pendiente.
            // Claudia: el resumen, si hay algo que contar (pendiente, aprobado o atrasado).
            const paraLista = filas.length ? await supervisoresDe(RECURSO, NOTIFICACION) : [];
            const hayResumen = filas.length || aprobados.length || atrasados.length;
            const resumenTodos = hayResumen ? await supervisoresDe(RECURSO, 'resumen-aprobaciones') : [];
            const paraResumen = resumenTodos.filter((d) => !paraLista.includes(d));

            const asuntoLista = `[Calidad] ${filas.length} control${filas.length === 1 ? '' : 'es'} LCC pendiente${filas.length === 1 ? '' : 's'} de aprobación`;
            const asuntoResumen = `[Calidad] Envases LCC: ${filas.length} pendiente${filas.length === 1 ? '' : 's'} de aprobar` +
                (atrasados.length ? `, ${atrasados.length} por hacer` : '');

            if (soloPrevisualizar) {
                return {
                    modo: 'previsualizacion', hoy: comoDia(reloj.hoy), conteo, activa,
                    pendientes: filas.length, aprobados: aprobados.length, correos: 0,
                    listaOperativa: {
                        asunto: asuntoLista, para: paraLista,
                        esperando: filas.map((f) =>
                            `${f.tipo} · ${f.envase || '—'} · ${comoDia(f.fecha)} · ${f.analista || '—'} · ${f.dias}d`),
                    },
                    resumenDeEstado: {
                        asunto: asuntoResumen, para: paraResumen,
                        porHacer: atrasados.map((p) => `${p.tipo} · ${p.envase} · último ${p.ultimo || '—'}`),
                    },
                };
            }

            let enviados = 0;
            if (paraLista.length) {
                try {
                    await enviar({ para: paraLista, asunto: asuntoLista,
                                   html: cuerpo(filas, aprobados), texto: asuntoLista });
                    enviados++;
                } catch (err) {
                    console.error('[avisos:envases] lista operativa fallo:', err.message);
                }
            }
            if (paraResumen.length) {
                try {
                    await enviar({ para: paraResumen, asunto: asuntoResumen,
                                   html: cuerpoResumen(filas, aprobados, atrasados), texto: asuntoResumen });
                    enviados++;
                } catch (err) {
                    // Que falle el resumen no puede llevarse puesto el operativo.
                    console.error('[avisos:envases] resumen fallo:', err.message);
                }
            }
            return { conteo, pendientes: filas.length, aprobados: aprobados.length, porHacer: atrasados.length,
                     correos: enviados,
                     detalle: `${filas.length} pendiente(s), ${aprobados.length} aprobado(s), ${atrasados.length} por hacer, ${enviados} correo(s)` };
        }
    );
}

export function configEnvases() {
    return { activos: ACTIVOS, hora: HORA, dia: 'lunes', base: BASE };
}
