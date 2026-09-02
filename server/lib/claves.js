import { scrypt, randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt);

// Parametros de scrypt. N=2^15 con r=8 tarda del orden de 100ms en hardware
// modesto, que es imperceptible en un login y caro de repetir millones de veces
// para quien intente probar claves.
const N = 32768;
const r = 8;
const p = 1;
const LARGO = 32;

// scrypt necesita 128 * N * r bytes = exactamente 32 MB con estos parametros, y
// el limite por defecto de Node es 32 MB: sin subirlo, falla con
// ERR_CRYPTO_INVALID_SCRYPT_PARAMS antes de hashear nada. Se deja el doble para
// tener margen si algun dia se sube N.
const MAXMEM = 64 * 1024 * 1024;

/**
 * Hashea una clave. El resultado se guarda autodescrito:
 *   scrypt$N$r$p$salt$hash
 * Guardar los parametros junto al hash permite subirlos en el futuro sin
 * invalidar las credenciales existentes.
 */
export async function hashear(clave) {
    const salt = randomBytes(16);
    const derivada = await scryptAsync(clave.normalize('NFKC'), salt, LARGO, { N, r, p, maxmem: MAXMEM });
    return `scrypt$${N}$${r}$${p}$${salt.toString('base64')}$${derivada.toString('base64')}`;
}

/** Verifica contra un hash scrypt autodescrito. */
async function verificarScrypt(clave, guardado) {
    const partes = guardado.split('$');
    if (partes.length !== 6 || partes[0] !== 'scrypt') return false;

    const [, sN, sr, sp, salt, hash] = partes;
    const esperado = Buffer.from(hash, 'base64');
    const derivada = await scryptAsync(clave.normalize('NFKC'), Buffer.from(salt, 'base64'),
        esperado.length, { N: +sN, r: +sr, p: +sp, maxmem: MAXMEM });

    // Comparacion en tiempo constante: comparar con === filtra informacion por
    // cuanto tarda en fallar.
    return derivada.length === esperado.length && timingSafeEqual(derivada, esperado);
}

function sha256Hex(texto) {
    return createHash('sha256').update(texto).digest('hex');
}

/**
 * El djb2 con el que estabilidad guardaba los PIN. Solo para verificar.
 *
 * Se reproduce TAL CUAL el original, sin normalizar a entero de 32 bits. Es
 * tentador cerrar con `| 0`, pero el origen no lo hace: `h << 5` si coacciona a
 * int32, y la suma siguiente devuelve a doble, asi que para cadenas largas el
 * acumulador se va del rango y el resultado no es un int32. Agregar `| 0` da
 * otro numero y ninguna clave larga validaria. Verificado contra los datos
 * reales: el PIN '1234' da 2088290703, que es el hash guardado.
 */
function djb2(texto) {
    let h = 5381;
    for (let i = 0; i < texto.length; i++) {
        h = ((h << 5) + h) + texto.charCodeAt(i);
    }
    return String(h);
}

/**
 * Verifica una clave contra la credencial guardada, sea cual sea su esquema.
 *
 * Devuelve { ok, necesitaRehash }. `necesitaRehash` es true cuando la
 * credencial es valida pero esta en un esquema viejo: quien llama debe
 * reescribirla con hashear() para que la proxima vez quede en scrypt.
 */
export async function verificar(clave, esquema, valor) {
    switch (esquema) {
        case 'scrypt':
            return { ok: await verificarScrypt(clave, valor), necesitaRehash: false };
        case 'sha256':
            // El portal hashea en el navegador antes de mandar, asi que lo
            // guardado es sha256(clave) sin sal.
            return { ok: sha256Hex(clave) === String(valor).toLowerCase(), necesitaRehash: true };
        case 'djb2':
            return { ok: djb2(clave) === String(valor), necesitaRehash: true };
        default:
            return { ok: false, necesitaRehash: false };
    }
}

/**
 * Clave inicial legible: cuatro grupos de cuatro caracteres de un alfabeto sin
 * ambiguos (nada de l/I/1, O/0). Se dictan por telefono sin equivocarse y son
 * ~62 bits de entropia, de sobra para una clave que se cambia en el primer uso.
 */
export function generarClave() {
    const alfabeto = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
    const bytes = randomBytes(16);
    let salida = '';
    for (let i = 0; i < 16; i++) {
        if (i > 0 && i % 4 === 0) salida += '-';
        salida += alfabeto[bytes[i] % alfabeto.length];
    }
    return salida;
}
