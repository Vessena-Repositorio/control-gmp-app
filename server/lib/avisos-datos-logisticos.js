/**
 * Los correos de Datos Logisticos PT.
 *
 * El circuito que pidio Claudia (16/10/2026):
 *
 *   1. Gloria arma la ficha del producto con los datos de Antonella y la manda
 *      a revisar.
 *   2. Antonella -o Claudia- la aprueba. Ahi sale sola a Finanzas (Marianela),
 *      con la ficha de alta adjunta, que es lo que ella carga en iDempiere.
 *      Si la ficha cambia despues de haber salido, al aprobarse de nuevo le
 *      llega como actualizacion, con el detalle de que cambio.
 *   3. Cuando el producto tiene la ficha aprobada, el certificado MSP y la
 *      ficha de seguridad, sale el aviso a Ventas y Logistica con los tres
 *      adjuntos: ya tienen todo para cargar los datos.
 *
 * Ademas, un mes antes de que venza una habilitacion MSP se le avisa a Claudia
 * (notificacion 'vencimientos').
 *
 * Los tres correos salen del servidor. En la app anterior eran un mailto que
 * alguien tenia que abrir y mandar a mano: si se olvidaban, no salia nada.
 */
import { consultar } from '../db.js';
import { hayCorreo, enviar } from './correo.js';
import { supervisoresDe } from './destinatarios.js';
import { ZONA, correrUnaVezPorDia } from './tareas.js';
import { leer as leerArchivo } from './almacen-documentos.js';

const BASE = (process.env.URL_PUBLICA || 'http://192.168.30.15:3000').replace(/\/+$/, '');
const PAGINA = '/datos-logisticos.html';

/** Dias antes del vencimiento en que se avisa (Claudia: un mes). */
export const DIAS_AVISO_MSP = Number(process.env.DL_DIAS_AVISO_MSP ?? 30);

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const fecha = (f) => (f ? new Date(f).toLocaleDateString('es-UY', { timeZone: ZONA }) : '');

async function mandar(para, asunto, html, texto, adjuntos = []) {
    if (!hayCorreo || !para.length) return false;
    try {
        await enviar({ para, asunto, html, texto, adjuntos });
        return true;
    } catch (err) {
        console.error('[datos-logisticos] no se pudo mandar el correo:', err.message);
        return false;
    }
}

/* ═══════════════════════════════════════════════════════════════════════════
   La ficha, en texto: lo mismo que va en el correo y lo que se compara para
   saber que cambio entre un envio y el siguiente.
   ═══════════════════════════════════════════════════════════════════════════ */

const medida = (l, a, h) => ([l, a, h].some((v) => v != null) ? `${l ?? '—'} x ${a ?? '—'} x ${h ?? '—'} cm` : null);

/** Los datos del alta, con la etiqueta con la que se leen en el correo. */
export function camposFicha(p) {
    const c = {
        'SKU': p.sku,
        'Descripción': p.descripcion,
        'Marca': p.marca,
        'Categoría de producto': p.categoria_producto,
        'Línea': p.linea,
        'Sublínea': p.sublinea,
        'Familia': p.familia,
        'Subfamilia': p.subfamilia,
        'Contenido neto': p.contenido != null ? `${p.contenido} ${p.contenido_um || ''}`.trim() : null,
        'Presentación': p.presentacion,
        'Origen': p.grupo,
        'Vida útil': p.vida_meses != null ? `${p.vida_meses} meses` : null,
        'EAN 13 (unidad)': p.ean,
        'DUN 14 (caja o funda)': p.dun,
        'Unidad de medida': p.um_base,
        'UM destino': p.um_destino,
        'Unidades por caja o funda': p.unidades_caja,
        'Código de caja o funda': p.cod_caja,
        'Peso de la unidad': p.peso_pt != null ? `${p.peso_pt} kg` : null,
        'Medidas de la unidad': medida(p.un_largo, p.un_ancho, p.un_alto),
        'Medidas de la caja o funda': medida(p.caja_largo, p.caja_ancho, p.caja_alto),
        'Cajas o fundas por piso': p.por_piso,
        'Estiba (pisos)': p.estiba,
        'Unidades por pallet': p.unidades_pallet,
        'Temperatura envase cerrado': p.temp_cerrado,
        'Temperatura envase abierto': p.temp_abierto,
        'Habilitación MSP': p.msp === true ? 'Sí' : p.msp === false ? 'No' : null,
        'Número de habilitación MSP': p.msp_numero,
        'Vence la habilitación MSP': p.msp_vence ? fecha(p.msp_vence) : null,
    };
    const limpio = {};
    for (const [k, v] of Object.entries(c)) limpio[k] = v == null || v === '' ? '' : String(v);
    return limpio;
}

/** Que cambio entre lo que se mando la vez pasada y lo que se manda ahora. */
export function cambiosDeFicha(antes, ahora) {
    if (!antes || typeof antes !== 'object') return [];
    const cambios = [];
    for (const [k, v] of Object.entries(ahora)) {
        const previo = antes[k] ?? '';
        if (String(previo) !== String(v)) cambios.push({ campo: k, antes: previo, ahora: v });
    }
    return cambios;
}

function tablaDatos(campos) {
    const fila = ([k, v]) => `<tr><td style="padding:3px 12px 3px 0;color:#475467;white-space:nowrap">${esc(k)}</td>` +
        `<td style="padding:3px 0"><b>${esc(v || '—')}</b></td></tr>`;
    return `<table style="font-size:14px;border-collapse:collapse">${Object.entries(campos).map(fila).join('')}</table>`;
}

function marco({ titulo, color, intro, cuerpo }) {
    return `<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;color:#101828;max-width:700px">
        <div style="background:${color};color:#fff;padding:14px 18px;border-radius:10px 10px 0 0">
          <div style="font-size:12px;opacity:.85;text-transform:uppercase;letter-spacing:1px">Vessena S.A. · Datos logísticos</div>
          <div style="font-size:19px;font-weight:700;margin-top:2px">${esc(titulo)}</div></div>
        <div style="border:1px solid #e4e7ec;border-top:0;border-radius:0 0 10px 10px;padding:14px 18px">
          <p style="margin:0 0 12px;font-size:14px">${intro}</p>
          ${cuerpo}
          <p style="margin:16px 0 0"><a href="${BASE}${PAGINA}" style="background:#0b5cff;color:#fff;text-decoration:none;padding:10px 16px;border-radius:8px;font-weight:600;display:inline-block">Abrir Datos logísticos</a></p>
        </div></div>`;
}

/* ═══════════════════════════════════════════════════════════════════════════
   Adjuntos
   ═══════════════════════════════════════════════════════════════════════════ */

/** Los documentos vigentes de un producto, listos para adjuntar. */
async function adjuntosDe(sku, tipos) {
    const { rows } = await consultar(
        `SELECT DISTINCT ON (tipo) tipo, nombre, ruta, mime
         FROM dl_documentos
         WHERE sku = $1 AND vigente AND tipo = ANY($2)
         ORDER BY tipo, subido_en DESC`,
        [sku, tipos]
    );
    const adjuntos = [];
    for (const d of rows) {
        try {
            adjuntos.push({ filename: d.nombre, content: await leerArchivo(d.ruta), contentType: d.mime || undefined });
        } catch (err) {
            console.error(`[datos-logisticos] no se pudo leer ${d.tipo} de ${sku}:`, err.message);
        }
    }
    return adjuntos;
}

async function productoDe(sku) {
    const { rows } = await consultar('SELECT * FROM dl_productos WHERE sku = $1', [sku]);
    return rows[0] || null;
}

/* ═══════════════════════════════════════════════════════════════════════════
   1 y 2. A Finanzas, cuando la ficha se aprueba
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Manda la ficha aprobada a Finanzas. `cambios` llega cuando ya se habia
 * mandado antes: entonces es una actualizacion y el correo dice que cambio,
 * para que Marianela sepa que tiene que rehacer en iDempiere.
 *
 * Devuelve lo que paso, que la ruta guarda en la bitacora.
 */
export async function avisarFinanzas(sku, { cambios = [], actualizacion = false } = {}) {
    const p = await productoDe(sku);
    if (!p) return { enviado: false, motivo: 'el producto no existe' };
    const para = await supervisoresDe('datos-logisticos', 'finanzas');
    if (!para.length) return { enviado: false, motivo: 'no hay destinatarios de Finanzas cargados' };

    const campos = camposFicha(p);
    const adjuntos = await adjuntosDe(sku, ['ficha']);
    const titulo = actualizacion
        ? `Actualización del producto ${p.sku}`
        : `Alta de producto ${p.sku}`;
    const intro = actualizacion
        ? `Cambiaron datos del SKU <b>${esc(p.sku)}</b>, que ya te habíamos mandado. Abajo va lo que cambió y la ficha corregida adjunta.`
        : 'Se aprobó la ficha de este producto para darlo de alta en iDempiere. La ficha va adjunta.';
    const lista = cambios.length
        ? `<div style="background:#fef0c7;border-radius:8px;padding:10px 12px;margin-bottom:12px;font-size:14px">
             <b>Lo que cambió</b><ul style="margin:6px 0 0;padding-left:18px">${cambios
            .map((c) => `<li>${esc(c.campo)}: <s style="color:#b42318">${esc(c.antes || '—')}</s> → <b>${esc(c.ahora || '—')}</b></li>`)
            .join('')}</ul></div>`
        : '';
    const pie = adjuntos.length
        ? ''
        : '<p style="font-size:12px;color:#b42318;margin-top:10px">No se pudo adjuntar la ficha: los datos van en este correo.</p>';

    const html = marco({
        titulo, color: actualizacion ? '#b54708' : '#0b5cff', intro,
        cuerpo: lista + tablaDatos(campos) + pie +
            `<p style="font-size:12px;color:#667085;margin:12px 0 0">Aprobada por ${esc(p.aprobada_por || '')}${p.aprobada_en ? ' el ' + esc(fecha(p.aprobada_en)) : ''}.</p>`,
    });
    const texto = `${titulo}\n\n${Object.entries(campos).map(([k, v]) => `${k}: ${v || '—'}`).join('\n')}\n\n${BASE}${PAGINA}\n`;
    const enviado = await mandar(para, `[Calidad] ${titulo} — ${p.descripcion || ''}`, html, texto, adjuntos);
    return { enviado, para, adjuntos: adjuntos.length, cambios: cambios.length };
}

/* ═══════════════════════════════════════════════════════════════════════════
   3. A Ventas y Logistica, cuando el producto tiene todo
   ═══════════════════════════════════════════════════════════════════════════ */

/** Los tres papeles que pide Claudia para avisarle a ventas. */
export async function loQueFalta(sku) {
    const p = await productoDe(sku);
    if (!p) return ['el producto no existe'];
    const { rows } = await consultar(
        'SELECT DISTINCT tipo FROM dl_documentos WHERE sku = $1 AND vigente', [sku]
    );
    const hay = new Set(rows.map((r) => r.tipo));
    const falta = [];
    if (p.estado !== 'aprobada') falta.push('la ficha aprobada');
    if (!hay.has('certificado')) falta.push('el certificado MSP del producto');
    if (!hay.has('seguridad')) falta.push('la ficha de seguridad');
    return falta;
}

/**
 * Avisa a Ventas y Logistica que el producto ya esta disponible, con la ficha,
 * el certificado MSP y la ficha de seguridad adjuntos. No manda nada si falta
 * alguno de los tres: un aviso incompleto obliga a mandar otro despues.
 */
export async function avisarVentas(sku, { forzar = false } = {}) {
    const p = await productoDe(sku);
    if (!p) return { enviado: false, motivo: 'el producto no existe' };
    if (p.enviada_ventas_en && !forzar) return { enviado: false, motivo: 'ya se había avisado' };
    const falta = await loQueFalta(sku);
    if (falta.length) return { enviado: false, motivo: `falta ${falta.join(', ')}` };

    const para = await supervisoresDe('datos-logisticos', 'ventas');
    if (!para.length) return { enviado: false, motivo: 'no hay destinatarios de Ventas cargados' };

    const campos = camposFicha(p);
    const adjuntos = await adjuntosDe(sku, ['ficha', 'certificado', 'seguridad']);
    const titulo = `Producto disponible: ${p.sku}`;
    const html = marco({
        titulo, color: '#12b76a',
        intro: `Ya tienen todo para cargar los datos del SKU <b>${esc(p.sku)}</b> — ${esc(p.descripcion || '')}. ` +
            'Van adjuntos la ficha del producto, el certificado MSP y la ficha de seguridad.',
        cuerpo: tablaDatos(campos),
    });
    const texto = `${titulo}\n${p.descripcion || ''}\n\n${Object.entries(campos).map(([k, v]) => `${k}: ${v || '—'}`).join('\n')}\n\n${BASE}${PAGINA}\n`;
    const enviado = await mandar(para, `[Calidad] ${titulo} — ${p.descripcion || ''}`, html, texto, adjuntos);
    if (enviado) {
        await consultar('UPDATE dl_productos SET enviada_ventas_en = now() WHERE sku = $1', [sku]);
    }
    return { enviado, para, adjuntos: adjuntos.length };
}

/* ═══════════════════════════════════════════════════════════════════════════
   4. Habilitaciones MSP por vencer
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Un mes antes del vencimiento de una habilitacion MSP, un correo a Claudia.
 * Cada registro se avisa una sola vez (avisado_en): si no, llegaria lo mismo
 * todos los dias durante un mes y se dejaria de leer.
 */
export async function revisarVencimientosMSP({ forzar = false, soloPrevisualizar = false } = {}) {
    if (!hayCorreo) return { estado: 'sin correo configurado' };
    return correrUnaVezPorDia('datos_logisticos_vencimientos_msp', { hora: 8, forzar, activa: true }, async () => {
        const { rows } = await consultar(
            `SELECT r.id, r.sku, r.numero, r.vence, p.descripcion, p.activo,
                    (r.vence - (now() AT TIME ZONE $1)::date) AS dias
             FROM dl_registros r
             JOIN dl_productos p ON p.sku = r.sku
             WHERE r.avisado_en IS NULL
               AND r.vence <= (now() AT TIME ZONE $1)::date + $2::int
               -- Una renovacion posterior del mismo producto deja sin efecto al anterior
               AND NOT EXISTS (SELECT 1 FROM dl_registros r2
                               WHERE r2.sku = r.sku AND r2.vence > r.vence)
             ORDER BY r.vence, r.sku`,
            [ZONA, DIAS_AVISO_MSP]
        );
        if (!rows.length) return { registros: 0, correos: 0, detalle: 'ninguna habilitación por vencer' };

        const para = await supervisoresDe('datos-logisticos', 'vencimientos');
        const asunto = rows.length === 1
            ? `[Calidad] Habilitación MSP por vencer: ${rows[0].sku}`
            : `[Calidad] ${rows.length} habilitaciones MSP por vencer`;
        if (soloPrevisualizar) {
            return { modo: 'previsualizacion', asunto, para, correos: 0, registros: rows.map((r) => `${r.sku} vence ${fecha(r.vence)}`) };
        }
        const fila = (r) => `<tr><td style="padding:4px 10px 4px 0"><b>${esc(r.sku)}</b></td>` +
            `<td style="padding:4px 10px 4px 0">${esc(r.descripcion || '')}</td>` +
            `<td style="padding:4px 10px 4px 0">${esc(r.numero)}</td>` +
            `<td style="padding:4px 0;white-space:nowrap">${esc(fecha(r.vence))} ` +
            `<span style="color:${r.dias <= 0 ? '#b42318' : '#b54708'}">(${r.dias <= 0 ? 'vencida' : `en ${r.dias} días`})</span></td></tr>`;
        const html = marco({
            titulo: rows.length === 1 ? 'Una habilitación MSP está por vencer' : `${rows.length} habilitaciones MSP por vencer`,
            color: '#b54708',
            intro: `Estas habilitaciones vencen dentro de ${DIAS_AVISO_MSP} días o ya vencieron. ` +
                'Al renovarlas, cargá el documento nuevo en la app: queda el anterior y se actualiza la ficha.',
            cuerpo: `<table style="font-size:14px;border-collapse:collapse"><tr style="text-align:left;color:#475467">
                <th style="padding-right:10px">SKU</th><th style="padding-right:10px">Producto</th>
                <th style="padding-right:10px">Habilitación</th><th>Vence</th></tr>${rows.map(fila).join('')}</table>`,
        });
        const texto = `${asunto}\n${rows.map((r) => `- ${r.sku} ${r.descripcion || ''} · ${r.numero} · vence ${fecha(r.vence)}`).join('\n')}\n`;
        const enviado = await mandar(para, asunto, html, texto);
        if (enviado) {
            await consultar('UPDATE dl_registros SET avisado_en = now() WHERE id = ANY($1)', [rows.map((r) => r.id)]);
        }
        return { registros: rows.length, correos: enviado ? 1 : 0, detalle: `${rows.length} habilitación(es) por vencer` };
    });
}
