/**
 * Reglas de evaluacion de las muestras de granel.
 *
 * Las usan la API, para no aprobar un lote con lo que el navegador diga que
 * cumple, y los avisos por correo, para decir por que una muestra sigue
 * pendiente. La misma regla vive tambien en aprobacion-graneles.html, que la
 * usa para pintar la tabla mientras se escribe: si se cambia una, hay que
 * cambiar la otra.
 */

/**
 * Numero de un valor cargado a mano. Acepta coma decimal, que es como se
 * escribe acá: sin esto "7,5" se leia como 7 y un pH fuera de rango pasaba.
 */
export function numero(v) {
    const t = String(v ?? '').trim().replace(',', '.');
    if (t === '') return null;
    const n = Number(t);
    return Number.isFinite(n) ? n : null;
}

/** true dentro de rango, false fuera, null si no hay un numero para evaluar. */
export function evaluar(param, valor) {
    const n = numero(valor);
    if (n === null) return null;
    const min = numero(param.min);
    const max = numero(param.max);
    return (min === null || n >= min) && (max === null || n <= max);
}

/**
 * Se guarda lo que se escribio con punto decimal y nada mas: no se pasa por
 * Number porque "7.50" quedaria "7.5", y en un registro de laboratorio los
 * decimales informados son parte del dato.
 */
export const limpiar = (v) => String(v ?? '').trim().replace(',', '.');

/**
 * Arma los resultados a partir de los parametros de la especificacion y de lo
 * que mando el cliente. Sale uno por parametro, en el orden de la ficha; lo que
 * venga para parametros que la ficha no tiene se descarta.
 */
export function armarResultados(parametros, enviados) {
    const porId = new Map(
        (Array.isArray(enviados) ? enviados : [])
            .filter((r) => r && typeof r === 'object')
            .map((r) => [r.paramId, r])
    );

    return (parametros || []).map((p) => {
        const r = porId.get(p.id) || {};
        const base = {
            paramId: p.id,
            paramName: p.name,
            type: p.type === 'text' ? 'text' : 'numeric',
            retestValue: '',
            retestPass: null,
        };

        if (base.type === 'text') {
            // Conforme guarda exactamente el texto objetivo, para que los KPI
            // cuenten sobre valores iguales y no sobre lo que cada uno escriba.
            if (r.pass === true) return { ...base, value: p.target || 'Conforme', pass: true };
            if (r.pass === false) return { ...base, value: String(r.value ?? '').trim(), pass: false };
            return { ...base, value: '', pass: null };
        }

        const value = limpiar(r.value);
        const pass = evaluar(p, value);
        // El retest solo existe si la primera medicion quedo fuera. Si se
        // corrige la primera y ahora cumple, el retest viejo se descarta.
        const retestValue = pass === false ? limpiar(r.retestValue) : '';
        const retestPass = retestValue === '' ? null : evaluar(p, retestValue);
        const fila = { ...base, value, pass, retestValue, retestPass };
        // Titulaciones: toma de muestra y gasto de titulante. Cada medicion
        // tiene los suyos, porque el retest es otra titulacion.
        if (llevaTitulacion({ paramName: p.name, type: base.type })) {
            fila.toma = limpiar(r.toma);
            fila.gasto = limpiar(r.gasto);
            fila.retestToma = retestValue === '' ? '' : limpiar(r.retestToma);
            fila.retestGasto = retestValue === '' ? '' : limpiar(r.retestGasto);
        }
        return fila;
    });
}

/** Resultado final de un parametro, contando el retest. */
export function passFinal(r) {
    if (r.pass === true) return true;
    // Un parametro de texto no tiene retest: "No conforme" es definitivo.
    if (r.pass === false && r.type === 'text') return false;
    if (r.pass === false) {
        if (r.retestPass === true) return true;
        if (r.retestPass === false) return false;
    }
    return null;
}

/**
 * Lo que impide aprobar, en palabras. Vacio si se puede.
 *
 * `ignorarDiferido` es para produccion: el catiónico pendiente no frena el
 * envasado, pero si la aprobacion documental (ver mas abajo).
 */
export function bloqueosDeAprobacion(resultados, horaFin, opciones = {}) {
    let lista = Array.isArray(resultados) ? resultados : [];
    const motivos = [];
    if (!lista.length) motivos.push('la muestra no tiene parametros');
    if (opciones.ignorarDiferido) lista = lista.filter((r) => !esDiferido(r));

    const sinCargar = lista.filter((r) => r.pass === null).length;
    const retestPendiente = lista.filter(
        (r) => r.type === 'numeric' && r.pass === false && r.retestValue === ''
    ).length;
    const fuera = lista.filter((r) => passFinal(r) === false).length;

    if (sinCargar) motivos.push(`faltan ${sinCargar} resultado(s)`);
    if (retestPendiente) motivos.push(`${retestPendiente} parametro(s) esperan retest`);
    if (fuera) motivos.push(`${fuera} parametro(s) fuera de especificacion`);
    if (!horaFin) motivos.push('falta la hora de fin de analisis');
    // La toma y el gasto son parte del dato analitico que se revisa al aprobar.
    // Para produccion no cuentan: el granel es apto por el resultado, y frenar
    // el envasado porque falta anotar el gasto seria parar la linea de mas.
    if (!opciones.ignorarTitulacion) {
        for (const falta of faltantesDeTitulacion(lista, opciones.exentosTitulacion)) {
            motivos.push(`falta ${falta}`);
        }
    }
    return motivos;
}

/**
 * Catiónicos de suavizantes: el ensayo se hace los sabados y se juntan los de
 * toda la semana (pedido de Claudia, 25/09/2026). Hasta entonces la muestra
 * tiene todo lo demas cargado y ese parametro vacio.
 *
 * Para PRODUCCION eso no frena el envasado: con el resto conforme el granel es
 * apto. Para la aprobacion documental si frena, porque el registro no esta
 * completo: la muestra espera en "Pendiente catiónico".
 */
const RE_DIFERIDO = /cati[oó]nico/i;

export const esDiferido = (r) => RE_DIFERIDO.test(String(r?.paramName ?? ''));

/** Todo lo que no es diferido esta cargado, sin retest pendiente. */
function restoCompleto(lista) {
    const resto = lista.filter((r) => !esDiferido(r));
    return resto.length > 0
        && resto.every((r) => r.pass !== null)
        && !resto.some((r) => r.type === 'numeric' && r.pass === false && r.retestValue === '');
}

/** La muestra solo espera el catiónico: el resto ya esta. */
export function soloFaltaDiferido(resultados) {
    const lista = Array.isArray(resultados) ? resultados : [];
    const dif = lista.filter(esDiferido);
    if (!dif.length) return false;
    if (!dif.every((r) => r.pass === null)) return false;
    return restoCompleto(lista);
}

/**
 * Titulaciones: materia activa -total, catiónico o surfactantes aniónicos- y
 * cloro. Ademas del resultado se anota la TOMA de muestra y el GASTO de
 * titulante (pedido de Claudia, 25/09/2026): son el dato analitico que revisa
 * quien aprueba. Quedan en el registro y en la bitacora, pero NO salen en la
 * hoja impresa del REG-SOP-AC-029, que informa el resultado.
 */
const RE_TITULACION = /materia\s+activa|cloro/i;

export const llevaTitulacion = (r) => RE_TITULACION.test(String(r?.paramName ?? r?.name ?? ''))
    && (r?.type ?? 'numeric') !== 'text';

/**
 * Lo que falta anotar de una titulacion, en palabras.
 *
 * Una muestra cargada antes de que existiera esta regla no tiene los campos: a
 * esa no se le pueden pedir datos que nadie anoto. Como armarResultados se los
 * agrega al recalcular, quien valida pasa en `exentos` los parametros que en
 * la fila guardada no los tenian.
 */
export const exentosDeTitulacion = (resultadosGuardados) => new Set(
    (Array.isArray(resultadosGuardados) ? resultadosGuardados : [])
        .filter((r) => r.toma === undefined && r.gasto === undefined)
        .map((r) => r.paramId)
);
export function faltantesDeTitulacion(resultados, exentos = null) {
    const faltan = [];
    for (const r of Array.isArray(resultados) ? resultados : []) {
        if (!llevaTitulacion(r)) continue;
        if (r.toma === undefined && r.gasto === undefined) continue;
        // Parametros de una muestra que se cargo antes de la regla: el
        // recalculo les agrega los campos vacios, pero el dato no existio.
        if (exentos && exentos.has(r.paramId)) continue;
        if (r.value !== '' && (!r.toma || !r.gasto)) {
            faltan.push(`${r.paramName}: ${!r.toma && !r.gasto ? 'toma y gasto' : (!r.toma ? 'toma de muestra' : 'gasto')}`);
        }
        if (r.retestValue !== '' && r.retestToma !== undefined
            && (!r.retestToma || !r.retestGasto)) {
            faltan.push(`${r.paramName} (retest): ${!r.retestToma && !r.retestGasto ? 'toma y gasto' : (!r.retestToma ? 'toma de muestra' : 'gasto')}`);
        }
    }
    return faltan;
}

/**
 * Lo que falta para GUARDAR la muestra (pedido de Claudia, 25/09/2026): las
 * analistas se olvidaban de completar campos, sobre todo los de conforme /
 * no conforme, y el lote llegaba a la aprobacion a medias.
 *
 * Se exige: hora de salida de fabrica, hora de ingreso al control y TODOS los
 * resultados. Las dos excepciones son el catiónico, que se ensaya los sabados,
 * y el Cloud point, que no es requisito.
 */
const RE_OPCIONAL = /cloud\s*point/i;

export const puedeQuedarPendiente = (r) =>
    esDiferido(r) || RE_OPCIONAL.test(String(r?.paramName ?? r?.name ?? ''));

export function faltantesParaGuardar({ horaFabrica, horaIngreso, resultados }) {
    const faltan = [];
    if (!horaFabrica) faltan.push('la hora de salida de fábrica');
    if (!horaIngreso) faltan.push('la hora de ingreso al control');

    const sinCargar = (Array.isArray(resultados) ? resultados : [])
        .filter((r) => r.pass === null && !puedeQuedarPendiente(r))
        .map((r) => r.paramName);
    if (sinCargar.length) {
        faltan.push(sinCargar.length <= 3
            ? `el resultado de ${sinCargar.join(', ')}`
            : `${sinCargar.length} resultados (${sinCargar.slice(0, 3).join(', ')}…)`);
    }
    return faltan;
}
