import { Router } from 'express';
import express from 'express';
import { consultar, enTransaccion } from '../db.js';
import { exigirPermiso } from '../lib/acceso.js';
import { auditar } from '../lib/sesiones.js';

export const rutasNcDesvios = Router();

const RECURSO = 'no-conformidades-desvios';

const leer = exigirPermiso(RECURSO, 'ver');
const escribir = exigirPermiso(RECURSO, 'cargar');
// Borrar un registro GMP no es una edicion mas: se exige el rol que administra
// la app, no el que carga datos en el turno.
const administrar = exigirPermiso(RECURSO, 'administrar');

// Adjuntos: lo que aceptamos y hasta cuanto. Las fotos se reducen en el
// navegador antes de subirse, asi que 10 MB es techo de seguridad y no la
// medida esperable de un archivo.
const MAX_ADJUNTO = 10 * 1024 * 1024;
const TIPOS_ADJUNTO = new Set([
    'image/jpeg', 'image/png', 'image/webp', 'image/heic', 'application/pdf',
]);

// El limite global de body es 2 MB (index.js) y alcanza para todo menos esto.
// Se levanta solo en la ruta de subida: subirlo para toda la API haria que
// cualquier endpoint acepte cuerpos de 14 MB sin necesitarlo.
const cuerpoAdjunto = express.json({ limit: '14mb' });

/* ═══════════════════════════════════════════════════════════════════════════
   Forma de los registros

   La base parte cada registro en dos: las columnas que se filtran y reportan,
   y `datos` con el resto del formulario. La app no tiene por que saber de esa
   division, asi que se rearma acá: lo que sale de estas funciones es el objeto
   tal como lo espera el front, y lo que entra se vuelve a partir.
   ═══════════════════════════════════════════════════════════════════════════ */

/** Campos que viven en columnas y por lo tanto no se duplican en `datos`. */
const COLUMNAS_NC = new Set([
    'id', 'code', 'phase', 'openDate', 'incidentDate', 'closeDate',
    'sector', 'source', 'classification', 'severity', 'probability',
]);
const COLUMNAS_DEV = new Set([
    'id', 'code', 'phase', 'date', 'closeDate', 'sector', 'critical',
    'decision', 'priority',
]);
const COLUMNAS_CAPA = new Set([
    'id', 'code', 'ncId', 'devId', 'type', 'description', 'responsible',
    'responsibleEmail', 'dueDate', 'status',
]);

/** Deja solo lo que no tiene columna propia. */
function soloDatos(obj, columnas) {
    const resto = {};
    for (const [k, v] of Object.entries(obj || {})) {
        if (!columnas.has(k)) resto[k] = v;
    }
    return resto;
}

/**
 * Las fechas de la app son 'YYYY-MM-DD' o cadena vacia. Postgres rechaza la
 * cadena vacia como DATE, asi que se traduce a NULL; sin esto, guardar una NC
 * sin fecha de cierre falla.
 */
const fecha = (v) => (v && String(v).trim() ? String(v).slice(0, 10) : null);

/** Año de un registro, para el filtro del sidebar. */
const anioDe = (v) => {
    const f = fecha(v);
    return f ? Number(f.slice(0, 4)) : null;
};

const filaANc = (f) => ({
    ...f.datos,
    id: f.id, code: f.code, phase: f.phase,
    openDate: f.open_date, incidentDate: f.incident_date, closeDate: f.close_date,
    sector: f.sector, source: f.source,
    classification: f.classification, severity: f.severity, probability: f.probability,
    actualizadoEn: f.actualizado_en, actualizadoPor: f.actualizado_por,
});

const filaADev = (f) => ({
    ...f.datos,
    id: f.id, code: f.code, phase: f.phase,
    date: f.fecha, closeDate: f.close_date, sector: f.sector,
    critical: f.critico, decision: f.decision, priority: f.prioridad,
    actualizadoEn: f.actualizado_en, actualizadoPor: f.actualizado_por,
});

const filaACapa = (f) => ({
    ...f.datos,
    id: f.id, code: f.code,
    ncId: f.nc_id || '', devId: f.dev_id || '',
    type: f.tipo, description: f.descripcion,
    responsible: f.responsable, responsibleEmail: f.responsable_email,
    dueDate: f.due_date, status: f.estado,
    // Metadatos de la evidencia, sin el contenido: la lista tiene que poder
    // mostrar "2 adjuntos" sin arrastrar los bytes de las fotos.
    adjuntos: f.adjuntos || [],
    actualizadoEn: f.actualizado_en, actualizadoPor: f.actualizado_por,
});

/**
 * Las fechas se devuelven como 'YYYY-MM-DD' y no como Date. El driver de
 * Postgres construye el Date en la zona del servidor, y al serializarlo a JSON
 * en UTC una fecha sin hora puede retroceder un dia. Para una fecha de cierre
 * de una NC eso no es un detalle cosmetico.
 */
const soloDia = (v) => {
    if (!v) return '';
    if (typeof v === 'string') return v.slice(0, 10);
    const y = v.getFullYear();
    const m = String(v.getMonth() + 1).padStart(2, '0');
    const d = String(v.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
};

/* ═══ Códigos ═══════════════════════════════════════════════════════════════
   Se numeran en el servidor, dentro de la transaccion que inserta. Antes los
   calculaba el navegador mirando el maximo que tenia cargado: con dos personas
   creando a la vez, las dos llegaban al mismo numero y la segunda chocaba
   contra la restriccion de unicidad.
   ═══════════════════════════════════════════════════════════════════════════ */

async function proximoCodigo(cliente, tabla, patron, formato, anio) {
    // La numeracion de NC y desvios reinicia cada año, porque el codigo lleva el
    // año adentro (NC-001-2026) y un expediente se identifica por los dos juntos.
    // Las CAPA no: su codigo es una serie unica, sin año, asi que se cuentan
    // todas. De ahi que el filtro por año sea opcional.
    const filtro = anio ? 'WHERE anio = $2' : '';
    const { rows } = await cliente.query(
        `SELECT coalesce(max((substring(code from $1))::int), 0) AS n
         FROM ${tabla} ${filtro}`,
        anio ? [patron, anio] : [patron]
    );
    return formato(rows[0].n + 1);
}

const codigoNC   = (c, anio) => proximoCodigo(c, 'ncd_nc', '^NC-0*(\\d+)',
    (n) => `NC-${String(n).padStart(3, '0')}-${anio}`, anio);
const codigoDev  = (c, anio) => proximoCodigo(c, 'ncd_desvios', '^DES-0*(\\d+)',
    (n) => `DES-${String(n).padStart(3, '0')}-${anio}`, anio);
const codigoCapa = (c) => proximoCodigo(c, 'ncd_capa', '^CAPA-0*(\\d+)',
    (n) => `CAPA-${String(n).padStart(4, '0')}`);

/** Deja constancia en el audit trail de la app. */
async function registrar(cliente, usuario, accion, entidad, detalle) {
    await cliente.query(
        `INSERT INTO ncd_actividad (usuario, accion, entidad, detalle)
         VALUES ($1,$2,$3,$4)`,
        [usuario, accion, entidad, detalle || null]
    );
}

/* ═══════════════════════════════════════════════════════════════════════════
   LECTURA
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * GET /api/nc-desvios/datos?anio=2026
 *
 * Todo lo que la app necesita para pintarse, en una sola vuelta. Son unos
 * cientos de registros por año: pedirlo por partes agregaria latencia y estados
 * intermedios sin ganar nada.
 *
 * Las CAPA no se filtran por año propio sino por el de la NC o el desvio del
 * que cuelgan: una accion abierta en enero de 2027 para una NC de 2026
 * pertenece al expediente de 2026.
 */
rutasNcDesvios.get('/datos', leer, async (req, res, next) => {
    const anio = Number(req.query.anio) || new Date().getFullYear();
    if (!Number.isInteger(anio) || anio < 2000 || anio > 2100) {
        return res.status(400).json({ ok: false, error: 'año invalido' });
    }

    /* Buscando se mira TODA la tabla, no el año que quedo elegido en la
     * pantalla: el codigo de una NC que se esta buscando puede ser de hace dos
     * años, y pedirle a alguien que adivine el año no es buscar (Claudia,
     * 22/10/2026: "no veo los controles de setiembre"). Sin texto, el año
     * manda como siempre.
     *
     * La clave se limpia igual que en la base (clave_busqueda, migracion 067):
     * primero se saca la tilde y despues los signos. Al reves la letra
     * acentuada se perdia entera y el nombre no se encontraba nunca. */
    const q = String(req.query.q || '')
        .normalize('NFD').replace(/[̀-ͯ]/g, '')
        .toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 60);
    const buscando = q !== '';
    // Tope alto y con el total al lado: no es para esconder nada, es para que
    // una busqueda de una letra no arrastre el expediente entero.
    const TOPE = 1000;

    // Los campos libres viven dentro de `datos`, asi que se los nombra uno por
    // uno: buscar sobre el JSON entero haria que "sector" o "description"
    // -nombres de clave- coincidieran con todos los registros.
    const comoNc = `($2 = '' OR clave_busqueda(code) LIKE '%' || $2 || '%'
                            OR clave_busqueda(sector) LIKE '%' || $2 || '%'
                            OR clave_busqueda(source) LIKE '%' || $2 || '%'
                            OR clave_busqueda(datos->>'description') LIKE '%' || $2 || '%'
                            OR clave_busqueda(datos->>'openedBy') LIKE '%' || $2 || '%'
                            OR clave_busqueda(datos->>'lot') LIKE '%' || $2 || '%'
                            OR clave_busqueda(datos->>'associatedItem') LIKE '%' || $2 || '%'
                            OR clave_busqueda(datos->>'rootCause') LIKE '%' || $2 || '%'
                            OR clave_busqueda(datos->>'analysisNotes') LIKE '%' || $2 || '%')`;
    const comoDev = `($2 = '' OR clave_busqueda(code) LIKE '%' || $2 || '%'
                            OR clave_busqueda(sector) LIKE '%' || $2 || '%'
                            OR clave_busqueda(decision) LIKE '%' || $2 || '%'
                            OR clave_busqueda(datos->>'description') LIKE '%' || $2 || '%'
                            OR clave_busqueda(datos->>'openedBy') LIKE '%' || $2 || '%'
                            OR clave_busqueda(datos->>'lot') LIKE '%' || $2 || '%'
                            OR clave_busqueda(datos->>'associatedItem') LIKE '%' || $2 || '%')`;
    const comoCapa = `($2 = '' OR clave_busqueda(c.code) LIKE '%' || $2 || '%'
                            OR clave_busqueda(c.tipo) LIKE '%' || $2 || '%'
                            OR clave_busqueda(c.descripcion) LIKE '%' || $2 || '%'
                            OR clave_busqueda(c.responsable) LIKE '%' || $2 || '%'
                            OR clave_busqueda(c.responsable_email) LIKE '%' || $2 || '%'
                            OR clave_busqueda(c.estado) LIKE '%' || $2 || '%'
                            OR clave_busqueda(c.datos->>'verification') LIKE '%' || $2 || '%'
                            OR clave_busqueda(c.datos->>'effectiveness') LIKE '%' || $2 || '%')`;

    /* Con texto no se filtra por año; sin texto, solo el año. El año va igual
     * en la consulta aunque no se use ($3 lo anula): si se lo sacara del texto
     * de la consulta, $1 quedaria sin tipo y Postgres rechaza el pedido. */
    const delAnio = '($3 OR anio = $1)';

    try {
        const [ncs, devs, capas, actividad, anios] = await Promise.all([
            consultar(
                `SELECT *, count(*) OVER ()::int AS total_filtrado FROM ncd_nc
                 WHERE ${delAnio} AND ${comoNc}
                 ORDER BY open_date DESC, code DESC LIMIT ${TOPE}`,
                [anio, q, buscando]
            ),
            consultar(
                `SELECT *, count(*) OVER ()::int AS total_filtrado FROM ncd_desvios
                 WHERE ${delAnio} AND ${comoDev}
                 ORDER BY fecha DESC, code DESC LIMIT ${TOPE}`,
                [anio, q, buscando]
            ),
            consultar(
                `SELECT c.*,
                        coalesce(
                            (SELECT json_agg(json_build_object(
                                        'id', a.id, 'nombre', a.nombre, 'tipo', a.tipo,
                                        'tamano', a.tamano, 'subidoPor', a.subido_por,
                                        'subidoEn', a.subido_en)
                                     ORDER BY a.subido_en DESC)
                             FROM ncd_adjuntos a WHERE a.capa_id = c.id),
                            '[]'::json) AS adjuntos
                        , count(*) OVER ()::int AS total_filtrado
                 FROM ncd_capa c
                 LEFT JOIN ncd_nc      n ON n.id = c.nc_id
                 LEFT JOIN ncd_desvios d ON d.id = c.dev_id
                 WHERE ($3 OR n.anio = $1 OR d.anio = $1
                    OR (c.nc_id IS NULL AND c.dev_id IS NULL
                        AND date_part('year', c.creado_en) = $1))
                   AND ${comoCapa}
                 ORDER BY c.code LIMIT ${TOPE}`,
                [anio, q, buscando]
            ),
            consultar(
                `SELECT id, ts, usuario, accion, entidad, detalle
                 FROM ncd_actividad ORDER BY ts DESC LIMIT 500`
            ),
            // Los años que tienen algo cargado, para que el selector no ofrezca
            // años vacios ni esconda uno con datos.
            consultar(
                `SELECT DISTINCT anio FROM (
                     SELECT anio FROM ncd_nc WHERE anio IS NOT NULL
                     UNION ALL
                     SELECT anio FROM ncd_desvios WHERE anio IS NOT NULL
                 ) t ORDER BY anio`
            ),
        ]);

        res.json({
            ok: true,
            anio,
            ncs: ncs.rows.map((f) => {
                const o = filaANc(f);
                o.openDate = soloDia(f.open_date);
                o.incidentDate = soloDia(f.incident_date);
                o.closeDate = soloDia(f.close_date);
                return o;
            }),
            devs: devs.rows.map((f) => {
                const o = filaADev(f);
                o.date = soloDia(f.fecha);
                o.closeDate = soloDia(f.close_date);
                return o;
            }),
            capas: capas.rows.map((f) => {
                const o = filaACapa(f);
                o.dueDate = soloDia(f.due_date);
                return o;
            }),
            actividad: actividad.rows,
            anios: anios.rows.map((f) => f.anio),
            // Que alcance tiene lo que se devuelve y cuantos hay en total antes
            // del tope, para que la pantalla pueda decirlo en vez de mostrar
            // una lista corta que se lee como "no hay mas".
            buscando,
            q: buscando ? String(req.query.q || '').trim().slice(0, 60) : '',
            totales: {
                ncs: ncs.rows.length ? ncs.rows[0].total_filtrado : 0,
                devs: devs.rows.length ? devs.rows[0].total_filtrado : 0,
                capas: capas.rows.length ? capas.rows[0].total_filtrado : 0,
            },
            tope: TOPE,
        });
    } catch (err) {
        next(err);
    }
});

/* ═══════════════════════════════════════════════════════════════════════════
   ESCRITURA — No conformidades
   ═══════════════════════════════════════════════════════════════════════════ */

rutasNcDesvios.post('/nc', escribir, async (req, res, next) => {
    const nc = req.body || {};
    // Quien firma sale de la sesion, nunca del cuerpo del pedido: si el cliente
    // eligiera el nombre, el audit trail no probaria nada.
    const usuario = req.usuario.nombre;

    try {
        const guardado = await enTransaccion(async (c) => {
            const esNuevo = !nc.id;
            const id = nc.id || `nc${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
            const anio = anioDe(nc.openDate) ?? new Date().getFullYear();
            const code = esNuevo ? await codigoNC(c, anio) : nc.code;

            // La fase anterior se lee dentro de la transaccion para poder
            // registrar la transicion exacta en el audit trail.
            const previo = esNuevo
                ? null
                : (await c.query('SELECT phase, code FROM ncd_nc WHERE id = $1', [id])).rows[0];

            if (!esNuevo && !previo) {
                const e = new Error('la no conformidad no existe');
                e.status = 404;
                throw e;
            }

            const { rows } = await c.query(
                `INSERT INTO ncd_nc (id, code, phase, anio, open_date, incident_date,
                                     close_date, sector, source, classification,
                                     severity, probability, datos, actualizado_por)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
                 ON CONFLICT (id) DO UPDATE SET
                    phase = EXCLUDED.phase, anio = EXCLUDED.anio,
                    open_date = EXCLUDED.open_date, incident_date = EXCLUDED.incident_date,
                    close_date = EXCLUDED.close_date, sector = EXCLUDED.sector,
                    source = EXCLUDED.source, classification = EXCLUDED.classification,
                    severity = EXCLUDED.severity, probability = EXCLUDED.probability,
                    datos = EXCLUDED.datos, actualizado_por = EXCLUDED.actualizado_por,
                    actualizado_en = now()
                 RETURNING *`,
                [
                    id, code, nc.phase || 'abierta', anio,
                    fecha(nc.openDate), fecha(nc.incidentDate), fecha(nc.closeDate),
                    nc.sector || null, nc.source || null, nc.classification || null,
                    nc.severity || null, nc.probability || null,
                    JSON.stringify(soloDatos(nc, COLUMNAS_NC)), usuario,
                ]
            );

            if (esNuevo) {
                await registrar(c, usuario, 'CREAR', 'No Conformidad', code);
            } else if (previo.phase !== rows[0].phase) {
                await registrar(c, usuario, 'CAMBIO FASE', 'No Conformidad',
                    `${code}: ${previo.phase} → ${rows[0].phase}`);
            } else {
                await registrar(c, usuario, 'EDITAR', 'No Conformidad', code);
            }

            return rows[0];
        });

        const o = filaANc(guardado);
        o.openDate = soloDia(guardado.open_date);
        o.incidentDate = soloDia(guardado.incident_date);
        o.closeDate = soloDia(guardado.close_date);
        res.json({ ok: true, nc: o });
    } catch (err) {
        if (err.status === 404) return res.status(404).json({ ok: false, error: err.message });
        next(err);
    }
});

rutasNcDesvios.delete('/nc/:id', administrar, async (req, res, next) => {
    try {
        const usuario = req.usuario.nombre;
        const borrado = await enTransaccion(async (c) => {
            const { rows } = await c.query(
                'DELETE FROM ncd_nc WHERE id = $1 RETURNING code', [req.params.id]
            );
            if (rows[0]) await registrar(c, usuario, 'ELIMINAR', 'No Conformidad', rows[0].code);
            return rows[0];
        });
        if (!borrado) return res.status(404).json({ ok: false, error: 'no existe' });

        await auditar(req, {
            usuarioId: req.usuario.id, usuarioTxt: req.usuario.usuario,
            accion: 'ncd_eliminar_nc', recurso: RECURSO, detalle: borrado.code,
        });
        res.json({ ok: true });
    } catch (err) {
        next(err);
    }
});

/* ═══════════════════════════════════════════════════════════════════════════
   ESCRITURA — Desvíos
   ═══════════════════════════════════════════════════════════════════════════ */

rutasNcDesvios.post('/desvios', escribir, async (req, res, next) => {
    const dev = req.body || {};
    const usuario = req.usuario.nombre;

    try {
        const guardado = await enTransaccion(async (c) => {
            const esNuevo = !dev.id;
            const id = dev.id || `dev${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
            const anio = anioDe(dev.date) ?? new Date().getFullYear();
            const code = esNuevo ? await codigoDev(c, anio) : dev.code;

            const previo = esNuevo
                ? null
                : (await c.query('SELECT phase FROM ncd_desvios WHERE id = $1', [id])).rows[0];

            if (!esNuevo && !previo) {
                const e = new Error('el desvio no existe');
                e.status = 404;
                throw e;
            }

            const { rows } = await c.query(
                `INSERT INTO ncd_desvios (id, code, phase, anio, fecha, close_date,
                                          sector, critico, decision, prioridad,
                                          datos, actualizado_por)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
                 ON CONFLICT (id) DO UPDATE SET
                    phase = EXCLUDED.phase, anio = EXCLUDED.anio,
                    fecha = EXCLUDED.fecha, close_date = EXCLUDED.close_date,
                    sector = EXCLUDED.sector, critico = EXCLUDED.critico,
                    decision = EXCLUDED.decision, prioridad = EXCLUDED.prioridad,
                    datos = EXCLUDED.datos, actualizado_por = EXCLUDED.actualizado_por,
                    actualizado_en = now()
                 RETURNING *`,
                [
                    id, code, dev.phase || 'abierto', anio,
                    fecha(dev.date), fecha(dev.closeDate), dev.sector || null,
                    Boolean(dev.critical), dev.decision || null, dev.priority || null,
                    JSON.stringify(soloDatos(dev, COLUMNAS_DEV)), usuario,
                ]
            );

            if (esNuevo) {
                await registrar(c, usuario, 'CREAR', 'Desvío', code);
            } else if (previo.phase !== rows[0].phase) {
                await registrar(c, usuario, 'CAMBIO FASE', 'Desvío',
                    `${code}: ${previo.phase} → ${rows[0].phase}`);
            } else {
                await registrar(c, usuario, 'EDITAR', 'Desvío', code);
            }

            return rows[0];
        });

        const o = filaADev(guardado);
        o.date = soloDia(guardado.fecha);
        o.closeDate = soloDia(guardado.close_date);
        res.json({ ok: true, dev: o });
    } catch (err) {
        if (err.status === 404) return res.status(404).json({ ok: false, error: err.message });
        next(err);
    }
});

rutasNcDesvios.delete('/desvios/:id', administrar, async (req, res, next) => {
    try {
        const usuario = req.usuario.nombre;
        const borrado = await enTransaccion(async (c) => {
            const { rows } = await c.query(
                'DELETE FROM ncd_desvios WHERE id = $1 RETURNING code', [req.params.id]
            );
            if (rows[0]) await registrar(c, usuario, 'ELIMINAR', 'Desvío', rows[0].code);
            return rows[0];
        });
        if (!borrado) return res.status(404).json({ ok: false, error: 'no existe' });

        await auditar(req, {
            usuarioId: req.usuario.id, usuarioTxt: req.usuario.usuario,
            accion: 'ncd_eliminar_desvio', recurso: RECURSO, detalle: borrado.code,
        });
        res.json({ ok: true });
    } catch (err) {
        next(err);
    }
});

/* ═══════════════════════════════════════════════════════════════════════════
   ESCRITURA — Acciones (CAPA)
   ═══════════════════════════════════════════════════════════════════════════ */

rutasNcDesvios.post('/capa', escribir, async (req, res, next) => {
    const capa = req.body || {};
    const usuario = req.usuario.nombre;

    if (!capa.description || !String(capa.description).trim()) {
        return res.status(400).json({ ok: false, error: 'la accion necesita una descripcion' });
    }

    // El email del responsable es obligatorio. Sin el, la accion no dispara
    // ningun aviso de vencimiento: el seguimiento queda librado a que alguien
    // se acuerde de mirar el panel, que es justo lo que el aviso viene a
    // reemplazar. Se valida en el servidor y no solo en el formulario porque
    // la API tambien la usa la importacion.
    const emailResp = String(capa.responsibleEmail || '').trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailResp)) {
        return res.status(400).json({
            ok: false,
            error: 'la accion necesita el email del responsable, para poder avisarle del vencimiento',
        });
    }

    try {
        const guardado = await enTransaccion(async (c) => {
            const esNuevo = !capa.id;
            const id = capa.id || `capa${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
            const code = esNuevo ? await codigoCapa(c) : capa.code;

            const previo = esNuevo
                ? null
                : (await c.query('SELECT estado FROM ncd_capa WHERE id = $1', [id])).rows[0];

            if (!esNuevo && !previo) {
                const e = new Error('la accion no existe');
                e.status = 404;
                throw e;
            }

            const { rows } = await c.query(
                `INSERT INTO ncd_capa (id, code, nc_id, dev_id, tipo, descripcion,
                                       responsable, responsable_email, due_date,
                                       estado, datos, actualizado_por)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
                 ON CONFLICT (id) DO UPDATE SET
                    nc_id = EXCLUDED.nc_id, dev_id = EXCLUDED.dev_id,
                    tipo = EXCLUDED.tipo, descripcion = EXCLUDED.descripcion,
                    responsable = EXCLUDED.responsable,
                    responsable_email = EXCLUDED.responsable_email,
                    due_date = EXCLUDED.due_date, estado = EXCLUDED.estado,
                    datos = EXCLUDED.datos, actualizado_por = EXCLUDED.actualizado_por,
                    actualizado_en = now()
                 RETURNING *`,
                [
                    id, code, capa.ncId || null, capa.devId || null,
                    capa.type || null, capa.description, capa.responsible || null,
                    emailResp, fecha(capa.dueDate),
                    capa.status || 'Abierto',
                    JSON.stringify(soloDatos(capa, COLUMNAS_CAPA)), usuario,
                ]
            );

            if (esNuevo) {
                await registrar(c, usuario, 'CREAR', 'CAPA', code);
            } else if (previo.estado !== rows[0].estado) {
                await registrar(c, usuario, 'CAMBIO ESTADO', 'CAPA',
                    `${code}: ${previo.estado} → ${rows[0].estado}`);
            } else {
                await registrar(c, usuario, 'EDITAR', 'CAPA', code);
            }

            return rows[0];
        });

        const o = filaACapa(guardado);
        o.dueDate = soloDia(guardado.due_date);
        res.json({ ok: true, capa: o });
    } catch (err) {
        if (err.status === 404) return res.status(404).json({ ok: false, error: err.message });
        next(err);
    }
});

rutasNcDesvios.delete('/capa/:id', administrar, async (req, res, next) => {
    try {
        const usuario = req.usuario.nombre;
        const borrado = await enTransaccion(async (c) => {
            const { rows } = await c.query(
                'DELETE FROM ncd_capa WHERE id = $1 RETURNING code', [req.params.id]
            );
            if (rows[0]) await registrar(c, usuario, 'ELIMINAR', 'CAPA', rows[0].code);
            return rows[0];
        });
        if (!borrado) return res.status(404).json({ ok: false, error: 'no existe' });

        await auditar(req, {
            usuarioId: req.usuario.id, usuarioTxt: req.usuario.usuario,
            accion: 'ncd_eliminar_capa', recurso: RECURSO, detalle: borrado.code,
        });
        res.json({ ok: true });
    } catch (err) {
        next(err);
    }
});

/* ═══════════════════════════════════════════════════════════════════════════
   Evidencia adjunta
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * POST /api/nc-desvios/capa/:id/adjuntos   { nombre, tipo, contenido }
 *
 * `contenido` viene en base64. Se recibe como JSON y no como multipart para no
 * sumar una dependencia de parseo por un unico endpoint; el costo es el 33% que
 * base64 agrega en transito, que sobre archivos ya reducidos en el navegador no
 * se nota.
 */
rutasNcDesvios.post('/capa/:id/adjuntos', escribir, cuerpoAdjunto, async (req, res, next) => {
    const { nombre, tipo, contenido } = req.body || {};

    if (!nombre || !tipo || !contenido) {
        return res.status(400).json({ ok: false, error: 'faltan nombre, tipo o contenido' });
    }
    if (!TIPOS_ADJUNTO.has(tipo)) {
        return res.status(415).json({
            ok: false,
            error: 'solo se aceptan imagenes (JPG, PNG, WEBP, HEIC) y PDF',
        });
    }

    let bytes;
    try {
        bytes = Buffer.from(contenido, 'base64');
    } catch {
        return res.status(400).json({ ok: false, error: 'el contenido no es base64 valido' });
    }
    if (!bytes.length) {
        return res.status(400).json({ ok: false, error: 'el archivo esta vacio' });
    }
    if (bytes.length > MAX_ADJUNTO) {
        return res.status(413).json({
            ok: false,
            error: `el archivo supera los ${Math.round(MAX_ADJUNTO / 1024 / 1024)} MB`,
        });
    }

    try {
        const usuario = req.usuario.nombre;
        const guardado = await enTransaccion(async (c) => {
            const { rows: capa } = await c.query(
                'SELECT code FROM ncd_capa WHERE id = $1', [req.params.id]
            );
            if (!capa[0]) {
                const e = new Error('la accion no existe');
                e.status = 404;
                throw e;
            }

            const { rows } = await c.query(
                `INSERT INTO ncd_adjuntos (capa_id, nombre, tipo, tamano, contenido, subido_por)
                 VALUES ($1,$2,$3,$4,$5,$6)
                 RETURNING id, nombre, tipo, tamano, subido_por, subido_en`,
                [req.params.id, String(nombre).slice(0, 300), tipo, bytes.length, bytes, usuario]
            );

            await registrar(c, usuario, 'ADJUNTAR', 'CAPA',
                `${capa[0].code}: ${nombre}`);
            return rows[0];
        });

        res.json({
            ok: true,
            adjunto: {
                id: guardado.id, nombre: guardado.nombre, tipo: guardado.tipo,
                tamano: guardado.tamano, subidoPor: guardado.subido_por,
                subidoEn: guardado.subido_en,
            },
        });
    } catch (err) {
        if (err.status === 404) return res.status(404).json({ ok: false, error: err.message });
        next(err);
    }
});

/** GET /api/nc-desvios/adjuntos/:id — devuelve el archivo. */
rutasNcDesvios.get('/adjuntos/:id', leer, async (req, res, next) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ ok: false, error: 'id invalido' });

    try {
        const { rows } = await consultar(
            'SELECT nombre, tipo, contenido FROM ncd_adjuntos WHERE id = $1', [id]
        );
        if (!rows[0]) return res.status(404).json({ ok: false, error: 'no existe' });

        res.setHeader('Content-Type', rows[0].tipo);
        // inline: la evidencia se mira, no se baja. El nombre va entre comillas
        // porque suele tener espacios.
        res.setHeader('Content-Disposition',
            `inline; filename="${rows[0].nombre.replace(/["\r\n]/g, '')}"`);
        // Es contenido de un expediente: no debe quedar en caches compartidas.
        res.setHeader('Cache-Control', 'private, max-age=300');
        res.send(rows[0].contenido);
    } catch (err) {
        next(err);
    }
});

rutasNcDesvios.delete('/adjuntos/:id', administrar, async (req, res, next) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ ok: false, error: 'id invalido' });

    try {
        const usuario = req.usuario.nombre;
        const borrado = await enTransaccion(async (c) => {
            const { rows } = await c.query(
                `DELETE FROM ncd_adjuntos a USING ncd_capa c
                 WHERE a.id = $1 AND c.id = a.capa_id
                 RETURNING a.nombre, c.code`,
                [id]
            );
            if (rows[0]) {
                await registrar(c, usuario, 'ELIMINAR ADJUNTO', 'CAPA',
                    `${rows[0].code}: ${rows[0].nombre}`);
            }
            return rows[0];
        });
        if (!borrado) return res.status(404).json({ ok: false, error: 'no existe' });
        res.json({ ok: true });
    } catch (err) {
        next(err);
    }
});

/* ═══════════════════════════════════════════════════════════════════════════
   Carga inicial
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * POST /api/nc-desvios/importar   { ncs: [], capas: [] }
 *
 * Trae de una vez los registros que la app traia escritos adentro del archivo.
 * Solo corre con la base vacia: es una carga inicial, no un importador general.
 * Si corriera con datos, un click de mas duplicaria un expediente.
 *
 * Se respetan los id y los codigos que vienen, porque las CAPA referencian a
 * las NC por id y los codigos (NC-001-2026) son los del expediente en papel.
 */
rutasNcDesvios.post('/importar', administrar, async (req, res, next) => {
    const { ncs = [], capas = [] } = req.body || {};
    if (!Array.isArray(ncs) || !Array.isArray(capas)) {
        return res.status(400).json({ ok: false, error: 'ncs y capas tienen que ser listas' });
    }

    try {
        const usuario = req.usuario.nombre;
        const resumen = await enTransaccion(async (c) => {
            const { rows: hay } = await c.query(
                `SELECT (SELECT count(*) FROM ncd_nc)      AS ncs,
                        (SELECT count(*) FROM ncd_desvios) AS devs,
                        (SELECT count(*) FROM ncd_capa)    AS capas`
            );
            if (Number(hay[0].ncs) || Number(hay[0].devs) || Number(hay[0].capas)) {
                const e = new Error('la base ya tiene registros: la carga inicial no se repite');
                e.status = 409;
                throw e;
            }

            for (const nc of ncs) {
                await c.query(
                    `INSERT INTO ncd_nc (id, code, phase, anio, open_date, incident_date,
                                         close_date, sector, source, classification,
                                         severity, probability, datos, actualizado_por)
                     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
                    [
                        nc.id, nc.code, nc.phase || 'abierta',
                        anioDe(nc.openDate) ?? anioDe(nc.createdAt),
                        fecha(nc.openDate), fecha(nc.incidentDate), fecha(nc.closeDate),
                        nc.sector || null, nc.source || null, nc.classification || null,
                        nc.severity || null, nc.probability || null,
                        JSON.stringify(soloDatos(nc, COLUMNAS_NC)), usuario,
                    ]
                );
            }

            for (const cp of capas) {
                await c.query(
                    `INSERT INTO ncd_capa (id, code, nc_id, dev_id, tipo, descripcion,
                                           responsable, responsable_email, due_date,
                                           estado, datos, actualizado_por)
                     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
                    [
                        cp.id, cp.code, cp.ncId || null, cp.devId || null,
                        cp.type || null, cp.description || '', cp.responsible || null,
                        cp.responsibleEmail || null, fecha(cp.dueDate),
                        cp.status || 'Abierto',
                        JSON.stringify(soloDatos(cp, COLUMNAS_CAPA)), usuario,
                    ]
                );
            }

            await registrar(c, usuario, 'CARGA INICIAL', 'Sistema',
                `${ncs.length} no conformidades y ${capas.length} acciones`);

            return { ncs: ncs.length, capas: capas.length };
        });

        await auditar(req, {
            usuarioId: req.usuario.id, usuarioTxt: req.usuario.usuario,
            accion: 'ncd_carga_inicial', recurso: RECURSO,
            detalle: `${resumen.ncs} NC, ${resumen.capas} CAPA`,
        });
        res.json({ ok: true, ...resumen });
    } catch (err) {
        if (err.status === 409) return res.status(409).json({ ok: false, error: err.message });
        next(err);
    }
});
