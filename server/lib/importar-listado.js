/**
 * Lectura del listado maestro LIS-SOP-DOC-001-E (hoja "Listado de documentos")
 * para importarlo a dc_documentos / dc_versiones.
 *
 * La planilla la lee el navegador (SheetJS) y manda las filas tal cual. Aca se
 * normalizan y se validan; nada toca la base. La ruta decide si guardar.
 *
 * Reglas acordadas con Claudia el 07/10/2026:
 *  - "Vigente" y "Aprobado" entran como vigentes ("Aprobado" era un estado sin
 *    actualizar en la planilla).
 *  - "Para revisar", "Para escribir" y "En proceso" entran como borradores y
 *    siguen el ciclo nuevo. Si el documento tiene una vigente, se mantiene.
 *  - "Dado de baja" entra como obsoleto.
 *  - El vencimiento es la "Fecha proxima revision" de la planilla, que ya
 *    recoge las extensiones sin cambios. Si no esta, vigencia + 36 meses.
 *  - Un documento con errores no entra en absoluto: nada se carga a medias.
 *
 * Particularidad del listado: hay una fila por documento, no por version.
 * Cuando un documento esta en revision, la fila muestra la version nueva (por
 * ejemplo SOP-AC-029 v8.0 "En proceso") y la vigente anterior no figura. Se
 * avisa, para buscarla en la carpeta VIGENTE.
 */
import { nombreComparable } from './firmas.js';

export const MESES_REVISION = 36;

const ESTADOS = {
    'vigente': 'vigente',
    'aprobado': 'vigente',
    'para revisar': 'borrador',
    'para escribir': 'borrador',
    'en proceso': 'borrador',
    'revisado': 'borrador',
    'dado de baja': 'obsoleto',
};

const t = (v) => (v == null ? '' : String(v).replace(/\s+/g, ' ').trim());

const iso = (a, m, d) => `${a}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

function fechaReal(a, m, d) {
    const f = new Date(Date.UTC(a, m - 1, d));
    return f.getUTCFullYear() === a && f.getUTCMonth() === m - 1 && f.getUTCDate() === d;
}

/**
 * Fecha de la planilla a 'YYYY-MM-DD'. Acepta lo que aparece en el listado:
 * fechas de Excel (el navegador las manda ISO), d/m/aaaa, d/m/aa y mm/aaaa.
 * Devuelve { fecha, aviso } o { error }.
 */
export function leerFecha(valor) {
    const s = t(valor);
    if (!s) return {};
    let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) {
        const [a, mes, d] = [+m[1], +m[2], +m[3]];
        return fechaReal(a, mes, d) ? { fecha: iso(a, mes, d) } : { error: `fecha inexistente: ${s}` };
    }
    m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/);
    if (m) {
        const dos = m[3].length === 2;
        const [d, mes, a] = [+m[1], +m[2], dos ? 2000 + +m[3] : +m[3]];
        if (!fechaReal(a, mes, d)) return { error: `fecha inexistente: ${s}` };
        return { fecha: iso(a, mes, d), aviso: dos ? `año con dos cifras (${s}), se tomó ${a}` : undefined };
    }
    m = s.match(/^(\d{1,2})\/(\d{4})$/);
    if (m && +m[1] >= 1 && +m[1] <= 12) {
        return { fecha: iso(+m[2], +m[1], 1), aviso: `fecha sin día (${s}), se tomó el día 1` };
    }
    return { error: `fecha ilegible: ${s}` };
}

export function sumarMeses(fechaIso, meses) {
    const [a, m, d] = fechaIso.split('-').map(Number);
    const f = new Date(Date.UTC(a, m - 1 + meses, 1));
    // Fin de mes: 31/01 + 1 mes es 28 o 29/02, no 03/03.
    const ultimo = new Date(Date.UTC(f.getUTCFullYear(), f.getUTCMonth() + 1, 0)).getUTCDate();
    return iso(f.getUTCFullYear(), f.getUTCMonth() + 1, Math.min(d, ultimo));
}

/** El tipo es el comienzo del codigo: se prueba primero el mas largo. */
function tipoDe(codigo, columna, tipos) {
    const col = t(columna).toUpperCase();
    if (tipos.includes(col) && codigo.startsWith(col + '-')) return col;
    return [...tipos].sort((a, b) => b.length - a.length).find((x) => codigo.startsWith(x + '-')) || null;
}

/**
 * Normaliza y valida. `tipos`: codigos de dc_tipos. `usuarios`: [{id, nombre}]
 * para reconocer al aprobador. `existentes`: Set de codigos ya cargados.
 * `hoy`: 'YYYY-MM-DD'.
 *
 * Devuelve { documentos, ignoradas } donde cada documento trae `errores` y
 * `avisos`; solo los que no tienen errores se pueden guardar.
 */
export function analizarListado(filas, { tipos, usuarios, existentes, hoy }) {
    const porNombre = new Map();
    for (const u of usuarios) {
        const k = nombreComparable(u.nombre);
        if (!k) continue;
        porNombre.set(k, porNombre.has(k) ? null : u.id); // null = ambiguo
    }
    const idDe = (nombre) => porNombre.get(nombreComparable(nombre)) ?? null;

    const grupos = new Map();
    let ignoradas = 0;

    for (const f of filas) {
        const codigo = t(f.codigo).toUpperCase().replace(/\s+/g, '');
        // Las filas en blanco de la planilla tienen el codigo armado por formula
        // ("--257"): sin letras y numero no es un documento.
        if (!/^[A-Z][A-Z0-9.]*(-[A-Z0-9.]+)+$/.test(codigo) || !/\d/.test(codigo)) { ignoradas++; continue; }

        const errores = [];
        const avisos = [];
        const estadoTxt = t(f.status).toLowerCase();
        const estado = ESTADOS[estadoTxt];
        if (!estado) errores.push(estadoTxt ? `estado desconocido: "${t(f.status)}"` : 'sin estado');

        const verTxt = t(f.ver).replace(',', '.');
        const numero = Number(verTxt);
        if (!verTxt || !Number.isFinite(numero) || numero < 0) errores.push(verTxt ? `versión ilegible: ${verTxt}` : 'sin versión');

        const vig = leerFecha(f.vigencia);
        const prox = leerFecha(f.proxima);
        if (vig.error) (estado === 'vigente' ? errores : avisos).push(`fecha de vigencia: ${vig.error}`);
        if (vig.aviso) avisos.push(`fecha de vigencia: ${vig.aviso}`);
        if (prox.aviso) avisos.push(`próxima revisión: ${prox.aviso}`);
        if (prox.error) avisos.push(`próxima revisión: ${prox.error}; se calcula desde la vigencia`);

        const aprueba = t(f.aprueba);
        const v = {
            fila: f.fila, estado, numero, version: verTxt,
            titulo: t(f.titulo), tipoColumna: f.tipo, prefijo: t(f.prefijo).toUpperCase(),
            fechaVigencia: vig.fecha || null,
            proxima: prox.fecha || null,
            elaboradoPor: t(f.redacta) || null,
            revisadoPor: t(f.revisa) || null,
            aprobadoPor: aprueba || null,
            aprobadoPorId: aprueba ? idDe(aprueba) : null,
            observaciones: t(f.observaciones) || null,
            errores, avisos,
        };
        if (!grupos.has(codigo)) grupos.set(codigo, []);
        grupos.get(codigo).push(v);
    }

    const documentos = [];
    for (const [codigo, vs] of grupos) {
        const errores = vs.flatMap((v) => v.errores.map((e) => `fila ${v.fila}: ${e}`));
        const avisos = vs.flatMap((v) => v.avisos.map((e) => `fila ${v.fila}: ${e}`));
        const tipo = tipoDe(codigo, vs[0].tipoColumna, tipos);
        if (!tipo) errores.push(`tipo de documento desconocido (${t(vs[0].tipoColumna) || 'columna vacía'})`);

        const nums = vs.map((v) => v.numero);
        if (new Set(nums).size !== nums.length) {
            errores.push(`la misma versión aparece en más de una fila (filas ${vs.map((v) => v.fila).join(', ')})`);
        }
        const vigentes = vs.filter((v) => v.estado === 'vigente');
        const borradores = vs.filter((v) => v.estado === 'borrador');
        if (vigentes.length > 1) errores.push('más de una versión vigente');
        if (borradores.length > 1) errores.push('más de una versión en curso');
        const vigente = vigentes[0];
        const borrador = borradores[0];
        if (vigente && borrador && borrador.numero <= vigente.numero) {
            errores.push(`la versión en curso (${borrador.version}) no es posterior a la vigente (${vigente.version})`);
        }
        // Una version obsoleta posterior a la vigente no tiene sentido.
        for (const o of vs.filter((v) => v.estado === 'obsoleto')) {
            if (vigente && o.numero > vigente.numero) errores.push(`la versión dada de baja ${o.version} es posterior a la vigente`);
        }

        let proxima = null;
        if (vigente) {
            proxima = vigente.proxima
                || (vigente.fechaVigencia ? sumarMeses(vigente.fechaVigencia, MESES_REVISION) : null);
            if (!proxima) errores.push('vigente sin fecha de entrada en vigencia ni de próxima revisión');
            else if (!vigente.fechaVigencia) avisos.push('vigente sin fecha de entrada en vigencia: se toma la próxima revisión de la planilla');
            if (vigente.aprobadoPor && !vigente.aprobadoPorId) {
                avisos.push(`"${vigente.aprobadoPor}" no tiene usuario: solo Calidad podrá renovarlo`);
            }
        } else if (borrador && borrador.numero > 1) {
            avisos.push(`está en curso la versión ${borrador.version} y el listado no trae la vigente anterior: buscarla en la carpeta VIGENTE`);
        }

        const base = vigente || borrador || vs[vs.length - 1];
        if (!base.titulo) errores.push('sin título');

        if (existentes.has(codigo)) {
            documentos.push({ codigo, titulo: base.titulo, existe: true, errores: [], avisos: ['ya está cargado: no se toca'], versiones: [] });
            continue;
        }

        const area = /^[A-Z]{2,5}$/.test(base.prefijo)
            ? base.prefijo
            : (tipo ? codigo.slice(tipo.length + 1).split('-')[0] : null);

        documentos.push({
            codigo, titulo: base.titulo, tipo, area, proxima,
            vencido: Boolean(proxima && proxima < hoy),
            estado: vigente ? 'vigente' : borrador ? 'borrador' : 'obsoleto',
            versiones: vs.map(({ errores: _e, avisos: _a, tipoColumna: _t, prefijo: _p, ...v }) => v),
            errores, avisos,
        });
    }

    documentos.sort((a, b) => a.codigo.localeCompare(b.codigo));
    return { documentos, ignoradas };
}

/**
 * Escalona el primer aviso de los que entran vencidos: el mas atrasado hoy, el
 * resto repartido en los 6 meses siguientes, en orden de atraso. Devuelve un
 * Map codigo → 'YYYY-MM-DD'.
 */
export function escalonarAvisos(documentos, hoy, dias = 182) {
    const vencidos = documentos.filter((d) => d.vencido).sort((a, b) => a.proxima.localeCompare(b.proxima));
    const [a, m, d] = hoy.split('-').map(Number);
    const base = Date.UTC(a, m - 1, d);
    const salida = new Map();
    vencidos.forEach((doc, i) => {
        const f = new Date(base + Math.floor((i * dias) / vencidos.length) * 86400000);
        salida.set(doc.codigo, f.toISOString().slice(0, 10));
    });
    return salida;
}
