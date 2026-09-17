/**
 * Compresion de las fotos que se guardan en la base (Claudia, 17/09/2026: "lo
 * mas que se pueda").
 *
 * Las fotos son evidencia: tiene que poder leerse el lote y el vencimiento
 * impresos. El punto elegido es 800 px del lado mayor -el mismo que ya usaban
 * las apps- y WebP calidad 55, que a ese tamaño deja el texto legible y pesa
 * bastante menos que el JPEG 60-72 que se guardaba.
 *
 * Una foto que ya llega en WebP y liviana (la comprime el celular) no se vuelve
 * a comprimir: cada pasada con perdida borronea un poco mas el texto.
 *
 * Si `sharp` no esta instalado, la foto se guarda como llego.
 */
const LADO_MAX = 800;
const CALIDAD = 55;
const YA_LIVIANA = 150 * 1024;

let sharp = null;
try {
    sharp = (await import('sharp')).default;
} catch (err) {
    console.warn('[fotos] sharp no esta disponible, las fotos se guardan sin recomprimir:', err.message);
}

/**
 * Devuelve { bytes, tipo } comprimidos, o los originales si comprimir no
 * achica o no se puede.
 */
export async function comprimirFoto(bytes, tipo) {
    if (!sharp) return { bytes, tipo };
    if (tipo === 'image/webp' && bytes.length <= YA_LIVIANA) return { bytes, tipo };
    try {
        const salida = await sharp(bytes, { failOn: 'error' })
            .rotate()
            .resize({ width: LADO_MAX, height: LADO_MAX, fit: 'inside', withoutEnlargement: true })
            .webp({ quality: CALIDAD, effort: 6 })
            .toBuffer();
        return salida.length < bytes.length ? { bytes: salida, tipo: 'image/webp' } : { bytes, tipo };
    } catch (err) {
        console.warn('[fotos] no se pudo recomprimir una foto, se guarda como llego:', err.message);
        return { bytes, tipo };
    }
}

export const hayCompresion = () => Boolean(sharp);
