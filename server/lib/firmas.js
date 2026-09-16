/**
 * Firmas registradas (tabla `firmas`, migraciones 028 y 029).
 *
 * Compartido entre las apps que imprimen registros con firma: Aprobacion de
 * Graneles y Control Fabuloso. La imagen de cada persona se carga una sola
 * vez, desde la pestaña Firmas de graneles.
 */
import { consultar } from '../db.js';

/** Nombre comparable: sin tildes, sin mayusculas y sin espacios de mas. */
export const nombreComparable = (s) => String(s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/\s+/g, ' ').trim();

/**
 * La firma de una persona para un momento dado: la que estaba vigente cuando
 * firmo. Si en ese momento todavia no tenia ninguna registrada -muestras
 * firmadas antes de cargar las imagenes- se usa la primera que se registro, y
 * se avisa con `posterior` para que la hoja lo diga en vez de aparentar otra
 * cosa.
 *
 * Solo cuentan las firmas registradas a nombre de quien figura en el registro.
 * Un usuario puede pasar de una persona a otra: analista.minilab@ fue de
 * Lorena Romero y desde el 15/09/2026 lo usa Alexis Araujo. Sin esta condicion
 * un ensayo de Lorena se imprimiria con la firma de Alexis. La comparacion
 * ignora tildes, para que "Núñez" y "Nuñez" sean la misma persona.
 */
export async function firmaDe(usuarioId, instante, nombreEnRegistro) {
    if (!usuarioId) return null;
    const { rows } = await consultar(
        `SELECT cargo, imagen, nombre, cargada_en, reemplazada_en
         FROM firmas WHERE usuario_id = $1 ORDER BY cargada_en`,
        [usuarioId]
    );
    const esperado = nombreComparable(nombreEnRegistro);
    const propias = rows.filter((f) => esperado && nombreComparable(f.nombre) === esperado);
    if (!propias.length) return null;

    const t = new Date(instante || Date.now()).getTime();
    const vigente = propias.find((f) =>
        new Date(f.cargada_en).getTime() <= t &&
        (!f.reemplazada_en || new Date(f.reemplazada_en).getTime() > t));
    const f = vigente || propias[0];
    return {
        cargo: f.cargo,
        imagen: f.imagen,
        imagenCargadaEn: f.cargada_en,
        posterior: !vigente,
    };
}
