/**
 * Lectura del lote y el vencimiento impresos, con IA.
 *
 * Por que existe: en el control en proceso el analista saca la foto del envase
 * y del sticker de la caja, y despues escribe el lote y el vencimiento a mano.
 * Validar lo escrito no alcanza -lo que esta mal es lo IMPRESO, y si lo copia
 * tal cual, la validacion lo deja pasar- asi que hay que leer la foto
 * (Claudia, 09/11/2026: "necesito que verifique cuando carga la foto, no sobre
 * el texto cargado").
 *
 * Lo que hace esto es solo LEER: devuelve lo que dice la foto, letra por letra.
 * Quien decide si esta bien es la pantalla, que tiene las reglas del
 * SOP-PR-063 -el lote- y las del vencimiento -dos años, o 180 dias si es
 * hipoclorito-.
 *
 * La regla mas importante de la instruccion es que NO corrija. Un modelo que
 * "ayuda" y escribe 6313UY20A1 donde la impresora puso 6311Y20A1 vuelve inutil
 * todo el control: lo que se busca es justamente el error de impresion.
 *
 * Usa el mismo camino que la lectura de planillas de capacitacion
 * (lib/lectura-planillas.js): misma clave, mismos reintentos cuando Google
 * esta saturado y mismo tope de espera.
 */
import { preguntar, validar } from './lectura-planillas.js';

/** Lo que se le pide al modelo. Sin reglas de formato que lo tienten a corregir. */
const INSTRUCCION =
    'Sos un asistente que lee codigos impresos en envases de productos de limpieza de la empresa ' +
    'Vessena (planta de domisanitarios en Uruguay).\n\n' +
    'En la foto hay una de estas dos cosas:\n' +
    '  a) el envase, con el lote y el vencimiento impresos con inkjet (letras de puntos, ' +
    'a veces sobre plastico curvo o translucido);\n' +
    '  b) el sticker o rotulo de la caja, que ademas del codigo de barras lleva el lote y el ' +
    'vencimiento impresos o escritos.\n\n' +
    'Tu tarea es transcribir el LOTE y el VENCIMIENTO tal como estan impresos.\n\n' +
    'Reglas, y la primera es la que importa:\n' +
    '- TRANSCRIBI LITERAL, caracter por caracter. NO corrijas, NO completes, NO normalices y ' +
    'NO ordenes nada. Si lo impreso parece tener un error -una letra de menos, un numero raro, ' +
    'algo torcido- transcribilo igual tal cual se ve. El objetivo de esta lectura es encontrar ' +
    'errores de impresion: si los arreglas, no sirve para nada.\n' +
    '- El lote suele venir despues de la palabra LOTE, L, LOT o similar. Es un codigo de digitos ' +
    'y letras, todo junto, de entre 8 y 12 caracteres. Copia solo el codigo, sin la palabra LOTE.\n' +
    '- El vencimiento suele venir despues de VENCE, VTO, VENCIMIENTO, V o CONSUMIR ANTES DE. ' +
    'Normalmente es mes y año (por ejemplo 11/2028), pero puede venir con dia. Copialo tal cual, ' +
    'con las barras o guiones que tenga.\n' +
    '- Si tambien se ve una fecha de elaboracion o envasado, ponela en "elaboracion".\n' +
    '- Distingui letras y numeros con cuidado: 0 y O, 1 y I, 5 y S, 8 y B, 2 y Z. Si no podes ' +
    'decidir entre dos, elegi la mas probable y bajá la confianza.\n' +
    '- Lo que no este en la foto o no se pueda leer va como cadena vacia, nunca inventado.\n' +
    '- legible: false si la foto esta borrosa, cortada, con brillo encima del codigo o demasiado ' +
    'lejos como para leer con seguridad.\n' +
    '- confianza: 0.0 a 1.0, tu certeza sobre la transcripcion del lote.\n' +
    '- nota: una frase corta en español, solo si hay algo que quien controla deberia saber ' +
    '(por ejemplo "el lote esta medio borrado", "hay dos lotes distintos en la foto", ' +
    '"la impresion esta pisada"). Si no hay nada que decir, cadena vacia.';

const ESQUEMA = {
    type: 'object',
    properties: {
        lote: { type: 'string' },
        vence: { type: 'string' },
        elaboracion: { type: 'string' },
        legible: { type: 'boolean' },
        confianza: { type: 'number' },
        nota: { type: 'string' },
    },
    required: ['lote', 'vence', 'legible'],
};

const limpio = (s, max) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

/**
 * Foto del envase o del sticker -> lo que dice.
 * { imageBase64, mimeType, donde } -> { lote, vence, elaboracion, legible, confianza, nota }
 *
 * `donde` ('envase' | 'caja') no cambia la lectura: solo entra en el pedido
 * para que el modelo sepa que esta mirando.
 */
export async function leerLoteVence(p) {
    validar(p);
    const donde = p.donde === 'caja' ? 'el sticker de la caja' : 'el envase';
    const r = await preguntar({
        instruccion: INSTRUCCION,
        pedido: `Esta foto es de ${donde}. Transcribí el lote y el vencimiento que se ven:`,
        p,
        esquema: ESQUEMA,
        // Cero temperatura: se quiere la lectura mas probable, sin variantes.
        temperatura: 0,
    });
    return {
        lote: limpio(r.lote, 40),
        vence: limpio(r.vence, 40),
        elaboracion: limpio(r.elaboracion, 40),
        legible: r.legible !== false,
        confianza: Number.isFinite(r.confianza) ? Math.min(Math.max(r.confianza, 0), 1) : null,
        nota: limpio(r.nota, 300),
    };
}
