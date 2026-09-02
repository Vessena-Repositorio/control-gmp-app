import { consultar } from '../db.js';
import { ARCHIVO_POR_RECURSO } from './permisos.js';
import { auditar } from './sesiones.js';

// Indice inverso: del archivo pedido al recurso protegido.
const RECURSO_POR_ARCHIVO = Object.fromEntries(
    Object.entries(ARCHIVO_POR_RECURSO).map(([recurso, archivo]) => [archivo.toLowerCase(), recurso])
);

/**
 * Paginas que se sirven sin sesion. Son las que hacen falta para poder
 * conseguir una: si estuvieran protegidas, nadie podria entrar nunca.
 */
const PUBLICAS = new Set(['index.html', 'cambiar-clave.html']);

/**
 * Gate de las paginas. Se aplica del lado del servidor y no solo en el
 * navegador: esconder un boton no impide que alguien escriba la URL, y el
 * archivo se entregaria igual con todo el JavaScript adentro.
 *
 * index.html queda publica a proposito: es donde esta el formulario de login.
 * Lo que muestre despues de entrar lo decide ella segun el rol.
 */
export async function permitirArchivo(req, res, next) {
    const archivo = (req.rutaArchivo || '').toLowerCase();

    if (PUBLICAS.has(archivo)) return next();

    const recurso = RECURSO_POR_ARCHIVO[archivo];
    // Un .html que no esta en el mapa no es un recurso conocido. Se exige
    // sesion igual: es mas seguro que un archivo nuevo nazca protegido a que
    // nazca abierto porque nadie se acordo de agregarlo.
    // Redirección simple al inicio, que es donde esta el login. Un 401 con
    // cuerpo dejaria al navegador mostrando un error en vez de la pantalla de
    // acceso; `volver` permite retomar a donde iba despues de entrar.
    if (!req.usuario) {
        return res.redirect('/?volver=' + encodeURIComponent(req.path));
    }

    if (!recurso) return next();

    try {
        const { rows } = await consultar(
            'SELECT rol FROM usuario_recursos WHERE usuario_id = $1 AND recurso = $2',
            [req.usuario.id, recurso]
        );

        if (!rows.length) {
            await auditar(req, {
                usuarioId: req.usuario.id,
                usuarioTxt: req.usuario.usuario,
                accion: 'acceso_denegado',
                recurso,
            });
            return res.status(403).type('text/html; charset=utf-8').send(paginaSinPermiso(recurso));
        }

        req.rol = rows[0].rol;
        next();
    } catch (err) {
        next(err);
    }
}

function paginaSinPermiso(recurso) {
    // Se nombra el recurso pero no quien si tiene acceso: eso es informacion
    // sobre la organizacion que no le corresponde a quien no puede entrar.
    return `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sin permiso</title>
<style>
body{font-family:system-ui,-apple-system,sans-serif;background:#0b1120;color:#e4eaf6;
     display:flex;align-items:center;justify-content:center;min-height:100dvh;margin:0;padding:20px}
.c{background:#131d33;border:1px solid #253354;border-radius:14px;padding:26px;max-width:400px;text-align:center}
h1{font-size:18px;margin:0 0 8px}
p{font-size:13px;color:#8494b7;line-height:1.55;margin:0 0 16px}
code{color:#f5a623}
a{color:#2dd4a8;text-decoration:none;font-size:13px}
</style></head><body><div class="c">
<h1>No tenés acceso a esta aplicación</h1>
<p>Tu usuario no tiene un rol asignado en <code>${recurso}</code>.
   Si necesitás entrar, pedile el permiso a un administrador.</p>
<a href="/">← Volver al inicio</a>
</div></body></html>`;
}
