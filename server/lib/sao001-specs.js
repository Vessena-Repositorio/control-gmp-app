/**
 * Especificaciones de SAO-001, leidas del propio dashboard.
 *
 * Los limites (PPQ-H2O-001 v2.0 + REG-SOP-LCC-095-A v5.0) y la forma de
 * evaluarlos -alerta, accion, OOS, LOD, aerobios en ufc/100 mL contra specs en
 * ufc/mL- estan en dashboard_sao001.html. Claudia pidio usar esos (18/09/2026).
 * No se copian: se extraen del html al arrancar, asi la carga y el dashboard no
 * pueden decir cosas distintas sobre el mismo valor. Mismo criterio que
 * personas-capacitaciones.js con la tabla de alias.
 *
 * Se extraen SPECS, parseValor, evaluar y formatSpec. La pantalla de carga
 * recibe el mismo codigo por GET /api/sao001-carga/especificaciones.js.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const HTML = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'dashboard_sao001.html');

/** La funcion `nombre` del html, desde "function nombre(" hasta su llave de cierre. */
function extraerFuncion(html, nombre) {
    const inicio = html.indexOf(`function ${nombre}(`);
    if (inicio < 0) throw new Error(`no se encontro la funcion ${nombre} en el dashboard`);
    let i = html.indexOf('{', inicio);
    let nivel = 0;
    for (; i < html.length; i++) {
        if (html[i] === '{') nivel++;
        else if (html[i] === '}' && --nivel === 0) break;
    }
    return html.slice(inicio, i + 1);
}

function extraer() {
    const html = readFileSync(HTML, 'utf8');
    const ini = html.indexOf('const SPECS = {');
    const fin = html.indexOf('const PUNTOS_ORDER');
    if (ini < 0 || fin < ini) throw new Error('no se encontro el bloque SPECS en el dashboard');
    return [
        html.slice(ini, fin),
        extraerFuncion(html, 'parseValor'),
        extraerFuncion(html, 'evaluar'),
        extraerFuncion(html, 'formatSpec'),
    ].join('\n\n');
}

export const CODIGO = extraer();

const contexto = vm.createContext({});
vm.runInContext(`${CODIGO}\nthis.SPECS = SPECS; this.parseValor = parseValor; this.evaluar = evaluar; this.formatSpec = formatSpec;`, contexto);

export const { SPECS, parseValor, evaluar, formatSpec } = contexto;

/** Clave de la carga -> nombre del parametro en el dashboard. TOC no tiene especificacion. */
export const ETIQUETA = {
    ph: 'pH',
    cond: 'Conductividad',
    cloro: 'Cloro Total',
    ozono: 'Ozono libre',
    micro: 'Aerobios Totales',
    dureza: 'Dureza Total',
    toc: null,
};

/** Evalua un valor de un punto: { status, detail, spec } con la logica del dashboard. */
export function evaluarValor(punto, clave, texto) {
    const spec = ETIQUETA[clave] ? (SPECS[punto] || {})[ETIQUETA[clave]] : null;
    const r = evaluar(parseValor(texto), spec);
    return { ...r, spec: spec ? formatSpec(spec) : 'sin especificación' };
}

console.log(`[sao001] especificaciones del dashboard: ${Object.keys(SPECS).length} puntos`);
