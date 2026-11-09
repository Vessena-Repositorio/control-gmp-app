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
 * Las fotos NO llevan todas lo mismo, y confundirlas da avisos falsos
 * (Claudia, 09/11/2026, despues de la primera prueba real):
 *   - el ENVASE lleva el lote y el vencimiento, impresos con inkjet;
 *   - el STICKER de la caja en CONTROL GMP lleva el codigo de barras y el
 *     vencimiento, y NO lleva lote: lo que parece uno -"FX15"- son las
 *     unidades por funda;
 *   - el rotulo de la caja en FABULOSO si lleva las tres cosas: codigo de
 *     barras, lote y vencimiento.
 * Por eso la caja se pide con `conLote` o sin el.
 *
 * Usa el mismo camino que la lectura de planillas de capacitacion
 * (lib/lectura-planillas.js): misma clave, mismos reintentos cuando Google
 * esta saturado y mismo tope de espera.
 */
import { preguntar, validar } from './lectura-planillas.js';

const COMUN =
    'Sos un asistente que lee codigos impresos en envases de productos de limpieza de la empresa ' +
    'Vessena (planta de domisanitarios en Uruguay).\n\n' +
    'Reglas, y la primera es la que importa:\n' +
    '- TRANSCRIBI LITERAL, caracter por caracter. NO corrijas, NO completes, NO normalices y ' +
    'NO ordenes nada. Si lo impreso parece tener un error -una letra de menos, un numero raro, ' +
    'algo torcido- transcribilo igual tal cual se ve. El objetivo de esta lectura es encontrar ' +
    'errores de impresion: si los arreglas, no sirve para nada.\n' +
    '- Distingui letras y numeros con cuidado: 0 y O, 1 y I, 5 y S, 8 y B, 2 y Z. Si no podes ' +
    'decidir entre dos, elegi la mas probable y bajá la confianza.\n' +
    '- Lo que no este en la foto o no se pueda leer va como cadena vacia, nunca inventado.\n' +
    '- legible: false si la foto esta borrosa, cortada, con brillo encima de lo que hay que leer ' +
    'o demasiado lejos como para leer con seguridad.\n' +
    '- confianza: 0.0 a 1.0, tu certeza sobre lo que transcribiste.\n' +
    '- nota: una frase corta en español, solo si hay algo que quien controla deberia saber ' +
    '(por ejemplo "el lote esta medio borrado", "hay dos lotes distintos en la foto", ' +
    '"la impresion esta pisada"). Si no hay nada que decir, cadena vacia.\n\n';

/** El envase: lote y vencimiento impresos con inkjet. */
const INSTRUCCION_ENVASE = COMUN +
    'Esta foto es del ENVASE. Lleva el lote y el vencimiento impresos con inkjet: letras de ' +
    'puntos, muchas veces sobre plastico curvo, translucido o de color.\n' +
    '- El lote suele venir despues de la palabra LOTE, L, LOT o similar. Es un codigo de digitos ' +
    'y letras de entre 8 y 12 caracteres. Copia solo el codigo, sin la palabra LOTE. Si el inkjet ' +
    'dejo espacios en el medio, copialos: la separacion puede ser parte del error.\n' +
    '- El vencimiento suele venir despues de VENCE, VTO, VENCIMIENTO, V o CONSUMIR ANTES DE. ' +
    'Normalmente es mes y año (por ejemplo 11/2028), pero puede venir con dia. Copialo tal cual, ' +
    'con las barras o guiones que tenga, y con todos los digitos que veas aunque parezcan de mas.\n' +
    '- Si tambien se ve una fecha de elaboracion o envasado, ponela en "elaboracion".\n' +
    '- codigoBarras va vacio: el envase no lo lleva.';

const CAJA_BARRAS =
    '- El numero del CODIGO DE BARRAS es el que esta impreso debajo de las barras. Ponelo en ' +
    '"codigoBarras", solo los digitos, sin espacios. Suele tener 13 o 14 digitos. Si no se ve ' +
    'ese numero, dejalo vacio: no lo deduzcas de las barras ni lo inventes.\n' +
    '- El VENCIMIENTO viene normalmente despues de VTO o VENCE, como mes y año (05/2028). ' +
    'Copialo tal cual.\n';

/** Sticker de la caja en Control GMP: codigo de barras y vencimiento. Lote NO tiene. */
const INSTRUCCION_CAJA = COMUN +
    'Esta foto es del STICKER o rotulo de la CAJA (el pack o la funda).\n' +
    CAJA_BARRAS +
    '- ATENCION: este sticker NO lleva numero de lote. Dejá "lote" SIEMPRE vacio, aunque veas ' +
    'codigos cortos tipo FX15, FX12 o similares: esos son las unidades por funda, no un lote. ' +
    'Tampoco es lote "ESTIBA MAX: 4 PISOS" ni nada parecido.';

/** Rotulo de la caja en Fabuloso: codigo de barras, lote y vencimiento. */
const INSTRUCCION_CAJA_CON_LOTE = COMUN +
    'Esta foto es del ROTULO de la CAJA.\n' +
    CAJA_BARRAS +
    '- El LOTE suele venir despues de la palabra LOTE, L o LOT. Es un codigo de digitos y letras ' +
    'de entre 8 y 12 caracteres. Copia solo el codigo, sin la palabra LOTE.\n' +
    '- No confundas con el lote los codigos cortos tipo FX15 o FX12 -unidades por funda- ni ' +
    '"ESTIBA MAX: 4 PISOS". Si el unico codigo que ves es de esos, dejá "lote" vacio.';

const ESQUEMA = {
    type: 'object',
    properties: {
        lote: { type: 'string' },
        vence: { type: 'string' },
        codigoBarras: { type: 'string' },
        elaboracion: { type: 'string' },
        legible: { type: 'boolean' },
        confianza: { type: 'number' },
        nota: { type: 'string' },
    },
    required: ['lote', 'vence', 'legible'],
};

const limpio = (s, max) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

/**
 * Foto del envase o de la caja -> lo que dice.
 * { imageBase64, mimeType, donde, conLote } -> { lote, vence, codigoBarras,
 *   elaboracion, legible, confianza, nota }
 *
 * `donde` ('envase' | 'caja') cambia la instruccion, porque las fotos no llevan
 * lo mismo. Para la caja, `conLote` dice si ese rotulo lleva lote: en Fabuloso
 * si, en Control GMP no.
 */
export async function leerLoteVence(p) {
    validar(p);
    const esCaja = p.donde === 'caja';
    const conLote = esCaja && p.conLote === true;
    const r = await preguntar({
        instruccion: !esCaja ? INSTRUCCION_ENVASE
            : conLote ? INSTRUCCION_CAJA_CON_LOTE : INSTRUCCION_CAJA,
        pedido: !esCaja
            ? 'Transcribí el lote y el vencimiento impresos en este envase:'
            : conLote
                ? 'Transcribí el código de barras, el lote y el vencimiento de este rótulo:'
                : 'Transcribí el vencimiento y el número del código de barras de este sticker:',
        p,
        esquema: ESQUEMA,
        // Cero temperatura: se quiere la lectura mas probable, sin variantes.
        temperatura: 0,
    });
    return {
        // Donde no hay lote, no vuelve lote: si el modelo igual devolvio algo,
        // se descarta aca y no en la pantalla, para que no llegue por ningun
        // camino.
        lote: (esCaja && !conLote) ? '' : limpio(r.lote, 40),
        vence: limpio(r.vence, 40),
        codigoBarras: esCaja ? limpio(r.codigoBarras, 20).replace(/\D/g, '') : '',
        elaboracion: limpio(r.elaboracion, 40),
        legible: r.legible !== false,
        confianza: Number.isFinite(r.confianza) ? Math.min(Math.max(r.confianza, 0), 1) : null,
        nota: limpio(r.nota, 300),
    };
}
