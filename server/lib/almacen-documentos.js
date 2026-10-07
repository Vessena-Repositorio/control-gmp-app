/**
 * Donde viven los Word y PDF del control de documentos.
 *
 * El contenedor no tiene disco persistente: lo que se escriba en /app se
 * pierde en el proximo deploy. Los archivos van a un volumen de Coolify
 * montado en DOC_DIR (decision del 07/10/2026). Sin DOC_DIR no se acepta
 * ningun archivo: guardarlo donde se va a borrar seria peor que rechazarlo.
 *
 * Cada archivo se guarda con el nombre de su sha256. El mismo archivo subido
 * dos veces ocupa lugar una vez, y un archivo guardado no se pisa nunca: si
 * el contenido cambia, el hash cambia y es otro archivo.
 */
import { createHash } from 'node:crypto';
import { mkdir, writeFile, access, stat, readFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { join, extname, resolve, sep } from 'node:path';

const DIR = process.env.DOC_DIR ? resolve(process.env.DOC_DIR) : null;

export const hayAlmacen = Boolean(DIR);

// Lo que se acepta. Los .doc y .xls viejos estan en la red por cientos.
export const TIPOS = {
    '.pdf': 'application/pdf',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.doc': 'application/msword',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.xls': 'application/vnd.ms-excel',
};

// El mas grande de la red (Z:, 07/10/2026) pesa 102 MB.
export const MAX_BYTES = 150 * 1024 * 1024;

export const extension = (nombre) => extname(String(nombre || '')).toLowerCase();

/** Guarda el contenido y devuelve { ruta, sha256, bytes, mime }. */
export async function guardar(buffer, nombre) {
    if (!DIR) throw Object.assign(new Error('DOC_DIR no configurado: falta el volumen de documentos'), { status: 503 });
    const ext = extension(nombre);
    const mime = TIPOS[ext];
    if (!mime) throw Object.assign(new Error(`tipo de archivo no admitido: ${ext || 'sin extensión'}`), { status: 400 });
    if (!buffer?.length) throw Object.assign(new Error('el archivo está vacío'), { status: 400 });

    const sha256 = createHash('sha256').update(buffer).digest('hex');
    const ruta = `${sha256.slice(0, 2)}/${sha256}${ext}`;
    const destino = join(DIR, ruta);

    try {
        await access(destino);
    } catch {
        await mkdir(join(DIR, sha256.slice(0, 2)), { recursive: true });
        // 'wx' falla si existe: dos subidas simultaneas del mismo archivo no
        // se pisan a medias.
        await writeFile(destino, buffer, { flag: 'wx' }).catch((err) => {
            if (err.code !== 'EEXIST') throw err;
        });
    }
    return { ruta, sha256, bytes: buffer.length, mime };
}

/** Contenido completo de un archivo guardado (para marcar un PDF). */
export async function leer(ruta) {
    if (!DIR) throw Object.assign(new Error('DOC_DIR no configurado'), { status: 503 });
    const completo = resolve(DIR, ruta);
    if (!completo.startsWith(DIR + sep)) throw Object.assign(new Error('ruta inválida'), { status: 400 });
    return readFile(completo);
}

/** Stream de lectura de un archivo guardado, con su tamaño. */
export async function abrir(ruta) {
    if (!DIR) throw Object.assign(new Error('DOC_DIR no configurado'), { status: 503 });
    const completo = resolve(DIR, ruta);
    // La ruta sale de la base, pero igual no se sale del volumen.
    if (!completo.startsWith(DIR + sep)) throw Object.assign(new Error('ruta inválida'), { status: 400 });
    const { size } = await stat(completo);
    return { stream: createReadStream(completo), bytes: size };
}
