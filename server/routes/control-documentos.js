/**
 * Control de documentos (GMP / ISO 9001 7.5 / 21 CFR Part 11) — migracion 054.
 *
 * Etapa cero: documentos, versiones en borrador, firma electronica y audit
 * trail. El ciclo de revision (pasos, plazos, correos), la carga de Word/PDF y
 * el entrenamiento se suman encima de esto; por eso firmar todavia no cambia
 * el estado de la version.
 *
 * Toda escritura va por enTransaccionAuditada: el audit trail lo escribe la
 * base, y sin autor declarado rechaza el cambio.
 *
 * Quien ve que: con solo `ver` se ve unicamente la version vigente. Los
 * borradores y las versiones en curso los ve quien carga, revisa o aprueba;
 * los obsoletos, quien administra.
 */
import express, { Router } from 'express';
import { createHash } from 'node:crypto';
import { consultar } from '../db.js';
import { exigirPermiso } from '../lib/acceso.js';
import { auditar } from '../lib/sesiones.js';
import { PERMISOS_POR_ROL, puede } from '../lib/permisos.js';
import { enTransaccionAuditada, historial, verificarIntegridad } from '../lib/audit-trail.js';
import { firmar, firmasDe, SIGNIFICADOS } from '../lib/firma-electronica.js';
import { analizarListado, escalonarAvisos } from '../lib/importar-listado.js';
import { guardar, abrir, extension, hayAlmacen, MAX_BYTES } from '../lib/almacen-documentos.js';

export const rutasControlDocumentos = Router();

const RECURSO = 'control-documentos';
const leer = exigirPermiso(RECURSO, 'ver');
const cargar = exigirPermiso(RECURSO, 'cargar');
const administrar = exigirPermiso(RECURSO, 'administrar');

// Que permiso hace falta para firmar con cada significado. `lectura` la firma
// cualquiera que pueda ver: es la constancia de entrenamiento.
const PERMISO_FIRMA = {
    autor: 'cargar',
    revisor: 'revisar',
    aprobador: 'aprobar',
    aprobador_calidad: 'aprobar',
    rechazo: 'revisar',
    lectura: 'ver',
    obsolescencia: 'administrar',
    // revision_periodica no va por /firmar: se firma en /renovar, que ademas
    // corre el vencimiento. Firmarla suelta dejaria una renovacion sin efecto.
};

const EN_CURSO = ['borrador', 'en_revision', 'en_aprobacion', 'aprobado', 'en_entrenamiento'];

const sha256 = (txt) => createHash('sha256').update(txt, 'utf8').digest('hex');
const texto = (v) => (v == null ? '' : String(v).trim());

function fallo(status, mensaje) {
    const e = new Error(mensaje);
    e.status = status;
    return e;
}
function responder(err, res, next) {
    if (err.status) return res.status(err.status).json({ ok: false, error: err.message });
    // Las reglas que hace cumplir la base (contenido firmado, motivo, sin
    // borrado) llegan como excepcion de Postgres: se devuelven como 409 con su
    // mensaje, que esta escrito para que se entienda.
    if (err.code === 'P0001') return res.status(409).json({ ok: false, error: err.message });
    if (err.code === '23505') return res.status(409).json({ ok: false, error: 'ya existe: ' + (err.detail || err.message) });
    next(err);
}

/** Que estados de version puede ver este rol. */
function estadosVisibles(rol) {
    const p = PERMISOS_POR_ROL[rol] || [];
    if (p.includes('administrar')) return null; // todos
    if (p.some((x) => ['cargar', 'revisar', 'aprobar'].includes(x))) return ['vigente', ...EN_CURSO];
    return ['vigente'];
}

/** GET /api/control-documentos/tipos */
rutasControlDocumentos.get('/tipos', leer, async (_req, res, next) => {
    try {
        const { rows } = await consultar(
            'SELECT codigo, nombre, meses_revision FROM dc_tipos WHERE activo ORDER BY codigo');
        res.json({ ok: true, tipos: rows, significados: SIGNIFICADOS });
    } catch (err) { next(err); }
});

/**
 * GET /api/control-documentos/documentos
 * Listado maestro: cada documento con su version vigente y la que este en curso.
 */
rutasControlDocumentos.get('/documentos', leer, async (req, res, next) => {
    try {
        const verEnCurso = estadosVisibles(req.rol)?.includes('borrador') ?? true;
        const { rows } = await consultar(
            `SELECT d.id, d.codigo, d.titulo, d.tipo, d.area, d.externo, d.proxima_revision, d.avisar_desde,
                    (v.pdf_sha256 IS NOT NULL OR v.archivo_sha256 IS NOT NULL) AS vigente_con_archivo,
                    du.nombre AS dueno,
                    v.id AS vigente_id, v.numero AS vigente_numero, v.fecha_vigencia,
                    CASE WHEN $1 THEN c.id END     AS en_curso_id,
                    CASE WHEN $1 THEN c.numero END AS en_curso_numero,
                    CASE WHEN $1 THEN c.estado END AS en_curso_estado
             FROM dc_documentos d
             LEFT JOIN usuarios du ON du.id = d.dueno_id
             LEFT JOIN dc_versiones v ON v.documento_id = d.id AND v.estado = 'vigente'
             LEFT JOIN dc_versiones c ON c.documento_id = d.id AND c.estado = ANY($2)
             WHERE $1 OR v.id IS NOT NULL
             ORDER BY d.codigo`,
            [verEnCurso, EN_CURSO]
        );
        res.json({ ok: true, permisos: PERMISOS_POR_ROL[req.rol] || [], documentos: rows });
    } catch (err) { next(err); }
});

/** GET /api/control-documentos/documentos/:id — datos, versiones visibles y firmas. */
rutasControlDocumentos.get('/documentos/:id', leer, async (req, res, next) => {
    try {
        const { rows: [doc] } = await consultar(
            `SELECT d.*, du.nombre AS dueno FROM dc_documentos d
             LEFT JOIN usuarios du ON du.id = d.dueno_id WHERE d.id = $1`,
            [req.params.id]
        );
        if (!doc) throw fallo(404, 'documento inexistente');

        const visibles = estadosVisibles(req.rol);
        const { rows: versiones } = await consultar(
            `SELECT v.id, v.numero, v.estado, v.formato, v.resumen_cambios, v.cc_codigo,
                    v.requiere_evaluacion, v.fecha_aprobacion, v.fecha_vigencia, v.fecha_obsoleto,
                    v.contenido_sha256, v.archivo_nombre, v.creado_en, u.nombre AS creado_por
             FROM dc_versiones v LEFT JOIN usuarios u ON u.id = v.creado_por_id
             WHERE v.documento_id = $1 AND ($2::text[] IS NULL OR v.estado = ANY($2))
             ORDER BY v.numero DESC`,
            [doc.id, visibles]
        );
        for (const v of versiones) v.firmas = await firmasDe('dc_versiones', v.id);

        res.json({ ok: true, documento: doc, versiones });
    } catch (err) { responder(err, res, next); }
});

/** GET /api/control-documentos/versiones/:id — una version con su contenido. */
rutasControlDocumentos.get('/versiones/:id', leer, async (req, res, next) => {
    try {
        const { rows: [v] } = await consultar('SELECT * FROM dc_versiones WHERE id = $1', [req.params.id]);
        const visibles = estadosVisibles(req.rol);
        // Mismo 404 exista o no: a quien no puede ver borradores no se le
        // confirma que hay uno.
        if (!v || (visibles && !visibles.includes(v.estado))) throw fallo(404, 'version inexistente');
        v.firmas = await firmasDe('dc_versiones', v.id);
        res.json({ ok: true, version: v });
    } catch (err) { responder(err, res, next); }
});

/**
 * POST /api/control-documentos/documentos
 * { codigo, titulo, tipo, area, duenoId, numero, contenidoHtml, resumenCambios, ccCodigo }
 * Alta de un documento nuevo con su primera version en borrador, escrita en el
 * editor. Los existentes en Word/PDF entran por la importacion (etapa 1).
 */
rutasControlDocumentos.post('/documentos', cargar, async (req, res, next) => {
    const b = req.body || {};
    const codigo = texto(b.codigo).toUpperCase();
    const titulo = texto(b.titulo);
    const tipo = texto(b.tipo).toUpperCase();
    const numero = b.numero == null || b.numero === '' ? 1 : Number(b.numero);
    const html = String(b.contenidoHtml || '');

    try {
        if (!codigo || !titulo || !tipo) throw fallo(400, 'faltan código, título o tipo');
        if (!Number.isInteger(numero) || numero < 0) throw fallo(400, 'número de versión inválido');

        const r = await enTransaccionAuditada(req, 'alta de documento', async (c) => {
            const { rows: [d] } = await c.query(
                `INSERT INTO dc_documentos (codigo, titulo, tipo, area, dueno_id, creado_por_id)
                 VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
                [codigo, titulo, tipo, texto(b.area) || null, b.duenoId || req.usuario.id, req.usuario.id]
            );
            const { rows: [v] } = await c.query(
                `INSERT INTO dc_versiones (documento_id, numero, formato, contenido_html, contenido_sha256,
                                           resumen_cambios, cc_codigo, creado_por_id)
                 VALUES ($1,$2,'editor',$3,$4,$5,$6,$7) RETURNING id`,
                [d.id, numero, html, sha256(html), texto(b.resumenCambios) || null,
                 texto(b.ccCodigo) || null, req.usuario.id]
            );
            return { documentoId: d.id, versionId: v.id };
        });
        res.status(201).json({ ok: true, ...r });
    } catch (err) {
        if (err.code === '23503') return res.status(400).json({ ok: false, error: `tipo de documento desconocido: ${tipo}` });
        responder(err, res, next);
    }
});

/**
 * PUT /api/control-documentos/versiones/:id  { contenidoHtml, resumenCambios, ccCodigo }
 * Edita un borrador del editor. Fuera de borrador la base lo rechaza.
 */
rutasControlDocumentos.put('/versiones/:id', cargar, async (req, res, next) => {
    const b = req.body || {};
    try {
        const r = await enTransaccionAuditada(req, texto(b.motivo) || 'edición de borrador', async (c) => {
            const { rows: [v] } = await c.query(
                'SELECT estado, formato FROM dc_versiones WHERE id = $1 FOR UPDATE', [req.params.id]);
            if (!v) throw fallo(404, 'version inexistente');
            if (v.estado !== 'borrador') throw fallo(409, 'solo se edita una versión en borrador');
            if (v.formato !== 'editor') throw fallo(409, 'esta versión es un archivo: se reemplaza subiendo otro');

            const html = b.contenidoHtml == null ? null : String(b.contenidoHtml);
            const { rows: [n] } = await c.query(
                `UPDATE dc_versiones SET
                    contenido_html   = coalesce($2, contenido_html),
                    contenido_sha256 = coalesce($3, contenido_sha256),
                    resumen_cambios  = coalesce($4, resumen_cambios),
                    cc_codigo        = coalesce($5, cc_codigo)
                 WHERE id = $1 RETURNING contenido_sha256`,
                [req.params.id, html, html == null ? null : sha256(html),
                 b.resumenCambios == null ? null : texto(b.resumenCambios),
                 b.ccCodigo == null ? null : texto(b.ccCodigo)]
            );
            return n;
        });
        res.json({ ok: true, contenidoSha256: r.contenido_sha256 });
    } catch (err) { responder(err, res, next); }
});

/**
 * PATCH /api/control-documentos/documentos/:id
 * { motivo, titulo, area, duenoId, mesesRevision, proximaRevision }
 * Corrige datos del documento. El motivo es obligatorio: lo exige la base.
 */
rutasControlDocumentos.patch('/documentos/:id', administrar, async (req, res, next) => {
    const b = req.body || {};
    try {
        const motivo = texto(b.motivo);
        if (!motivo) throw fallo(400, 'indicá el motivo del cambio');
        await enTransaccionAuditada(req, motivo, async (c) => {
            const { rowCount } = await c.query(
                `UPDATE dc_documentos SET
                    titulo           = coalesce($2, titulo),
                    area             = coalesce($3, area),
                    dueno_id         = coalesce($4, dueno_id),
                    meses_revision   = coalesce($5, meses_revision),
                    proxima_revision = coalesce($6, proxima_revision)
                 WHERE id = $1`,
                [req.params.id, texto(b.titulo) || null, texto(b.area) || null, b.duenoId || null,
                 b.mesesRevision || null, b.proximaRevision || null]
            );
            if (!rowCount) throw fallo(404, 'documento inexistente');
        });
        res.json({ ok: true });
    } catch (err) { responder(err, res, next); }
});

/**
 * POST /api/control-documentos/versiones/:id/firmar
 * { usuario, clave, significado, comentario }
 *
 * Firma la version sobre el hash de su contenido. Por ahora no mueve el
 * estado: las reglas de quien firma en que paso llegan con el ciclo.
 */
rutasControlDocumentos.post('/versiones/:id/firmar', leer, async (req, res, next) => {
    const b = req.body || {};
    try {
        const significado = texto(b.significado);
        const necesita = PERMISO_FIRMA[significado];
        if (!necesita) throw fallo(400, 'significado de firma desconocido');
        if (!puede(req.rol, necesita)) throw fallo(403, `tu rol no puede firmar como "${SIGNIFICADOS[significado]}"`);

        const firma = await enTransaccionAuditada(req, `firma: ${SIGNIFICADOS[significado]}`, async (c) => {
            const { rows: [v] } = await c.query(
                `SELECT id, estado, coalesce(pdf_sha256, contenido_sha256, archivo_sha256) AS huella
                 FROM dc_versiones WHERE id = $1 FOR UPDATE`,
                [req.params.id]
            );
            const visibles = estadosVisibles(req.rol);
            if (!v || (visibles && !visibles.includes(v.estado))) throw fallo(404, 'version inexistente');
            if (['obsoleto', 'anulado'].includes(v.estado)) throw fallo(409, `la versión está ${v.estado}`);
            if (!v.huella) throw fallo(409, 'la versión no tiene contenido para firmar');

            return firmar(c, req, {
                usuario: b.usuario, clave: b.clave, significado,
                recurso: RECURSO, tabla: 'dc_versiones', registroId: v.id,
                contenidoSha256: v.huella, comentario: texto(b.comentario) || null,
            });
        });
        res.status(201).json({ ok: true, firma });
    } catch (err) { responder(err, res, next); }
});

/**
 * POST /api/control-documentos/documentos/:id/renovar  { usuario, clave, comentario }
 *
 * Revision periodica sin cambios: el documento vence a los 3 años y, si no
 * hay nada que cambiar, se renueva por otros 3 sin nueva version, sin ciclo de
 * aprobacion y sin reentrenar (decision de Claudia, 07/10/2026).
 *
 * Lo que NO hace es renovarse solo: alguien tiene que mirar el documento y
 * firmar que sigue vigente. Una renovacion sin persona que la decida seria una
 * fecha que se corre, no una revision, y en una inspeccion se lee asi.
 *
 * Renueva quien aprobo la version vigente -por firma en el sistema o, si se
 * aprobo en papel, segun el listado maestro- o Calidad (Claudia y Gloria, que
 * administran). Decision de Claudia, 07/10/2026. El nuevo vencimiento se
 * cuenta desde hoy.
 */
rutasControlDocumentos.post('/documentos/:id/renovar', leer, async (req, res, next) => {
    const b = req.body || {};
    try {
        const r = await enTransaccionAuditada(req, 'revisión periódica sin cambios', async (c) => {
            const { rows: [d] } = await c.query(
                `SELECT d.id, coalesce(d.meses_revision, t.meses_revision) AS meses,
                        v.id AS version_id,
                        coalesce(v.pdf_sha256, v.contenido_sha256, v.archivo_sha256) AS huella,
                        (v.aprobado_por_id = $2 OR EXISTS (
                            SELECT 1 FROM firmas_electronicas f
                            WHERE f.tabla = 'dc_versiones' AND f.registro_id = v.id::text
                              AND f.usuario_id = $2
                              AND f.significado IN ('aprobador', 'aprobador_calidad')
                        )) AS es_aprobador
                 FROM dc_documentos d
                 JOIN dc_tipos t ON t.codigo = d.tipo
                 LEFT JOIN dc_versiones v ON v.documento_id = d.id AND v.estado = 'vigente'
                 WHERE d.id = $1 FOR UPDATE OF d`,
                [req.params.id, req.usuario.id]
            );
            if (!d) throw fallo(404, 'documento inexistente');
            if (!d.version_id) throw fallo(409, 'el documento no tiene versión vigente para renovar');
            if (!d.es_aprobador && !puede(req.rol, 'administrar')) {
                throw fallo(403, 'renueva quien aprobó el documento, o Calidad');
            }
            if (!d.huella) throw fallo(409, 'la versión vigente no tiene contenido para firmar');

            const firma = await firmar(c, req, {
                usuario: b.usuario, clave: b.clave, significado: 'revision_periodica',
                recurso: RECURSO, tabla: 'dc_versiones', registroId: d.version_id,
                contenidoSha256: d.huella, comentario: texto(b.comentario) || null,
            });
            const { rows: [n] } = await c.query(
                `UPDATE dc_documentos
                 SET proxima_revision = (current_date + make_interval(months => $2))::date
                 WHERE id = $1 RETURNING proxima_revision`,
                [d.id, d.meses]
            );
            return { firma, proximaRevision: n.proxima_revision };
        });
        res.json({ ok: true, ...r });
    } catch (err) { responder(err, res, next); }
});

/** GET /api/control-documentos/documentos/:id/audit — audit trail del documento y sus versiones. */
rutasControlDocumentos.get('/documentos/:id/audit', leer, async (req, res, next) => {
    try {
        const { rows: vs } = await consultar(
            'SELECT id FROM dc_versiones WHERE documento_id = $1', [req.params.id]);
        const { rows } = await consultar(
            `SELECT seq, ts, usuario_nombre, tabla, registro_id, accion, cambios, despues, motivo
             FROM audit_trail
             WHERE (tabla = 'dc_documentos' AND registro_id = $1)
                OR (tabla = 'dc_versiones' AND registro_id = ANY($2))
                OR (tabla = 'firmas_electronicas'
                    AND despues ->> 'tabla' = 'dc_versiones' AND despues ->> 'registro_id' = ANY($2))
             ORDER BY seq`,
            [String(req.params.id), vs.map((v) => String(v.id))]
        );
        res.json({ ok: true, registros: rows });
    } catch (err) { next(err); }
});

/** GET /api/control-documentos/audit/:tabla/:id — historia de un registro cualquiera. */
rutasControlDocumentos.get('/audit/:tabla/:id', administrar, async (req, res, next) => {
    try {
        res.json({ ok: true, registros: await historial(req.params.tabla, req.params.id) });
    } catch (err) { next(err); }
});

/** GET /api/control-documentos/audit-verificar — integridad de la cadena completa. */
rutasControlDocumentos.get('/audit-verificar', administrar, async (_req, res, next) => {
    try {
        res.json({ ok: true, ...(await verificarIntegridad()) });
    } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// Importacion del listado maestro (LIS-SOP-DOC-001-E) y archivos de la red
// ---------------------------------------------------------------------------

const hoyIso = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Montevideo' });

/**
 * POST /api/control-documentos/importar/listado
 * { archivoNombre, archivoSha256, filas: [...], confirmar }
 *
 * Sin `confirmar` es una simulacion: devuelve que entraria, que no y por que,
 * sin tocar la base. Con `confirmar` guarda los documentos sin errores, en una
 * sola transaccion, y deja constancia en dc_importaciones. Los que ya estan
 * cargados no se tocan, asi que volver a importar la planilla corregida solo
 * suma los que faltaban.
 */
rutasControlDocumentos.post('/importar/listado', administrar, async (req, res, next) => {
    const b = req.body || {};
    try {
        if (!Array.isArray(b.filas) || !b.filas.length) throw fallo(400, 'no llegaron filas del listado');

        const [{ rows: tipos }, { rows: usuarios }, { rows: ya }] = await Promise.all([
            consultar('SELECT codigo FROM dc_tipos WHERE activo'),
            consultar(`SELECT id, nombre FROM usuarios WHERE nombre IS NOT NULL AND origen = 'vessena'`),
            consultar('SELECT upper(codigo) AS codigo FROM dc_documentos'),
        ]);
        const hoy = hoyIso();
        const { documentos, ignoradas } = analizarListado(b.filas, {
            tipos: tipos.map((x) => x.codigo),
            usuarios,
            existentes: new Set(ya.map((x) => x.codigo)),
            hoy,
        });

        const nuevos = documentos.filter((d) => !d.existe && !d.errores.length);
        const resumen = {
            filas: b.filas.length,
            filasIgnoradas: ignoradas,
            documentos: documentos.length,
            aImportar: nuevos.length,
            conErrores: documentos.filter((d) => d.errores.length).length,
            yaCargados: documentos.filter((d) => d.existe).length,
            vigentes: nuevos.filter((d) => d.estado === 'vigente').length,
            enCurso: nuevos.filter((d) => d.versiones.some((v) => v.estado === 'borrador')).length,
            vencidos: nuevos.filter((d) => d.vencido).length,
        };

        if (!b.confirmar) return res.json({ ok: true, simulacion: true, resumen, documentos });
        if (!nuevos.length) throw fallo(409, 'no hay documentos nuevos sin errores para importar');

        const avisarDesde = escalonarAvisos(nuevos, hoy);
        const motivo = `importación del listado maestro ${texto(b.archivoNombre) || 'LIS-SOP-DOC-001-E'}`;

        const importacionId = await enTransaccionAuditada(req, motivo, async (c) => {
            const { rows: [imp] } = await c.query(
                `INSERT INTO dc_importaciones (importado_por, archivo_nombre, archivo_sha256, resumen)
                 VALUES ($1,$2,$3,$4) RETURNING id`,
                [req.usuario.nombre || req.usuario.usuario, texto(b.archivoNombre) || null,
                 texto(b.archivoSha256) || null,
                 JSON.stringify({ ...resumen, errores: documentos.filter((d) => d.errores.length)
                     .map((d) => ({ codigo: d.codigo, errores: d.errores })) })]
            );
            for (const d of nuevos) {
                const { rows: [doc] } = await c.query(
                    `INSERT INTO dc_documentos (codigo, titulo, tipo, area, proxima_revision, avisar_desde, creado_por_id)
                     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
                    [d.codigo, d.titulo, d.tipo, d.area, d.proxima, avisarDesde.get(d.codigo) || null, req.usuario.id]
                );
                for (const v of d.versiones) {
                    await c.query(
                        `INSERT INTO dc_versiones (documento_id, numero, estado, formato, fecha_vigencia,
                                elaborado_por_nombre, revisado_por_nombre, aprobado_por_nombre, aprobado_por_id,
                                observaciones, importacion_id, creado_por_id)
                         VALUES ($1,$2,$3,'archivo',$4,$5,$6,$7,$8,$9,$10,$11)`,
                        [doc.id, v.numero, v.estado, v.fechaVigencia, v.elaboradoPor, v.revisadoPor,
                         v.aprobadoPor, v.aprobadoPorId, v.observaciones, imp.id, req.usuario.id]
                    );
                }
            }
            return imp.id;
        });
        res.status(201).json({ ok: true, importacionId, resumen });
    } catch (err) { responder(err, res, next); }
});

/**
 * GET /api/control-documentos/importar/sin-archivo
 * Versiones importadas que todavia no tienen su Word o PDF. La pantalla las
 * busca en la carpeta de la red que elija quien importa.
 */
rutasControlDocumentos.get('/importar/sin-archivo', administrar, async (_req, res, next) => {
    try {
        const { rows } = await consultar(
            `SELECT v.id, d.codigo, d.titulo, v.numero, v.estado,
                    v.archivo_sha256 IS NOT NULL AS tiene_word, v.pdf_sha256 IS NOT NULL AS tiene_pdf
             FROM dc_versiones v JOIN dc_documentos d ON d.id = v.documento_id
             WHERE v.formato = 'archivo' AND (v.archivo_sha256 IS NULL OR v.pdf_sha256 IS NULL)
               AND v.estado <> 'anulado'
             ORDER BY d.codigo, v.numero`
        );
        res.json({ ok: true, hayAlmacen, versiones: rows });
    } catch (err) { next(err); }
});

/**
 * POST /api/control-documentos/versiones/:id/archivo?nombre=...&origen=...
 * Cuerpo: el archivo, como application/octet-stream.
 *
 * El PDF va al lugar del PDF y el Word (o Excel) al del archivo editable. En
 * un borrador se puede reemplazar; fuera de borrador solo se completa un lugar
 * vacio (lo hace cumplir la base). `origen` es la ruta en la red de donde se
 * tomo, y queda en el motivo del audit trail.
 */
rutasControlDocumentos.post('/versiones/:id/archivo',
    express.raw({ type: 'application/octet-stream', limit: MAX_BYTES }),
    cargar,
    async (req, res, next) => {
        try {
            const nombre = texto(req.query.nombre).split(/[\\/]/).pop();
            if (!nombre) throw fallo(400, 'falta el nombre del archivo');
            const origen = texto(req.query.origen);
            const esPdf = extension(nombre) === '.pdf';

            const r = await enTransaccionAuditada(req,
                origen ? `archivo tomado de la red: ${origen}` : `archivo adjuntado: ${nombre}`,
                async (c) => {
                    const { rows: [v] } = await c.query(
                        'SELECT estado, formato, archivo_sha256, pdf_sha256 FROM dc_versiones WHERE id = $1 FOR UPDATE',
                        [req.params.id]);
                    if (!v) throw fallo(404, 'version inexistente');
                    if (v.formato !== 'archivo') throw fallo(409, 'esta versión se escribe en el editor');
                    const ocupado = esPdf ? v.pdf_sha256 : v.archivo_sha256;
                    if (v.estado !== 'borrador') {
                        if (!puede(req.rol, 'administrar')) throw fallo(403, 'solo Calidad completa archivos de versiones que no son borrador');
                        if (ocupado) throw fallo(409, `la versión ya tiene ${esPdf ? 'PDF' : 'archivo editable'} y no está en borrador: no se reemplaza`);
                    }

                    const g = await guardar(req.body, nombre);
                    if (ocupado === g.sha256) return { sha256: g.sha256, igual: true };
                    if (esPdf) {
                        await c.query('UPDATE dc_versiones SET pdf_ruta = $2, pdf_sha256 = $3 WHERE id = $1',
                            [req.params.id, g.ruta, g.sha256]);
                    } else {
                        await c.query(
                            `UPDATE dc_versiones SET archivo_ruta = $2, archivo_sha256 = $3, archivo_nombre = $4,
                                    archivo_mime = $5, archivo_bytes = $6 WHERE id = $1`,
                            [req.params.id, g.ruta, g.sha256, nombre, g.mime, g.bytes]);
                    }
                    return { sha256: g.sha256 };
                });
            res.status(201).json({ ok: true, ...r });
        } catch (err) { responder(err, res, next); }
    });

/**
 * GET /api/control-documentos/versiones/:id/descargar?que=pdf|archivo
 * Cada descarga queda en la auditoria de accesos.
 * Pendiente: la marca "COPIA NO CONTROLADA" sobre el PDF.
 */
rutasControlDocumentos.get('/versiones/:id/descargar', leer, async (req, res, next) => {
    try {
        const { rows: [v] } = await consultar(
            `SELECT v.*, d.codigo FROM dc_versiones v JOIN dc_documentos d ON d.id = v.documento_id WHERE v.id = $1`,
            [req.params.id]);
        const visibles = estadosVisibles(req.rol);
        if (!v || (visibles && !visibles.includes(v.estado))) throw fallo(404, 'version inexistente');

        // El editable es para quien trabaja el documento; el resto baja el PDF.
        const trabaja = puede(req.rol, 'cargar');
        const ruta = req.query.que === 'archivo' && trabaja
            ? v.archivo_ruta
            : (v.pdf_ruta || (trabaja ? v.archivo_ruta : null));
        if (!ruta) throw fallo(404, 'esta versión no tiene archivo cargado');

        const esPdf = ruta === v.pdf_ruta;
        const nombre = esPdf
            ? `${v.codigo}_V${Number(v.numero).toFixed(1)}.pdf`
            : (v.archivo_nombre || `${v.codigo}${extension(ruta)}`);
        const { stream, bytes } = await abrir(ruta);
        await auditar(req, {
            usuarioId: req.usuario.id, usuarioTxt: req.usuario.usuario, accion: 'descarga_documento',
            recurso: RECURSO, detalle: `${v.codigo} v${v.numero} (${nombre})`,
        });
        res.setHeader('Content-Type', esPdf ? 'application/pdf' : (v.archivo_mime || 'application/octet-stream'));
        res.setHeader('Content-Length', bytes);
        res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(nombre)}`);
        stream.pipe(res);
    } catch (err) { responder(err, res, next); }
});
