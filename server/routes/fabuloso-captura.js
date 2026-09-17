/**
 * Control Fabuloso (captura) — control de atributos en linea, SOP-LCC-200 v3.0.
 *
 * Reemplaza al Apps Script de la app (Code.gs), con las mismas reglas:
 *   - QR = 100 − (750·DC + 140·DM + 5·DL) / N, redondeado a dos decimales.
 *   - Rango: Perfecta ≥ 100, Muy buena ≥ 95, Aceptable ≥ 90, No aceptable.
 *   - Estado inicial: Retenido si QR < 90, Controlado si no.
 *   - Una orden aprobada queda cerrada y no acepta mas controles.
 *   - Aprobar exige las dos fotos obligatorias en cada control y el checklist
 *     de rotulo (lote, vencimiento, producto).
 *
 * Lo que cambia, a proposito:
 *   - Identidad y permisos salen del portal. El Apps Script tenia usuarios y
 *     contraseñas propios, con tokens generados con Math.random y claves
 *     iniciales escritas en el codigo.
 *   - La firma es la de la tabla `firmas`; las fotos nuevas van a la base.
 *   - Cada control guarda la clasificacion de sus defectos al momento de
 *     calcular el QR: reclasificar un defecto no reescribe controles viejos.
 */
import { Router } from 'express';
import { consultar, enTransaccion } from '../db.js';
import { exigirPermiso } from '../lib/acceso.js';
import { PERMISOS_POR_ROL } from '../lib/permisos.js';
import { auditar } from '../lib/sesiones.js';
import { firmaDe } from '../lib/firmas.js';
import { ZONA } from '../lib/tareas.js';
import { comprimirFoto } from '../lib/comprimir-foto.js';

export const rutasFabulosoCaptura = Router();

const RECURSO = 'fabuloso-captura';
const leer = exigirPermiso(RECURSO, 'ver');
const cargar = exigirPermiso(RECURSO, 'cargar');
const aprobar = exigirPermiso(RECURSO, 'aprobar');
const administrar = exigirPermiso(RECURSO, 'administrar');

const CLASIFICACIONES = ['Leve', 'Moderado', 'Crítico'];
const ESTADOS_DISPOSICION = ['Aprobado', 'Rechazado', 'Retenido'];
const TIPOS_FOTO = new Set(['image/jpeg', 'image/png', 'image/webp']);
const MAX_FOTO = 5 * 1024 * 1024;
const URL_FOTO = /^(\/api\/fabuloso-captura\/fotos\/\d+|https:\/\/[^\s"'<>]{1,500})$/;

/* ═══════════════════════════════════════════════════════════════════════════
   Reglas y utilidades
   ═══════════════════════════════════════════════════════════════════════════ */

/** computeQR_ del Apps Script. */
export function calcularQR(dc, dm, dl, n) {
    if (!n || n <= 0) return 0;
    return Math.round((100 - (750 * dc + 140 * dm + 5 * dl) / n) * 100) / 100;
}

/** calidadRango_ del Apps Script. */
export function rangoDe(qr) {
    if (qr >= 100) return 'Perfecta';
    if (qr >= 95) return 'Muy buena';
    if (qr >= 90) return 'Aceptable';
    return 'No aceptable';
}

/** El rol que entiende la pantalla (la de la app vieja), a partir del rol del portal. */
function rolDeApp(permisos) {
    if (permisos.includes('administrar')) return 'Admin';
    if (permisos.includes('aprobar')) return 'Coordinador';
    return 'Analista';
}

const texto = (v, max = 500) => String(v ?? '').trim().slice(0, max);
const entero = (v, def = 0) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.trunc(n) : def;
};
const aIso = (v) => (v instanceof Date ? v.toISOString() : (v || null));
const verdadero = (v) => v === true || String(v).trim().toLowerCase() === 'true';

function fallo(status, mensaje) {
    const e = new Error(mensaje);
    e.status = status;
    return e;
}

function responder(err, res, next) {
    if (err.status) return res.status(err.status).json({ ok: false, error: err.message });
    next(err);
}

/** Id con el formato del Apps Script (MUE-aaaammdd-hhmmss-nnn), en hora de Montevideo. */
function nuevoIdMuestreo() {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
        timeZone: ZONA, year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    }).formatToParts(new Date()).map((x) => [x.type, x.value]));
    const azar = String(Math.floor(Math.random() * 1000)).padStart(3, '0');
    return `MUE-${p.year}${p.month}${p.day}-${p.hour}${p.minute}${p.second}-${azar}`;
}

/** Deja constancia en la auditoria de la app. Solo inserta. */
async function registrar(c, req, accion, entidad, entidadId, detalles) {
    await c.query(
        `INSERT INTO fab_actividad (usuario, rol, accion, entidad, entidad_id, detalles, user_agent)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
            req.usuario.nombre || req.usuario.usuario, req.rol, accion, entidad || null,
            entidadId == null ? null : String(entidadId), detalles || null,
            String(req.get('user-agent') || '').slice(0, 300),
        ]
    );
}

/** Serializa lo que toca una orden: agregar un control y cerrarla no pueden cruzarse. */
const bloquearOrden = (c, orden) =>
    c.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['fab-orden:' + orden]);

async function ordenesCerradas(ordenes) {
    if (!ordenes.length) return new Map();
    const { rows } = await consultar(
        'SELECT * FROM fab_ordenes WHERE orden_envasado = ANY($1)', [ordenes]
    );
    return new Map(rows.map((o) => [o.orden_envasado, o]));
}

/* ═══════════════════════════════════════════════════════════════════════════
   Forma de las respuestas: la misma que devolvia el Apps Script
   ═══════════════════════════════════════════════════════════════════════════ */

const comunes = (f) => ({
    id: f.id,
    timestamp: aIso(f.registrado_en),
    linea: f.linea || '',
    lote: f.lote,
    codigo_pt: f.codigo_pt || '',
    fecha_muestreo: f.fecha_muestreo || '',
    hora_muestreo: f.hora_muestreo || '',
    n_muestras: f.n_muestras,
    DC: f.dc, DM: f.dm, DL: f.dl,
    QR: Number(f.qr),
    estado: f.estado,
    unidades_retiradas: f.unidades_retiradas,
    motivo_retiro: f.motivo_retiro || '',
    acciones_correctivas: f.acciones_correctivas || '',
    fotos: Array.isArray(f.fotos) ? f.fotos : [],
    foto_rotulo_url: f.foto_rotulo || '',
    foto_lote_url: f.foto_lote || '',
    aprobado_por: f.aprobado_por || '',
    analista_username: f.analista_usuario || '',
});

const filaAListado = (f, cerrada) => ({
    ...comunes(f),
    analista: f.analista_nombre,
    orden: f.orden_envasado,
    rango: f.calidad_rango,
    orden_cerrada: cerrada,
});

const filaADetalle = (f, cerrada) => ({
    ...comunes(f),
    analista_nombre: f.analista_nombre,
    orden_envasado: f.orden_envasado,
    calidad_rango: f.calidad_rango,
    defectos: Array.isArray(f.defectos) ? f.defectos : [],
    aprobado_ts: aIso(f.aprobado_en),
    notas_aprobador: f.notas_aprobador || '',
    orden_cerrada: cerrada,
});

const filaAOrden = (f, cerrada) => ({
    ...comunes(f),
    analista: f.analista_nombre,
    rango: f.calidad_rango,
    defectos: Array.isArray(f.defectos) ? f.defectos : [],
    orden_cerrada: cerrada,
    aprobado_ts: aIso(f.aprobado_en),
    notas_aprobador: f.notas_aprobador || '',
});

/* ═══════════════════════════════════════════════════════════════════════════
   Sesion, firma y catalogo
   ═══════════════════════════════════════════════════════════════════════════ */

/** GET /api/fabuloso-captura/sesion — quien es y que puede, en los terminos de la pantalla. */
rutasFabulosoCaptura.get('/sesion', leer, (req, res) => {
    const permisos = PERMISOS_POR_ROL[req.rol] || [];
    res.json({
        ok: true,
        user: {
            username: req.usuario.usuario,
            nombre: req.usuario.nombre || req.usuario.usuario,
            rol: rolDeApp(permisos),
        },
        permisos,
    });
});

/** GET /api/fabuloso-captura/mi-firma — la firma vigente de quien consulta. */
rutasFabulosoCaptura.get('/mi-firma', leer, async (req, res, next) => {
    try {
        const { rows } = await consultar(
            `SELECT imagen, cargo, cargada_en, cargada_por FROM firmas
             WHERE usuario_id = $1 AND reemplazada_en IS NULL`,
            [req.usuario.id]
        );
        const f = rows[0];
        res.json({
            ok: true,
            firma: f ? { imagen: f.imagen, cargo: f.cargo, cargadaEn: f.cargada_en, cargadaPor: f.cargada_por } : null,
        });
    } catch (err) {
        next(err);
    }
});

/** GET /api/fabuloso-captura/catalogo — defectos activos. */
rutasFabulosoCaptura.get('/catalogo', leer, async (_req, res, next) => {
    try {
        const { rows } = await consultar(
            `SELECT codigo, descripcion, clasificacion, grupo FROM fab_defectos
             WHERE activo ORDER BY codigo`
        );
        res.json({
            ok: true,
            defectos: rows.map((d) => ({
                codigo: d.codigo, descripcion: d.descripcion,
                clasificacion: d.clasificacion, grupo: d.grupo || '',
            })),
        });
    } catch (err) {
        next(err);
    }
});

/** POST /api/fabuloso-captura/catalogo/:codigo  { clasificacion } */
rutasFabulosoCaptura.post('/catalogo/:codigo', administrar, async (req, res, next) => {
    const clasificacion = texto(req.body?.clasificacion, 20);
    if (!CLASIFICACIONES.includes(clasificacion)) {
        return res.status(400).json({ ok: false, error: 'Clasificación inválida' });
    }
    try {
        await enTransaccion(async (c) => {
            const { rows } = await c.query(
                `UPDATE fab_defectos SET clasificacion = $1, actualizado_en = now(), actualizado_por = $2
                 WHERE codigo = $3 RETURNING codigo`,
                [clasificacion, req.usuario.nombre, req.params.codigo]
            );
            if (!rows[0]) throw fallo(404, 'Defecto no encontrado');
            await registrar(c, req, 'defect_update', 'defecto', req.params.codigo, `clasif=${clasificacion}`);
        });
        res.json({ ok: true });
    } catch (err) {
        responder(err, res, next);
    }
});

/* ═══════════════════════════════════════════════════════════════════════════
   Muestreos
   ═══════════════════════════════════════════════════════════════════════════ */

/** POST /api/fabuloso-captura/muestreos  { data } — saveMuestreo */
rutasFabulosoCaptura.post('/muestreos', cargar, async (req, res, next) => {
    const d = req.body?.data || {};
    const orden = texto(d.orden_envasado, 100);
    const lote = texto(d.lote, 100);
    const n = entero(d.n_muestras, 5);
    const fotoRotulo = texto(d.foto_rotulo_url, 600);
    const fotoLote = texto(d.foto_lote_url, 600);
    const fotos = (Array.isArray(d.fotos_urls) ? d.fotos_urls : []).map((u) => texto(u, 600)).filter(Boolean);

    if (!lote || !orden) return res.status(400).json({ ok: false, error: 'Lote y orden de envasado son requeridos' });
    if (n < 1 || n > 500) return res.status(400).json({ ok: false, error: 'N° de muestras inválido' });
    if (!fotoRotulo || !fotoLote) {
        return res.status(400).json({ ok: false, error: 'Faltan las fotos obligatorias (rótulo de caja y lote del envase)' });
    }
    if (![fotoRotulo, fotoLote, ...fotos].every((u) => URL_FOTO.test(u))) {
        return res.status(400).json({ ok: false, error: 'Hay una foto con una dirección no válida' });
    }

    try {
        const r = await enTransaccion(async (c) => {
            await bloquearOrden(c, orden);
            const { rows: cerrada } = await c.query(
                'SELECT 1 FROM fab_ordenes WHERE orden_envasado = $1', [orden]
            );
            if (cerrada[0]) throw fallo(409, 'Esta orden ya fue aprobada y cerrada. No se pueden agregar más controles.');

            const { rows: catalogo } = await c.query('SELECT codigo, descripcion, clasificacion FROM fab_defectos');
            const porCodigo = new Map(catalogo.map((x) => [x.codigo, x]));

            let dc = 0, dm = 0, dl = 0;
            const defectos = [];
            for (const def of Array.isArray(d.defectos) ? d.defectos : []) {
                const codigo = texto(def?.codigo, 20);
                const info = porCodigo.get(codigo);
                if (!info) throw fallo(400, `Defecto desconocido: ${codigo || '(vacío)'}`);
                const cantidad = Math.max(1, entero(def.cantidad, 1));
                if (info.clasificacion === 'Crítico') dc += cantidad;
                else if (info.clasificacion === 'Moderado') dm += cantidad;
                else if (info.clasificacion === 'Leve') dl += cantidad;
                defectos.push({ codigo, cantidad, descripcion: info.descripcion, clasificacion: info.clasificacion });
            }
            const qr = calcularQR(dc, dm, dl, n);
            const rango = rangoDe(qr);
            const estado = qr < 90 ? 'Retenido' : 'Controlado';

            const valores = [
                req.usuario.id, req.usuario.usuario, req.usuario.nombre || req.usuario.usuario,
                texto(d.linea, 60) || 'Fabuloso', orden, lote, texto(d.codigo_pt, 60),
                texto(d.fecha_muestreo, 20), texto(d.hora_muestreo, 10), n, dc, dm, dl, qr, rango,
                Math.max(0, entero(d.unidades_retiradas, 0)), texto(d.motivo_retiro, 2000),
                texto(d.acciones_correctivas, 2000), JSON.stringify(defectos), JSON.stringify(fotos),
                fotoRotulo, fotoLote, estado,
            ];
            // El id lleva segundos y tres digitos al azar: dos controles en el
            // mismo segundo son improbables, pero si pasa se reintenta.
            let id = null;
            for (let intento = 0; intento < 5 && !id; intento++) {
                const candidato = nuevoIdMuestreo();
                const { rows } = await c.query(
                    `INSERT INTO fab_muestreos
                        (id, analista_id, analista_usuario, analista_nombre, linea, orden_envasado, lote,
                         codigo_pt, fecha_muestreo, hora_muestreo, n_muestras, dc, dm, dl, qr, calidad_rango,
                         unidades_retiradas, motivo_retiro, acciones_correctivas, defectos, fotos,
                         foto_rotulo, foto_lote, estado)
                     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24)
                     ON CONFLICT (id) DO NOTHING
                     RETURNING id`,
                    [candidato, ...valores]
                );
                if (rows[0]) id = rows[0].id;
            }
            if (!id) throw fallo(503, 'No se pudo generar el número de control. Probá de nuevo.');

            await registrar(c, req, 'muestreo_create', 'muestreo', id, `QR=${qr} DC=${dc} DM=${dm} DL=${dl} N=${n}`);
            return { id, QR: qr, rango, DC: dc, DM: dm, DL: dl, estado };
        });
        res.json({ ok: true, ...r });
    } catch (err) {
        responder(err, res, next);
    }
});

/** GET /api/fabuloso-captura/muestreos?desde=&hasta=&limit= — listMuestreos */
rutasFabulosoCaptura.get('/muestreos', leer, async (req, res, next) => {
    const desde = /^\d{4}-\d{2}-\d{2}$/.test(req.query.desde || '') ? req.query.desde : null;
    const hasta = /^\d{4}-\d{2}-\d{2}$/.test(req.query.hasta || '') ? req.query.hasta : null;
    const limite = Math.min(Math.max(entero(req.query.limit, 200), 1), 2000);
    try {
        // Desde y hasta son dias de Montevideo, los dos incluidos.
        const { rows } = await consultar(
            `SELECT * FROM fab_muestreos
             WHERE ($1::date IS NULL OR (registrado_en AT TIME ZONE $3)::date >= $1::date)
               AND ($2::date IS NULL OR (registrado_en AT TIME ZONE $3)::date <= $2::date)
             ORDER BY registrado_en DESC
             LIMIT $4`,
            [desde, hasta, ZONA, limite]
        );
        const cerradas = await ordenesCerradas([...new Set(rows.map((f) => f.orden_envasado))]);
        res.json({ ok: true, rows: rows.map((f) => filaAListado(f, cerradas.has(f.orden_envasado))) });
    } catch (err) {
        next(err);
    }
});

/** GET /api/fabuloso-captura/muestreos/:id — getMuestreo */
rutasFabulosoCaptura.get('/muestreos/:id', leer, async (req, res, next) => {
    try {
        const { rows } = await consultar('SELECT * FROM fab_muestreos WHERE id = $1', [req.params.id]);
        if (!rows[0]) return res.status(404).json({ ok: false, error: 'No encontrado' });
        const cerradas = await ordenesCerradas([rows[0].orden_envasado]);
        res.json({ ok: true, muestreo: filaADetalle(rows[0], cerradas.has(rows[0].orden_envasado)) });
    } catch (err) {
        next(err);
    }
});

/** POST /api/fabuloso-captura/muestreos/:id/disposicion  { estado, notas } — approveMuestreo */
rutasFabulosoCaptura.post('/muestreos/:id/disposicion', aprobar, async (req, res, next) => {
    const notas = texto(req.body?.notas, 2000);
    try {
        const estado = await enTransaccion(async (c) => {
            const { rows } = await c.query('SELECT * FROM fab_muestreos WHERE id = $1 FOR UPDATE', [req.params.id]);
            const f = rows[0];
            if (!f) throw fallo(404, 'No encontrado');
            await bloquearOrden(c, f.orden_envasado);
            const { rows: cerrada } = await c.query(
                'SELECT 1 FROM fab_ordenes WHERE orden_envasado = $1', [f.orden_envasado]
            );
            // Una orden cerrada es un registro terminado: sus controles no cambian.
            if (cerrada[0]) throw fallo(409, 'La orden de este control ya está aprobada y cerrada');

            const pedido = texto(req.body?.estado, 20);
            const nuevo = pedido || (Number(f.qr) >= 90 ? 'Aprobado' : 'Rechazado');
            if (!ESTADOS_DISPOSICION.includes(nuevo)) throw fallo(400, 'Estado inválido');

            await c.query(
                `UPDATE fab_muestreos SET estado = $1, aprobado_por = $2, aprobado_por_id = $3,
                        aprobado_en = now(), notas_aprobador = $4
                 WHERE id = $5`,
                [nuevo, req.usuario.nombre, req.usuario.id, notas, f.id]
            );
            await registrar(c, req, 'muestreo_approve', 'muestreo', f.id, `estado=${nuevo} notas=${notas}`);
            return nuevo;
        });
        res.json({ ok: true, estado });
    } catch (err) {
        responder(err, res, next);
    }
});

/* ═══════════════════════════════════════════════════════════════════════════
   Ordenes
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Firmas para imprimir una orden, con la clave que usa la pantalla: el usuario
 * de cada analista y el nombre de quien aprobo. Los controles de la app nueva
 * usan la firma registrada vigente al firmar; los importados, la firma que se
 * habia dibujado en la app vieja.
 */
async function firmasDeOrden(filas, cierre) {
    const { rows: legado } = await consultar('SELECT usuario, firma_url FROM fab_firmas_legado');
    const firmaLegado = new Map(legado.map((l) => [String(l.usuario).toLowerCase(), l.firma_url]));
    const firmas = {};

    for (const f of filas) {
        const clave = f.analista_usuario;
        if (!clave || clave in firmas) continue;
        const imagen = f.origen === 'app'
            ? (await firmaDe(f.analista_id, f.registrado_en, f.analista_nombre))?.imagen
            : firmaLegado.get(String(clave).toLowerCase());
        if (imagen) firmas[clave] = imagen;
    }
    if (cierre) {
        const clave = cierre.aprobada_por;
        const imagen = cierre.origen === 'app'
            ? (await firmaDe(cierre.aprobada_por_id, cierre.aprobada_en, cierre.aprobada_por))?.imagen
            : firmaLegado.get(String(clave).toLowerCase());
        if (imagen) firmas[clave] = imagen;
    }
    return firmas;
}

/** GET /api/fabuloso-captura/ordenes/:orden — listOrder */
rutasFabulosoCaptura.get('/ordenes/:orden', leer, async (req, res, next) => {
    const orden = texto(req.params.orden, 100);
    if (!orden) return res.status(400).json({ ok: false, error: 'Falta orden_envasado' });
    try {
        const { rows } = await consultar(
            'SELECT * FROM fab_muestreos WHERE orden_envasado = $1 ORDER BY registrado_en', [orden]
        );
        const cierre = (await ordenesCerradas([orden])).get(orden) || null;
        res.json({
            ok: true,
            orden,
            cerrada: !!cierre,
            firmas: await firmasDeOrden(rows, cierre),
            rows: rows.map((f) => filaAOrden(f, !!cierre)),
        });
    } catch (err) {
        next(err);
    }
});

/** POST /api/fabuloso-captura/ordenes/:orden/aprobar  { checklist, notas } — approveOrder */
rutasFabulosoCaptura.post('/ordenes/:orden/aprobar', aprobar, async (req, res, next) => {
    const orden = texto(req.params.orden, 100);
    const notas = texto(req.body?.notas, 2000);
    const chk = req.body?.checklist || {};
    try {
        const cerrados = await enTransaccion(async (c) => {
            await bloquearOrden(c, orden);
            const { rows } = await c.query(
                'SELECT id, foto_rotulo, foto_lote FROM fab_muestreos WHERE orden_envasado = $1', [orden]
            );
            if (!rows.length) throw fallo(404, 'No hay controles para esta orden');

            const { rows: ya } = await c.query('SELECT 1 FROM fab_ordenes WHERE orden_envasado = $1', [orden]);
            if (ya[0]) throw fallo(409, 'La orden ya fue aprobada y cerrada previamente');

            const faltan = rows.filter((m) => !m.foto_rotulo || !m.foto_lote);
            if (faltan.length) {
                throw fallo(409, `Faltan las fotos obligatorias (rótulo caja + lote envase) en ${faltan.length} control(es). ` +
                    `No se puede aprobar. Controles: ${faltan.map((m) => m.id).join(', ')}`);
            }
            if (chk.lote !== true || chk.vence !== true || chk.producto !== true) {
                throw fallo(400, 'Debe confirmar los 3 puntos del checklist: LOTE, VENCIMIENTO y PRODUCTO correctos.');
            }

            await c.query(
                `INSERT INTO fab_ordenes (orden_envasado, aprobada_por, aprobada_por_id, notas,
                                          checklist_lote, checklist_vence, checklist_producto)
                 VALUES ($1, $2, $3, $4, true, true, true)`,
                [orden, req.usuario.nombre, req.usuario.id, notas]
            );
            await c.query(
                `UPDATE fab_muestreos SET estado = 'Aprobado', aprobado_por = $1, aprobado_por_id = $2,
                        aprobado_en = now(), notas_aprobador = $3
                 WHERE orden_envasado = $4`,
                [req.usuario.nombre, req.usuario.id, notas, orden]
            );
            await registrar(c, req, 'orden_approve', 'orden', orden, `controles=${rows.length} notas=${notas}`);
            return rows.length;
        });
        await auditar(req, {
            usuarioId: req.usuario.id, usuarioTxt: req.usuario.usuario,
            accion: 'fabuloso_orden_aprobada', recurso: RECURSO, detalle: `${orden} (${cerrados} controles)`,
        });
        res.json({ ok: true, closed: cerrados, orden });
    } catch (err) {
        responder(err, res, next);
    }
});

/* ═══════════════════════════════════════════════════════════════════════════
   Fotos
   ═══════════════════════════════════════════════════════════════════════════ */

/** POST /api/fabuloso-captura/fotos  { filename, mime, dataBase64, muestreo_ref } — uploadPhoto */
rutasFabulosoCaptura.post('/fotos', cargar, async (req, res, next) => {
    const { filename, mime, dataBase64, muestreo_ref: referencia } = req.body || {};
    const tipo = texto(mime, 60) || 'image/jpeg';
    if (!dataBase64) return res.status(400).json({ ok: false, error: 'Falta la imagen' });
    if (!TIPOS_FOTO.has(tipo)) return res.status(415).json({ ok: false, error: 'Solo se aceptan fotos JPG, PNG o WEBP' });

    let recibida;
    try { recibida = Buffer.from(String(dataBase64), 'base64'); } catch { recibida = null; }
    if (!recibida || !recibida.length) return res.status(400).json({ ok: false, error: 'La imagen no es válida' });
    if (recibida.length > MAX_FOTO) return res.status(413).json({ ok: false, error: 'La foto supera los 5 MB' });

    // Se guarda lo mas liviana posible sin perder la lectura del rotulo (lib/comprimir-foto.js)
    const { bytes, tipo: tipoFinal } = await comprimirFoto(recibida, tipo);
    const nombre = (texto(filename, 200) || `muestreo_${Date.now()}`).replace(/\.\w+$/, '') + '.' + tipoFinal.split('/')[1];
    try {
        const id = await enTransaccion(async (c) => {
            const { rows } = await c.query(
                `INSERT INTO fab_fotos (nombre, tipo, tamano, contenido, referencia, subida_por)
                 VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
                [nombre, tipoFinal, bytes.length, bytes, texto(referencia, 200), req.usuario.nombre]
            );
            await registrar(c, req, 'photo_upload', 'foto', rows[0].id,
                `ref=${texto(referencia, 200)} size=${bytes.length}`);
            return rows[0].id;
        });
        res.json({ ok: true, url: `/api/fabuloso-captura/fotos/${id}`, id: String(id), name: nombre, size: bytes.length });
    } catch (err) {
        next(err);
    }
});

/** GET /api/fabuloso-captura/fotos/:id */
rutasFabulosoCaptura.get('/fotos/:id', leer, async (req, res, next) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ ok: false, error: 'id invalido' });
    try {
        const { rows } = await consultar('SELECT nombre, tipo, contenido FROM fab_fotos WHERE id = $1', [id]);
        if (!rows[0]) return res.status(404).json({ ok: false, error: 'no existe' });
        res.setHeader('Content-Type', rows[0].tipo);
        res.setHeader('Content-Disposition', `inline; filename="${String(rows[0].nombre).replace(/["\r\n]/g, '')}"`);
        // Evidencia de un registro: puede quedar en el navegador de quien la
        // mira, no en caches compartidas.
        res.setHeader('Cache-Control', 'private, max-age=86400');
        res.send(rows[0].contenido);
    } catch (err) {
        next(err);
    }
});

/* ═══════════════════════════════════════════════════════════════════════════
   Auditoria e importacion
   ═══════════════════════════════════════════════════════════════════════════ */

/** GET /api/fabuloso-captura/actividad — getAuditLog (ultimos 500) */
rutasFabulosoCaptura.get('/actividad', aprobar, async (_req, res, next) => {
    try {
        const { rows } = await consultar(
            `SELECT ts, usuario, rol, accion, entidad, entidad_id, detalles
             FROM fab_actividad ORDER BY ts DESC, id DESC LIMIT 500`
        );
        res.json({
            ok: true,
            rows: rows.map((r) => ({
                timestamp: aIso(r.ts), usuario: r.usuario || '', rol: r.rol || '', accion: r.accion,
                entidad: r.entidad || '', entidad_id: r.entidad_id || '', detalles: r.detalles || '',
            })),
        });
    } catch (err) {
        next(err);
    }
});

/** Instante valido o null. Acepta lo que produce la lectura del Excel (ISO). */
function instante(v) {
    if (!v) return null;
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * POST /api/fabuloso-captura/importar  { muestreos, defectos, auditoria, firmas }
 *
 * Carga unica del historial de la planilla del Apps Script. Solo corre con la
 * tabla de muestreos vacia: un segundo click duplicaria registros. Todo o nada.
 * La pantalla lee el Excel y manda solo las columnas que hacen falta: de la
 * hoja Usuarios, usuario, nombre y firma; nunca las contraseñas.
 */
rutasFabulosoCaptura.post('/importar', administrar, async (req, res, next) => {
    const b = req.body || {};
    const muestreos = Array.isArray(b.muestreos) ? b.muestreos : [];
    const defectos = Array.isArray(b.defectos) ? b.defectos : [];
    const auditoria = Array.isArray(b.auditoria) ? b.auditoria : [];
    const firmas = Array.isArray(b.firmas) ? b.firmas : [];
    if (!muestreos.length) return res.status(400).json({ ok: false, error: 'El archivo no trae muestreos' });

    try {
        const resumen = await enTransaccion(async (c) => {
            await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['fab-importar']);
            // "Una sola vez" es que el historial no se haya importado antes, no
            // que la tabla este vacia: el equipo empieza a cargar en la app nueva
            // apenas se despliega, y esos controles no pueden trabar la carga
            // del historial (paso el 16/09/2026 con el primer control nuevo).
            const { rows: hay } = await c.query(
                `SELECT count(*)::int AS n FROM fab_muestreos WHERE origen = 'apps-script'`
            );
            if (hay[0].n) throw fallo(409, `El historial ya se importó (${hay[0].n} muestreos): la importación no se repite`);

            // Catalogo: la planilla manda (clasificaciones vigentes).
            let nDefectos = 0;
            for (const d of defectos) {
                const codigo = texto(d.codigo, 20);
                const clasificacion = texto(d.clasificacion, 20);
                if (!codigo || !CLASIFICACIONES.includes(clasificacion)) continue;
                await c.query(
                    `INSERT INTO fab_defectos (codigo, descripcion, clasificacion, grupo, activo, actualizado_por)
                     VALUES ($1, $2, $3, $4, $5, 'importación Apps Script')
                     ON CONFLICT (codigo) DO UPDATE SET descripcion = EXCLUDED.descripcion,
                        clasificacion = EXCLUDED.clasificacion, grupo = EXCLUDED.grupo,
                        activo = EXCLUDED.activo, actualizado_en = now(),
                        actualizado_por = EXCLUDED.actualizado_por`,
                    [codigo, texto(d.descripcion, 300) || codigo, clasificacion, texto(d.grupo, 40) || null,
                     d.activo === undefined ? true : verdadero(d.activo)]
                );
                nDefectos++;
            }

            // Muestreos
            const cierres = new Map();
            for (const m of muestreos) {
                const id = texto(m.id, 60);
                const registrado = instante(m.timestamp);
                if (!id) throw fallo(400, 'Hay un muestreo sin id en el archivo');
                if (!registrado) throw fallo(400, `El muestreo ${id} no tiene fecha válida`);
                const orden = texto(m.orden_envasado, 100) || '(sin orden)';
                const n = Math.max(1, entero(m.n_muestras, 5));
                const qr = Number(m.QR);
                const cerrada = verdadero(m.orden_cerrada);
                await c.query(
                    `INSERT INTO fab_muestreos
                        (id, registrado_en, analista_usuario, analista_nombre, linea, orden_envasado, lote,
                         codigo_pt, fecha_muestreo, hora_muestreo, n_muestras, dc, dm, dl, qr, calidad_rango,
                         unidades_retiradas, motivo_retiro, acciones_correctivas, defectos, fotos,
                         foto_rotulo, foto_lote, estado, aprobado_por, aprobado_en, notas_aprobador, origen)
                     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,'apps-script')`,
                    [
                        id, registrado, texto(m.analista_username, 100),
                        texto(m.analista_nombre, 200) || texto(m.analista_username, 100) || '(sin nombre)',
                        texto(m.linea, 60), orden, texto(m.lote, 100), texto(m.codigo_pt, 60),
                        texto(m.fecha_muestreo, 20), texto(m.hora_muestreo, 10), n,
                        entero(m.DC), entero(m.DM), entero(m.DL),
                        Number.isFinite(qr) ? qr : calcularQR(entero(m.DC), entero(m.DM), entero(m.DL), n),
                        texto(m.calidad_rango, 30) || rangoDe(Number.isFinite(qr) ? qr : 0),
                        Math.max(0, entero(m.unidades_retiradas)), texto(m.motivo_retiro, 2000),
                        texto(m.acciones_correctivas, 2000),
                        JSON.stringify(Array.isArray(m.defectos) ? m.defectos : []),
                        JSON.stringify((Array.isArray(m.fotos) ? m.fotos : []).map((u) => texto(u, 600)).filter(Boolean)),
                        texto(m.foto_rotulo_url, 600) || null, texto(m.foto_lote_url, 600) || null,
                        texto(m.estado, 30) || (qr < 90 ? 'Retenido' : 'Controlado'),
                        texto(m.aprobado_por, 100) || null, instante(m.aprobado_ts), texto(m.notas_aprobador, 2000) || null,
                    ]
                );
                if (cerrada) {
                    const previo = cierres.get(orden);
                    const aprobadoEn = instante(m.aprobado_ts) || registrado;
                    if (!previo || aprobadoEn > previo.aprobadaEn) {
                        cierres.set(orden, {
                            aprobadaPor: texto(m.aprobado_por, 100) || '(sin dato)',
                            aprobadaEn: aprobadoEn,
                            notas: texto(m.notas_aprobador, 2000) || null,
                            lote: verdadero(m.checklist_lote),
                            vence: verdadero(m.checklist_vence),
                            producto: verdadero(m.checklist_producto),
                        });
                    }
                }
            }
            for (const [orden, o] of cierres) {
                await c.query(
                    `INSERT INTO fab_ordenes (orden_envasado, aprobada_por, aprobada_en, notas,
                        checklist_lote, checklist_vence, checklist_producto, origen)
                     VALUES ($1, $2, $3, $4, $5, $6, $7, 'apps-script')
                     ON CONFLICT (orden_envasado) DO NOTHING`,
                    [orden, o.aprobadaPor, o.aprobadaEn, o.notas, o.lote, o.vence, o.producto]
                );
            }
            // Una orden cerrada en la planilla deja cerrados tambien los
            // controles que se le hayan agregado en la app nueva.
            if (cierres.size) {
                await c.query(
                    `UPDATE fab_muestreos m SET estado = 'Aprobado', aprobado_por = o.aprobada_por,
                            aprobado_en = o.aprobada_en, notas_aprobador = o.notas
                     FROM fab_ordenes o
                     WHERE o.orden_envasado = m.orden_envasado AND m.origen = 'app'
                       AND o.origen = 'apps-script' AND m.orden_envasado = ANY($1)`,
                    [[...cierres.keys()]]
                );
            }

            // Auditoria de la app vieja
            let nAuditoria = 0;
            for (const a of auditoria) {
                const accion = texto(a.accion, 60);
                const ts = instante(a.timestamp);
                if (!accion || !ts) continue;
                await c.query(
                    `INSERT INTO fab_actividad (ts, usuario, rol, accion, entidad, entidad_id, detalles, user_agent, origen)
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'apps-script')`,
                    [ts, texto(a.usuario, 100), texto(a.rol, 40), accion, texto(a.entidad, 60),
                     texto(a.entidad_id, 100), texto(a.detalles, 2000), texto(a.user_agent, 300)]
                );
                nAuditoria++;
            }

            // Firmas dibujadas en la app vieja
            let nFirmas = 0;
            for (const f of firmas) {
                const usuario = texto(f.username, 100);
                const url = texto(f.firma_url, 600);
                if (!usuario || !/^https:\/\//.test(url)) continue;
                await c.query(
                    `INSERT INTO fab_firmas_legado (usuario, nombre, firma_url) VALUES ($1, $2, $3)
                     ON CONFLICT (usuario) DO UPDATE SET nombre = EXCLUDED.nombre, firma_url = EXCLUDED.firma_url`,
                    [usuario, texto(f.nombre, 200) || null, url]
                );
                nFirmas++;
            }

            const r = {
                muestreos: muestreos.length, ordenes: cierres.size,
                defectos: nDefectos, auditoria: nAuditoria, firmas: nFirmas,
            };
            await registrar(c, req, 'importar', 'historial', null, JSON.stringify(r));
            return r;
        });
        await auditar(req, {
            usuarioId: req.usuario.id, usuarioTxt: req.usuario.usuario,
            accion: 'fabuloso_importacion', recurso: RECURSO, detalle: JSON.stringify(resumen),
        });
        res.json({ ok: true, ...resumen });
    } catch (err) {
        if (err.code === '23505') {
            return res.status(409).json({ ok: false, error: 'El archivo trae muestreos u órdenes repetidos: ' + (err.detail || '') });
        }
        responder(err, res, next);
    }
});
