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
        return { ...base, value, pass, retestValue, retestPass };
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

/** Lo que impide aprobar, en palabras. Vacio si se puede. */
export function bloqueosDeAprobacion(resultados, horaFin) {
    const lista = Array.isArray(resultados) ? resultados : [];
    const motivos = [];
    if (!lista.length) motivos.push('la muestra no tiene parametros');

    const sinCargar = lista.filter((r) => r.pass === null).length;
    const retestPendiente = lista.filter(
        (r) => r.type === 'numeric' && r.pass === false && r.retestValue === ''
    ).length;
    const fuera = lista.filter((r) => passFinal(r) === false).length;

    if (sinCargar) motivos.push(`faltan ${sinCargar} resultado(s)`);
    if (retestPendiente) motivos.push(`${retestPendiente} parametro(s) esperan retest`);
    if (fuera) motivos.push(`${fuera} parametro(s) fuera de especificacion`);
    if (!horaFin) motivos.push('falta la hora de fin de analisis');
    return motivos;
}
