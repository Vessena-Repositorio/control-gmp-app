/**
 * Datos Logisticos PT — la ficha de alta de producto.
 *
 * Reemplaza al artefacto de Claude que habia armado otra persona (migracion
 * 060): los datos pasan a Postgres y la sesion es la del portal, con permisos
 * por recurso. De la app vieja se conserva el modelo de datos del producto
 * -por eso los 792 SKU entran tal cual- y lo que hacia bien: calcular el
 * pallet, marcar los datos que faltan y exportar en formato ASU.
 *
 * Lo nuevo es el circuito, que antes era un correo a mano:
 *
 *   borrador  Gloria carga los datos (de Antonella) y la manda a revisar
 *   pendiente Antonella -o Claudia- la aprueba o la devuelve con un comentario
 *   aprobada  sale sola a Finanzas con la ficha adjunta
 *
 * Y los papeles del producto: certificado MSP y ficha de seguridad. Cuando
 * estan los tres, el aviso a Ventas sale solo (lib/avisos-datos-logisticos.js).
 *
 * La ficha en Excel la arma la pantalla, que es donde esta la libreria, y la
 * sube como documento 'ficha' antes de aprobar: lo que se manda a Finanzas es
 * exactamente el archivo que se vio en la app.
 */
import express, { Router } from 'express';
import { consultar, enTransaccion } from '../db.js';
import { exigirPermiso } from '../lib/acceso.js';
import { puede } from '../lib/permisos.js';
import { guardar, abrir, extension, hayAlmacen, MAX_BYTES, TIPOS } from '../lib/almacen-documentos.js';
import { avisarFinanzas, avisarVentas, camposFicha, cambiosDeFicha, loQueFalta, DIAS_AVISO_MSP } from '../lib/avisos-datos-logisticos.js';

export const rutasDatosLogisticos = Router();

const RECURSO = 'datos-logisticos';
const leer = exigirPermiso(RECURSO, 'ver');
const cargar = exigirPermiso(RECURSO, 'cargar');
const aprobar = exigirPermiso(RECURSO, 'aprobar');
const administrar = exigirPermiso(RECURSO, 'administrar');

const texto = (v, max = 500) => String(v ?? '').trim().slice(0, max);

function numero(v) {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(String(v).replace(',', '.'));
    return Number.isFinite(n) ? n : null;
}

function entero(v) {
    const n = numero(v);
    return n === null ? null : Math.round(n);
}

function booleano(v) {
    if (v === true || v === false) return v;
    if (v === null || v === undefined || v === '') return null;
    const t = String(v).trim().toLowerCase();
    if (['si', 'sí', 'true', '1'].includes(t)) return true;
    if (['no', 'false', '0'].includes(t)) return false;
    return null;
}

function aFecha(v) {
    const t = texto(v, 30);
    return /^\d{4}-\d{2}-\d{2}$/.test(t) ? t : null;
}

function fallo(status, mensaje) {
    const e = new Error(mensaje);
    e.status = status;
    return e;
}

function responder(err, res, next) {
    if (err.status) return res.status(err.status).json({ ok: false, error: err.message });
    next(err);
}

async function registrar(c, req, accion, sku, detalles) {
    await c.query(
        `INSERT INTO dl_actividad (usuario, rol, accion, sku, detalles) VALUES ($1, $2, $3, $4, $5)`,
        [req.usuario.nombre || req.usuario.usuario, req.rol, accion, sku || null, detalles || null]
    );
}

/* ═══════════════════════════════════════════════════════════════════════════
   Campos del producto
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Columna -> como se lee del cuerpo. La clave es la que usa la pantalla, que
 * es la misma que usaba la app vieja, para no tener que tocar sus cuentas.
 */
const CAMPOS = {
    descripcion: ['desc', texto],
    grupo: ['grupo', texto],
    categoria: ['cat', texto],
    marca: ['marca', texto],
    nota: ['nota', (v) => texto(v, 2000)],
    ean: ['ean', (v) => texto(v, 20)],
    dun: ['dun', (v) => texto(v, 20)],
    pack_gtins: ['packGtins', (v) => texto(v, 200)],
    vida_meses: ['vida', entero],
    peso_pt: ['pesoPT', numero],
    un_largo: ['uL', numero],
    un_ancho: ['uA', numero],
    un_alto: ['uH', numero],
    contenido: ['contenido', numero],
    contenido_um: ['contenidoUM', (v) => texto(v, 20)],
    presentacion: ['presentacion', (v) => texto(v, 60)],
    unidades_caja: ['unx', entero],
    cod_caja: ['codCaja', (v) => texto(v, 60)],
    tipo_empaque: ['tipoEmpaque', (v) => texto(v, 40)],
    caja_largo: ['cL', numero],
    caja_ancho: ['cA', numero],
    caja_alto: ['cH', numero],
    peso_caja: ['pesoCaja', numero],
    por_piso: ['porPiso', entero],
    estiba: ['estiba', entero],
    unidades_pallet: ['unPal', entero],
    separadores: ['sep', entero],
    film_unidad: ['filmU', numero],
    acostada: ['acostada', booleano],
    temp_cerrado: ['tempCerrado', (v) => texto(v, 60)],
    temp_abierto: ['tempAbierto', (v) => texto(v, 60)],
    gpc: ['gpc', (v) => texto(v, 60)],
    categoria_producto: ['categoriaProducto', (v) => texto(v, 60)],
    linea: ['linea', (v) => texto(v, 60)],
    sublinea: ['sublinea', (v) => texto(v, 60)],
    familia: ['familia', (v) => texto(v, 60)],
    subfamilia: ['subfamilia', (v) => texto(v, 60)],
    um_base: ['umBase', (v) => texto(v, 20)],
    um_destino: ['umDestino', (v) => texto(v, 20)],
    tipo_producto: ['tipoProducto', (v) => texto(v, 40)],
    categoria_impuesto: ['categoriaImpuesto', (v) => texto(v, 60)],
    impuesto_cv: ['impuestoCV', (v) => texto(v, 60)],
};

/**
 * Los datos que ve Finanzas. Si cambia uno de estos en una ficha ya aprobada,
 * la ficha vuelve a revision: lo que salio y lo que hay tienen que coincidir.
 */
const CAMPOS_DE_LA_FICHA = new Set([
    'descripcion', 'marca', 'categoria_producto', 'linea', 'sublinea', 'familia', 'subfamilia',
    'contenido', 'contenido_um', 'presentacion', 'grupo', 'vida_meses', 'ean', 'dun',
    'um_base', 'um_destino', 'unidades_caja', 'cod_caja', 'peso_pt',
    'un_largo', 'un_ancho', 'un_alto', 'caja_largo', 'caja_ancho', 'caja_alto',
    'por_piso', 'estiba', 'unidades_pallet', 'temp_cerrado', 'temp_abierto',
]);

/** Lee del cuerpo solo los campos que vienen, ya convertidos. */
function leerCampos(cuerpo) {
    const datos = {};
    for (const [columna, [clave, conv]] of Object.entries(CAMPOS)) {
        if (Object.prototype.hasOwnProperty.call(cuerpo, clave)) {
            const v = conv(cuerpo[clave]);
            datos[columna] = v === '' ? null : v;
        }
    }
    return datos;
}

/* ═══════════════════════════════════════════════════════════════════════════
   Lectura
   ═══════════════════════════════════════════════════════════════════════════ */

/** Un producto como lo espera la pantalla (las claves de la app vieja). */
function aPantalla(p) {
    return {
        sku: p.sku, desc: p.descripcion, grupo: p.grupo || '', cat: p.categoria || '',
        marca: p.marca || '', activo: p.activo, nota: p.nota || '',
        ean: p.ean || '', dun: p.dun || '', packGtins: p.pack_gtins || '',
        vida: p.vida_meses, pesoPT: p.peso_pt === null ? null : Number(p.peso_pt),
        uL: p.un_largo === null ? null : Number(p.un_largo),
        uA: p.un_ancho === null ? null : Number(p.un_ancho),
        uH: p.un_alto === null ? null : Number(p.un_alto),
        contenido: p.contenido === null ? null : Number(p.contenido),
        contenidoUM: p.contenido_um || '', presentacion: p.presentacion || '',
        unx: p.unidades_caja, codCaja: p.cod_caja || '', tipoEmpaque: p.tipo_empaque || '',
        cL: p.caja_largo === null ? null : Number(p.caja_largo),
        cA: p.caja_ancho === null ? null : Number(p.caja_ancho),
        cH: p.caja_alto === null ? null : Number(p.caja_alto),
        pesoCaja: p.peso_caja === null ? null : Number(p.peso_caja),
        porPiso: p.por_piso, estiba: p.estiba, unPal: p.unidades_pallet,
        sep: p.separadores, filmU: p.film_unidad === null ? null : Number(p.film_unidad),
        acostada: p.acostada, tempCerrado: p.temp_cerrado || '', tempAbierto: p.temp_abierto || '',
        gpc: p.gpc || '',
        categoriaProducto: p.categoria_producto || '', linea: p.linea || '', sublinea: p.sublinea || '',
        familia: p.familia || '', subfamilia: p.subfamilia || '',
        umBase: p.um_base || '', umDestino: p.um_destino || '',
        tipoProducto: p.tipo_producto || '', categoriaImpuesto: p.categoria_impuesto || '',
        impuestoCV: p.impuesto_cv || '',
        msp: p.msp, mspNum: p.msp_numero || '', mspVence: p.msp_vence || null,
        estado: p.estado, armadaPor: p.armada_por || '', armadaEn: p.armada_en,
        aprobadaPor: p.aprobada_por || '', aprobadaEn: p.aprobada_en, rechazo: p.rechazo || '',
        fichaVersion: p.ficha_version,
        enviadaFinanzasEn: p.enviada_finanzas_en, enviadaVentasEn: p.enviada_ventas_en,
        extra: p.extra || {},
        actualizadoEn: p.actualizado_en, actualizadoPor: p.actualizado_por || '',
        documentos: p.documentos || [], registros: p.registros || [],
    };
}

const SELECT_PRODUCTO = `
    SELECT p.*,
           (SELECT json_agg(json_build_object('id', d.id, 'tipo', d.tipo, 'nombre', d.nombre,
                                              'bytes', d.bytes, 'subidoPor', d.subido_por,
                                              'subidoEn', d.subido_en, 'vigente', d.vigente)
                            ORDER BY d.subido_en DESC)
            FROM dl_documentos d WHERE d.sku = p.sku) AS documentos,
           (SELECT json_agg(json_build_object('id', r.id, 'numero', r.numero, 'emitido', r.emitido,
                                              'vence', r.vence, 'nota', r.nota,
                                              'documentoId', r.documento_id,
                                              'cargadoPor', r.cargado_por, 'cargadoEn', r.cargado_en)
                            ORDER BY r.vence DESC)
            FROM dl_registros r WHERE r.sku = p.sku) AS registros
    FROM dl_productos p`;

/** GET /api/datos-logisticos/sesion */
rutasDatosLogisticos.get('/sesion', leer, async (req, res) => {
    res.json({
        ok: true,
        nombre: req.usuario.nombre || req.usuario.usuario,
        rol: req.rol,
        permisos: ['ver', 'cargar', 'revisar', 'aprobar', 'administrar'].filter((a) => puede(req.rol, a)),
        hayAlmacen,
        diasAvisoMsp: DIAS_AVISO_MSP,
    });
});

/** GET /api/datos-logisticos/productos */
rutasDatosLogisticos.get('/productos', leer, async (_req, res, next) => {
    try {
        const { rows } = await consultar(`${SELECT_PRODUCTO} ORDER BY p.sku`);
        res.json({ ok: true, productos: rows.map(aPantalla) });
    } catch (err) { next(err); }
});

/** GET /api/datos-logisticos/productos/:sku */
rutasDatosLogisticos.get('/productos/:sku', leer, async (req, res, next) => {
    try {
        const { rows } = await consultar(`${SELECT_PRODUCTO} WHERE p.sku = $1`, [texto(req.params.sku, 60)]);
        if (!rows.length) throw fallo(404, 'No hay ningún producto con ese código');
        res.json({ ok: true, producto: aPantalla(rows[0]), falta: await loQueFalta(rows[0].sku) });
    } catch (err) { responder(err, res, next); }
});

/* ═══════════════════════════════════════════════════════════════════════════
   Alta y edicion
   ═══════════════════════════════════════════════════════════════════════════ */

/** POST /api/datos-logisticos/productos */
rutasDatosLogisticos.post('/productos', cargar, async (req, res, next) => {
    const d = req.body || {};
    const sku = texto(d.sku, 60);
    try {
        if (!sku) throw fallo(400, 'Falta el código (SKU) del producto');
        if (!texto(d.desc)) throw fallo(400, 'Falta la descripción del producto');
        const datos = leerCampos(d);
        const columnas = ['sku', ...Object.keys(datos), 'armada_por', 'armada_en', 'actualizado_por'];
        const valores = [sku, ...Object.values(datos), req.usuario.nombre || req.usuario.usuario, new Date(), req.usuario.nombre || req.usuario.usuario];
        const producto = await enTransaccion(async (c) => {
            const { rows: ya } = await c.query('SELECT 1 FROM dl_productos WHERE sku = $1', [sku]);
            if (ya.length) throw fallo(409, `Ya hay un producto con el código ${sku}`);
            const { rows } = await c.query(
                `INSERT INTO dl_productos (${columnas.join(', ')})
                 VALUES (${columnas.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING sku`,
                valores
            );
            await registrar(c, req, 'producto_nuevo', sku, texto(d.desc));
            return rows[0].sku;
        });
        const { rows } = await consultar(`${SELECT_PRODUCTO} WHERE p.sku = $1`, [producto]);
        res.status(201).json({ ok: true, producto: aPantalla(rows[0]) });
    } catch (err) { responder(err, res, next); }
});

/**
 * PUT /api/datos-logisticos/productos/:sku
 * Si cambia un dato que Finanzas ya vio, la ficha vuelve a revision: lo que se
 * mando y lo que hay en la app tienen que ser lo mismo.
 */
rutasDatosLogisticos.put('/productos/:sku', cargar, async (req, res, next) => {
    const sku = texto(req.params.sku, 60);
    const d = req.body || {};
    try {
        const datos = leerCampos(d);
        if (!Object.keys(datos).length && d.activo === undefined && d.extra === undefined) {
            throw fallo(400, 'No hay nada para cambiar');
        }
        const r = await enTransaccion(async (c) => {
            const { rows } = await c.query('SELECT * FROM dl_productos WHERE sku = $1 FOR UPDATE', [sku]);
            const p = rows[0];
            if (!p) throw fallo(404, 'No hay ningún producto con ese código');
            if (datos.descripcion === null) throw fallo(400, 'La descripción no puede quedar vacía');

            const cambios = [];
            for (const [col, valor] of Object.entries(datos)) {
                const antes = p[col] === null || p[col] === undefined ? null : p[col];
                const comparable = (x) => (x === null ? '' : String(x));
                if (comparable(antes) !== comparable(valor)) cambios.push(col);
            }
            if (d.activo !== undefined && booleano(d.activo) !== p.activo) cambios.push('activo');
            if (!cambios.length) return { sinCambios: true };

            const tocaLaFicha = cambios.some((c2) => CAMPOS_DE_LA_FICHA.has(c2));
            const vuelveARevision = tocaLaFicha && p.estado === 'aprobada';

            const sets = [];
            const valores = [sku];
            for (const [col, valor] of Object.entries(datos)) {
                valores.push(valor);
                sets.push(`${col} = $${valores.length}`);
            }
            if (d.activo !== undefined) {
                valores.push(booleano(d.activo));
                sets.push(`activo = $${valores.length}`);
            }
            if (d.extra !== undefined && d.extra && typeof d.extra === 'object') {
                valores.push(JSON.stringify(d.extra));
                sets.push(`extra = extra || $${valores.length}::jsonb`);
            }
            valores.push(req.usuario.nombre || req.usuario.usuario);
            sets.push(`actualizado_por = $${valores.length}`, 'actualizado_en = now()');
            if (vuelveARevision) sets.push(`estado = 'pendiente'`, 'rechazo = NULL');

            await c.query(`UPDATE dl_productos SET ${sets.join(', ')} WHERE sku = $1`, valores);
            await registrar(c, req, 'producto_editado', sku,
                `${cambios.join(', ')}${vuelveARevision ? ' · vuelve a revisión: la ficha ya había salido a Finanzas' : ''}`);
            return { cambios, vuelveARevision };
        });
        const { rows } = await consultar(`${SELECT_PRODUCTO} WHERE p.sku = $1`, [sku]);
        res.json({ ok: true, ...r, producto: aPantalla(rows[0]) });
    } catch (err) { responder(err, res, next); }
});

/* ═══════════════════════════════════════════════════════════════════════════
   El circuito de la ficha
   ═══════════════════════════════════════════════════════════════════════════ */

/** POST /api/datos-logisticos/productos/:sku/revision — Gloria la manda a revisar. */
rutasDatosLogisticos.post('/productos/:sku/revision', cargar, async (req, res, next) => {
    const sku = texto(req.params.sku, 60);
    try {
        await enTransaccion(async (c) => {
            const { rows } = await c.query('SELECT estado FROM dl_productos WHERE sku = $1 FOR UPDATE', [sku]);
            if (!rows.length) throw fallo(404, 'No hay ningún producto con ese código');
            if (rows[0].estado === 'pendiente') throw fallo(409, 'Esa ficha ya está esperando revisión');
            await c.query(
                `UPDATE dl_productos SET estado = 'pendiente', rechazo = NULL, armada_por = $2,
                        armada_en = now(), actualizado_en = now() WHERE sku = $1`,
                [sku, req.usuario.nombre || req.usuario.usuario]
            );
            await registrar(c, req, 'ficha_a_revision', sku, null);
        });
        const { rows } = await consultar(`${SELECT_PRODUCTO} WHERE p.sku = $1`, [sku]);
        res.json({ ok: true, producto: aPantalla(rows[0]) });
    } catch (err) { responder(err, res, next); }
});

/**
 * POST /api/datos-logisticos/productos/:sku/aprobar
 * La aprueba Antonella o Claudia. Manda la ficha a Finanzas en el momento; si
 * ya habia salido antes, va como actualizacion con el detalle de que cambio.
 */
rutasDatosLogisticos.post('/productos/:sku/aprobar', aprobar, async (req, res, next) => {
    const sku = texto(req.params.sku, 60);
    try {
        const r = await enTransaccion(async (c) => {
            const { rows } = await c.query('SELECT * FROM dl_productos WHERE sku = $1 FOR UPDATE', [sku]);
            const p = rows[0];
            if (!p) throw fallo(404, 'No hay ningún producto con ese código');
            if (p.estado === 'aprobada') throw fallo(409, `Esa ficha ya la aprobó ${p.aprobada_por}`);
            const { rows: ficha } = await c.query(
                `SELECT 1 FROM dl_documentos WHERE sku = $1 AND tipo = 'ficha' AND vigente LIMIT 1`, [sku]
            );
            if (!ficha.length) throw fallo(409, 'Falta la ficha en Excel: generala desde la pantalla antes de aprobar');

            const ahora = camposFicha(p);
            const cambios = cambiosDeFicha(p.extra?.fichaEnviada, ahora);
            const actualizacion = Boolean(p.enviada_finanzas_en);
            await c.query(
                `UPDATE dl_productos
                    SET estado = 'aprobada', aprobada_por = $2, aprobada_por_id = $3, aprobada_en = now(),
                        rechazo = NULL, ficha_version = ficha_version + 1, enviada_finanzas_en = now(),
                        extra = extra || jsonb_build_object('fichaEnviada', $4::jsonb),
                        actualizado_en = now()
                  WHERE sku = $1`,
                [sku, req.usuario.nombre || req.usuario.usuario, req.usuario.id, JSON.stringify(ahora)]
            );
            await registrar(c, req, 'ficha_aprobada', sku,
                actualizacion ? `actualización · ${cambios.length} dato(s) cambiados` : 'primera vez');
            return { cambios, actualizacion };
        });

        // Fuera de la transaccion: el correo no tiene que poder voltear la aprobacion.
        const finanzas = await avisarFinanzas(sku, r);
        const ventas = await avisarVentas(sku);
        const { rows } = await consultar(`${SELECT_PRODUCTO} WHERE p.sku = $1`, [sku]);
        res.json({ ok: true, finanzas, ventas, falta: await loQueFalta(sku), producto: aPantalla(rows[0]) });
    } catch (err) { responder(err, res, next); }
});

/** POST /api/datos-logisticos/productos/:sku/devolver  { motivo } */
rutasDatosLogisticos.post('/productos/:sku/devolver', aprobar, async (req, res, next) => {
    const sku = texto(req.params.sku, 60);
    const motivo = texto(req.body?.motivo, 1000);
    try {
        if (motivo.length < 5) throw fallo(400, 'Escribí qué hay que corregir: lo ve quien la armó');
        await enTransaccion(async (c) => {
            const { rows } = await c.query('SELECT estado FROM dl_productos WHERE sku = $1 FOR UPDATE', [sku]);
            if (!rows.length) throw fallo(404, 'No hay ningún producto con ese código');
            if (rows[0].estado !== 'pendiente') throw fallo(409, 'Esa ficha no está esperando revisión');
            await c.query(
                `UPDATE dl_productos SET estado = 'borrador', rechazo = $2, actualizado_en = now() WHERE sku = $1`,
                [sku, motivo]
            );
            await registrar(c, req, 'ficha_devuelta', sku, motivo);
        });
        const { rows } = await consultar(`${SELECT_PRODUCTO} WHERE p.sku = $1`, [sku]);
        res.json({ ok: true, producto: aPantalla(rows[0]) });
    } catch (err) { responder(err, res, next); }
});

/* ═══════════════════════════════════════════════════════════════════════════
   Documentos: la ficha en Excel, el certificado MSP y la ficha de seguridad
   ═══════════════════════════════════════════════════════════════════════════ */

const TIPOS_DOC = new Set(['ficha', 'certificado', 'seguridad', 'registro']);

/**
 * POST /api/datos-logisticos/productos/:sku/documentos?tipo=&nombre=
 * El archivo va en el cuerpo, como application/octet-stream.
 * El anterior del mismo tipo deja de ser el vigente, pero no se borra.
 */
rutasDatosLogisticos.post('/productos/:sku/documentos',
    express.raw({ type: 'application/octet-stream', limit: MAX_BYTES }),
    cargar,
    async (req, res, next) => {
        const sku = texto(req.params.sku, 60);
        try {
            if (!hayAlmacen) throw fallo(503, 'Falta configurar dónde se guardan los documentos (DOC_DIR)');
            const tipo = texto(req.query.tipo, 20);
            if (!TIPOS_DOC.has(tipo)) throw fallo(400, 'Tipo de documento desconocido');
            const nombre = texto(req.query.nombre, 200).split(/[\\/]/).pop();
            if (!nombre) throw fallo(400, 'Falta el nombre del archivo');
            if (!TIPOS[extension(nombre)]) throw fallo(400, `No se admiten archivos ${extension(nombre) || 'sin extensión'}`);

            const g = await guardar(req.body, nombre);
            const doc = await enTransaccion(async (c) => {
                const { rows: hay } = await c.query('SELECT 1 FROM dl_productos WHERE sku = $1', [sku]);
                if (!hay.length) throw fallo(404, 'No hay ningún producto con ese código');
                // 'registro' no tiene vigente: cada habilitacion guarda el suyo.
                if (tipo !== 'registro') {
                    await c.query(
                        'UPDATE dl_documentos SET vigente = false WHERE sku = $1 AND tipo = $2 AND vigente',
                        [sku, tipo]
                    );
                }
                const { rows } = await c.query(
                    `INSERT INTO dl_documentos (sku, tipo, nombre, ruta, sha256, mime, bytes, subido_por)
                     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
                    [sku, tipo, nombre, g.ruta, g.sha256, g.mime, g.bytes, req.usuario.nombre || req.usuario.usuario]
                );
                await registrar(c, req, 'documento_subido', sku, `${tipo}: ${nombre}`);
                return rows[0].id;
            });

            // Con la ficha aprobada y los dos papeles, el aviso a ventas sale solo.
            const ventas = tipo === 'ficha' ? { enviado: false, motivo: 'es la ficha' } : await avisarVentas(sku);
            res.status(201).json({ ok: true, id: doc, ventas, falta: await loQueFalta(sku) });
        } catch (err) { responder(err, res, next); }
    });

/** GET /api/datos-logisticos/documentos/:id — descarga. */
rutasDatosLogisticos.get('/documentos/:id', leer, async (req, res, next) => {
    try {
        const { rows } = await consultar('SELECT * FROM dl_documentos WHERE id = $1', [Number(req.params.id) || 0]);
        const d = rows[0];
        if (!d) throw fallo(404, 'Ese documento no existe');
        const { stream, bytes } = await abrir(d.ruta);
        res.setHeader('Content-Type', d.mime || 'application/octet-stream');
        res.setHeader('Content-Length', bytes);
        res.setHeader('Content-Disposition', `inline; filename="${d.nombre.replace(/["\\]/g, '')}"`);
        stream.pipe(res);
    } catch (err) { responder(err, res, next); }
});

/* ═══════════════════════════════════════════════════════════════════════════
   La plantilla de la ficha (migracion 062)
   ═══════════════════════════════════════════════════════════════════════════
   Es el formulario en blanco de Finanzas. La pantalla lo baja, le escribe los
   valores en las celdas que van a mano y deja que las formulas del propio
   formulario hagan el resto: asi la ficha sale con el formato al que Marianela
   esta acostumbrada. */

/** GET /api/datos-logisticos/plantilla/estado */
rutasDatosLogisticos.get('/plantilla/estado', leer, async (_req, res, next) => {
    try {
        const { rows } = await consultar(
            'SELECT id, nombre, bytes, subida_por, subida_en FROM dl_plantilla ORDER BY subida_en DESC LIMIT 1'
        );
        const p = rows[0];
        res.json({
            ok: true,
            hay: Boolean(p),
            plantilla: p ? { id: p.id, nombre: p.nombre, bytes: p.bytes, subidaPor: p.subida_por, subidaEn: p.subida_en } : null,
        });
    } catch (err) { next(err); }
});

/** GET /api/datos-logisticos/plantilla — el archivo, para llenarlo. */
rutasDatosLogisticos.get('/plantilla', leer, async (_req, res, next) => {
    try {
        const { rows } = await consultar('SELECT * FROM dl_plantilla ORDER BY subida_en DESC LIMIT 1');
        if (!rows.length) throw fallo(404, 'Todavía no se subió la plantilla de la ficha');
        const { stream, bytes } = await abrir(rows[0].ruta);
        res.setHeader('Content-Type', rows[0].mime || 'application/octet-stream');
        res.setHeader('Content-Length', bytes);
        res.setHeader('Content-Disposition', `inline; filename="${rows[0].nombre.replace(/["\\]/g, '')}"`);
        stream.pipe(res);
    } catch (err) { responder(err, res, next); }
});

/** POST /api/datos-logisticos/plantilla?nombre= — el .xlsx en el cuerpo. */
rutasDatosLogisticos.post('/plantilla',
    express.raw({ type: 'application/octet-stream', limit: MAX_BYTES }),
    administrar,
    async (req, res, next) => {
        try {
            if (!hayAlmacen) throw fallo(503, 'Falta configurar dónde se guardan los documentos (DOC_DIR)');
            const nombre = texto(req.query.nombre, 200).split(/[\\/]/).pop();
            if (!nombre) throw fallo(400, 'Falta el nombre del archivo');
            if (!['.xlsx', '.xls'].includes(extension(nombre))) throw fallo(400, 'La plantilla tiene que ser el Excel del formulario');
            const g = await guardar(req.body, nombre);
            const r = await enTransaccion(async (c) => {
                const { rows } = await c.query(
                    `INSERT INTO dl_plantilla (nombre, ruta, sha256, mime, bytes, nota, subida_por)
                     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
                    [nombre, g.ruta, g.sha256, g.mime, g.bytes, texto(req.query.nota, 300) || null,
                        req.usuario.nombre || req.usuario.usuario]
                );
                await registrar(c, req, 'plantilla_subida', null, nombre);
                return rows[0].id;
            });
            res.status(201).json({ ok: true, id: r });
        } catch (err) { responder(err, res, next); }
    });

/* ═══════════════════════════════════════════════════════════════════════════
   Registros sanitarios (habilitacion MSP)
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * POST /api/datos-logisticos/productos/:sku/registros
 *   { numero, emitido, vence, nota, documentoId }
 * Una renovacion es un registro nuevo: el anterior queda. El producto muestra
 * siempre el de vencimiento mas lejano, que es el que va en la ficha.
 */
rutasDatosLogisticos.post('/productos/:sku/registros', cargar, async (req, res, next) => {
    const sku = texto(req.params.sku, 60);
    const d = req.body || {};
    try {
        const numero = texto(d.numero, 100);
        const vence = aFecha(d.vence);
        if (!numero) throw fallo(400, 'Falta el número de la habilitación');
        if (!vence) throw fallo(400, 'Falta la fecha de vencimiento (aaaa-mm-dd)');
        await enTransaccion(async (c) => {
            const { rows: hay } = await c.query('SELECT 1 FROM dl_productos WHERE sku = $1', [sku]);
            if (!hay.length) throw fallo(404, 'No hay ningún producto con ese código');
            const documentoId = Number(d.documentoId) || null;
            if (documentoId) {
                const { rows: doc } = await c.query(
                    `SELECT 1 FROM dl_documentos WHERE id = $1 AND sku = $2 AND tipo = 'registro'`,
                    [documentoId, sku]
                );
                if (!doc.length) throw fallo(400, 'El documento del registro no es de este producto');
            }
            await c.query(
                `INSERT INTO dl_registros (sku, numero, emitido, vence, documento_id, nota, cargado_por)
                 VALUES ($1,$2,$3,$4,$5,$6,$7)`,
                [sku, numero, aFecha(d.emitido), vence, documentoId, texto(d.nota, 500) || null,
                    req.usuario.nombre || req.usuario.usuario]
            );
            // El producto queda con la habilitacion que vence mas tarde.
            await c.query(
                `UPDATE dl_productos p
                    SET msp = true, msp_numero = r.numero, msp_vence = r.vence, actualizado_en = now()
                   FROM (SELECT numero, vence FROM dl_registros WHERE sku = $1 ORDER BY vence DESC LIMIT 1) r
                  WHERE p.sku = $1`,
                [sku]
            );
            await registrar(c, req, 'registro_sanitario', sku, `${numero} · vence ${vence}`);
        });
        const { rows } = await consultar(`${SELECT_PRODUCTO} WHERE p.sku = $1`, [sku]);
        res.status(201).json({ ok: true, producto: aPantalla(rows[0]) });
    } catch (err) { responder(err, res, next); }
});

/** DELETE /api/datos-logisticos/registros/:id — se borra un error de carga. */
rutasDatosLogisticos.delete('/registros/:id', administrar, async (req, res, next) => {
    try {
        const sku = await enTransaccion(async (c) => {
            const { rows } = await c.query('SELECT * FROM dl_registros WHERE id = $1', [Number(req.params.id) || 0]);
            const r = rows[0];
            if (!r) throw fallo(404, 'Ese registro no existe');
            await c.query('DELETE FROM dl_registros WHERE id = $1', [r.id]);
            const { rows: queda } = await c.query(
                'SELECT numero, vence FROM dl_registros WHERE sku = $1 ORDER BY vence DESC LIMIT 1', [r.sku]
            );
            await c.query(
                `UPDATE dl_productos SET msp_numero = $2, msp_vence = $3, msp = $4, actualizado_en = now()
                  WHERE sku = $1`,
                [r.sku, queda[0]?.numero || null, queda[0]?.vence || null, queda.length ? true : null]
            );
            await registrar(c, req, 'registro_borrado', r.sku, `${r.numero} · vencía ${r.vence}`);
            return r.sku;
        });
        const { rows } = await consultar(`${SELECT_PRODUCTO} WHERE p.sku = $1`, [sku]);
        res.json({ ok: true, producto: aPantalla(rows[0]) });
    } catch (err) { responder(err, res, next); }
});

/* ═══════════════════════════════════════════════════════════════════════════
   Bitacora
   ═══════════════════════════════════════════════════════════════════════════ */

/** GET /api/datos-logisticos/actividad?sku=&dias=90 */
rutasDatosLogisticos.get('/actividad', leer, async (req, res, next) => {
    try {
        const sku = texto(req.query.sku, 60);
        const dias = Math.min(Math.max(Number(req.query.dias) || 90, 1), 1095);
        const { rows } = await consultar(
            `SELECT ts, usuario, rol, accion, sku, detalles
               FROM dl_actividad
              WHERE ts >= now() - ($1 || ' days')::interval
                AND ($2 = '' OR sku = $2)
              ORDER BY ts DESC
              LIMIT 500`,
            [String(dias), sku]
        );
        res.json({ ok: true, actividad: rows });
    } catch (err) { next(err); }
});
