/**
 * Lectura de planillas de capacitacion (REG-SOP-AC-039-A) con IA.
 *
 * Reemplaza a `ocrForm_` y `bulkForm_` del Apps Script de capacitaciones. Usa las
 * mismas instrucciones y devuelve el mismo formato, asi la app no cambia como
 * usa lo que vuelve. Lo que cambia es donde corre.
 *
 * Por que se mudo: la carga masiva de un PDF escaneado terminaba con Apps Script
 * cortando la ejecucion antes de responder -Google devolvia una pagina de error
 * HTML en vez de datos- y la app solo decia "Sin respuesta del backend". Desde
 * el servidor hay tope de espera propio, el error llega con el motivo, y
 * capacitaciones deja de depender de Apps Script.
 *
 * Tres diferencias con el script, las tres a proposito:
 *   - La clave viaja en un encabezado y no en la URL: una URL con la clave
 *     termina escrita en cualquier registro intermedio.
 *   - Se pide razonamiento BAJO. El script no lo fijaba y lo decidia el modelo;
 *     para leer un formulario no hace falta mas, y es lo que mas pesa en la
 *     demora.
 *   - Tope de espera explicito. UrlFetchApp podia quedar esperando hasta que
 *     Apps Script mataba la ejecucion, sin decir nada.
 *
 * Lo que sale hacia Google es lo mismo que ya salia por el Apps Script: la
 * imagen del formulario y la lista de nombres del padron como pista.
 */

const MODELO = process.env.GEMINI_MODELO || 'gemini-3.6-flash';
const ESPERA_MS = Number(process.env.GEMINI_ESPERA_MS) || 240000;

// Gemini acepta hasta ~20 MB por pedido con el archivo adentro. En base64 eso
// son unos 14 MB de archivo, dejando lugar para el texto de la instruccion.
const MAX_BASE64 = 19 * 1024 * 1024;
const TIPOS = /^(image\/(jpeg|png|webp|heic|heif)|application\/pdf)$/;

export class ErrorLectura extends Error {
    constructor(mensaje, estado) {
        super(mensaje);
        this.estado = estado;
    }
}

export function lecturaConfigurada() {
    return !!process.env.GEMINI_API_KEY;
}

function validar(p) {
    if (!process.env.GEMINI_API_KEY) {
        throw new ErrorLectura('El servidor no tiene configurada la clave de la IA (GEMINI_API_KEY en Coolify).', 503);
    }
    if (!p || typeof p.imageBase64 !== 'string' || !p.imageBase64) {
        throw new ErrorLectura('No llegó el archivo.', 400);
    }
    if (!TIPOS.test(String(p.mimeType || ''))) {
        throw new ErrorLectura(`Tipo de archivo no admitido (${p.mimeType || 'sin tipo'}). Solo PDF o imagen.`, 400);
    }
    if (p.imageBase64.length > MAX_BASE64) {
        throw new ErrorLectura('El archivo es demasiado grande para leerlo de una vez (máximo unos 14 MB). Partilo en varios.', 413);
    }
}

const lista = (x) => (Array.isArray(x) ? x.map((v) => String(v)) : []);

/** Manda el archivo con la instruccion y devuelve el JSON que armo el modelo. */
async function preguntar({ instruccion, pedido, p, esquema, temperatura }) {
    const cuerpo = {
        contents: [{
            role: 'user',
            parts: [
                { text: instruccion + '\n\n' + pedido },
                { inlineData: { mimeType: p.mimeType, data: p.imageBase64 } },
            ],
        }],
        generationConfig: {
            temperature: temperatura,
            responseMimeType: 'application/json',
            responseSchema: esquema,
            thinkingConfig: { thinkingLevel: 'low' },
        },
    };
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(MODELO)}:generateContent`;

    let res, texto;
    try {
        res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY },
            body: JSON.stringify(cuerpo),
            signal: AbortSignal.timeout(ESPERA_MS),
        });
        texto = await res.text();
    } catch (err) {
        if (err.name === 'TimeoutError' || err.name === 'AbortError') {
            throw new ErrorLectura(
                `La IA no terminó de leer el archivo en ${Math.round(ESPERA_MS / 60000)} minutos. Probá con menos páginas por archivo.`, 504);
        }
        throw new ErrorLectura('No se pudo contactar a la IA de Google: ' + err.message, 502);
    }

    if (!res.ok) {
        // Google explica el motivo en el cuerpo: clave invalida, cuota, modelo
        // inexistente. Se toma el mensaje y no el cuerpo entero, que es largo.
        let motivo = texto.slice(0, 300);
        try { motivo = JSON.parse(texto).error?.message || motivo; } catch { /* queda el texto crudo */ }
        throw new ErrorLectura(`La IA de Google rechazó el pedido (HTTP ${res.status}): ${motivo}`, 502);
    }

    let datos;
    try { datos = JSON.parse(texto); } catch {
        throw new ErrorLectura('La IA devolvió algo que no son datos.', 502);
    }
    const candidato = (datos.candidates || [])[0];
    // Con razonamiento activo puede venir una parte de "pensamiento" antes de la
    // respuesta: se toma la que no lo es.
    const parte = candidato?.content?.parts?.find((x) => typeof x.text === 'string' && !x.thought);
    if (!parte) {
        const razon = candidato?.finishReason || datos.promptFeedback?.blockReason || 'sin detalle';
        throw new ErrorLectura(`La IA no devolvió resultado (${razon}).`, 502);
    }
    try {
        return JSON.parse(parte.text);
    } catch {
        throw new ErrorLectura('La IA devolvió un resultado que no se pudo interpretar.', 502);
    }
}

/**
 * Foto de UNA planilla firmada -> asistentes.
 * Igual que ocrForm_: devuelve { attendees: [{ name, sector, confidence }], count }.
 */
export async function leerAsistentes(p) {
    validar(p);
    const sectores = lista(p.sectors);
    const personal = lista(p.personal);

    const instruccion =
        'Eres un asistente que lee formularios de asistencia a capacitaciones de la empresa Vessena (planta farmacéutica en Uruguay). ' +
        'El formulario es REGSOPAC-039A y tiene una tabla con columnas: Fecha | Nombre | Firma | Sector | Nota. ' +
        'Tu tarea: leer CADA FILA de asistentes escrita a mano y devolver el nombre completo y el sector. ' +
        '\n\nReglas:' +
        '\n- Ignorá la columna Firma (son garabatos, no texto).' +
        '\n- Ignorá filas totalmente vacías.' +
        '\n- Si una fila tiene solo firma sin nombre legible, no la incluyas.' +
        '\n- Devolvé el nombre en MAYÚSCULAS, tal como aparece.' +
        '\n- Si tenés duda sobre una letra manuscrita, elegí la interpretación más probable.' +
        '\n- Para el sector, normalizá al valor más cercano de esta lista si es evidente: ' + sectores.join(', ') + '.' +
        '\n- Si tenés una lista de nombres del personal registrado, usá esa lista como pista para desambiguar letras poco claras (pero NO inventes nombres que no están escritos).' +
        (personal.length ? '\n- Personal registrado (usar como referencia): ' + personal.slice(0, 300).join('; ') : '') +
        '\n- confidence: 0.0-1.0, tu certeza sobre la lectura del nombre.';

    const esquema = {
        type: 'object',
        properties: {
            attendees: {
                type: 'array',
                items: {
                    type: 'object',
                    properties: {
                        name: { type: 'string' },
                        sector: { type: 'string' },
                        confidence: { type: 'number' },
                    },
                    required: ['name'],
                },
            },
        },
        required: ['attendees'],
    };

    const r = await preguntar({ instruccion, pedido: 'Extraé los asistentes de esta imagen:', p, esquema, temperatura: 0.1 });
    const attendees = (r.attendees || []).map((a) => ({
        name: String(a.name || '').toUpperCase().trim(),
        sector: String(a.sector || '').toUpperCase().trim(),
        confidence: typeof a.confidence === 'number' ? a.confidence : 0.7,
    })).filter((a) => a.name.length >= 3);
    return { attendees, count: attendees.length };
}

/**
 * PDF (una planilla por pagina) o foto -> sesiones completas con asistentes.
 * Igual que bulkForm_: devuelve { sessions: [...], count }.
 */
export async function leerSesiones(p) {
    validar(p);
    const sectores = lista(p.sectors);
    const personal = lista(p.personal);
    const temas = lista(p.temasConocidos);

    const instruccion =
        'Eres un asistente que lee formularios de asistencia a capacitaciones (REGSOPAC-039A) de Vessena S.A., planta farmacéutica en Uruguay.\n\n' +
        'ESTRUCTURA DE CADA PÁGINA:\n' +
        '- Encabezado con: Duración (ej: "1.5h", "30 min", "20\'"), tipo (Teórico/Práctico/Teórico-práctico), modalidad (Grupal/Estudio Personal), Manual de inducción, Inducción GMP, Capacitación en Procedimientos o Instructivos, Código (ej: SOP-AC-026), Versión, "Otro (indicar)" (con nombre del tema en texto libre), Evaluación (Escrita/Oral/Práctica), Puntaje de aprobación, Responsable, Firma del responsable, Dpto/Cargo.\n' +
        '- Tabla de asistentes con columnas: Fecha | Nombre | Firma | Sector | Nota.\n\n' +
        'TU TAREA: para CADA página del archivo (si es PDF multipágina), devolver UN objeto de sesión con TODA la metadata + la lista de asistentes.\n\n' +
        'REGLAS PARA LA METADATA:\n' +
        '- fecha: la fecha PRINCIPAL de la sesión. Si en el encabezado no hay una sola fecha clara, usá la fecha más común entre los asistentes (columna Fecha de la tabla). Formato ISO yyyy-mm-dd. Si en la tabla figura dd/mm/yy, convertí a yyyy-mm-dd (asumí año 2000+ salvo evidencia contraria).\n' +
        '- tema: elegí el título/tema principal. Miralo en este orden: (a) texto en "Otro (indicar)"; (b) si están marcados "Manual de inducción" / "Inducción GMP" / "Capacitación en Procedimientos o Instructivos", usá ese texto; (c) si hay solo un código (SOP/MAN), usá el código como tema.\n' +
        '- descripcion: texto largo del tema (lo escrito a mano en "Otro (indicar)" o similar).\n' +
        '- codigo: código del documento (ej "SOP-AC-026"). Vacío si no hay.\n' +
        '- duracionHoras: número decimal en HORAS. "30 min" → 0.5. "1.5h" → 1.5. "20\'" → 0.33. Si no se ve, 0.\n' +
        '- tipo: uno de "TEORICO", "PRACTICO", "TEORICO-PRACTICO". Mirá los tildes/cruces (✓, X) sobre los cuadros del encabezado.\n' +
        '- evaluacion: uno de "NO APLICA", "ESCRITA", "ORAL", "PRACTICA".\n' +
        '- puntajeMin: número (ej: 70 si dice "70%"). 0 si no aplica.\n' +
        '- responsable: nombre en MAYÚSCULAS del responsable (escrito a mano al lado de "Responsable").\n' +
        '- pagina: número de página en el PDF (1-based). Si es imagen suelta, 1.\n\n' +
        'REGLAS PARA ASISTENTES:\n' +
        '- Extraé CADA fila de la tabla que tenga nombre legible. Ignorá filas vacías o solo con firma.\n' +
        '- nombre: MAYÚSCULAS, nombre completo tal como aparece. Si tenés duda, elegí la interpretación más probable.\n' +
        '- sector: MAYÚSCULAS. Normalizá al valor más cercano de esta lista si es evidente: ' + sectores.join(', ') + '.\n' +
        '  Ejemplos de normalización: "OP MANT" → "MANTENIMIENTO", "MC" → "MICROBIOLOGIA", "DT" → "DIRECCIÓN TÉCNICA" o dejá "DT" si no hay match.\n' +
        '- nota: solo si hay número en la columna Nota (ej: "100%" → "100"). Vacío si no.\n' +
        (personal.length ? '\n- Personal registrado (usá como referencia para desambiguar letra fea, NO inventes nombres): ' + personal.slice(0, 300).join('; ') + '\n' : '') +
        (temas.length ? '\n- Temas conocidos en el sistema (mapeá al más cercano si evidente): ' + temas.join('; ') + '\n' : '') +
        '\nSi el archivo NO es un formulario REGSOPAC-039A, devolvé sessions: [].';

    const esquema = {
        type: 'object',
        properties: {
            sessions: {
                type: 'array',
                items: {
                    type: 'object',
                    properties: {
                        pagina: { type: 'integer' },
                        fecha: { type: 'string' },
                        tema: { type: 'string' },
                        descripcion: { type: 'string' },
                        codigo: { type: 'string' },
                        duracionHoras: { type: 'number' },
                        tipo: { type: 'string' },
                        evaluacion: { type: 'string' },
                        puntajeMin: { type: 'number' },
                        responsable: { type: 'string' },
                        asistentes: {
                            type: 'array',
                            items: {
                                type: 'object',
                                properties: {
                                    nombre: { type: 'string' },
                                    sector: { type: 'string' },
                                    nota: { type: 'string' },
                                },
                                required: ['nombre'],
                            },
                        },
                    },
                    required: ['asistentes'],
                },
            },
        },
        required: ['sessions'],
    };

    const r = await preguntar({ instruccion, pedido: 'Extraé todas las sesiones del archivo:', p, esquema, temperatura: 0.05 });
    const sessions = (r.sessions || []).map((s, i) => ({
        pagina: s.pagina || (i + 1),
        fecha: String(s.fecha || '').trim(),
        tema: String(s.tema || '').trim(),
        descripcion: String(s.descripcion || '').trim(),
        codigo: String(s.codigo || '').trim(),
        duracionHoras: typeof s.duracionHoras === 'number' ? s.duracionHoras : 0,
        tipo: String(s.tipo || '').trim(),
        evaluacion: String(s.evaluacion || '').trim(),
        puntajeMin: typeof s.puntajeMin === 'number' ? s.puntajeMin : 0,
        responsable: String(s.responsable || '').trim(),
        asistentes: (s.asistentes || []).map((a) => ({
            nombre: String(a.nombre || '').toUpperCase().trim(),
            sector: String(a.sector || '').toUpperCase().trim(),
            nota: String(a.nota || '').trim(),
        })).filter((a) => a.nombre.length >= 3),
    }));
    return { sessions, count: sessions.length };
}
