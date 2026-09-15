import { Router } from 'express';
import express from 'express';
import { consultar, enTransaccion } from '../db.js';
import { exigirPermiso } from '../lib/acceso.js';
import { auditar } from '../lib/sesiones.js';
import { hayCorreo, enviar } from '../lib/correo.js';
import { relojLocal, comoDia } from '../lib/tareas.js';
import { dma, esc, BASE, PREFIJO } from '../lib/avisos-control-cambios.js';

/**
 * API de Control de Cambios, sobre Postgres.
 *
 * Reemplaza las cinco acciones del Apps Script compartido con la app vieja de
 * No Conformidades: getAll_CC, saveCC, deleteCC, notifyCC y uploadImg. Hasta el
 * corte la app no la usa; se deja lista para verificarla con los datos reales.
 */
export const rutasControlCambios = Router();

const RECURSO = 'control-cambios';

const leer = exigirPermiso(RECURSO, 'ver');
const escribir = exigirPermiso(RECURSO, 'cargar');
// Borrar un cambio y resembrar desde la replica no son ediciones de turno.
const administrar = exigirPermiso(RECURSO, 'administrar');

const MARCAS_DE_SIEMBRA = ['siembra desde la replica', 'resembrado desde la replica'];

// La app comprime las fotos a 600 px antes de subirlas: lo tipico son decenas de
// KB. 5 MB es techo de seguridad, no la medida esperable.
const MAX_EVIDENCIA = 5 * 1024 * 1024;
const TIPOS_EVIDENCIA = new Set(['image/jpeg', 'image/png', 'image/webp']);
// El limite global de body es 2 MB; se levanta solo donde hace falta.
const cuerpoEvidencia = express.json({ limit: '8mb' });

/** El registro tal como lo espera la app, con la version para detectar choques. */
const aCambio = (f) => ({
    ...f.datos,
    id: Number(f.id),
    numero: f.numero,
    estado: f.estado,
    version: f.version,
});

const anioDe = (fecha) => {
    const m = /^(\d{4})/.exec(String(fecha || ''));
    return m ? Number(m[1]) : null;
};

async function registrar(c, usuario, accion, cambio, detalle) {
    await c.query(
        `INSERT INTO cc_actividad (usuario, accion, cambio, detalle) VALUES ($1,$2,$3,$4)`,
        [usuario, accion, cambio || null, detalle || null]
    );
}

function error(status, mensaje, extra) {
    const e = new Error(mensaje);
    e.status = status;
    e.extra = extra;
    return e;
}

function responderError(res, next, err) {
    if (err.status) return res.status(err.status).json({ ok: false, error: err.message, ...(err.extra || {}) });
    next(err);
}

/* ═══ Lectura ════════════════════════════════════════════════════════════════ */

/** GET /api/control-cambios/datos — todos los cambios, como getAll_CC. */
rutasControlCambios.get('/datos', leer, async (_req, res, next) => {
    try {
        const { rows } = await consultar(
            `SELECT id, numero, estado, datos, version FROM cc_cambios
             ORDER BY anio DESC NULLS LAST, id DESC`
        );
        res.json({ ok: true, ccs: rows.map(aCambio) });
    } catch (err) {
        next(err);
    }
});

/**
 * GET /api/control-cambios/estado — para verificar antes y despues del corte:
 * cuantos hay, cuantos siguen siendo la siembra y cuantos ya escribio la app.
 */
rutasControlCambios.get('/estado', leer, async (_req, res, next) => {
    try {
        const { rows } = await consultar(
            `SELECT count(*)::int AS total,
                    count(*) FILTER (WHERE actualizado_por = ANY($1))::int AS sembrados,
                    count(*) FILTER (WHERE actualizado_por IS NULL OR NOT (actualizado_por = ANY($1)))::int AS escritos_por_la_app,
                    (SELECT count(*)::int FROM cc_adjuntos) AS evidencias_en_base,
                    (SELECT count(*)::int FROM documentos
                      WHERE dominio = 'control_cambios' AND coleccion = 'ccs') AS en_replica
             FROM cc_cambios`,
            [MARCAS_DE_SIEMBRA]
        );
        const { rows: porEstado } = await consultar(
            `SELECT estado, count(*)::int AS n FROM cc_cambios GROUP BY estado ORDER BY estado`
        );
        res.json({ ok: true, ...rows[0], porEstado });
    } catch (err) {
        next(err);
    }
});

/* ═══ Escritura ══════════════════════════════════════════════════════════════ */

/**
 * POST /api/control-cambios/cambio   { cc, version? }
 *
 * Crea o actualiza un cambio. Reemplaza saveCC.
 *
 * - El numero lo asigna el servidor al crear. La app lo calculaba mirando el
 *   maximo que tenia cargado: dos personas creando a la vez llegaban al mismo.
 * - Si llega `version` y no coincide con la guardada, otra persona lo guardo en
 *   el medio: se devuelve 409 con el registro actual en vez de pisarlo.
 */
rutasControlCambios.post('/cambio', escribir, async (req, res, next) => {
    const { cc, version } = req.body || {};
    const usuario = req.usuario.nombre;

    if (!cc || typeof cc !== 'object' || Array.isArray(cc)) {
        return res.status(400).json({ ok: false, error: 'falta el cambio' });
    }
    if (!String(cc.titulo || '').trim()) {
        return res.status(400).json({ ok: false, error: 'el cambio necesita un titulo' });
    }

    try {
        const guardado = await enTransaccion(async (c) => {
            // Serializa las altas: sin esto dos altas simultaneas calculan el
            // mismo numero.
            await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['cc_cambios']);

            const idPedido = Number(cc.id);
            const { rows: previos } = Number.isSafeInteger(idPedido)
                ? await c.query('SELECT * FROM cc_cambios WHERE id = $1 FOR UPDATE', [idPedido])
                : { rows: [] };
            const previo = previos[0];

            if (!previo) {
                const reloj = await relojLocal();
                const anio = Number(comoDia(reloj.hoy).slice(0, 4));
                const { rows: max } = await c.query(
                    `SELECT coalesce(max(substring(numero from '^CC 0*([0-9]+)/')::int), 0) AS n
                     FROM cc_cambios WHERE numero ~ ('^CC [0-9]+/' || $1 || '$')`,
                    [String(anio)]
                );
                const numero = `CC ${String(max[0].n + 1).padStart(3, '0')}/${anio}`;
                const id = Number.isSafeInteger(idPedido) && idPedido > 0 ? idPedido : Date.now();
                const { version: _v, ...resto } = cc;
                const datos = { ...resto, id, numero, estado: cc.estado || 'Solicitado' };

                const { rows } = await c.query(
                    `INSERT INTO cc_cambios (id, numero, estado, anio, datos, actualizado_por)
                     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
                    [id, numero, datos.estado, anioDe(datos.fechaSolicitud) ?? anio, JSON.stringify(datos), usuario]
                );
                await registrar(c, usuario, 'CREAR', numero, datos.titulo);
                return rows[0];
            }

            if (version !== undefined && version !== null && Number(version) !== previo.version) {
                throw error(409, 'otra persona guardo este cambio mientras lo editabas', {
                    actual: aCambio(previo),
                });
            }

            // El numero no se cambia desde la app: identifica el expediente.
            const { version: _v, ...resto } = cc;
            const datos = { ...resto, id: Number(previo.id), numero: previo.numero };
            const estado = datos.estado || previo.estado;

            const { rows } = await c.query(
                `UPDATE cc_cambios
                    SET datos = $2, estado = $3, anio = $4, version = version + 1,
                        actualizado_en = now(), actualizado_por = $5
                  WHERE id = $1 RETURNING *`,
                [previo.id, JSON.stringify({ ...datos, estado }), estado,
                 anioDe(datos.fechaSolicitud) ?? previo.anio, usuario]
            );

            if (estado !== previo.estado) {
                await registrar(c, usuario, 'CAMBIO ESTADO', previo.numero, `${previo.estado} → ${estado}`);
            } else {
                await registrar(c, usuario, 'EDITAR', previo.numero, null);
            }
            return rows[0];
        });

        res.json({ ok: true, cc: aCambio(guardado) });
    } catch (err) {
        responderError(res, next, err);
    }
});

/** DELETE /api/control-cambios/cambio/:id — reemplaza deleteCC. */
rutasControlCambios.delete('/cambio/:id', administrar, async (req, res, next) => {
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id)) return res.status(400).json({ ok: false, error: 'id invalido' });

    try {
        const usuario = req.usuario.nombre;
        const borrado = await enTransaccion(async (c) => {
            const { rows } = await c.query('DELETE FROM cc_cambios WHERE id = $1 RETURNING numero', [id]);
            if (rows[0]) await registrar(c, usuario, 'ELIMINAR', rows[0].numero, null);
            return rows[0];
        });
        if (!borrado) return res.status(404).json({ ok: false, error: 'no existe' });

        await auditar(req, {
            usuarioId: req.usuario.id, usuarioTxt: req.usuario.usuario,
            accion: 'cc_eliminar', recurso: RECURSO, detalle: borrado.numero,
        });
        res.json({ ok: true });
    } catch (err) {
        next(err);
    }
});

/* ═══ Aviso de asignacion ════════════════════════════════════════════════════ */

function mailDeAsignacion(cambio, r) {
    const titulo = `Tarea asignada: ${cambio.numero} — ${cambio.titulo || ''}`;
    const fila = (k, v) =>
        `<tr><td style="padding:6px 10px;color:#475467;white-space:nowrap">${k}</td>` +
        `<td style="padding:6px 10px"><b>${v}</b></td></tr>`;
    const html = `<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;color:#101828">
        <h2 style="margin:0 0 8px">Se te asignó una tarea en un Control de Cambios</h2>
        <p style="margin:0 0 12px">Hola ${esc(r.nombre || '')}:</p>
        <table style="border-collapse:collapse;font-size:14px">
          ${fila('Cambio', esc(cambio.numero))}
          ${fila('Título', esc(cambio.titulo))}
          ${fila('Tarea', esc(r.tarea))}
          ${fila('Plazo', esc(dma(r.plazo) || r.plazo))}
          ${fila('Estado del cambio', esc(cambio.estado))}
        </table>
        <p style="margin-top:16px;font-size:13px">
          <a href="${BASE}/control_cambios.html">Abrir Control de Cambios</a>
        </p>
      </div>`;
    const texto = `Se te asignó una tarea en un Control de Cambios.\n\n` +
        `Cambio: ${cambio.numero}\nTítulo: ${cambio.titulo || ''}\nTarea: ${r.tarea}\n` +
        `Plazo: ${dma(r.plazo) || r.plazo}\nEstado del cambio: ${cambio.estado}\n\n` +
        `Ver el detalle en ${BASE}/control_cambios.html\n`;
    return { asunto: PREFIJO + titulo, html, texto };
}

const claveTarea = (r) => [r.mail, r.tarea, r.plazo].map((x) => String(x || '').trim().toLowerCase()).join('|');

/**
 * POST /api/control-cambios/cambio/:id/aviso-asignacion
 *
 * Reemplaza notifyCC. El servidor decide a quien avisar mirando el registro
 * guardado -tareas con mail, tarea y plazo que todavia no fueron notificadas- en
 * vez de confiar en la lista que mande el navegador. Marca `_notificado` solo
 * en las que efectivamente salieron.
 */
rutasControlCambios.post('/cambio/:id/aviso-asignacion', escribir, async (req, res, next) => {
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id)) return res.status(400).json({ ok: false, error: 'id invalido' });

    try {
        const { rows } = await consultar('SELECT * FROM cc_cambios WHERE id = $1', [id]);
        if (!rows[0]) return res.status(404).json({ ok: false, error: 'no existe' });
        const cambio = aCambio(rows[0]);

        const pendientes = (cambio.responsables || []).filter((r) =>
            r && String(r.mail || '').includes('@') && String(r.tarea || '').trim() &&
            String(r.plazo || '').trim() && !r._notificado
        );
        if (!pendientes.length) return res.json({ ok: true, enviados: 0, cc: cambio });
        if (!hayCorreo) {
            return res.json({ ok: true, enviados: 0, motivo: 'el servidor no tiene correo configurado', cc: cambio });
        }

        const enviadas = new Set();
        const fallidos = [];
        for (const r of pendientes) {
            try {
                const m = mailDeAsignacion(cambio, r);
                await enviar({ para: String(r.mail).trim(), asunto: m.asunto, html: m.html, texto: m.texto });
                enviadas.add(claveTarea(r));
            } catch (err) {
                console.error(`[control-cambios] no se pudo avisar a ${r.mail}:`, err.message);
                fallidos.push(String(r.mail).trim());
            }
        }

        let actual = rows[0];
        if (enviadas.size) {
            const usuario = req.usuario.nombre;
            actual = await enTransaccion(async (c) => {
                // Se relee con bloqueo: entre el envio y esto alguien pudo guardar.
                const { rows: r2 } = await c.query('SELECT * FROM cc_cambios WHERE id = $1 FOR UPDATE', [id]);
                if (!r2[0]) return rows[0];
                const datos = r2[0].datos;
                datos.responsables = (datos.responsables || []).map((r) =>
                    r && enviadas.has(claveTarea(r)) ? { ...r, _notificado: true } : r
                );
                const { rows: r3 } = await c.query(
                    `UPDATE cc_cambios SET datos = $2, version = version + 1, actualizado_en = now(),
                            actualizado_por = $3
                      WHERE id = $1 RETURNING *`,
                    [id, JSON.stringify(datos), usuario]
                );
                await registrar(c, usuario, 'AVISO ASIGNACION', r2[0].numero, `${enviadas.size} mail(s)`);
                return r3[0];
            });
        }

        res.json({ ok: true, enviados: enviadas.size, fallidos, cc: aCambio(actual) });
    } catch (err) {
        next(err);
    }
});

/* ═══ Evidencias ═════════════════════════════════════════════════════════════ */

/**
 * POST /api/control-cambios/cambio/:id/evidencias   { nombre, tipo, contenido }
 *
 * Reemplaza uploadImg, que subia a Drive. `contenido` en base64. Agrega la
 * evidencia al registro con thumbUrl y viewUrl apuntando aca, para que la app la
 * muestre igual que las de Drive.
 */
rutasControlCambios.post('/cambio/:id/evidencias', escribir, cuerpoEvidencia, async (req, res, next) => {
    const id = Number(req.params.id);
    const { nombre, tipo, contenido } = req.body || {};
    if (!Number.isSafeInteger(id)) return res.status(400).json({ ok: false, error: 'id invalido' });
    if (!nombre || !tipo || !contenido) {
        return res.status(400).json({ ok: false, error: 'faltan nombre, tipo o contenido' });
    }
    if (!TIPOS_EVIDENCIA.has(tipo)) {
        return res.status(415).json({ ok: false, error: 'solo se aceptan imagenes JPG, PNG o WEBP' });
    }
    const bytes = Buffer.from(String(contenido), 'base64');
    if (!bytes.length) return res.status(400).json({ ok: false, error: 'el archivo esta vacio' });
    if (bytes.length > MAX_EVIDENCIA) {
        return res.status(413).json({ ok: false, error: 'la imagen supera los 5 MB' });
    }

    try {
        const usuario = req.usuario.nombre;
        const reloj = await relojLocal();
        const resultado = await enTransaccion(async (c) => {
            const { rows } = await c.query('SELECT * FROM cc_cambios WHERE id = $1 FOR UPDATE', [id]);
            if (!rows[0]) throw error(404, 'el cambio no existe');

            const { rows: adj } = await c.query(
                `INSERT INTO cc_adjuntos (cambio_id, nombre, tipo, tamano, contenido, subido_por)
                 VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
                [id, String(nombre).slice(0, 300), tipo, bytes.length, bytes, usuario]
            );
            const url = `/api/control-cambios/evidencias/${adj[0].id}`;
            const evidencia = {
                adjuntoId: Number(adj[0].id), thumbUrl: url, viewUrl: url,
                nombre: String(nombre).slice(0, 300), fecha: comoDia(reloj.hoy),
                sizeKB: Math.round(bytes.length / 1024),
            };
            const datos = rows[0].datos;
            datos.evidencias = [...(Array.isArray(datos.evidencias) ? datos.evidencias : []), evidencia];

            const { rows: r2 } = await c.query(
                `UPDATE cc_cambios SET datos = $2, version = version + 1, actualizado_en = now(),
                        actualizado_por = $3
                  WHERE id = $1 RETURNING *`,
                [id, JSON.stringify(datos), usuario]
            );
            await registrar(c, usuario, 'ADJUNTAR', rows[0].numero, evidencia.nombre);
            return { evidencia, cambio: r2[0] };
        });

        res.json({ ok: true, evidencia: resultado.evidencia, cc: aCambio(resultado.cambio) });
    } catch (err) {
        responderError(res, next, err);
    }
});

/** GET /api/control-cambios/evidencias/:id — la imagen. */
rutasControlCambios.get('/evidencias/:id', leer, async (req, res, next) => {
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id)) return res.status(400).json({ ok: false, error: 'id invalido' });
    try {
        const { rows } = await consultar('SELECT nombre, tipo, contenido FROM cc_adjuntos WHERE id = $1', [id]);
        if (!rows[0]) return res.status(404).json({ ok: false, error: 'no existe' });
        res.setHeader('Content-Type', rows[0].tipo);
        res.setHeader('Content-Disposition', `inline; filename="${rows[0].nombre.replace(/["\r\n]/g, '')}"`);
        res.setHeader('Cache-Control', 'private, max-age=300');
        res.send(rows[0].contenido);
    } catch (err) {
        next(err);
    }
});

/* ═══ Resembrar ══════════════════════════════════════════════════════════════ */

/**
 * POST /api/control-cambios/resembrar
 *
 * Vuelve a copiar los cambios desde la replica. Es el paso del dia del corte:
 * la siembra de la migracion es una foto del dia del deploy, y la app siguio
 * guardando en el Apps Script despues.
 *
 * Se niega si la app ya escribio algo aca (un cambio guardado por una persona o
 * una evidencia subida): desde ese momento la base es la fuente de verdad y la
 * planilla quedo congelada, asi que copiar seria volver atras. A diferencia de
 * capacitaciones no hay `forzar`: si hiciera falta, se decide y se hace a mano.
 *
 * Tambien elimina los cambios que ya no estan en la replica, siempre que sigan
 * siendo la siembra original. Son cambios borrados en la planilla despues de
 * sembrar (el 15/09 se borraron tres de prueba): si quedaran, el corte arrancaria
 * con registros que ya no existen en el origen. Solo pueden ser siembra, porque
 * la guarda de arriba ya corto si la app escribio algo; igual se filtra por la
 * marca, para que esta ruta nunca pueda borrar algo cargado desde la app. Cada
 * numero eliminado queda en cc_actividad.
 */
rutasControlCambios.post('/resembrar', administrar, async (req, res, next) => {
    try {
        const resultado = await enTransaccion(async (c) => {
            await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['cc_cambios']);

            const { rows: esc1 } = await c.query(
                `SELECT count(*) FILTER (WHERE actualizado_por IS NULL OR NOT (actualizado_por = ANY($1)))::int AS escritos,
                        (SELECT count(*)::int FROM cc_adjuntos) AS evidencias
                 FROM cc_cambios`,
                [MARCAS_DE_SIEMBRA]
            );
            if (esc1[0].escritos || esc1[0].evidencias) {
                throw error(409, 'la app ya escribio en la base: resembrar pisaria lo cargado desde el corte', esc1[0]);
            }

            const { rows: antes } = await c.query('SELECT count(*)::int AS n FROM cc_cambios');
            const { rows: copiados } = await c.query(
                `INSERT INTO cc_cambios (id, numero, estado, anio, datos, actualizado_por)
                 SELECT x.id, x.raw->>'numero',
                        coalesce(nullif(x.raw->>'estado', ''), 'Solicitado'),
                        substring(x.raw->>'fechaSolicitud' from '^([0-9]{4})')::int,
                        jsonb_set(x.raw, '{id}', to_jsonb(x.id)),
                        'resembrado desde la replica'
                 FROM (
                     SELECT CASE WHEN d.raw->>'id' ~ '^[0-9]{1,15}$'
                                 THEN (d.raw->>'id')::bigint
                                 ELSE 900000000000000 + d.id END AS id,
                            d.raw::jsonb AS raw
                     FROM documentos d
                     WHERE d.dominio = 'control_cambios' AND d.coleccion = 'ccs'
                       AND json_typeof(d.raw) = 'object'
                 ) x
                 ON CONFLICT (id) DO UPDATE
                    SET numero = EXCLUDED.numero, estado = EXCLUDED.estado, anio = EXCLUDED.anio,
                        datos = EXCLUDED.datos, version = cc_cambios.version + 1,
                        actualizado_en = now(), actualizado_por = EXCLUDED.actualizado_por
                 RETURNING id`
            );
            if (!copiados.length) throw error(409, 'la replica no tiene cambios: no se toca nada');

            const ids = copiados.map((r) => r.id);

            // Borrados en la planilla despues de sembrar. Solo se eliminan si
            // siguen siendo siembra: la marca es la condicion, no un supuesto.
            const { rows: eliminados } = await c.query(
                `DELETE FROM cc_cambios
                  WHERE NOT (id = ANY($1::bigint[]))
                    AND actualizado_por = ANY($2)
                  RETURNING id, numero, datos->>'titulo' AS titulo`,
                [ids, MARCAS_DE_SIEMBRA]
            );
            for (const e of eliminados) {
                await registrar(c, req.usuario.nombre, 'ELIMINAR', e.numero,
                    `ya no estaba en la planilla al resembrar: ${e.titulo || ''}`);
            }

            // Lo que quede fuera de la replica y no sea siembra no se toca: se
            // informa para decidirlo a mano. Con la guarda de arriba no deberia
            // haber nada.
            const { rows: soloEnBase } = await c.query(
                `SELECT numero FROM cc_cambios WHERE NOT (id = ANY($1::bigint[])) ORDER BY numero`,
                [ids]
            );
            await registrar(c, req.usuario.nombre, 'RESEMBRAR', null,
                `${copiados.length} desde la replica; ${eliminados.length} eliminado(s)`);
            return {
                antes: antes[0].n,
                copiados: copiados.length,
                eliminados: eliminados.map((e) => `${e.numero} — ${e.titulo || ''}`),
                soloEnBase: soloEnBase.map((r) => r.numero),
            };
        });

        res.json({ ok: true, ...resultado });
    } catch (err) {
        responderError(res, next, err);
    }
});
