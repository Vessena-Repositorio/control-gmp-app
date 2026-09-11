/**
 * Avisos programados de Capacitaciones.
 *
 * Reemplaza a `sendDailyReminders` y `checkPendingInductions` del Apps Script:
 * los avisos 09, 10 y 12 del inventario, mas el 13, que es nuevo. El 11 lo
 * dispara una persona desde la app, asi que llega con el corte de escritura.
 *
 * Textos y asuntos de los migrados, replicados tal cual.
 *
 * Los recordatorios previos disparan solo si faltan EXACTAMENTE 7 o 1 dias,
 * igual que hoy: si un dia no corre, ese recordatorio no sale, porque al dia
 * siguiente la cuenta ya no da 7 ni 1. Arreglarlo pide registrar que item ya fue
 * avisado y cambia el comportamiento ante una falla, asi que se dejo como esta.
 *
 * El aviso 13 lo amortigua sin cambiar nada de eso: la capacitacion que se
 * paso de fecha ahora avisa igual, todos los dias, aunque se hayan perdido los
 * dos recordatorios previos. Antes ese caso terminaba en silencio.
 */
import { hayCorreo, enviar } from './correo.js';
import { supervisoresDe, unir } from './destinatarios.js';
import { correrUnaVezPorDia, coleccionCapacitaciones, relojLocal, comoDia } from './tareas.js';

const RECURSO = 'capacitaciones';
const TAREA_PLAN = 'avisos_capacitaciones_plan';
const TAREA_INDUCCIONES = 'avisos_capacitaciones_inducciones';

const HORA = Number(process.env.AVISOS_CAPACITACIONES_HORA ?? 8);
const ACTIVOS = ['1', 'true', 'si'].includes(
    String(process.env.AVISOS_CAPACITACIONES_ACTIVOS || '').toLowerCase()
);

const NAV = '#1a3352';
const MESES = ['Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'];
const MODULOS_INDUCCION = ['REGLAMENTO', 'INDUCCION GMP', 'INDUCCION SEGURIDAD/SALUD'];
const NOMBRE_MODULO = {
    'REGLAMENTO': 'Reglamento',
    'INDUCCION GMP': 'Inducción GMP',
    'INDUCCION SEGURIDAD/SALUD': 'Inducción Seg./Salud',
};

/**
 * Que modulos de induccion cubre un registro. Mira el TEMA y la DESCRIPCION.
 *
 * Los 3.130 registros historicos usan una taxonomia vieja: el reglamento esta
 * descrito en `desc` con el tema puesto como PROCEDIMIENTO u OTRO. Clasificando
 * solo por tema quedaban afuera 94 registros de reglamento.
 *
 * El tema SEGURIDAD/SALUD por si solo NO cuenta: agrupa charlas corrientes
 * -simulacros, extintores, ergonomia- que no son la induccion de ingreso.
 * Contarlas daba 7 personas como completas sin estarlo.
 *
 * Tiene que coincidir con `modulosDeRegistro` de capacitaciones_vessena.html:
 * si divergen, la pantalla y el correo vuelven a decir cosas distintas sobre el
 * mismo dato, que es el problema que ya tuvimos con el limite de un anio.
 */
function normTxt(s) {
    return String(s == null ? '' : s).toUpperCase()
        .replace(/[ÁÀÄÂ]/g, 'A').replace(/[ÉÈËÊ]/g, 'E').replace(/[ÍÌÏÎ]/g, 'I')
        .replace(/[ÓÒÖÔ]/g, 'O').replace(/[ÚÙÜÛ]/g, 'U').replace(/Ñ/g, 'N');
}

function modulosDeRegistro(r) {
    if (!r) return [];
    const t = normTxt(r.tema).trim();
    const d = normTxt(r.desc);
    const m = [];
    if (t === 'REGLAMENTO' || /REGLAMENTO/.test(d)) m.push('REGLAMENTO');
    if (t === 'INDUCCION GMP' || t === 'MANUAL INDUCION'
        || /INDUCCION GMP|MANUAL DE INDUCCION|MANUAK DE INDUCCION|CONCEPTOS GMP|GMP MANTENIMIENTO|INDUCCINON GMP/.test(d))
        m.push('INDUCCION GMP');
    if (t === 'INDUCCION SEGURIDAD/SALUD'
        || /INDUCCION SEGURIDAD|INDUCCION DE SEGURIDAD|INDUCCION SYSO|SYSO/.test(d))
        m.push('INDUCCION SEGURIDAD/SALUD');
    return m;
}

function esc(s) {
    return String(s ?? '').replace(/[&<>"]/g, (c) =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

/** Diferencia en dias entre dos 'AAAA-MM-DD', sin que la zona horaria la corra. */
function diasEntre(desde, hasta) {
    const a = Date.parse(desde + 'T12:00:00Z');
    const b = Date.parse(hasta + 'T12:00:00Z');
    if (Number.isNaN(a) || Number.isNaN(b)) return null;
    return Math.round((b - a) / 86400000);
}

// ---------------------------------------------------------------------------
// 09 y 10 — recordatorios del plan
// ---------------------------------------------------------------------------

function cuerpoRecordatorio(p, dias) {
    let urgencia, color;
    if (dias === 1)      { urgencia = 'MAÑANA';  color = '#dc2626'; }
    else if (dias === 0) { urgencia = 'HOY';     color = '#dc2626'; }
    else if (dias > 0)   { urgencia = `en ${dias} días`; color = '#d97706'; }
    else if (dias < 0)   { urgencia = `atrasada (${Math.abs(dias)} días)`; color = '#dc2626'; }
    // Sin fecha programada -recordatorio manual de una partida que solo tiene
    // mes- no se inventa una urgencia: se dice lo que hay.
    else                 { urgencia = 'según lo planificado'; color = NAV; }

    const dirigido = String(p.d || '')
        .replace(/\|/g, ', ').replace(/TODOS:/g, '').replace(/:/g, ' · ') || '—';
    const meses = p.m
        ? String(p.m).split(',').filter(Boolean).map((mi) => MESES[parseInt(mi, 10) - 1] || mi).join(', ')
        : '—';
    const fila = (etiqueta, valor) =>
        `<div style="font-size:12px;margin:4px 0"><b>${etiqueta}:</b> ${esc(valor)}</div>`;

    return `<div style="font-family:Arial,Helvetica,sans-serif;background:#f5f5f5;padding:20px">` +
      `<div style="max-width:600px;margin:auto">` +
        `<div style="background:${NAV};color:#fff;padding:22px 24px;border-radius:8px 8px 0 0">` +
          `<div style="font-size:20px;font-weight:800">Vessena S.A. — Capacitaciones</div>` +
          `<div style="font-size:12px;opacity:.85;margin-top:2px">Recordatorio automático · REG-SOP-AC-039-D</div>` +
        `</div>` +
        `<div style="background:#fff;padding:24px;border-radius:0 0 8px 8px">` +
          `<p style="margin:0 0 12px 0">Hola <b>${esc(p.resp || '')}</b>,</p>` +
          `<p style="margin:0 0 12px 0">Te recordamos que sos responsable de la siguiente ` +
          `capacitación, programada <b style="color:${color}">${urgencia}</b>` +
          `${p.fp ? ` (${esc(p.fp)})` : ''}:</p>` +
          `<div style="background:#f9fafb;border-left:4px solid ${NAV};padding:16px 18px;margin:16px 0;border-radius:0 6px 6px 0">` +
            `<div style="font-size:16px;font-weight:800;color:${NAV};margin-bottom:8px">${esc(p.t || '—')}</div>` +
            (p.o ? fila('Objetivo', p.o) : '') +
            (p.dc ? fila('Código doc', p.dc) : '') +
            fila('Dirigido a', dirigido) +
            (p.persEst ? fila('Personas estimadas', p.persEst) : '') +
            (p.h ? fila('Duración', `${p.h} hs`) : '') +
            (p.ev ? fila('Evaluación', p.ev) : '') +
            fila('Mes planificado', meses) +
            (p.fp ? fila('Fecha programada', p.fp) : '') +
          `</div>` +
          `<p style="margin:12px 0;font-size:13px">Al finalizar la capacitación, cargá la ` +
          `asistencia en la app de <b>Registro</b>.</p>` +
          `<p style="margin:12px 0 0 0;font-size:11px;color:#666;border-top:1px solid #e5e7eb;padding-top:12px">` +
            `Este es un email automático enviado por el sistema de capacitaciones de Vessena.<br>` +
            `Si no sos vos el responsable, avisá a Dirección Técnica.` +
          `</p>` +
        `</div></div></div>`;
}

/**
 * Aviso 13 — capacitaciones atrasadas. NUEVO: no existia en el Apps Script.
 *
 * Es un resumen por persona y no un correo por capacitacion: alguien con cuatro
 * atrasadas recibe uno, no cuatro. Y se repite todos los dias mientras siga
 * atrasada, siguiendo el criterio de estabilidad, que es el unico de los tres
 * scripts que no pierde avisos.
 */
function cuerpoAtrasadas(items) {
    const celda = 'padding:8px 10px;border:1px solid #e5e7eb';
    const filas = items.map(({ p, dias }) => {
        const color = dias >= 30 ? '#dc2626' : dias >= 8 ? '#d97706' : '#92400e';
        return `<tr>` +
            `<td style="${celda}"><b>${esc(p.t || '—')}</b></td>` +
            `<td style="${celda}">${esc(p.dc || '—')}</td>` +
            `<td style="${celda}">${esc(comoDia(p.fp))}</td>` +
            `<td style="${celda};color:${color};font-weight:800">${dias}</td>` +
        `</tr>`;
    }).join('');
    const th = (t, al) => `<th style="padding:8px 10px;text-align:${al};border:1px solid ${NAV}">${t}</th>`;
    const plural = items.length === 1 ? '' : 'es';

    return `<div style="font-family:Arial,Helvetica,sans-serif;background:#f5f5f5;padding:20px">` +
      `<div style="max-width:700px;margin:auto">` +
        `<div style="background:${NAV};color:#fff;padding:22px 24px;border-radius:8px 8px 0 0">` +
          `<div style="font-size:20px;font-weight:800">Vessena S.A. — Capacitaciones atrasadas</div>` +
          `<div style="font-size:12px;opacity:.85;margin-top:2px">Recordatorio automático · REG-SOP-AC-039-D</div>` +
        `</div>` +
        `<div style="background:#fff;padding:24px;border-radius:0 0 8px 8px">` +
          `<p style="margin:0 0 12px 0">Hola,</p>` +
          `<p style="margin:0 0 12px 0">Sos responsable de <b style="color:#dc2626">` +
          `${items.length} capacitación${plural}</b> cuya fecha programada ya pasó:</p>` +
          `<table style="width:100%;border-collapse:collapse;font-size:12px;margin:12px 0">` +
            `<thead style="background:${NAV};color:#fff"><tr>` +
              th('Tema','left') + th('Código doc','left') + th('Fecha programada','left') +
              th('Días de atraso','center') +
            `</tr></thead><tbody>${filas}</tbody></table>` +
          `<p style="margin:12px 0;font-size:13px">Si ya se dictó, cargá la asistencia en la app ` +
          `de <b>Registro</b>. Si se reprograma o se suspende, actualizá el plan para que deje de ` +
          `figurar como atrasada.</p>` +
          `<p style="margin:12px 0 0 0;font-size:11px;color:#666;border-top:1px solid #e5e7eb;padding-top:12px">` +
            `Este recordatorio se envía todos los días hasta que la capacitación se cargue, ` +
            `se reprograme o se suspenda.` +
          `</p>` +
        `</div></div></div>`;
}

/**
 * Aviso 11 — el recordatorio que una persona manda a mano desde la app.
 *
 * Antes lo mandaba el Apps Script (`sendReminderNow`) leyendo la planilla, que
 * desde el corte del 10/09/2026 quedo congelada: una partida reprogramada, una
 * ronda nueva o un email corregido en la app no llegaban al correo, que salia
 * con los datos viejos o no salia.
 *
 * El destinatario sale del plan guardado, NUNCA del pedido. Asi esta ruta no se
 * puede usar para mandar un correo a cualquiera firmado como Vessena: lo mas que
 * permite es recordarle su capacitacion al responsable que figura en el plan.
 */
export async function enviarRecordatorioManual(id) {
    if (!hayCorreo) return { ok: false, error: 'el servidor no tiene correo configurado' };
    const plan = await coleccionCapacitaciones('PL');
    const p = plan.find((x) => x && Number(x.id) === Number(id));
    if (!p) return { ok: false, error: 'no existe esa capacitacion en el plan' };
    const para = String(p.email || '').trim().toLowerCase();
    if (!para.includes('@')) return { ok: false, error: 'la capacitacion no tiene email de responsable' };

    // Sin fecha programada no hay cuenta regresiva que hacer: el cuerpo lo dice
    // como "segun lo planificado" en vez de inventar una urgencia.
    let dias = null;
    if (p.fp) {
        const reloj = await relojLocal();
        dias = diasEntre(comoDia(reloj.hoy), comoDia(p.fp));
    }
    const asunto = dias === 1 ? `⏰ MAÑANA: capacitación — ${p.t}`
                 : (dias !== null && dias < 0) ? `⚠ ATRASADA: capacitación — ${p.t}`
                 : `📅 Recordatorio: capacitación — ${p.t}`;
    await enviar({ para: [para], asunto, html: cuerpoRecordatorio(p, dias), texto: asunto });
    return { ok: true, to: para, subject: asunto };
}

export async function revisarRecordatoriosPlan({ forzar = false, soloPrevisualizar = false } = {}) {
    if (!hayCorreo) return { estado: 'sin correo configurado' };

    return correrUnaVezPorDia(TAREA_PLAN, { hora: HORA, forzar, activa: ACTIVOS }, async () => {
        const reloj = await relojLocal();
        const hoy = comoDia(reloj.hoy);
        const plan = await coleccionCapacitaciones('PL');

        // Escalamiento opcional del aviso de atrasadas: si alguien se carga en
        // notificacion_supervisores para 'atrasadas', recibe copia. Vacio por
        // defecto, asi que hoy solo le llega al responsable.
        const escalan = await supervisoresDe(RECURSO, 'atrasadas');

        const planeados = [];
        const atrasadasPorPersona = new Map();

        for (const p of plan) {
            if (!p) continue;
            if (['cumplida', 'suspendida', 'reprogramada'].includes(p.e)) continue;
            if (!p.email || !String(p.email).includes('@')) continue;
            if (!p.fp) continue;

            const dias = diasEntre(hoy, comoDia(p.fp));
            if (dias === null) continue;

            if (dias === 7 || dias === 1) {
                planeados.push({
                    para: [String(p.email).trim().toLowerCase()],
                    asunto: dias === 1
                        ? `⏰ MAÑANA: capacitación — ${p.t}`
                        : `📅 Recordatorio: capacitación en 7 días — ${p.t}`,
                    html: cuerpoRecordatorio(p, dias),
                    dias,
                });
                continue;
            }

            // Aviso 13: la fecha ya paso y el item sigue abierto.
            if (dias < 0) {
                const correo = String(p.email).trim().toLowerCase();
                if (!atrasadasPorPersona.has(correo)) atrasadasPorPersona.set(correo, []);
                atrasadasPorPersona.get(correo).push({ p, dias: Math.abs(dias) });
            }
        }

        for (const [correo, items] of atrasadasPorPersona) {
            items.sort((a, b) => b.dias - a.dias);
            // Con una sola se reusa la ficha del recordatorio, que ya contempla
            // el caso atrasado; con varias, la tabla resumen.
            const unica = items.length === 1;
            planeados.push({
                para: unir(correo, escalan),
                asunto: unica
                    ? `⚠ ATRASADA: capacitación — ${items[0].p.t}`
                    : `⚠ ${items.length} capacitaciones atrasadas`,
                html: unica ? cuerpoRecordatorio(items[0].p, -items[0].dias) : cuerpoAtrasadas(items),
                dias: -items[0].dias,
            });
        }

        if (soloPrevisualizar) {
            // Mismo criterio que en estabilidad: que la previsualizacion pueda
            // explicar por que NO sale nada, no solo que sale.
            const cerrados = plan.filter((p) => ['cumplida', 'suspendida', 'reprogramada'].includes(p?.e)).length;
            return {
                modo: 'previsualizacion',
                itemsRevisados: plan.length,
                hoy,
                conteo: {
                    cerrados,
                    sinEmail: plan.filter((p) => p && !String(p.email || '').includes('@')).length,
                    sinFecha: plan.filter((p) => p && !p.fp).length,
                    atrasados: [...atrasadasPorPersona.values()].reduce((n, x) => n + x.length, 0),
                },
                correos: 0,
                saldrian: planeados.map((x) => ({ asunto: x.asunto, para: x.para, dias: x.dias })),
            };
        }

        let enviados = 0;
        for (const x of planeados) {
            try {
                await enviar({ para: x.para, asunto: x.asunto, html: x.html, texto: x.asunto });
                enviados++;
            } catch (err) {
                console.error('[avisos:capacitaciones] recordatorio fallo:', err.message);
            }
        }
        console.log(`[avisos:capacitaciones] plan: ${enviados}/${planeados.length}`);
        return {
            itemsRevisados: plan.length,
            correos: enviados,
            detalle: `${enviados} de ${planeados.length} recordatorio(s)`,
        };
    });
}

// ---------------------------------------------------------------------------
// 12 — inducciones pendientes, los lunes
// ---------------------------------------------------------------------------

function cuerpoInducciones(pendientes) {
    const filas = pendientes.map((p) => {
        const fondo = p.dias >= 60 ? '#fef2f2' : p.dias >= 45 ? '#fffbeb' : '#fff';
        const color = p.dias >= 60 ? '#dc2626' : p.dias >= 45 ? '#d97706' : '#92400e';
        const celda = 'padding:8px 10px;border:1px solid #e5e7eb';
        const nombra = (m) => NOMBRE_MODULO[m] || m;
        return `<tr style="background:${fondo}">` +
            `<td style="${celda}"><b>${esc(p.nombre)}</b></td>` +
            `<td style="${celda}">${esc(p.sector)}</td>` +
            `<td style="${celda}">${esc(p.fechaAlta)}</td>` +
            `<td style="${celda};color:${color};font-weight:800">${p.dias}</td>` +
            `<td style="${celda};font-size:11px;color:#059669">` +
              `${p.tiene.length ? esc(p.tiene.map(nombra).join(', ')) : '<i>ninguno</i>'}</td>` +
            `<td style="${celda};font-size:11px;color:#dc2626;font-weight:700">` +
              `${esc(p.falta.map(nombra).join(' + '))}</td>` +
        `</tr>`;
    }).join('');

    const th = (t, al) => `<th style="padding:8px 10px;text-align:${al};border:1px solid ${NAV}">${t}</th>`;
    const plural = pendientes.length === 1 ? '' : 's';

    return `<div style="font-family:Arial,Helvetica,sans-serif;background:#f5f5f5;padding:20px">` +
      `<div style="max-width:800px;margin:auto">` +
        `<div style="background:${NAV};color:#fff;padding:22px 24px;border-radius:8px 8px 0 0">` +
          `<div style="font-size:20px;font-weight:800">Vessena S.A. — Nuevos ingresos con inducción pendiente</div>` +
          `<div style="font-size:12px;opacity:.85;margin-top:2px">Reporte semanal · REG-SOP-AC-039-D</div>` +
        `</div>` +
        `<div style="background:#fff;padding:24px;border-radius:0 0 8px 8px">` +
          `<p style="margin:0 0 12px 0">Hola,</p>` +
          `<p style="margin:0 0 12px 0">Detectamos <b style="color:#dc2626">${pendientes.length} ` +
          `persona${plural}</b> activa${plural} con más de 30 días de antigüedad que todavía no ` +
          `completaron todos los módulos de inducción (Reglamento + Inducción GMP + Inducción ` +
          `Seguridad/Salud):</p>` +
          `<table style="width:100%;border-collapse:collapse;font-size:12px;margin:12px 0">` +
            `<thead style="background:${NAV};color:#fff"><tr>` +
              th('Nombre','left') + th('Sector','left') + th('Alta','left') +
              th('Días','center') + th('Tiene','left') + th('Falta','left') +
            `</tr></thead><tbody>${filas}</tbody></table>` +
          `<p style="font-size:12px;color:#666;margin-top:16px"><b>Código de colores por ` +
          `antigüedad:</b> naranja 30-45 días · amarillo 45-60 días · rojo +60 días.</p>` +
          `<p style="margin:12px 0;font-size:13px">Coordinar las inducciones faltantes y cargarlas ` +
          `en el sistema.</p>` +
          `<p style="margin:12px 0 0 0;font-size:11px;color:#666;border-top:1px solid #e5e7eb;padding-top:12px">` +
            `Este es un email automático semanal del sistema de capacitaciones de Vessena.<br>` +
            `Cuando todos los ingresos estén al día, deja de enviarse.` +
          `</p>` +
        `</div></div></div>`;
}

export async function revisarInduccionesPendientes({ forzar = false, soloPrevisualizar = false } = {}) {
    if (!hayCorreo) return { estado: 'sin correo configurado' };

    return correrUnaVezPorDia(
        TAREA_INDUCCIONES,
        { hora: HORA, diaSemana: 1, forzar, activa: ACTIVOS },
        async () => {
            const reloj = await relojLocal();
            const hoy = comoDia(reloj.hoy);
            const [personal, registros] = await Promise.all([
                coleccionCapacitaciones('PE'),
                coleccionCapacitaciones('R'),
            ]);

            // Indice de quien hizo que modulo de induccion, por nombre en
            // mayusculas: es la unica llave que comparten las dos colecciones.
            // Se guarda tambien la fecha del primer registro de cada uno, que
            // es lo que permite detectar una fecha de alta que no es el ingreso
            // real (ver ANTES_DEL_SISTEMA mas abajo).
            const hechos = new Map();
            const primerRegistro = new Map();
            for (const r of registros) {
                const nom = String(r.nom || '').toUpperCase().trim();
                if (!nom) continue;
                const f = String(r.fecha || '').slice(0, 10);
                if (f && (!primerRegistro.has(nom) || f < primerRegistro.get(nom))) {
                    primerRegistro.set(nom, f);
                }
                const mods = modulosDeRegistro(r);
                if (!mods.length) continue;
                if (!hechos.has(nom)) hechos.set(nom, new Set());
                for (const m of mods) hechos.get(nom).add(m);
            }
            // El aviso es sobre INGRESOS: gente que entro hace poco y todavia no
            // completo la induccion. La pantalla de la app ya excluye a quien
            // tiene mas de un año -"para no llenar de gente vieja"- y este correo
            // no lo hacia, asi que reportaba a alguien con siete años de casa
            // como si fuera un ingreso pendiente. Las dos reglas ahora coinciden.
            const DIAS_MAXIMO = 365;

            // Los registros arrancan en 2020. La induccion de quien ya trabajaba
            // antes ocurrio y quedo en papel, pero no esta en ninguna planilla y
            // nunca va a estarlo. Se los deja fuera del control, no como
            // cumplidos: la app no sabe si la hicieron, sabe que no puede saberlo.
            //
            // Tiene que coincidir con INICIO_REGISTROS / indFueraDeAlcance() de
            // capacitaciones_vessena.html. Si el correo y la pantalla usaran
            // reglas distintas, volveriamos al problema de siempre: dos numeros
            // sobre lo mismo que no cierran.
            const ANTES_DEL_SISTEMA = '2020-01-01';

            const pendientes = [];
            let sinFechaAlta = 0;
            let veteranosSinInduccion = 0;
            let antesDelSistema = 0;

            for (const p of personal) {
                if (!p || p.a === false) continue;

                // Sin fecha de alta no se puede saber si es un ingreso reciente.
                // Se cuentan aparte: son gente que este control NO esta mirando,
                // y conviene que eso se vea en vez de desaparecer.
                if (!p.fechaAlta) { sinFechaAlta++; continue; }

                const nom = String(p.n || '').toUpperCase().trim();
                const alta = String(comoDia(p.fechaAlta) || '').slice(0, 10);
                const primero = primerRegistro.get(nom) || '';

                // Dos señales de que la persona es anterior al sistema: el alta
                // es previa a 2020, o tiene registros ANTERIORES a su propia
                // fecha de alta -o sea que esa fecha no es su ingreso real, que
                // es lo que pasa cuando alguien cambia de sector y la ficha toma
                // la fecha del cambio-.
                if (alta && (alta < ANTES_DEL_SISTEMA || (primero && primero < alta))) {
                    antesDelSistema++;
                    continue;
                }

                const dias = diasEntre(comoDia(p.fechaAlta), hoy);
                if (dias === null || dias < 30) continue;

                const tiene = hechos.get(nom) || new Set();
                const falta = MODULOS_INDUCCION.filter((m) => !tiene.has(m));
                if (!falta.length) continue;

                // Le falta induccion pero no es un ingreso: es una brecha
                // historica, y mezclarla con los ingresos recientes hace que el
                // aviso pierda el sentido de urgencia que tiene.
                if (dias > DIAS_MAXIMO) { veteranosSinInduccion++; continue; }

                pendientes.push({
                    nombre: p.n, sector: p.s || '(sin sector)',
                    fechaAlta: comoDia(p.fechaAlta), dias,
                    tiene: [...tiene], falta,
                });
            }
            pendientes.sort((a, b) => b.dias - a.dias);

            // Lo que este control NO esta mirando, visible siempre. Sin esto, un
            // "0 pendientes" puede significar que esta todo al dia o que casi
            // nadie tiene fecha de alta cargada, y no habria forma de saberlo.
            const noEvaluados = { sinFechaAlta, veteranosSinInduccion, antesDelSistema };

            // Sin pendientes no manda nada: no tiene sentido un correo semanal
            // que diga que todo esta bien.
            if (!pendientes.length) {
                return { revisados: personal.length, pendientes: 0, correos: 0,
                         noEvaluados, detalle: 'sin ingresos recientes con induccion pendiente' };
            }

            const para = await supervisoresDe(RECURSO, 'inducciones-pendientes');
            const plural = pendientes.length === 1 ? '' : 's';
            const asunto = `⚠️ ${pendientes.length} nuevo${plural} ingreso${plural} con inducción pendiente`;

            if (soloPrevisualizar) {
                return {
                    modo: 'previsualizacion', revisados: personal.length,
                    pendientes: pendientes.length, correos: 0, noEvaluados,
                    saldrian: [{ asunto, para, personas: pendientes.map((x) => `${x.nombre} (${x.dias}d)`) }],
                };
            }
            if (!para.length) {
                return { revisados: personal.length, pendientes: pendientes.length, correos: 0,
                         noEvaluados, detalle: 'sin supervisores cargados' };
            }

            let enviados = 0;
            try {
                await enviar({ para, asunto, html: cuerpoInducciones(pendientes), texto: asunto });
                enviados = 1;
            } catch (err) {
                console.error('[avisos:capacitaciones] inducciones fallo:', err.message);
            }
            return {
                revisados: personal.length, pendientes: pendientes.length, correos: enviados,
                noEvaluados,
                detalle: `${pendientes.length} pendiente(s), ${enviados} correo(s); no evaluados: ${sinFechaAlta} sin fecha de alta, ${veteranosSinInduccion} con mas de un año, ${antesDelSistema} anteriores a los registros`,
            };
        }
    );
}

export function configCapacitaciones() {
    return { activos: ACTIVOS, hora: HORA, diaInducciones: 'lunes' };
}
