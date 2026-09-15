import { Router } from 'express';
import { consultar, enTransaccion } from '../db.js';
import { exigirPermiso } from '../lib/acceso.js';
import { PERMISOS_POR_ROL } from '../lib/permisos.js';
import { auditar } from '../lib/sesiones.js';
import { createHash, randomBytes } from 'node:crypto';
import { armarResultados, bloqueosDeAprobacion, limpiar, numero, passFinal } from '../lib/graneles-reglas.js';

export const rutasGraneles = Router();

const RECURSO = 'aprobacion-graneles';

const leer = exigirPermiso(RECURSO, 'ver');
const cargar = exigirPermiso(RECURSO, 'cargar');
const aprobar = exigirPermiso(RECURSO, 'aprobar');
// Editar especificaciones y borrar no es trabajo del turno: queda para quien
// administra la app.
const administrar = exigirPermiso(RECURSO, 'administrar');

const ZONA = process.env.ZONA_HORARIA || 'America/Montevideo';

/* ═══════════════════════════════════════════════════════════════════════════
   Forma de los registros
   ═══════════════════════════════════════════════════════════════════════════ */

const COLUMNAS_ESPEC = new Set([
    'id', 'code', 'name', 'category', 'brand', 'docRef', 'docVersion', 'parameters',
    'actualizadoEn', 'actualizadoPor',
]);

function soloDatos(obj, columnas) {
    const resto = {};
    for (const [k, v] of Object.entries(obj || {})) {
        if (!columnas.has(k)) resto[k] = v;
    }
    return resto;
}

/**
 * Las fechas se devuelven como 'YYYY-MM-DD'. El driver arma un Date en la zona
 * del servidor y al pasarlo a JSON en UTC una fecha sin hora puede correrse un
 * dia.
 */
const soloDia = (v) => {
    if (!v) return '';
    if (typeof v === 'string') return v.slice(0, 10);
    const y = v.getFullYear();
    const m = String(v.getMonth() + 1).padStart(2, '0');
    const d = String(v.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
};

/** Dia local de un instante, para mostrar la fecha de aprobacion. */
const diaLocal = (instante) =>
    instante ? new Intl.DateTimeFormat('en-CA', { timeZone: ZONA }).format(new Date(instante)) : '';

/** Postgres devuelve TIME como 'HH:MM:SS'; la app trabaja con 'HH:MM'. */
const hora = (v) => (v ? String(v).slice(0, 5) : '');

const horaValida = (v) => {
    const t = String(v ?? '').trim();
    return /^([01]\d|2[0-3]):[0-5]\d$/.test(t) ? t : null;
};

const fechaValida = (v) => {
    const t = String(v ?? '').trim();
    return /^\d{4}-\d{2}-\d{2}$/.test(t) ? t : diaLocal(new Date());
};

const filaAEspec = (f) => ({
    ...f.datos,
    id: f.id,
    code: f.code,
    name: f.name,
    category: f.category || '',
    brand: f.brand || '',
    docRef: f.doc_ref || '',
    docVersion: f.doc_version || '',
    parameters: f.parametros || [],
    actualizadoEn: f.actualizado_en,
    actualizadoPor: f.actualizado_por,
});

const filaAMuestra = (f) => ({
    id: f.id,
    batchCode: f.lote,
    productCode: f.producto_code,
    spec: f.especificacion,
    date: soloDia(f.fecha),
    analyst: f.analista,
    timeFactory: hora(f.hora_fabrica),
    timeIn: hora(f.hora_ingreso),
    timeEnd: hora(f.hora_fin),
    results: f.resultados || [],
    observations: f.observaciones || '',
    status: f.estado,
    approvedBy: f.aprobado_por || '',
    approvedDate: diaLocal(f.aprobado_en),
    approvedAt: f.aprobado_en,
    createdBy: f.creado_por,
    createdAt: f.creado_en,
    updatedAt: f.actualizado_en,
    updatedBy: f.actualizado_por,
});

const nuevoId = (prefijo) =>
    `${prefijo}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

function fallo(status, mensaje) {
    const e = new Error(mensaje);
    e.status = status;
    return e;
}

/** Traduce los errores esperables a una respuesta; el resto sigue a next. */
function responder(err, res, next) {
    if (err.status) return res.status(err.status).json({ ok: false, error: err.message });
    if (err.code === '23505' && err.constraint === 'gra_muestras_lote_key') {
        return res.status(409).json({ ok: false, error: 'ese lote ya esta registrado' });
    }
    if (err.code === '23505' && err.constraint === 'gra_especificaciones_code_key') {
        return res.status(409).json({ ok: false, error: 'ya hay una especificacion con ese codigo' });
    }
    next(err);
}

/** Deja constancia en el audit trail de la app. */
async function registrar(cliente, usuario, accion, entidad, detalle) {
    await cliente.query(
        `INSERT INTO gra_actividad (usuario, accion, entidad, detalle) VALUES ($1,$2,$3,$4)`,
        [usuario, accion, entidad, detalle || null]
    );
}

/** Trae una muestra bloqueada para escribirla, y exige que siga pendiente. */
async function muestraPendiente(c, id) {
    const { rows } = await c.query('SELECT * FROM gra_muestras WHERE id = $1 FOR UPDATE', [id]);
    if (!rows[0]) throw fallo(404, 'la muestra no existe');
    // Una muestra con disposicion es un registro cerrado: si se pudiera
    // editar, un lote aprobado podria terminar mostrando otros resultados que
    // los que se aprobaron.
    if (rows[0].estado !== 'pending') {
        throw fallo(409, 'la muestra ya fue aprobada o rechazada y no se puede modificar');
    }
    return rows[0];
}

/* ═══════════════════════════════════════════════════════════════════════════
   LECTURA
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * GET /api/graneles/datos
 *
 * Todo en una vuelta: KPI y analisis estadistico se calculan en el navegador
 * sobre la bitacora completa. Son unas decenas de muestras por semana; si en
 * unos años pesa, se pagina por fecha.
 *
 * `permisos` sale del rol y no se deduce en la app, para que la politica de
 * que puede cada rol este en un solo lugar.
 */
rutasGraneles.get('/datos', leer, async (req, res, next) => {
    try {
        const [especs, muestras] = await Promise.all([
            consultar('SELECT * FROM gra_especificaciones ORDER BY brand NULLS LAST, code'),
            consultar('SELECT * FROM gra_muestras ORDER BY fecha DESC, creado_en DESC'),
        ]);
        res.json({
            ok: true,
            permisos: PERMISOS_POR_ROL[req.rol] || [],
            specs: especs.rows.map(filaAEspec),
            muestras: muestras.rows.map(filaAMuestra),
        });
    } catch (err) {
        next(err);
    }
});

/* ═══════════════════════════════════════════════════════════════════════════
   ESCRITURA — Especificaciones
   ═══════════════════════════════════════════════════════════════════════════ */

rutasGraneles.post('/especificaciones', administrar, async (req, res, next) => {
    const s = req.body || {};
    const usuario = req.usuario.nombre;

    const code = String(s.code || '').trim().toUpperCase();
    const name = String(s.name || '').trim();
    if (!code || !name) {
        return res.status(400).json({ ok: false, error: 'la especificacion necesita codigo y nombre' });
    }
    if (!Array.isArray(s.parameters) || !s.parameters.length) {
        return res.status(400).json({ ok: false, error: 'la especificacion necesita al menos un parametro' });
    }

    const ids = new Set();
    const parametros = [];
    for (const p of s.parameters) {
        const nombre = String(p?.name || '').trim();
        if (!nombre) return res.status(400).json({ ok: false, error: 'hay un parametro sin nombre' });

        const type = p.type === 'text' ? 'text' : 'numeric';
        const min = type === 'numeric' ? limpiar(p.min) : '';
        const max = type === 'numeric' ? limpiar(p.max) : '';
        // Un limite que no es numero no falla: se ignora y deja pasar cualquier
        // valor. Por eso se rechaza al guardar y no se descubre al aprobar.
        if ((min !== '' && numero(min) === null) || (max !== '' && numero(max) === null)) {
            return res.status(400).json({
                ok: false,
                error: `los limites de "${nombre}" tienen que ser numeros`,
            });
        }

        let id = String(p.id || '').trim() || nuevoId(`${code}-`);
        if (ids.has(id)) id = nuevoId(`${code}-`);
        ids.add(id);

        parametros.push({
            id, name: nombre, type,
            method: String(p.method || '').trim(),
            unit: String(p.unit || '').trim(),
            min, max,
            target: String(p.target || '').trim(),
            note: String(p.note || '').trim(),
        });
    }

    try {
        const guardada = await enTransaccion(async (c) => {
            const previo = s.id
                ? (await c.query('SELECT code FROM gra_especificaciones WHERE id = $1 FOR UPDATE', [s.id])).rows[0]
                : null;
            if (s.id && !previo) throw fallo(404, 'la especificacion no existe');

            // Cambiar el codigo de un granel que ya tiene muestras partiria su
            // historia en dos: la bitacora y el analisis agrupan por codigo.
            if (previo && previo.code !== code) {
                const { rows } = await c.query(
                    'SELECT count(*)::int AS n FROM gra_muestras WHERE producto_code = $1', [previo.code]
                );
                if (rows[0].n) {
                    throw fallo(409, `${previo.code} ya tiene ${rows[0].n} muestra(s): el codigo no se cambia`);
                }
            }

            const valores = [
                code, name, s.category || null, String(s.brand || '').trim() || null,
                String(s.docRef || '').trim() || null, String(s.docVersion || '').trim() || null,
                JSON.stringify(parametros), JSON.stringify(soloDatos(s, COLUMNAS_ESPEC)), usuario,
            ];

            const { rows } = previo
                ? await c.query(
                    `UPDATE gra_especificaciones SET
                        code = $1, name = $2, category = $3, brand = $4, doc_ref = $5,
                        doc_version = $6, parametros = $7, datos = $8, actualizado_por = $9,
                        actualizado_en = now()
                     WHERE id = $10 RETURNING *`,
                    [...valores, s.id]
                )
                : await c.query(
                    `INSERT INTO gra_especificaciones
                        (code, name, category, brand, doc_ref, doc_version, parametros, datos,
                         actualizado_por, id)
                     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
                    [...valores, nuevoId('spec-')]
                );

            await registrar(c, usuario, previo ? 'EDITAR' : 'CREAR', 'Especificación', `${code} — ${name}`);
            return rows[0];
        });

        res.json({ ok: true, spec: filaAEspec(guardada) });
    } catch (err) {
        responder(err, res, next);
    }
});

/**
 * Eliminar pide motivo (pedido de Claudia, 15/09/2026). Queda en la actividad de
 * la app y en la auditoria junto con quien elimino y cuando: un registro GMP que
 * desaparece tiene que poder explicarse.
 */
function motivoEliminacion(req) {
    const motivo = String(req.body?.motivo || '').replace(/\s+/g, ' ').trim();
    if (motivo.length < 10) throw fallo(400, 'escribí el motivo de la eliminación (al menos 10 caracteres)');
    if (motivo.length > 500) throw fallo(400, 'el motivo es demasiado largo (hasta 500 caracteres)');
    return motivo;
}

rutasGraneles.delete('/especificaciones/:id', administrar, async (req, res, next) => {
    let motivo;
    try { motivo = motivoEliminacion(req); } catch (e) { return res.status(e.status).json({ ok: false, error: e.message }); }
    try {
        const usuario = req.usuario.nombre;
        const borrada = await enTransaccion(async (c) => {
            const { rows } = await c.query(
                'DELETE FROM gra_especificaciones WHERE id = $1 RETURNING code, name', [req.params.id]
            );
            if (rows[0]) {
                await registrar(c, usuario, 'ELIMINAR', 'Especificación',
                    `${rows[0].code} — ${rows[0].name} · motivo: ${motivo}`);
            }
            return rows[0];
        });
        if (!borrada) return res.status(404).json({ ok: false, error: 'no existe' });

        await auditar(req, {
            usuarioId: req.usuario.id, usuarioTxt: req.usuario.usuario,
            accion: 'graneles_eliminar_especificacion', recurso: RECURSO,
            detalle: `${borrada.code} · motivo: ${motivo}`,
        });
        res.json({ ok: true });
    } catch (err) {
        next(err);
    }
});

/* ═══════════════════════════════════════════════════════════════════════════
   ESCRITURA — Muestras
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * POST /api/graneles/muestras
 *
 * El analista es quien tiene la sesion, no un nombre que se escribe. La
 * especificacion se toma de la base, no del cuerpo del pedido: la foto que
 * queda guardada tiene que ser la vigente, no la que tenia cargada ese
 * navegador.
 */
rutasGraneles.post('/muestras', cargar, async (req, res, next) => {
    const m = req.body || {};
    const usuario = req.usuario.nombre;

    const lote = String(m.batchCode || '').trim().toUpperCase();
    const codigo = String(m.productCode || '').trim().toUpperCase();
    if (!lote) return res.status(400).json({ ok: false, error: 'falta el codigo de lote' });
    if (!codigo) return res.status(400).json({ ok: false, error: 'falta el codigo de granel' });

    try {
        const guardada = await enTransaccion(async (c) => {
            const { rows: especs } = await c.query(
                'SELECT * FROM gra_especificaciones WHERE code = $1', [codigo]
            );
            if (!especs[0]) throw fallo(400, `no hay especificacion para el granel ${codigo}`);

            const e = especs[0];
            const foto = {
                id: e.id, code: e.code, name: e.name, brand: e.brand || '',
                docRef: e.doc_ref || '', docVersion: e.doc_version || '',
                parameters: e.parametros || [],
            };

            const resultados = armarResultados(foto.parameters, m.results);
            const { rows } = await c.query(
                `INSERT INTO gra_muestras
                    (id, lote, producto_code, especificacion, fecha, analista, hora_fabrica,
                     hora_ingreso, hora_fin, resultados, observaciones, creado_por, actualizado_por,
                     analista_id)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12,$13)
                 RETURNING *`,
                [
                    nuevoId('gm'), lote, codigo, JSON.stringify(foto), fechaValida(m.date), usuario,
                    horaValida(m.timeFactory), horaValida(m.timeIn), horaFinAlGuardar(m.timeEnd, resultados),
                    JSON.stringify(resultados),
                    String(m.observations || '').trim() || null, usuario,
                    // La persona, para encontrar su firma al imprimir.
                    req.usuario.id,
                ]
            );

            await registrar(c, usuario, 'CREAR', 'Muestra', `${lote} (${codigo})`);
            return rows[0];
        });

        res.json({ ok: true, muestra: filaAMuestra(guardada) });
    } catch (err) {
        responder(err, res, next);
    }
});

/**
 * Hora de fin de analisis al guardar. Si no se cargo a mano y el analisis quedo
 * completo -todos los resultados y ningun retest pendiente-, es la hora en que
 * se guarda: ese es el fin del analisis, y para produccion el momento en que el
 * granel pasa a estar apto (pedido de Claudia, 15/09/2026). Con resultados a
 * medias no se marca: seria un fin que todavia no ocurrio. Una hora cargada a
 * mano se respeta.
 */
function horaFinAlGuardar(enviada, resultados) {
    const manual = horaValida(enviada);
    if (manual) return manual;
    const lista = Array.isArray(resultados) ? resultados : [];
    const completo = lista.length > 0
        && lista.every((r) => r.pass !== null)
        && !lista.some((r) => r.type === 'numeric' && r.pass === false && r.retestValue === '');
    if (!completo) return null;
    return new Intl.DateTimeFormat('en-GB', {
        timeZone: ZONA, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).format(new Date());
}

/** Campos que el analista puede cambiar mientras la muestra esta pendiente. */
function camposEditables(m, fila) {
    const resultados = armarResultados(fila.especificacion?.parameters, m.results);
    return {
        horaFabrica: horaValida(m.timeFactory),
        horaIngreso: horaValida(m.timeIn),
        horaFin: horaFinAlGuardar(m.timeEnd, resultados),
        observaciones: String(m.observations || '').trim() || null,
        resultados,
    };
}

rutasGraneles.put('/muestras/:id', cargar, async (req, res, next) => {
    const usuario = req.usuario.nombre;

    try {
        const guardada = await enTransaccion(async (c) => {
            const fila = await muestraPendiente(c, req.params.id);
            const v = camposEditables(req.body || {}, fila);

            const { rows } = await c.query(
                `UPDATE gra_muestras SET
                    hora_fabrica = $1, hora_ingreso = $2, hora_fin = $3, observaciones = $4,
                    resultados = $5, actualizado_por = $6, actualizado_en = now()
                 WHERE id = $7 RETURNING *`,
                [v.horaFabrica, v.horaIngreso, v.horaFin, v.observaciones,
                 JSON.stringify(v.resultados), usuario, fila.id]
            );

            await registrar(c, usuario, 'EDITAR', 'Muestra', fila.lote);
            return rows[0];
        });

        res.json({ ok: true, muestra: filaAMuestra(guardada) });
    } catch (err) {
        responder(err, res, next);
    }
});

/**
 * POST /api/graneles/muestras/:id/disposicion   { status, ...campos }
 *
 * Guarda lo que haya en pantalla y aplica la disposicion en la misma
 * transaccion, para que lo aprobado sea exactamente lo que se estaba viendo.
 * Las condiciones para aprobar se verifican acá con los resultados
 * recalculados: el boton deshabilitado en la app es comodidad, no control.
 */
rutasGraneles.post('/muestras/:id/disposicion', aprobar, async (req, res, next) => {
    const body = req.body || {};
    const usuario = req.usuario.nombre;

    if (!['approved', 'rejected'].includes(body.status)) {
        return res.status(400).json({ ok: false, error: 'la disposicion es aprobar o rechazar' });
    }

    try {
        const guardada = await enTransaccion(async (c) => {
            const fila = await muestraPendiente(c, req.params.id);
            const v = camposEditables(body, fila);

            if (body.status === 'approved') {
                const motivos = bloqueosDeAprobacion(v.resultados, v.horaFin);
                if (motivos.length) throw fallo(409, 'no se puede aprobar: ' + motivos.join(', '));
            }

            const { rows } = await c.query(
                `UPDATE gra_muestras SET
                    hora_fabrica = $1, hora_ingreso = $2, hora_fin = $3, observaciones = $4,
                    resultados = $5, estado = $6, aprobado_por = $7, aprobado_en = now(),
                    actualizado_por = $7, actualizado_en = now(), aprobado_por_id = $9
                 WHERE id = $8 RETURNING *`,
                [v.horaFabrica, v.horaIngreso, v.horaFin, v.observaciones,
                 JSON.stringify(v.resultados), body.status, usuario, fila.id, req.usuario.id]
            );

            await registrar(c, usuario, body.status === 'approved' ? 'APROBAR' : 'RECHAZAR',
                'Muestra', `${fila.lote} (${fila.producto_code})`);
            return rows[0];
        });

        res.json({ ok: true, muestra: filaAMuestra(guardada) });
    } catch (err) {
        responder(err, res, next);
    }
});

rutasGraneles.delete('/muestras/:id', administrar, async (req, res, next) => {
    let motivo;
    try { motivo = motivoEliminacion(req); } catch (e) { return res.status(e.status).json({ ok: false, error: e.message }); }
    try {
        const usuario = req.usuario.nombre;
        const borrada = await enTransaccion(async (c) => {
            const { rows } = await c.query(
                'DELETE FROM gra_muestras WHERE id = $1 RETURNING lote, producto_code, estado',
                [req.params.id]
            );
            if (rows[0]) {
                await registrar(c, usuario, 'ELIMINAR', 'Muestra',
                    `${rows[0].lote} (${rows[0].producto_code}, ${rows[0].estado}) · motivo: ${motivo}`);
            }
            return rows[0];
        });
        if (!borrada) return res.status(404).json({ ok: false, error: 'no existe' });

        await auditar(req, {
            usuarioId: req.usuario.id, usuarioTxt: req.usuario.usuario,
            accion: 'graneles_eliminar_muestra', recurso: RECURSO,
            detalle: `${borrada.lote} · motivo: ${motivo}`,
        });
        res.json({ ok: true });
    } catch (err) {
        next(err);
    }
});

/* ═══════════════════════════════════════════════════════════════════════════
   FIRMAS E IMPRESION DEL REGISTRO
   ═══════════════════════════════════════════════════════════════════════════ */

// Hoja impresa de cada ensayo, para el dossier fisico.
const CODIGO_REGISTRO = 'REG-SOP-AC-029';

// Tope del data URL: unos 500 KB de imagen. Una firma escaneada o fotografiada
// y recortada pesa bastante menos; una foto entera del celular no es una firma.
const MAX_FIRMA = 700 * 1024;
const IMAGEN_FIRMA = /^data:image\/(png|jpeg);base64,[A-Za-z0-9+/]+=*$/;

/** Nombre comparable: sin tildes, sin mayusculas y sin espacios de mas. */
const nombreComparable = (s) => String(s || '')
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
async function firmaDe(usuarioId, instante, nombreEnRegistro) {
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

/**
 * GET /api/graneles/muestras/:id/impresion
 *
 * Lo que va en la hoja impresa: la muestra, las dos firmas con su imagen y
 * cargo, y quien imprime. Cada impresion queda en la actividad de la app: una
 * copia en papel de un registro es algo que tiene que poder rastrearse.
 */
rutasGraneles.get('/muestras/:id/impresion', leer, async (req, res, next) => {
    try {
        const { rows } = await consultar('SELECT * FROM gra_muestras WHERE id = $1', [req.params.id]);
        if (!rows[0]) return res.status(404).json({ ok: false, error: 'la muestra no existe' });
        const f = rows[0];
        const dispuesta = f.estado !== 'pending';

        const [firmaAnalista, firmaDisposicion] = await Promise.all([
            firmaDe(f.analista_id, f.creado_en, f.analista),
            dispuesta ? firmaDe(f.aprobado_por_id, f.aprobado_en, f.aprobado_por) : null,
        ]);

        await registrar({ query: consultar }, req.usuario.nombre, 'IMPRIMIR', 'Muestra',
            `${f.lote} (${f.producto_code}, ${f.estado})`);

        res.json({
            ok: true,
            registro: CODIGO_REGISTRO,
            muestra: filaAMuestra(f),
            firmas: {
                analista: { nombre: f.analista, firmadoEn: f.creado_en, ...(firmaAnalista || {}) },
                disposicion: dispuesta
                    ? { nombre: f.aprobado_por, firmadoEn: f.aprobado_en, ...(firmaDisposicion || {}) }
                    : null,
            },
            impreso: { por: req.usuario.nombre, en: new Date().toISOString() },
        });
    } catch (err) {
        next(err);
    }
});

/**
 * El usuario con el que una persona entra al sistema. Hay personas con varias
 * filas en `usuarios` -la del portal y las que trajeron las replicas de las
 * apps viejas-, y la firma tiene que quedar en la que usa la sesion, que es la
 * que elige el login: por mail, prefiriendo origen 'vessena' (routes/auth.js).
 */
const USUARIOS_DE_INGRESO = `
    SELECT DISTINCT ON (lower(usuario)) id
    FROM usuarios
    WHERE activo
    ORDER BY lower(usuario), (origen = 'vessena') DESC, id`;

/** GET /api/graneles/firmas — una fila por persona con acceso, con su firma vigente. */
rutasGraneles.get('/firmas', administrar, async (_req, res, next) => {
    try {
        const { rows } = await consultar(
            `SELECT u.id, u.nombre, u.usuario, r.rol,
                    f.cargo, f.imagen, f.cargada_por, f.cargada_en
             FROM usuario_recursos r
             JOIN usuarios u ON u.id = r.usuario_id
             LEFT JOIN firmas f ON f.usuario_id = u.id AND f.reemplazada_en IS NULL
             WHERE r.recurso = $1 AND u.activo
               AND u.id IN (${USUARIOS_DE_INGRESO})
             ORDER BY u.nombre NULLS LAST, u.usuario`,
            [RECURSO]
        );
        res.json({
            ok: true,
            personas: rows.map((p) => ({
                id: Number(p.id),
                nombre: p.nombre || p.usuario,
                usuario: p.usuario,
                rol: p.rol,
                firma: p.imagen
                    ? { cargo: p.cargo, imagen: p.imagen, cargadaPor: p.cargada_por, cargadaEn: p.cargada_en }
                    : null,
            })),
        });
    } catch (err) {
        next(err);
    }
});

/**
 * POST /api/graneles/firmas  { usuarioId, cargo, imagen }
 *
 * Registra la firma de una persona. Si ya tenia una, la anterior se cierra y
 * queda guardada: los ensayos que firmo con ella se siguen imprimiendo igual.
 */
rutasGraneles.post('/firmas', administrar, async (req, res, next) => {
    const usuarioId = Number(req.body?.usuarioId);
    const cargo = String(req.body?.cargo || '').trim();
    const imagen = String(req.body?.imagen || '');

    if (!Number.isInteger(usuarioId)) {
        return res.status(400).json({ ok: false, error: 'falta la persona' });
    }
    if (!cargo || cargo.length > 120) {
        return res.status(400).json({ ok: false, error: 'el cargo es obligatorio (hasta 120 caracteres)' });
    }
    if (imagen.length > MAX_FIRMA) {
        return res.status(413).json({ ok: false, error: 'la imagen de la firma es demasiado grande (máximo 500 KB)' });
    }
    if (!IMAGEN_FIRMA.test(imagen)) {
        return res.status(400).json({ ok: false, error: 'la firma tiene que ser una imagen PNG o JPG' });
    }

    try {
        const r = await enTransaccion(async (c) => {
            const { rows } = await c.query(
                `SELECT u.nombre, u.usuario
                 FROM usuario_recursos r JOIN usuarios u ON u.id = r.usuario_id
                 WHERE r.usuario_id = $1 AND r.recurso = $2`,
                [usuarioId, RECURSO]
            );
            if (!rows[0]) throw fallo(404, 'esa persona no tiene acceso a la app');
            const nombre = rows[0].nombre || rows[0].usuario;

            const { rows: ingreso } = await c.query(
                `SELECT 1 FROM (${USUARIOS_DE_INGRESO}) i WHERE i.id = $1`, [usuarioId]
            );
            if (!ingreso[0]) {
                throw fallo(409, `${nombre} no entra al sistema con ese usuario: la firma tiene que quedar en su usuario del portal`);
            }

            await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['firma:' + usuarioId]);
            await c.query(
                'UPDATE firmas SET reemplazada_en = now() WHERE usuario_id = $1 AND reemplazada_en IS NULL',
                [usuarioId]
            );
            const { rows: nueva } = await c.query(
                `INSERT INTO firmas (usuario_id, cargo, imagen, cargada_por, nombre)
                 VALUES ($1, $2, $3, $4, $5) RETURNING cargada_en`,
                [usuarioId, cargo, imagen, req.usuario.nombre, nombre]
            );
            await registrar(c, req.usuario.nombre, 'FIRMA', 'Usuario', `${nombre} (${cargo})`);
            return { nombre, cargadaEn: nueva[0].cargada_en };
        });

        await auditar(req, {
            usuarioId: req.usuario.id, usuarioTxt: req.usuario.usuario,
            accion: 'firma_cargada', recurso: RECURSO, detalle: `${r.nombre} (${cargo})`,
        });
        res.json({
            ok: true,
            firma: { cargo, imagen, cargadaPor: req.usuario.nombre, cargadaEn: r.cargadaEn },
        });
    } catch (err) {
        responder(err, res, next);
    }
});

/* ═══════════════════════════════════════════════════════════════════════════
   INTEGRACIONES — estado de un lote para el sistema de produccion
   ═══════════════════════════════════════════════════════════════════════════ */
//
// El sistema de produccion es otro software: imprime la etiqueta QR (lote y
// orden) que despues se lee en Control de Calidad, y antes de pasar un granel a
// envasado pregunta aca si esta apto. Para produccion "apto" es el analisis
// guardado y conforme, sin esperar la aprobacion documental: la respuesta
// informa las dos cosas por separado para que nadie las confunda.

const ALCANCE_ESTADO_LOTE = 'graneles:estado-lote';
const huellaClave = (clave) => createHash('sha256').update(String(clave)).digest('hex');

/**
 * Middleware: exige una clave de integracion vigente con ese alcance. No usa la
 * sesion ni da acceso a nada mas: la clave del sistema de produccion solo
 * consulta el estado de un lote.
 */
function exigirClaveApi(alcance) {
    return async (req, res, next) => {
        const auth = req.get('authorization') || '';
        const clave = auth.toLowerCase().startsWith('bearer ')
            ? auth.slice(7).trim()
            : String(req.get('x-api-key') || '').trim();
        if (!clave) {
            return res.status(401).json({ ok: false, error: 'falta la clave (encabezado Authorization: Bearer ...)' });
        }
        try {
            const { rows } = await consultar(
                `UPDATE api_claves SET ultimo_uso = now(), usos = usos + 1
                 WHERE huella = $1 AND alcance = $2 AND revocada_en IS NULL
                 RETURNING id, nombre`,
                [huellaClave(clave), alcance]
            );
            if (!rows[0]) return res.status(401).json({ ok: false, error: 'clave invalida o revocada' });
            req.integracion = rows[0];
            next();
        } catch (err) {
            next(err);
        }
    };
}

/**
 * La consulta puede venir desde el navegador de otra aplicacion. Se permite
 * cualquier origen porque la autorizacion es la clave en el encabezado, no una
 * cookie: otro sitio no puede usarla sin tenerla.
 */
function permitirOrigenes(_req, res, next) {
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Headers', 'Authorization, X-Api-Key');
    res.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
    next();
}

/** Lo que produccion necesita saber de una muestra, con las mismas reglas que la aprobacion. */
function estadoParaProduccion(f) {
    if (f.estado === 'rejected') {
        return { apto: false, estado: 'rechazado', detalle: 'Control de Calidad rechazó el lote' };
    }
    const resultados = Array.isArray(f.resultados) ? f.resultados : [];
    const motivos = bloqueosDeAprobacion(resultados, hora(f.hora_fin));
    if (resultados.some((r) => passFinal(r) === false)) {
        return { apto: false, estado: 'no_conforme', detalle: motivos.join('; ') };
    }
    if (motivos.length) {
        return { apto: false, estado: 'en_analisis', detalle: motivos.join('; ') };
    }
    return {
        apto: true,
        estado: 'conforme',
        detalle: f.estado === 'approved'
            ? 'análisis conforme y aprobado documentalmente'
            : 'análisis conforme; aprobación documental pendiente',
    };
}

const DISPOSICION = { pending: 'pendiente', approved: 'aprobado', rejected: 'rechazado' };

rutasGraneles.options('/lotes/:lote/estado', permitirOrigenes, (_req, res) => res.sendStatus(204));

/**
 * GET /api/graneles/lotes/:lote/estado[?granel=G000000]
 * Encabezado: Authorization: Bearer <clave>
 *
 * `apto_envasado` es la respuesta que produccion usa para dejar pasar el
 * granel. Si se manda `granel` y no coincide con el registrado para ese lote,
 * no es apto: la etiqueta y la muestra no hablan del mismo producto.
 */
rutasGraneles.get('/lotes/:lote/estado', permitirOrigenes, exigirClaveApi(ALCANCE_ESTADO_LOTE), async (req, res, next) => {
    const lote = String(req.params.lote || '').trim().toUpperCase();
    const granel = String(req.query.granel || '').trim().toUpperCase();
    const consultadoEn = new Date().toISOString();

    try {
        const { rows } = await consultar('SELECT * FROM gra_muestras WHERE lote = $1', [lote]);
        if (!rows[0]) {
            return res.status(404).json({
                ok: false, lote, apto_envasado: false, estado: 'no_registrado',
                detalle: 'Control de Calidad no tiene registrada una muestra de ese lote',
                consultado_en: consultadoEn,
            });
        }
        const f = rows[0];

        if (granel && granel !== f.producto_code) {
            return res.json({
                ok: true, lote: f.lote, granel: f.producto_code, apto_envasado: false,
                estado: 'granel_no_coincide',
                detalle: `el lote está registrado con el granel ${f.producto_code}, no con ${granel}`,
                consultado_en: consultadoEn,
            });
        }

        const e = estadoParaProduccion(f);
        res.json({
            ok: true,
            lote: f.lote,
            granel: f.producto_code,
            producto: f.especificacion?.name || '',
            apto_envasado: e.apto,
            estado: e.estado,
            detalle: e.detalle,
            analista: f.analista,
            hora_fin_analisis: hora(f.hora_fin) || null,
            analisis_actualizado_en: f.actualizado_en,
            disposicion: DISPOSICION[f.estado] || f.estado,
            dispuesto_por: f.aprobado_por || null,
            dispuesto_en: f.aprobado_en || null,
            consultado_en: consultadoEn,
        });
    } catch (err) {
        next(err);
    }
});

/** GET /api/graneles/integraciones — las claves creadas, sin la clave. */
rutasGraneles.get('/integraciones', administrar, async (_req, res, next) => {
    try {
        const { rows } = await consultar(
            `SELECT id, nombre, prefijo, creada_por, creada_en, revocada_por, revocada_en, ultimo_uso, usos
             FROM api_claves WHERE alcance = $1 ORDER BY creada_en DESC`,
            [ALCANCE_ESTADO_LOTE]
        );
        res.json({
            ok: true,
            integraciones: rows.map((c) => ({
                id: Number(c.id), nombre: c.nombre, prefijo: c.prefijo,
                creadaPor: c.creada_por, creadaEn: c.creada_en,
                revocadaPor: c.revocada_por, revocadaEn: c.revocada_en,
                ultimoUso: c.ultimo_uso, usos: Number(c.usos),
            })),
        });
    } catch (err) {
        next(err);
    }
});

/**
 * POST /api/graneles/integraciones  { nombre }
 *
 * Crea una clave y la devuelve UNA sola vez: en la base queda su huella.
 */
rutasGraneles.post('/integraciones', administrar, async (req, res, next) => {
    const nombre = String(req.body?.nombre || '').trim();
    if (!nombre || nombre.length > 80) {
        return res.status(400).json({ ok: false, error: 'poné un nombre para reconocer la clave (hasta 80 caracteres)' });
    }
    const clave = 'vgr_' + randomBytes(32).toString('base64url');
    try {
        const { rows } = await consultar(
            `INSERT INTO api_claves (nombre, alcance, huella, prefijo, creada_por)
             VALUES ($1, $2, $3, $4, $5) RETURNING id, creada_en`,
            [nombre, ALCANCE_ESTADO_LOTE, huellaClave(clave), clave.slice(0, 10), req.usuario.nombre]
        );
        await registrar({ query: consultar }, req.usuario.nombre, 'CLAVE_API', 'Integración', `creada: ${nombre}`);
        await auditar(req, {
            usuarioId: req.usuario.id, usuarioTxt: req.usuario.usuario,
            accion: 'clave_api_creada', recurso: RECURSO, detalle: nombre,
        });
        res.json({ ok: true, clave, integracion: { id: Number(rows[0].id), nombre, creadaEn: rows[0].creada_en } });
    } catch (err) {
        next(err);
    }
});

/** POST /api/graneles/integraciones/:id/revocar */
rutasGraneles.post('/integraciones/:id/revocar', administrar, async (req, res, next) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ ok: false, error: 'id invalido' });
    try {
        const { rows } = await consultar(
            `UPDATE api_claves SET revocada_en = now(), revocada_por = $2
             WHERE id = $1 AND alcance = $3 AND revocada_en IS NULL
             RETURNING nombre`,
            [id, req.usuario.nombre, ALCANCE_ESTADO_LOTE]
        );
        if (!rows[0]) return res.status(404).json({ ok: false, error: 'esa clave no existe o ya estaba revocada' });
        await registrar({ query: consultar }, req.usuario.nombre, 'CLAVE_API', 'Integración', `revocada: ${rows[0].nombre}`);
        await auditar(req, {
            usuarioId: req.usuario.id, usuarioTxt: req.usuario.usuario,
            accion: 'clave_api_revocada', recurso: RECURSO, detalle: rows[0].nombre,
        });
        res.json({ ok: true });
    } catch (err) {
        next(err);
    }
});
