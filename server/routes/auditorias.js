/**
 * Auditorías (SOP-AC-035 V4.0) — migracion 051.
 *
 * La pantalla trabaja con listas completas en memoria y las guarda enteras;
 * aca cada lista es una fila de aud_colecciones con su `version`. Al guardar
 * hay que mandar la version que se leyo: si otra persona guardo mientras
 * tanto, se rechaza con 409 y la pantalla recarga en vez de pisarle el trabajo
 * (la leccion de Estabilidad, migracion 023).
 *
 * Lo que decide quien puede que: ver para mirar, cargar para escribir,
 * administrar para la configuracion y para importar el año.
 */
import { Router } from 'express';
import { consultar, enTransaccion } from '../db.js';
import { exigirPermiso } from '../lib/acceso.js';
import { PERMISOS_POR_ROL } from '../lib/permisos.js';
import { nombreComparable } from '../lib/firmas.js';

export const rutasAuditorias = Router();

const RECURSO = 'auditorias';
const leer = exigirPermiso(RECURSO, 'ver');
const cargar = exigirPermiso(RECURSO, 'cargar');
const administrar = exigirPermiso(RECURSO, 'administrar');

// Las listas que maneja la pantalla. Solo estas: un nombre libre dejaria que
// cualquiera escriba lo que quiera en la base.
const COLECCIONES = new Set([
    'auditorias', 'hallazgos', 'acciones', 'autoinspecciones',
    'autoinspecciones_hallazgos', 'programa_sectores', 'config',
]);
// La configuracion define clasificaciones, sectores y equipos: la toca quien
// administra, no el turno.
const SOLO_ADMIN = new Set(['config']);

const quien = (req) => req.usuario.nombre || req.usuario.usuario;

function fallo(status, mensaje) {
    const e = new Error(mensaje);
    e.status = status;
    return e;
}
function responder(err, res, next) {
    if (err.status) return res.status(err.status).json({ ok: false, error: err.message });
    next(err);
}

async function registrar(c, req, accion, entidad, detalle) {
    await c.query(
        `INSERT INTO aud_actividad (usuario, accion, entidad, detalle) VALUES ($1,$2,$3,$4)`,
        [quien(req), accion, entidad || null, detalle || null]
    );
}

/** GET /api/auditorias/datos — todo lo que la pantalla necesita para arrancar. */
rutasAuditorias.get('/datos', leer, async (req, res, next) => {
    try {
        const { rows } = await consultar('SELECT nombre, datos, version FROM aud_colecciones');
        const colecciones = {};
        for (const f of rows) colecciones[f.nombre] = { datos: f.datos, version: Number(f.version) };
        const { rows: imp } = await consultar('SELECT importado_en, detalle FROM aud_importacion');
        res.json({
            ok: true,
            nombre: quien(req),
            permisos: PERMISOS_POR_ROL[req.rol] || [],
            colecciones,
            importado: imp[0] || null,
        });
    } catch (err) { next(err); }
});

/**
 * PUT /api/auditorias/coleccion/:nombre  { version, datos, detalle }
 *
 * `version` es la que tenia la pantalla al leer. Si no coincide, alguien
 * guardo en el medio: se responde 409 con lo que hay ahora.
 */
rutasAuditorias.put('/coleccion/:nombre', cargar, async (req, res, next) => {
    const nombre = String(req.params.nombre || '');
    try {
        if (!COLECCIONES.has(nombre)) throw fallo(400, `Colección desconocida: ${nombre}`);
        if (SOLO_ADMIN.has(nombre) && !(PERMISOS_POR_ROL[req.rol] || []).includes('administrar')) {
            throw fallo(403, 'La configuración la cambia quien administra la app');
        }
        const datos = req.body?.datos;
        if (datos === undefined || datos === null) throw fallo(400, 'Faltan los datos');
        const version = Number(req.body?.version);

        const resultado = await enTransaccion(async (c) => {
            const { rows } = await c.query(
                'SELECT version, datos FROM aud_colecciones WHERE nombre = $1 FOR UPDATE', [nombre]
            );
            const actual = rows[0];
            if (actual && Number.isFinite(version) && Number(actual.version) !== version) {
                throw fallo(409, 'Alguien más guardó cambios mientras tanto: se recargan los datos para no pisarlos');
            }
            const { rows: act } = await c.query(
                `INSERT INTO aud_colecciones (nombre, datos, version, actualizado_por)
                 VALUES ($1, $2, 1, $3)
                 ON CONFLICT (nombre) DO UPDATE SET
                    datos = EXCLUDED.datos,
                    version = aud_colecciones.version + 1,
                    actualizado_por = EXCLUDED.actualizado_por,
                    actualizado_en = now()
                 RETURNING version`,
                [nombre, JSON.stringify(datos), quien(req)]
            );
            const cuantos = Array.isArray(datos) ? `${datos.length} registro(s)` : 'configuración';
            await registrar(c, req, 'GUARDAR', nombre, String(req.body?.detalle || cuantos).slice(0, 500));
            return Number(act[0].version);
        });
        res.json({ ok: true, version: resultado });
    } catch (err) {
        if (err.status === 409) {
            const { rows } = await consultar('SELECT datos, version FROM aud_colecciones WHERE nombre = $1', [nombre]);
            return res.status(409).json({
                ok: false, error: err.message,
                actual: rows[0] ? { datos: rows[0].datos, version: Number(rows[0].version) } : null,
            });
        }
        responder(err, res, next);
    }
});

/**
 * POST /api/auditorias/firmas  { nombres: [...], fecha, codigo }
 *
 * Las firmas electrónicas para el informe REG-035-C: las mismas de la tabla
 * `firmas` que usan Graneles y los demás registros, cargadas una sola vez
 * desde Graneles → Firmas. Se busca por nombre porque el informe guarda el
 * nombre del auditor, no su usuario; quien no tenga firma registrada sale con
 * el renglón en blanco para firmar a mano, en vez de aparentar una firma.
 */
rutasAuditorias.post('/firmas', leer, async (req, res, next) => {
    const nombres = (Array.isArray(req.body?.nombres) ? req.body.nombres : [])
        .map((n) => String(n || '').trim()).filter(Boolean).slice(0, 12);
    const fecha = String(req.body?.fecha || '').slice(0, 10);
    try {
        const { rows } = await consultar(
            'SELECT usuario_id, nombre, cargo, imagen, cargada_en, reemplazada_en FROM firmas ORDER BY cargada_en'
        );
        const instante = /^\d{4}-\d{2}-\d{2}$/.test(fecha) ? new Date(`${fecha}T12:00:00Z`) : new Date();
        const firmas = [];
        for (const nombre of nombres) {
            const esperado = nombreComparable(nombre);
            // Un mismo nombre puede tener firmas sucesivas: vale la que estaba
            // vigente cuando se hizo la auditoría.
            const propias = rows.filter((f) => nombreComparable(f.nombre) === esperado);
            const vigente = propias.find((f) => new Date(f.cargada_en) <= instante
                && (!f.reemplazada_en || new Date(f.reemplazada_en) > instante));
            const f = vigente || propias[0] || null;
            firmas.push({
                nombre, cargo: f?.cargo || '', imagen: f?.imagen || '',
                sinFirma: !f, posterior: Boolean(f && !vigente),
            });
        }
        if (req.body?.codigo) {
            await enTransaccion((c) => registrar(c, req, 'IMPRIMIR', 'Informe',
                `${String(req.body.codigo).slice(0, 40)} · ${firmas.filter((f) => !f.sinFirma).length} firma(s)`));
        }
        res.json({ ok: true, firmas });
    } catch (err) { next(err); }
});

/** GET /api/auditorias/actividad — la bitácora de la app. */
rutasAuditorias.get('/actividad', leer, async (req, res, next) => {
    try {
        const limite = Math.min(Math.max(Number(req.query.limite) || 300, 1), 2000);
        const { rows } = await consultar(
            'SELECT ts, usuario, accion, entidad, detalle FROM aud_actividad ORDER BY ts DESC LIMIT $1',
            [limite]
        );
        res.json({ ok: true, actividad: rows });
    } catch (err) { next(err); }
});

/**
 * POST /api/auditorias/importar  { colecciones, confirmar }
 * El año que estaba dentro del HTML viejo. Una sola vez; sin `confirmar`
 * cuenta lo que entraria.
 */
rutasAuditorias.post('/importar', administrar, async (req, res, next) => {
    const entrada = req.body?.colecciones || {};
    try {
        const { rows: ya } = await consultar('SELECT importado_en FROM aud_importacion');
        if (ya.length) throw fallo(409, `El año ya se importó el ${String(ya[0].importado_en).slice(0, 10)}`);

        const resumen = {};
        for (const [nombre, datos] of Object.entries(entrada)) {
            if (!COLECCIONES.has(nombre)) continue;
            resumen[nombre] = Array.isArray(datos) ? datos.length : 1;
        }
        if (!Object.keys(resumen).length) throw fallo(400, 'No hay nada para importar');
        if (req.body?.confirmar !== true) return res.json({ ok: true, preview: resumen });

        await enTransaccion(async (c) => {
            for (const [nombre, datos] of Object.entries(entrada)) {
                if (!COLECCIONES.has(nombre)) continue;
                await c.query(
                    `INSERT INTO aud_colecciones (nombre, datos, actualizado_por)
                     VALUES ($1, $2, $3)
                     ON CONFLICT (nombre) DO UPDATE SET
                        datos = EXCLUDED.datos, version = aud_colecciones.version + 1,
                        actualizado_por = EXCLUDED.actualizado_por, actualizado_en = now()`,
                    [nombre, JSON.stringify(datos), quien(req)]
                );
            }
            await c.query(
                'INSERT INTO aud_importacion (importado_por, detalle) VALUES ($1, $2)',
                [quien(req), Object.entries(resumen).map(([k, v]) => `${k}: ${v}`).join(', ')]
            );
            await registrar(c, req, 'IMPORTAR', 'historial',
                Object.entries(resumen).map(([k, v]) => `${k}: ${v}`).join(', '));
        });
        res.json({ ok: true, importado: resumen });
    } catch (err) { responder(err, res, next); }
});
