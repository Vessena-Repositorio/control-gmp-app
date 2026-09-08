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
                o.numero_orden AS orden,
                ((now() AT TIME ZONE $1)::date - c.fecha) AS dias
         FROM controles c
         LEFT JOIN ordenes o ON o.id = c.orden_id
         WHERE c.tipo IN ('semanal', 'quincenal')
           AND c.raw -> 'mediciones' ->> '_estado' = 'completo'
           AND coalesce(c.raw -> 'mediciones' ->> '_aprobado', 'pendiente') <> 'aprobado'
         ORDER BY c.fecha, c.tipo`,
        [ZONA]
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

function cuerpo(filas) {
    const celda = 'padding:8px 10px;border:1px solid #e5e7eb';
    const th = (t, al) => `<th style="padding:8px 10px;text-align:${al};border:1px solid ${NAV}">${t}</th>`;

    const cuerpoFilas = filas.map((f) => {
        const dias = Number(f.dias ?? 0);
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

    const plural = filas.length === 1 ? '' : 's';
    return `<div style="font-family:Arial,Helvetica,sans-serif;background:#f5f5f5;padding:20px">` +
      `<div style="max-width:820px;margin:auto">` +
        `<div style="background:${NAV};color:#fff;padding:22px 24px;border-radius:8px 8px 0 0">` +
          `<div style="font-size:20px;font-weight:800">Vessena S.A. — Análisis pendientes de aprobación</div>` +
          `<div style="font-size:12px;opacity:.85;margin-top:2px">Control de calidad de envases · SOP-PR-138</div>` +
        `</div>` +
        `<div style="background:#fff;padding:24px;border-radius:0 0 8px 8px">` +
          `<p style="margin:0 0 12px 0">Hola,</p>` +
          `<p style="margin:0 0 12px 0">Hay <b style="color:#dc2626">${filas.length} análisis</b> ` +
          `terminado${plural} por las analistas que sigue${plural === '' ? '' : 'n'} esperando aprobación:</p>` +
          `<table style="width:100%;border-collapse:collapse;font-size:12px;margin:12px 0">` +
            `<thead style="background:${NAV};color:#fff"><tr>` +
              th('Tipo', 'left') + th('Envase', 'left') + th('Orden', 'left') +
              th('Fecha', 'left') + th('Analista', 'left') + th('Días esperando', 'center') +
            `</tr></thead><tbody>${cuerpoFilas}</tbody></table>` +
          `<p style="font-size:12px;color:#666;margin-top:14px">Naranja: más de una semana esperando · Rojo: más de dos.</p>` +
          `<p style="margin:14px 0"><a href="${BASE}/control-calidad-envases.html" ` +
          `style="display:inline-block;padding:10px 20px;background:#0E6B67;color:#fff;` +
          `text-decoration:none;border-radius:6px;font-weight:bold">Abrir para aprobar →</a></p>` +
          `<p style="margin:12px 0 0 0;font-size:11px;color:#666;border-top:1px solid #e5e7eb;padding-top:12px">` +
            `Este aviso sale los lunes y solo cuando hay algo pendiente.` +
          `</p>` +
        `</div></div></div>`;
}

/**
 * Corre el aviso si corresponde. Lunes, una vez por semana.
 * `soloPrevisualizar` arma todo y no manda: devuelve que saldria y a quien.
 */
export async function revisarPendientesAprobacion({ forzar = false, soloPrevisualizar = false } = {}) {
    if (!hayCorreo) return { estado: 'sin correo configurado' };

    return correrUnaVezPorDia(
        TAREA,
        { hora: HORA, diaSemana: 1, forzar, activa: ACTIVOS },
        async () => {
            const reloj = await relojLocal();
            const filas = await pendientes();
            const conteo = await diagnostico();

            // Sin pendientes no se manda nada: un correo semanal que dice que
            // esta todo bien se deja de leer, y despues no se lee el que importa.
            if (!filas.length) {
                return { hoy: comoDia(reloj.hoy), conteo, pendientes: 0, correos: 0,
                         detalle: 'sin pendientes de aprobacion' };
            }

            const para = await supervisoresDe(RECURSO, NOTIFICACION);
            const plural = filas.length === 1 ? '' : 's';
            const asunto = `[Calidad] ${filas.length} análisis pendiente${plural} de aprobación`;

            if (soloPrevisualizar) {
                return {
                    modo: 'previsualizacion', hoy: comoDia(reloj.hoy), conteo,
                    pendientes: filas.length, correos: 0,
                    saldria: {
                        asunto, para,
                        detalle: filas.map((f) =>
                            `${f.tipo} · ${f.envase || '—'} · ${comoDia(f.fecha)} · ${f.analista || '—'} · ${f.dias}d`),
                    },
                };
            }
            if (!para.length) {
                return { hoy: comoDia(reloj.hoy), conteo, pendientes: filas.length, correos: 0,
                         detalle: 'sin destinatarios cargados' };
            }

            let enviados = 0;
            try {
                await enviar({ para, asunto, html: cuerpo(filas), texto: asunto });
                enviados = 1;
            } catch (err) {
                console.error('[avisos:envases] fallo:', err.message);
            }
            return { conteo, pendientes: filas.length, correos: enviados,
                     detalle: `${filas.length} pendiente(s), ${enviados} correo(s)` };
        }
    );
}

export function configEnvases() {
    return { activos: ACTIVOS, hora: HORA, dia: 'lunes', base: BASE };
}
