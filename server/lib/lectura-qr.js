/**
 * Lectura con QR para quien no tiene usuario (migracion 058).
 *
 * El operario se identifica con el codigo de su credencial. El codigo se
 * resuelve contra el padron de Capacitaciones (PE), en este orden:
 *   1. la tabla personal_codigos (la lista de credenciales que carga Calidad);
 *   2. la cedula o el numero de funcionario del padron, por si la credencial
 *      trae uno de los dos.
 *
 * Al cerrar la sesion, los aprobados se agregan como capacitacion a la
 * coleccion R de Capacitaciones, con el mismo lock y el mismo respaldo que usa
 * la app al guardar (routes/capacitaciones.js): quien tenga la app abierta
 * recibe un 409 en su proximo guardado, vuelve a leer y no pisa nada.
 */
import { randomBytes } from 'node:crypto';
import { consultar } from '../db.js';
import { coleccionCapacitaciones } from './tareas.js';

const MESES = ['ENERO', 'FEBRERO', 'MARZO', 'ABRIL', 'MAYO', 'JUNIO', 'JULIO', 'AGOSTO',
    'SEPTIEMBRE', 'OCTUBRE', 'NOVIEMBRE', 'DICIEMBRE'];

export const nuevoToken = () => randomBytes(18).toString('base64url');

const soloDigitos = (s) => String(s ?? '').replace(/\D/g, '');
const limpio = (s) => String(s ?? '').trim().toUpperCase();

function fallo(status, mensaje) {
    const e = new Error(mensaje);
    e.status = status;
    return e;
}

/** La persona del padron que corresponde al codigo de una credencial, o null. */
export async function personaPorCodigo(codigo) {
    const cod = limpio(codigo);
    if (!cod) return null;
    const personal = (await coleccionCapacitaciones('PE')).filter((p) => p && p.a !== false);

    const { rows: [fila] } = await consultar('SELECT ci, nro, nombre FROM personal_codigos WHERE upper(codigo) = $1', [cod]);
    const buscar = (ci, nro, nombre) =>
        (ci && personal.find((p) => soloDigitos(p.ci) && soloDigitos(p.ci) === soloDigitos(ci))) ||
        (nro && personal.find((p) => p.nro != null && soloDigitos(p.nro) && soloDigitos(p.nro) === soloDigitos(nro))) ||
        (nombre && personal.find((p) => limpio(p.n) === limpio(nombre))) || null;

    if (fila) return buscar(fila.ci, fila.nro, fila.nombre);
    // Sin lista cargada: la credencial puede traer la cedula o el numero.
    const d = soloDigitos(cod);
    return d.length >= 3 ? buscar(d, d, null) : null;
}

/** Preguntas para mostrar: sin la respuesta correcta. */
export function preguntasPublicas(evaluacion) {
    return (Array.isArray(evaluacion) ? evaluacion : []).map((p) => ({ texto: p.texto, opciones: p.opciones }));
}

/** { puntaje 0-100, aprobado, errores } para las respuestas (indices). */
export function corregir(evaluacion, respuestas, minimo) {
    const ps = Array.isArray(evaluacion) ? evaluacion : [];
    if (!ps.length) return { puntaje: null, aprobado: true, errores: 0 };
    const r = Array.isArray(respuestas) ? respuestas : [];
    if (r.length !== ps.length || r.some((x) => x == null || x === '')) {
        throw fallo(400, 'contestá todas las preguntas');
    }
    const bien = ps.filter((p, i) => Number(r[i]) === Number(p.correcta)).length;
    const puntaje = Math.round((bien * 100) / ps.length);
    return { puntaje, aprobado: puntaje >= minimo, errores: ps.length - bien };
}

/** Valida y normaliza la evaluacion que carga quien prepara la capacitacion. */
export function validarEvaluacion(preguntas) {
    if (!Array.isArray(preguntas)) throw fallo(400, 'evaluación inválida');
    return preguntas.map((p, i) => {
        const texto = String(p?.texto || '').trim();
        // Las opciones vacias se descartan, y la correcta se vuelve a ubicar
        // entre las que quedan: si no, quitar una vacia del medio correria la
        // respuesta correcta a otra opcion.
        const todas = (Array.isArray(p?.opciones) ? p.opciones : []).map((o) => String(o || '').trim());
        const marcada = Number(p?.correcta);
        const opciones = todas.filter(Boolean);
        if (!texto) throw fallo(400, `la pregunta ${i + 1} no tiene texto`);
        if (opciones.length < 2) throw fallo(400, `la pregunta ${i + 1} necesita al menos dos opciones`);
        if (!Number.isInteger(marcada) || !todas[marcada]) {
            throw fallo(400, `marcá la respuesta correcta de la pregunta ${i + 1}`);
        }
        const correcta = todas.slice(0, marcada).filter(Boolean).length;
        return { texto, opciones, correcta };
    });
}

/**
 * Agrega a la coleccion R de Capacitaciones un registro por asistente
 * aprobado. Corre dentro de la transaccion `c` del cierre de la sesion.
 */
export async function registrarEnCapacitaciones(c, { asistentes, codigo, version, titulo, resp, horas, conEvaluacion, minimo, sectores, fecha }) {
    if (!asistentes.length) return 0;
    await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['capacitaciones']);
    const { rows: [fila] } = await c.query("SELECT valor, version FROM capacitaciones_datos WHERE clave = 'R' FOR UPDATE");
    if (!fila) throw fallo(409, 'no se encontraron los registros de Capacitaciones');
    const R = JSON.parse(fila.valor);
    const [a, m] = fecha.split('-').map(Number);
    const base = {
        fecha, mes: MESES[m - 1], tema: 'PROCEDIMIENTO', desc: `${codigo} v${version} · ${titulo}`.slice(0, 200),
        cod: codigo, hrs: horas, tipo: 'TEORICO', ev: conEvaluacion ? 'ESCRITA' : 'NO APLICA', plan: 'NO',
        resp, puntajeMin: conEvaluacion ? minimo : 0, planId: 0, dirigido: (sectores || []).join(', '),
        persEst: 0, year: a, origen: 'lectura QR',
    };
    for (const p of asistentes) {
        R.push({
            ...base,
            id: 'q' + Date.now().toString(36) + randomBytes(3).toString('hex'),
            nom: p.persona_nombre, sec: p.persona_sector || '',
            nota: p.puntaje == null ? '' : String(p.puntaje),
        });
    }
    await c.query(
        `INSERT INTO capacitaciones_respaldos (clave, valor, version, guardado_por, motivo)
         VALUES ('R', $1, $2, $3, $4)`,
        [fila.valor, fila.version, resp, `antes de agregar la lectura QR de ${codigo}`]);
    await c.query(
        `UPDATE capacitaciones_datos SET valor = $1, version = version + 1, actualizado_en = now(),
                actualizado_por = $2 WHERE clave = 'R'`,
        [JSON.stringify(R), `${resp} (lectura QR ${codigo})`]);
    return asistentes.length;
}
