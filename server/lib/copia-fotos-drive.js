/**
 * Copia al servidor las fotos viejas de control en proceso que estan en Drive.
 *
 * La app vieja subia cada foto a la carpeta "Fotos GMP" de Drive, compartida
 * con cualquiera que tenga el enlace. Mientras las fotos vivan ahi, el registro
 * depende de esa carpeta y de esa cuenta: si alguien la borra o cambia el
 * permiso, la evidencia desaparece sin que el sistema se entere.
 *
 * Corre en segundo plano y de a pocas fotos a la vez, para no saturar a Google.
 * Si el contenedor se reinicia a mitad de camino, se vuelve a lanzar y sigue
 * donde quedo: las ya copiadas se reconocen por origen_url.
 */
import { consultar, enTransaccion } from '../db.js';
import { comprimirFoto } from './comprimir-foto.js';

const SIMULTANEAS = 3;
const MAX_FOTO = 5 * 1024 * 1024;
const MAX_INTENTOS = 3;
const ESPERA_MS = 30000;

let estado = { enCurso: false, iniciado: null, terminado: null, copiadas: 0, fallidas: 0, total: 0, ultimoError: null, por: null };

/** Id del archivo en un enlace de Drive (/file/d/ID/... u ?id=ID). */
export function idDeDrive(url) {
    const m = /\/d\/([\w-]{10,})/.exec(url) || /[?&]id=([\w-]{10,})/.exec(url);
    return m ? m[1] : null;
}

/** Tipo de imagen segun sus primeros bytes; null si no es una imagen. */
export function tipoDeImagen(b) {
    if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
    if (b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
    if (b.length > 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
    return null;
}

async function descargar(id) {
    const r = await fetch(`https://drive.google.com/uc?export=download&id=${encodeURIComponent(id)}`, {
        redirect: 'follow',
        signal: AbortSignal.timeout(ESPERA_MS),
    });
    if (!r.ok) throw new Error(`Drive respondio HTTP ${r.status}`);
    const bytes = Buffer.from(await r.arrayBuffer());
    if (bytes.length > MAX_FOTO) throw new Error('la foto supera los 5 MB');
    const tipo = tipoDeImagen(bytes);
    // Sin permiso o con el archivo borrado, Drive contesta 200 con una pagina.
    if (!tipo) throw new Error('Drive no devolvio una imagen (archivo borrado o sin permiso)');
    return { bytes, tipo };
}

/** Pendientes: fotos de Drive en controles que todavia no se copiaron. */
export async function contarPendientes() {
    const { rows } = await consultar(
        `SELECT count(*) FILTER (WHERE f.url IS NULL OR f.intentos < $1)::int AS pendientes,
                count(*) FILTER (WHERE f.intentos >= $1)::int AS sin_copia
         FROM proceso_controles c
         CROSS JOIN LATERAL jsonb_array_elements_text(COALESCE(c.raw::jsonb -> 'fotos', '[]'::jsonb)) AS u(url)
         LEFT JOIN proceso_fotos_fallidas f ON f.url = u.url
         WHERE c.origen = 'planilla' AND u.url LIKE 'https://%'`,
        [MAX_INTENTOS]
    );
    const { rows: copiadas } = await consultar(
        'SELECT count(*)::int AS n FROM proceso_fotos WHERE origen_url IS NOT NULL'
    );
    return { ...rows[0], copiadas: copiadas[0].n };
}

export function estadoCopia() {
    return { ...estado };
}

/** Copia una foto (o reutiliza la copia existente) y devuelve su id, o null. */
async function copiarUna(url) {
    const { rows: ya } = await consultar('SELECT id FROM proceso_fotos WHERE origen_url = $1', [url]);
    if (ya.length) return ya[0].id;
    const id = idDeDrive(url);
    try {
        if (!id) throw new Error('enlace de Drive sin id');
        const original = await descargar(id);
        const { bytes, tipo } = await comprimirFoto(original.bytes, original.tipo);
        const { rows } = await consultar(
            `INSERT INTO proceso_fotos (nombre, tipo, tamano, contenido, subida_por, origen_url)
             VALUES ($1, $2, $3, $4, 'copia de Drive', $5)
             ON CONFLICT (origen_url) WHERE origen_url IS NOT NULL DO UPDATE SET origen_url = EXCLUDED.origen_url
             RETURNING id`,
            [`drive_${id}.${tipo.split('/')[1]}`, tipo, bytes.length, bytes, url]
        );
        await consultar('DELETE FROM proceso_fotos_fallidas WHERE url = $1', [url]);
        return rows[0].id;
    } catch (err) {
        estado.ultimoError = err.message;
        await consultar(
            `INSERT INTO proceso_fotos_fallidas (url, error) VALUES ($1, $2)
             ON CONFLICT (url) DO UPDATE SET intentos = proceso_fotos_fallidas.intentos + 1,
                 error = EXCLUDED.error, ultimo_intento = now()`,
            [url, err.message.slice(0, 300)]
        );
        return null;
    }
}

async function copiarControl(control) {
    const fotos = Array.isArray(control.fotos) ? control.fotos.slice(0, 3) : [];
    const drive = Array.isArray(control.fotos_drive) ? control.fotos_drive.slice(0, 3) : [null, null, null];
    let cambio = false;
    for (let i = 0; i < fotos.length; i++) {
        const url = fotos[i];
        if (typeof url !== 'string' || !url.startsWith('https://')) continue;
        const { rows: f } = await consultar('SELECT intentos FROM proceso_fotos_fallidas WHERE url = $1', [url]);
        if (f[0] && f[0].intentos >= MAX_INTENTOS) continue;
        const id = await copiarUna(url);
        if (id) {
            drive[i] = url;
            fotos[i] = `/api/control-en-proceso/fotos/${id}`;
            estado.copiadas++;
            cambio = true;
        } else {
            estado.fallidas++;
        }
    }
    if (!cambio) return;
    while (drive.length < fotos.length) drive.push(null);
    await enTransaccion(async (c) => {
        await c.query(
            `UPDATE proceso_controles
             SET raw = (raw::jsonb || $2::jsonb)::json
             WHERE id = $1`,
            [control.id, JSON.stringify({
                fotos,
                photoLinks: fotos.filter(Boolean),
                fotosDrive: drive,
            })]
        );
    });
}

/**
 * Lanza la copia en segundo plano. Devuelve enseguida; el avance se consulta
 * con estadoCopia().
 */
export async function iniciarCopia(por) {
    if (estado.enCurso) return estadoCopia();
    const { rows } = await consultar(
        `SELECT id, raw::jsonb -> 'fotos' AS fotos, raw::jsonb -> 'fotosDrive' AS fotos_drive
         FROM proceso_controles
         WHERE origen = 'planilla'
           AND EXISTS (SELECT 1 FROM jsonb_array_elements_text(COALESCE(raw::jsonb -> 'fotos', '[]'::jsonb)) u
                       WHERE u LIKE 'https://%')
         ORDER BY id`
    );
    estado = {
        enCurso: true, iniciado: new Date().toISOString(), terminado: null,
        copiadas: 0, fallidas: 0, total: rows.length, ultimoError: null, por,
    };
    const cola = rows.slice();
    const trabajador = async () => {
        while (cola.length) {
            const control = cola.shift();
            try {
                await copiarControl(control);
            } catch (err) {
                estado.ultimoError = err.message;
                estado.fallidas++;
            }
        }
    };
    Promise.all(Array.from({ length: SIMULTANEAS }, trabajador))
        .catch((err) => { estado.ultimoError = err.message; })
        .finally(async () => {
            estado.enCurso = false;
            estado.terminado = new Date().toISOString();
            console.log(`[fotos-drive] copia terminada: ${estado.copiadas} copiadas, ${estado.fallidas} fallidas`);
            await consultar(
                `INSERT INTO proceso_actividad (usuario, accion, entidad, detalles)
                 VALUES ($1, 'fotos_drive_copiadas', 'foto', $2)`,
                [por, JSON.stringify({ copiadas: estado.copiadas, fallidas: estado.fallidas, controles: estado.total })]
            ).catch(() => {});
        });
    return estadoCopia();
}
