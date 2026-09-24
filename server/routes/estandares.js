/**
 * Gestión de Estándares — SOP-LCC-071 v2.0 (migracion 045).
 *
 * Reemplaza el Apps Script que tenia login propio y adjuntos en Drive. Mismo
 * alcance: REG-C (stock), REG-A (registro e inspecciones), REG-B (certificado
 * con doble firma), REG-D (rotulo por envase) y REG-E (lote interno
 * correlativo), con audit trail y motivo obligatorio en cada cambio.
 *
 * Diferencias a proposito:
 *   - Entra quien tiene sesion del portal; el rol sale de usuario_recursos.
 *   - CoA y MSDS se guardan en la base (est_adjuntos), no en Drive con enlace
 *     publico. Las imagenes pasan por comprimirFoto; los PDF quedan tal cual.
 *   - Las firmas de las hojas impresas son las de la tabla `firmas`
 *     (Graneles -> Firmas), no un texto escrito a mano.
 */
import { Router } from 'express';
import { consultar, enTransaccion } from '../db.js';
import { exigirPermiso } from '../lib/acceso.js';
import { PERMISOS_POR_ROL } from '../lib/permisos.js';
import { comprimirFoto } from '../lib/comprimir-foto.js';
import { firmaDe } from '../lib/firmas.js';
import { ZONA } from '../lib/tareas.js';

export const rutasEstandares = Router();

const RECURSO = 'estandares';
const leer = exigirPermiso(RECURSO, 'ver');
const cargar = exigirPermiso(RECURSO, 'cargar');
const aprobar = exigirPermiso(RECURSO, 'aprobar');
const administrar = exigirPermiso(RECURSO, 'administrar');

// SOP 5.1: 6 meses para los preparados en casa, 12 para el certificado (CRS).
const MESES = { mp: 6, granel: 6, pt: 6, certificado: 12 };
const DIAS_AVISO = 30;
const TIPOS = Object.keys(MESES);
const MAX_ADJUNTO = 20 * 1024 * 1024;
const TIPOS_ADJUNTO = new Set([
    'application/pdf', 'image/jpeg', 'image/png', 'image/webp',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
]);

const FECHA = /^\d{4}-\d{2}-\d{2}$/;
const texto = (v, max = 500) => String(v ?? '').trim().slice(0, max);
const fechaOpcional = (v) => (FECHA.test(String(v ?? '').trim()) ? String(v).trim() : null);

function fallo(status, mensaje) {
    const e = new Error(mensaje);
    e.status = status;
    return e;
}
function responder(err, res, next) {
    if (err.status) return res.status(err.status).json({ ok: false, error: err.message });
    next(err);
}

const quien = (req) => req.usuario.nombre || req.usuario.usuario;

async function hoyLocal(c = null) {
    const q = c ? (s, p) => c.query(s, p) : consultar;
    const { rows } = await q('SELECT (now() AT TIME ZONE $1)::date::text AS hoy', [ZONA]);
    return rows[0].hoy;
}

function sumarMeses(iso, meses) {
    const d = new Date(`${iso}T12:00:00Z`);
    d.setUTCMonth(d.getUTCMonth() + meses);
    return d.toISOString().slice(0, 10);
}
const diasEntre = (a, b) => Math.round((new Date(`${b}T12:00:00Z`) - new Date(`${a}T12:00:00Z`)) / 86400000);

/**
 * Estado que se muestra. Los definitivos mandan; el resto sale de la fecha,
 * asi un vencido nunca aparece como vigente por falta de un proceso diario.
 */
export function estadoDe(fila, hoy) {
    if (fila.estado && fila.estado !== 'vigente') return fila.estado;
    const venc = fila.vencimiento ? String(fila.vencimiento).slice(0, 10) : '';
    if (!venc) return 'vigente';
    if (venc < hoy) return 'vencido';
    return diasEntre(hoy, venc) <= DIAS_AVISO ? 'proximo_a_vencer' : 'vigente';
}

async function registrar(c, req, accion, entidad, entidadId, motivo, antes, despues) {
    await c.query(
        `INSERT INTO est_actividad (usuario, accion, entidad, entidad_id, motivo, antes, despues)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [quien(req), accion, entidad, entidadId == null ? null : String(entidadId),
            motivo || null, antes ? JSON.stringify(antes) : null, despues ? JSON.stringify(despues) : null]
    );
}

const CAMPOS = ['codigo', 'nombre', 'tipo', 'proveedor', 'lote_proveedor', 'cantidad', 'pureza',
    'conservacion', 'ubicacion', 'recepcion', 'vencimiento', 'reanalisis', 'envases',
    'coa_ref', 'msds_ref', 'observaciones'];

/* ═══════════════════════════════════════════════════════════════════════════
   Lectura
   ═══════════════════════════════════════════════════════════════════════════ */

rutasEstandares.get('/sesion', leer, async (req, res, next) => {
    try {
        const { rows } = await consultar('SELECT importado_en FROM est_importacion');
        res.json({
            ok: true,
            nombre: quien(req),
            permisos: PERMISOS_POR_ROL[req.rol] || [],
            historialImportado: rows.length > 0,
            hoy: await hoyLocal(),
        });
    } catch (err) { next(err); }
});

function comoSalida(f, hoy) {
    return { ...f, recepcion: f.recepcion && String(f.recepcion).slice(0, 10),
        vencimiento: f.vencimiento && String(f.vencimiento).slice(0, 10),
        reanalisis: f.reanalisis ? String(f.reanalisis).slice(0, 10) : '',
        fuera_de_stock_en: f.fuera_de_stock_en ? String(f.fuera_de_stock_en).slice(0, 10) : '',
        estado: estadoDe(f, hoy) };
}

/** GET /api/estandares — el listado de stock (REG-C). */
rutasEstandares.get('/', leer, async (_req, res, next) => {
    try {
        const hoy = await hoyLocal();
        const { rows } = await consultar(
            `SELECT e.*, (SELECT count(*)::int FROM est_adjuntos a WHERE a.estandar_id = e.id) AS adjuntos
             FROM est_estandares e ORDER BY e.codigo`
        );
        res.json({ ok: true, hoy, estandares: rows.map((f) => comoSalida(f, hoy)) });
    } catch (err) { next(err); }
});

/** Un estandar con su registro, inspecciones, certificado y adjuntos. */
async function armarEstandar(id, hoy) {
    const { rows } = await consultar('SELECT * FROM est_estandares WHERE id = $1', [id]);
    if (!rows.length) throw fallo(404, 'No existe ese estándar');
    const [insp, cert, adj] = await Promise.all([
        consultar('SELECT * FROM est_inspecciones WHERE estandar_id = $1 ORDER BY fecha DESC, id DESC', [id]),
        consultar('SELECT * FROM est_certificados WHERE estandar_id = $1', [id]),
        consultar('SELECT id, clase, nombre, tipo, tamano, subido_por, subido_en FROM est_adjuntos WHERE estandar_id = $1', [id]),
    ]);
    return {
        ...comoSalida(rows[0], hoy),
        inspecciones: insp.rows.map((i) => ({ ...i, fecha: String(i.fecha).slice(0, 10) })),
        certificado: cert.rows[0] ? {
            ...cert.rows[0],
            analisis: String(cert.rows[0].analisis).slice(0, 10),
            vencimiento: String(cert.rows[0].vencimiento).slice(0, 10),
            reanalisis: cert.rows[0].reanalisis ? String(cert.rows[0].reanalisis).slice(0, 10) : '',
            ref_vencimiento: cert.rows[0].ref_vencimiento ? String(cert.rows[0].ref_vencimiento).slice(0, 10) : '',
        } : null,
        adjuntos: adj.rows,
    };
}

rutasEstandares.get('/estandar/:id', leer, async (req, res, next) => {
    try {
        res.json({ ok: true, estandar: await armarEstandar(Number(req.params.id), await hoyLocal()) });
    } catch (err) { responder(err, res, next); }
});

/* ═══════════════════════════════════════════════════════════════════════════
   Alta y edicion
   ═══════════════════════════════════════════════════════════════════════════ */

async function proximoLote(c) {
    const { rows } = await c.query('SELECT COALESCE(max(numero), 1221) + 1 AS n FROM est_lotes');
    return Number(rows[0].n);
}

rutasEstandares.get('/lotes', leer, async (_req, res, next) => {
    try {
        const { rows } = await consultar('SELECT * FROM est_lotes ORDER BY numero DESC');
        const { rows: prox } = await consultar('SELECT COALESCE(max(numero), 1221) + 1 AS n FROM est_lotes');
        res.json({ ok: true, lotes: rows, proximo: Number(prox[0].n) });
    } catch (err) { next(err); }
});

rutasEstandares.post('/lotes', cargar, async (req, res, next) => {
    const material = texto(req.body?.material, 200);
    if (!material) return res.status(400).json({ ok: false, error: 'Falta el material' });
    try {
        const numero = await enTransaccion(async (c) => {
            await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['estandares-lote']);
            const n = await proximoLote(c);
            await c.query(
                `INSERT INTO est_lotes (numero, material, lote_proveedor, observaciones, emitido_por, emitido_por_id)
                 VALUES ($1, $2, $3, $4, $5, $6)`,
                [n, material, texto(req.body?.lote_proveedor, 100) || null,
                    texto(req.body?.observaciones, 500) || null, quien(req), req.usuario.id]
            );
            await registrar(c, req, 'lote_emitido', 'lote', n, 'Emisión manual de lote interno');
            return n;
        });
        res.json({ ok: true, numero });
    } catch (err) { next(err); }
});

/** POST /api/estandares — alta (REG-C), con lote interno si se pide. */
rutasEstandares.post('/', cargar, async (req, res, next) => {
    const d = req.body || {};
    try {
        const codigo = texto(d.codigo, 60).toUpperCase();
        const nombre = texto(d.nombre, 200);
        const tipo = texto(d.tipo, 20);
        const recepcion = fechaOpcional(d.recepcion);
        if (!codigo || !nombre || !recepcion) throw fallo(400, 'Faltan código, nombre o fecha de recepción');
        if (!TIPOS.includes(tipo)) throw fallo(400, 'Tipo de estándar desconocido');

        const hoy = await hoyLocal();
        const vencimiento = fechaOpcional(d.vencimiento) || sumarMeses(recepcion, MESES[tipo]);
        // SOP 5.1.2: un estandar vencido no entra.
        if (vencimiento < hoy) throw fallo(400, 'No se puede dar de alta un estándar vencido (SOP 5.1.2)');

        const resultado = await enTransaccion(async (c) => {
            await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['estandares-lote']);
            const { rows: ya } = await c.query('SELECT 1 FROM est_estandares WHERE codigo = $1', [codigo]);
            if (ya.length) throw fallo(409, `Ya existe un estándar con código ${codigo}`);

            let lote = null;
            if (d.emitir_lote !== false) {
                lote = await proximoLote(c);
                await c.query(
                    `INSERT INTO est_lotes (numero, material, lote_proveedor, observaciones, emitido_por, emitido_por_id)
                     VALUES ($1, $2, $3, $4, $5, $6)`,
                    [lote, nombre, texto(d.lote_proveedor, 100) || null,
                        `Emitido al crear el estándar ${codigo}`, quien(req), req.usuario.id]
                );
            }

            const { rows } = await c.query(
                `INSERT INTO est_estandares
                    (codigo, nombre, tipo, proveedor, lote_proveedor, lote_interno, cantidad, pureza,
                     conservacion, ubicacion, recepcion, vencimiento, reanalisis, envases,
                     coa_ref, msds_ref, observaciones, creado_por, creado_por_id, actualizado_por)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$18)
                 RETURNING *`,
                [codigo, nombre, tipo, texto(d.proveedor, 200) || null, texto(d.lote_proveedor, 100) || null,
                    lote, texto(d.cantidad, 60) || null, texto(d.pureza, 60) || null,
                    texto(d.conservacion, 200) || null, texto(d.ubicacion, 120) || null,
                    recepcion, vencimiento, fechaOpcional(d.reanalisis),
                    Math.min(Math.max(Number(d.envases) || 1, 1), 99),
                    texto(d.coa_ref, 200) || null, texto(d.msds_ref, 200) || null,
                    texto(d.observaciones, 1000) || null, quien(req), req.usuario.id]
            );
            await registrar(c, req, 'alta', 'estandar', rows[0].id, `Alta del estándar ${codigo}`, null, rows[0]);
            return { id: rows[0].id, lote };
        });
        res.json({ ok: true, ...resultado, vencimiento });
    } catch (err) { responder(err, res, next); }
});

/** POST /api/estandares/estandar/:id — edicion, con motivo obligatorio. */
rutasEstandares.post('/estandar/:id', cargar, async (req, res, next) => {
    const d = req.body || {};
    const motivo = texto(d.motivo, 1000);
    try {
        if (motivo.length < 5) throw fallo(400, 'Escribí el motivo del cambio (queda en el audit trail)');
        const id = Number(req.params.id);
        await enTransaccion(async (c) => {
            const { rows } = await c.query('SELECT * FROM est_estandares WHERE id = $1 FOR UPDATE', [id]);
            const antes = rows[0];
            if (!antes) throw fallo(404, 'No existe ese estándar');

            const set = {};
            for (const campo of CAMPOS) {
                if (d[campo] === undefined) continue;
                if (['recepcion', 'vencimiento', 'reanalisis'].includes(campo)) {
                    const f = fechaOpcional(d[campo]);
                    if (campo !== 'reanalisis' && !f) throw fallo(400, `Fecha inválida en ${campo}`);
                    set[campo] = f;
                } else if (campo === 'envases') {
                    set[campo] = Math.min(Math.max(Number(d[campo]) || 1, 1), 99);
                } else if (campo === 'tipo') {
                    if (!TIPOS.includes(texto(d[campo], 20))) throw fallo(400, 'Tipo desconocido');
                    set[campo] = texto(d[campo], 20);
                } else if (campo === 'codigo') {
                    set[campo] = texto(d[campo], 60).toUpperCase();
                } else {
                    set[campo] = texto(d[campo], 1000) || null;
                }
            }
            if (!Object.keys(set).length) throw fallo(400, 'No hay nada para cambiar');
            set.actualizado_por = quien(req);
            set.actualizado_en = new Date();
            // Cambio de fechas: vuelve a avisar desde cero.
            if (set.vencimiento && String(set.vencimiento) !== String(antes.vencimiento).slice(0, 10)) {
                set.aviso_umbral = null;
            }
            const claves = Object.keys(set);
            const { rows: act } = await c.query(
                `UPDATE est_estandares SET ${claves.map((k, i) => `${k} = $${i + 2}`).join(', ')}
                 WHERE id = $1 RETURNING *`,
                [id, ...claves.map((k) => set[k])]
            );
            await registrar(c, req, 'edicion', 'estandar', id, motivo, antes, act[0]);
        });
        res.json({ ok: true });
    } catch (err) { responder(err, res, next); }
});

/** POST /api/estandares/estandar/:id/estado  { estado, motivo } */
rutasEstandares.post('/estandar/:id/estado', cargar, async (req, res, next) => {
    const estado = texto(req.body?.estado, 20);
    const motivo = texto(req.body?.motivo, 1000);
    try {
        if (!['alterado', 'obsoleto', 'fuera_de_stock'].includes(estado)) throw fallo(400, 'Estado no permitido');
        if (motivo.length < 5) throw fallo(400, 'Escribí el motivo (queda en el audit trail)');
        const id = Number(req.params.id);
        await enTransaccion(async (c) => {
            const { rows } = await c.query('SELECT * FROM est_estandares WHERE id = $1 FOR UPDATE', [id]);
            const antes = rows[0];
            if (!antes) throw fallo(404, 'No existe ese estándar');
            if (antes.estado !== 'vigente') throw fallo(409, `El estándar ya está marcado como ${antes.estado}`);
            const { rows: act } = await c.query(
                `UPDATE est_estandares SET estado = $2, fuera_de_stock_en = $3,
                        actualizado_por = $4, actualizado_en = now()
                 WHERE id = $1 RETURNING *`,
                [id, estado, estado === 'alterado' ? null : await hoyLocal(c), quien(req)]
            );
            await registrar(c, req, 'estado', 'estandar', id, `Marcado ${estado}: ${motivo}`, antes, act[0]);
        });
        res.json({ ok: true });
    } catch (err) { responder(err, res, next); }
});

/**
 * POST /api/estandares/estandar/:id/reanalisis  { reanalisis, vencimiento?, resultado }
 * Retest conforme: extiende las fechas y deja la inspeccion con el resultado.
 */
rutasEstandares.post('/estandar/:id/reanalisis', cargar, async (req, res, next) => {
    const nuevaReanalisis = fechaOpcional(req.body?.reanalisis);
    const nuevoVencimiento = fechaOpcional(req.body?.vencimiento);
    const resultado = texto(req.body?.resultado, 1000);
    try {
        if (!nuevaReanalisis) throw fallo(400, 'Falta la nueva fecha de reanálisis');
        if (resultado.length < 5) throw fallo(400, 'Escribí el resultado del reanálisis');
        const id = Number(req.params.id);
        await enTransaccion(async (c) => {
            const { rows } = await c.query('SELECT * FROM est_estandares WHERE id = $1 FOR UPDATE', [id]);
            const antes = rows[0];
            if (!antes) throw fallo(404, 'No existe ese estándar');
            if (antes.estado !== 'vigente') throw fallo(409, `No se puede reanalizar un estándar ${antes.estado}`);
            const { rows: act } = await c.query(
                `UPDATE est_estandares SET reanalisis = $2,
                        vencimiento = COALESCE($3::date, vencimiento),
                        aviso_umbral = NULL, aviso_en = NULL,
                        actualizado_por = $4, actualizado_en = now()
                 WHERE id = $1 RETURNING *`,
                [id, nuevaReanalisis, nuevoVencimiento, quien(req)]
            );
            await c.query(
                `INSERT INTO est_inspecciones (estandar_id, fecha, conforme, observacion, analista, analista_id)
                 VALUES ($1, $2, true, $3, $4, $5)`,
                [id, await hoyLocal(c),
                    `REANÁLISIS conforme. ${resultado} Nueva fecha de reanálisis: ${nuevaReanalisis}` +
                    (nuevoVencimiento ? `. Nuevo vencimiento: ${nuevoVencimiento}` : '') + '.',
                    quien(req), req.usuario.id]
            );
            await registrar(c, req, 'reanalisis', 'estandar', id, resultado, antes, act[0]);
        });
        res.json({ ok: true });
    } catch (err) { responder(err, res, next); }
});

/** POST /api/estandares/estandar/:id/registro  { conservacion, notas, motivo } — REG-A */
rutasEstandares.post('/estandar/:id/registro', cargar, async (req, res, next) => {
    const motivo = texto(req.body?.motivo, 1000);
    try {
        if (motivo.length < 5) throw fallo(400, 'Escribí el motivo del cambio');
        const id = Number(req.params.id);
        await enTransaccion(async (c) => {
            const { rows } = await c.query('SELECT * FROM est_estandares WHERE id = $1 FOR UPDATE', [id]);
            if (!rows.length) throw fallo(404, 'No existe ese estándar');
            const { rows: act } = await c.query(
                `UPDATE est_estandares SET conservacion = $2, notas = $3,
                        actualizado_por = $4, actualizado_en = now()
                 WHERE id = $1 RETURNING *`,
                [id, texto(req.body?.conservacion, 200) || null, texto(req.body?.notas, 2000) || null, quien(req)]
            );
            await registrar(c, req, 'registro', 'estandar', id, motivo, rows[0], act[0]);
        });
        res.json({ ok: true });
    } catch (err) { responder(err, res, next); }
});

/** POST /api/estandares/estandar/:id/inspecciones  { fecha, conforme, observacion } — REG-A */
rutasEstandares.post('/estandar/:id/inspecciones', cargar, async (req, res, next) => {
    const fecha = fechaOpcional(req.body?.fecha);
    try {
        if (!fecha) throw fallo(400, 'Falta la fecha de la inspección');
        const hoy = await hoyLocal();
        if (fecha > hoy) throw fallo(400, 'La inspección no puede ser futura');
        const id = Number(req.params.id);
        const conforme = req.body?.conforme !== false;
        const observacion = texto(req.body?.observacion, 1000);
        if (!conforme && observacion.length < 5) throw fallo(400, 'Una inspección no conforme lleva observación');
        await enTransaccion(async (c) => {
            const { rows } = await c.query('SELECT 1 FROM est_estandares WHERE id = $1', [id]);
            if (!rows.length) throw fallo(404, 'No existe ese estándar');
            const { rows: ins } = await c.query(
                `INSERT INTO est_inspecciones (estandar_id, fecha, conforme, observacion, analista, analista_id)
                 VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
                [id, fecha, conforme, observacion || null, quien(req), req.usuario.id]
            );
            await registrar(c, req, 'inspeccion', 'estandar', id,
                `Inspección ${conforme ? 'conforme' : 'NO conforme'}`, null, ins[0]);
        });
        res.json({ ok: true });
    } catch (err) { responder(err, res, next); }
});

/* ═══════════════════════════════════════════════════════════════════════════
   REG-B: certificado con doble firma
   ═══════════════════════════════════════════════════════════════════════════ */

rutasEstandares.post('/estandar/:id/certificado', cargar, async (req, res, next) => {
    const d = req.body || {};
    try {
        const id = Number(req.params.id);
        const analisis = fechaOpcional(d.analisis);
        const vencimiento = fechaOpcional(d.vencimiento);
        if (!analisis || !vencimiento) throw fallo(400, 'Faltan la fecha de análisis o la de vencimiento');
        const ensayos = (Array.isArray(d.ensayos) ? d.ensayos : [])
            .map((t) => ({ aspecto: texto(t?.aspecto, 200), especificacion: texto(t?.especificacion, 200), resultado: texto(t?.resultado, 200) }))
            .filter((t) => t.aspecto);
        if (!ensayos.length) throw fallo(400, 'Cargá al menos un ensayo');
        await enTransaccion(async (c) => {
            const { rows } = await c.query('SELECT * FROM est_estandares WHERE id = $1', [id]);
            if (!rows.length) throw fallo(404, 'No existe ese estándar');
            const { rows: ya } = await c.query('SELECT 1 FROM est_certificados WHERE estandar_id = $1', [id]);
            if (ya.length) throw fallo(409, 'Ese estándar ya tiene certificado emitido');
            const { rows: cert } = await c.query(
                `INSERT INTO est_certificados
                    (estandar_id, analisis, ref_sustancia, ref_codigo, ref_pureza, ref_vencimiento,
                     tecnica, reanalisis, vencimiento, ensayos, analista, analista_id, firmado_analista_en)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, now()) RETURNING *`,
                [id, analisis, texto(d.ref_sustancia, 200) || null, texto(d.ref_codigo, 100) || null,
                    texto(d.ref_pureza, 60) || null, fechaOpcional(d.ref_vencimiento),
                    texto(d.tecnica, 200) || null, fechaOpcional(d.reanalisis), vencimiento,
                    JSON.stringify(ensayos), quien(req), req.usuario.id]
            );
            await registrar(c, req, 'certificado', 'estandar', id,
                'Certificado emitido y firmado por la analista', null, cert[0]);
        });
        res.json({ ok: true });
    } catch (err) { responder(err, res, next); }
});

/** Firma de la coordinadora. Exige permiso de aprobar, no solo esconder el boton. */
rutasEstandares.post('/estandar/:id/certificado/firmar', aprobar, async (req, res, next) => {
    try {
        const id = Number(req.params.id);
        const nota = texto(req.body?.nota, 500);
        await enTransaccion(async (c) => {
            const { rows } = await c.query('SELECT * FROM est_certificados WHERE estandar_id = $1 FOR UPDATE', [id]);
            const cert = rows[0];
            if (!cert) throw fallo(404, 'Ese estándar no tiene certificado');
            if (cert.coordinador) throw fallo(409, `El certificado ya fue firmado por ${cert.coordinador}`);
            if (cert.analista_id && Number(cert.analista_id) === Number(req.usuario.id)) {
                throw fallo(409, 'La firma de la coordinadora tiene que ser de otra persona que la analista');
            }
            const { rows: act } = await c.query(
                `UPDATE est_certificados SET coordinador = $2, coordinador_id = $3,
                        firmado_coord_en = now(), nota_coordinador = $4
                 WHERE estandar_id = $1 RETURNING *`,
                [id, quien(req), req.usuario.id, nota || null]
            );
            await registrar(c, req, 'firma_coordinador', 'estandar', id, nota || 'Firma de la coordinadora', cert, act[0]);
        });
        res.json({ ok: true });
    } catch (err) { responder(err, res, next); }
});

/* ═══════════════════════════════════════════════════════════════════════════
   Adjuntos (CoA / MSDS)
   ═══════════════════════════════════════════════════════════════════════════ */

rutasEstandares.post('/estandar/:id/adjuntos', cargar, async (req, res, next) => {
    const clase = texto(req.body?.clase, 10);
    const tipo = texto(req.body?.tipo, 100) || 'application/pdf';
    try {
        if (!['coa', 'msds'].includes(clase)) throw fallo(400, 'El adjunto tiene que ser CoA o MSDS');
        if (!TIPOS_ADJUNTO.has(tipo)) throw fallo(415, 'Se aceptan PDF, Word, JPG, PNG o WEBP');
        const recibido = Buffer.from(String(req.body?.dataBase64 || '').replace(/^data:[^,]*,/, ''), 'base64');
        if (!recibido.length) throw fallo(400, 'El archivo no es válido');
        if (recibido.length > MAX_ADJUNTO) throw fallo(413, 'El archivo supera los 20 MB');

        // Las fotos del certificado se comprimen; un PDF se guarda tal cual.
        const esImagen = tipo.startsWith('image/');
        const { bytes, tipo: tipoFinal } = esImagen
            ? await comprimirFoto(recibido, tipo)
            : { bytes: recibido, tipo };

        const id = Number(req.params.id);
        const nombre = texto(req.body?.nombre, 200) || `${clase}.pdf`;
        await enTransaccion(async (c) => {
            const { rows } = await c.query('SELECT codigo FROM est_estandares WHERE id = $1', [id]);
            if (!rows.length) throw fallo(404, 'No existe ese estándar');
            await c.query(
                `INSERT INTO est_adjuntos (estandar_id, clase, nombre, tipo, tamano, contenido, subido_por)
                 VALUES ($1,$2,$3,$4,$5,$6,$7)
                 ON CONFLICT (estandar_id, clase) DO UPDATE SET
                    nombre = EXCLUDED.nombre, tipo = EXCLUDED.tipo, tamano = EXCLUDED.tamano,
                    contenido = EXCLUDED.contenido, subido_por = EXCLUDED.subido_por, subido_en = now()`,
                [id, clase, nombre, tipoFinal, bytes.length, bytes, quien(req)]
            );
            await registrar(c, req, 'adjunto', 'estandar', id,
                `${clase.toUpperCase()}: ${nombre} (${Math.round(bytes.length / 1024)} KB)`);
        });
        res.json({ ok: true });
    } catch (err) { responder(err, res, next); }
});

rutasEstandares.get('/adjuntos/:id', leer, async (req, res, next) => {
    try {
        const { rows } = await consultar('SELECT * FROM est_adjuntos WHERE id = $1', [Number(req.params.id)]);
        if (!rows.length) return res.status(404).json({ ok: false, error: 'No existe ese archivo' });
        res.type(rows[0].tipo)
            .set('Content-Disposition', `inline; filename="${rows[0].nombre.replace(/[^\w.\- ]/g, '_')}"`)
            .set('Cache-Control', 'private, max-age=600')
            .send(rows[0].contenido);
    } catch (err) { next(err); }
});

rutasEstandares.post('/adjuntos/:id/quitar', cargar, async (req, res, next) => {
    const motivo = texto(req.body?.motivo, 1000);
    try {
        if (motivo.length < 5) throw fallo(400, 'Escribí el motivo (queda en el audit trail)');
        await enTransaccion(async (c) => {
            const { rows } = await c.query('SELECT id, estandar_id, clase, nombre FROM est_adjuntos WHERE id = $1', [Number(req.params.id)]);
            if (!rows.length) throw fallo(404, 'No existe ese archivo');
            await c.query('DELETE FROM est_adjuntos WHERE id = $1', [rows[0].id]);
            await registrar(c, req, 'adjunto_quitado', 'estandar', rows[0].estandar_id,
                `${rows[0].clase.toUpperCase()} ${rows[0].nombre}: ${motivo}`, rows[0], null);
        });
        res.json({ ok: true });
    } catch (err) { responder(err, res, next); }
});

/* ═══════════════════════════════════════════════════════════════════════════
   Impresion: rotulo (REG-D) y certificado (REG-B), con las firmas de graneles
   ═══════════════════════════════════════════════════════════════════════════ */

rutasEstandares.get('/estandar/:id/impresion', leer, async (req, res, next) => {
    try {
        const id = Number(req.params.id);
        const hoy = await hoyLocal();
        const e = await armarEstandar(id, hoy);
        const firmas = [];
        const alta = e.creado_por_id ? await firmaDe(e.creado_por_id, e.creado_en, e.creado_por) : null;
        firmas.push({ rol: 'Creado por', nombre: e.creado_por || '—', firmadoEn: e.creado_en,
            sinFirma: !alta, deLaPlanilla: e.origen !== 'app', ...(alta || {}) });
        if (e.certificado) {
            const a = e.certificado.analista_id
                ? await firmaDe(e.certificado.analista_id, e.certificado.firmado_analista_en, e.certificado.analista) : null;
            firmas.push({ rol: 'Analista', nombre: e.certificado.analista || '—',
                firmadoEn: e.certificado.firmado_analista_en, sinFirma: !a,
                deLaPlanilla: e.certificado.origen !== 'app', ...(a || {}) });
            if (e.certificado.coordinador) {
                const co = e.certificado.coordinador_id
                    ? await firmaDe(e.certificado.coordinador_id, e.certificado.firmado_coord_en, e.certificado.coordinador) : null;
                firmas.push({ rol: 'Coordinadora C.C.', nombre: e.certificado.coordinador,
                    firmadoEn: e.certificado.firmado_coord_en, sinFirma: !co, ...(co || {}) });
            }
        }
        await enTransaccion((c) => registrar(c, req, 'impresion', 'estandar', id,
            texto(req.query.que, 30) === 'rotulo' ? 'Rótulo REG-D' : 'Certificado REG-B'));
        res.json({ ok: true, estandar: e, firmas, impreso: { por: quien(req), en: new Date().toISOString() } });
    } catch (err) { responder(err, res, next); }
});

/* ═══════════════════════════════════════════════════════════════════════════
   Audit trail e importacion del historial
   ═══════════════════════════════════════════════════════════════════════════ */

rutasEstandares.get('/actividad', leer, async (req, res, next) => {
    try {
        const limite = Math.min(Math.max(Number(req.query.limite) || 300, 1), 2000);
        const { rows } = await consultar('SELECT * FROM est_actividad ORDER BY ts DESC LIMIT $1', [limite]);
        res.json({ ok: true, actividad: rows });
    } catch (err) { next(err); }
});

/**
 * POST /api/estandares/importar — una sola vez, desde el .xlsx de la planilla
 * leido en el navegador. Cuerpo: { estandares: [...], lotes: [...],
 * inspecciones: [...], certificados: [...], confirmar }
 *
 * Sin `confirmar` solo cuenta lo que entraria. Todo lo importado queda con
 * origen 'planilla': esas filas no tienen firma electronica y las hojas lo
 * dicen, en vez de aparentar una firma que nunca existio.
 */
rutasEstandares.post('/importar', administrar, async (req, res, next) => {
    const d = req.body || {};
    try {
        const { rows: ya } = await consultar('SELECT importado_en FROM est_importacion');
        if (ya.length) throw fallo(409, `El historial ya se importó el ${String(ya[0].importado_en).slice(0, 10)}`);

        const estandares = Array.isArray(d.estandares) ? d.estandares : [];
        const lotes = Array.isArray(d.lotes) ? d.lotes : [];
        const inspecciones = Array.isArray(d.inspecciones) ? d.inspecciones : [];
        const certificados = Array.isArray(d.certificados) ? d.certificados : [];
        if (!estandares.length) throw fallo(400, 'La planilla no trae estándares');

        const resumen = { estandares: estandares.length, lotes: lotes.length,
            inspecciones: inspecciones.length, certificados: certificados.length };
        if (d.confirmar !== true) return res.json({ ok: true, preview: resumen });

        const hecho = await enTransaccion(async (c) => {
            const conteo = { estandares: 0, lotes: 0, inspecciones: 0, certificados: 0 };
            for (const l of lotes) {
                const numero = Number(l.numero);
                if (!Number.isSafeInteger(numero)) continue;
                const { rowCount } = await c.query(
                    `INSERT INTO est_lotes (numero, material, lote_proveedor, observaciones, emitido_por, emitido_en, origen)
                     VALUES ($1,$2,$3,$4,$5,COALESCE($6::timestamptz, now()),'planilla')
                     ON CONFLICT (numero) DO NOTHING`,
                    [numero, texto(l.material, 200) || '—', texto(l.lote_proveedor, 100) || null,
                        texto(l.observaciones, 500) || null, texto(l.emitido_por, 120) || null, l.emitido_en || null]
                );
                conteo.lotes += rowCount;
            }
            const porCodigo = new Map();
            for (const e of estandares) {
                const codigo = texto(e.codigo, 60).toUpperCase();
                const tipo = TIPOS.includes(texto(e.tipo, 20)) ? texto(e.tipo, 20) : 'mp';
                const recepcion = fechaOpcional(e.recepcion);
                const vencimiento = fechaOpcional(e.vencimiento);
                if (!codigo || !recepcion || !vencimiento) continue;
                const estado = ['alterado', 'obsoleto', 'fuera_de_stock'].includes(texto(e.estado, 20))
                    ? texto(e.estado, 20) : 'vigente';
                const { rows } = await c.query(
                    `INSERT INTO est_estandares
                        (codigo, nombre, tipo, proveedor, lote_proveedor, lote_interno, cantidad, pureza,
                         conservacion, ubicacion, recepcion, vencimiento, reanalisis, fuera_de_stock_en,
                         envases, coa_ref, msds_ref, observaciones, estado, creado_por, creado_en,
                         actualizado_por, origen)
                     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,
                             COALESCE($21::timestamptz, now()), $20, 'planilla')
                     ON CONFLICT (codigo) DO NOTHING
                     RETURNING id`,
                    [codigo, texto(e.nombre, 200) || codigo, tipo, texto(e.proveedor, 200) || null,
                        texto(e.lote_proveedor, 100) || null,
                        Number.isSafeInteger(Number(e.lote_interno)) && e.lote_interno ? Number(e.lote_interno) : null,
                        texto(e.cantidad, 60) || null, texto(e.pureza, 60) || null,
                        texto(e.conservacion, 200) || null, texto(e.ubicacion, 120) || null,
                        recepcion, vencimiento, fechaOpcional(e.reanalisis), fechaOpcional(e.fuera_de_stock_en),
                        Math.min(Math.max(Number(e.envases) || 1, 1), 99),
                        texto(e.coa_ref, 200) || null, texto(e.msds_ref, 200) || null,
                        texto(e.observaciones, 1000) || null, estado, texto(e.creado_por, 120) || null,
                        e.creado_en || null]
                );
                if (rows.length) { conteo.estandares++; porCodigo.set(codigo, rows[0].id); }
            }
            for (const i of inspecciones) {
                const id = porCodigo.get(texto(i.codigo, 60).toUpperCase());
                const fecha = fechaOpcional(i.fecha);
                if (!id || !fecha) continue;
                await c.query(
                    `INSERT INTO est_inspecciones (estandar_id, fecha, conforme, observacion, analista, creado_en, origen)
                     VALUES ($1,$2,$3,$4,$5,COALESCE($6::timestamptz, now()),'planilla')`,
                    [id, fecha, i.conforme !== false, texto(i.observacion, 1000) || null,
                        texto(i.analista, 120) || null, i.creado_en || null]
                );
                conteo.inspecciones++;
            }
            for (const cert of certificados) {
                const id = porCodigo.get(texto(cert.codigo, 60).toUpperCase());
                const analisis = fechaOpcional(cert.analisis);
                const vencimiento = fechaOpcional(cert.vencimiento);
                if (!id || !analisis || !vencimiento) continue;
                const ensayos = Array.isArray(cert.ensayos) ? cert.ensayos : [];
                const { rowCount } = await c.query(
                    `INSERT INTO est_certificados
                        (estandar_id, analisis, ref_sustancia, ref_codigo, ref_pureza, ref_vencimiento,
                         tecnica, reanalisis, vencimiento, ensayos, analista, firmado_analista_en,
                         coordinador, firmado_coord_en, origen)
                     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'planilla')
                     ON CONFLICT (estandar_id) DO NOTHING`,
                    [id, analisis, texto(cert.ref_sustancia, 200) || null, texto(cert.ref_codigo, 100) || null,
                        texto(cert.ref_pureza, 60) || null, fechaOpcional(cert.ref_vencimiento),
                        texto(cert.tecnica, 200) || null, fechaOpcional(cert.reanalisis), vencimiento,
                        JSON.stringify(ensayos), texto(cert.analista, 120) || null, cert.firmado_analista_en || null,
                        texto(cert.coordinador, 120) || null, cert.firmado_coord_en || null]
                );
                conteo.certificados += rowCount;
            }
            await c.query(
                `INSERT INTO est_importacion (importado_por, detalle) VALUES ($1, $2)`,
                [quien(req), `${conteo.estandares} estándares, ${conteo.lotes} lotes, ` +
                    `${conteo.inspecciones} inspecciones, ${conteo.certificados} certificados`]
            );
            await registrar(c, req, 'importacion', 'historial', null,
                `Importación del historial de la planilla`, null, conteo);
            return conteo;
        });
        res.json({ ok: true, importado: hecho });
    } catch (err) { responder(err, res, next); }
});
