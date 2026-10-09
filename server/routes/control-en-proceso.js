/**
 * Control en proceso (captura) — reemplaza al Apps Script de la planilla
 * "CONTROLES EN PROCESO ENVASADO".
 *
 * Lo que cambia, a proposito:
 *   - Quien carga sale de la sesion del portal. Antes se escribia un nombre
 *     cualquiera, y la hoja tiene al mismo analista como "Monica" y "Mónica
 *     puñales".
 *   - Cada envio se confirma. El POST no-cors del Apps Script no podia saber si
 *     guardo: la gente reintentaba y quedaban controles duplicados (007), o no
 *     reintentaba y el control se perdia sin aviso. Cada control trae un
 *     id_envio: reintentar no duplica.
 *   - La fecha y el numero de control los pone el servidor, en hora de
 *     Montevideo. La pantalla usaba toISOString: despues de las 21 horas los
 *     controles quedaban con la fecha del dia siguiente.
 *   - Las fotos van a la base, y son obligatorias la del sticker y la de lote y
 *     vencimiento, como en Fabuloso. Las viejas de Drive se copian a la base
 *     (lib/copia-fotos-drive.js).
 *
 * Los controles van a proceso_controles, la misma tabla que leia la replica,
 * asi el informe gerencial (/api/proceso) no cambia.
 */
import { Router } from 'express';
import { consultar, enTransaccion } from '../db.js';
import { exigirPermiso } from '../lib/acceso.js';
import { PERMISOS_POR_ROL } from '../lib/permisos.js';
import { ZONA } from '../lib/tareas.js';
import { sincronizarProceso } from '../sync/sync-proceso.js';
import { contarPendientes, estadoCopia, iniciarCopia } from '../lib/copia-fotos-drive.js';
import { firmaDe } from '../lib/firmas.js';
import { comprimirFoto } from '../lib/comprimir-foto.js';
import { frenoDe, registrarControl, avisarSupervision, rotuloDe, montarRutasRotulo } from '../lib/rotulos.js';

export const rutasControlEnProceso = Router();

const RECURSO = 'control-en-proceso';
const leer = exigirPermiso(RECURSO, 'ver');
const cargar = exigirPermiso(RECURSO, 'cargar');
const aprobar = exigirPermiso(RECURSO, 'aprobar');
const administrar = exigirPermiso(RECURSO, 'administrar');

const TIPOS_FOTO = new Set(['image/jpeg', 'image/png', 'image/webp']);
const MAX_FOTO = 5 * 1024 * 1024;
const URL_DRIVE = /^https:\/\/drive\.google\.com\/[^\s"'<>]{1,400}$/;
const HORA = /^([01]\d|2[0-3]):[0-5]\d$/;

/* ═══════════════════════════════════════════════════════════════════════════
   Utilidades
   ═══════════════════════════════════════════════════════════════════════════ */

export const texto = (v, max = 500) => String(v ?? '').trim().slice(0, max);

/** Numero con punto o coma decimal, o null. Un campo de peso no es una lista. */
export function numero(v) {
    if (v === null || v === undefined) return null;
    if (typeof v === 'number') return Number.isFinite(v) ? v : null;
    const t = String(v).trim().replace(',', '.');
    if (!/^-?\d+(\.\d+)?$/.test(t)) return null;
    return Number(t);
}

/** Vencimiento como fecha, si se puede leer (dd/mm/aaaa, mm/aaaa o aaaa-mm-dd). */
export function venceAFecha(v) {
    const t = String(v ?? '').trim();
    let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(t);
    let y; let mo; let d;
    if (m) [y, mo, d] = [+m[1], +m[2], +m[3]];
    else if ((m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/.exec(t))) [d, mo, y] = [+m[1], +m[2], +m[3]];
    else if ((m = /^(\d{1,2})[/.-](\d{4})$/.exec(t))) [d, mo, y] = [1, +m[1], +m[2]];
    else return null;
    if (y < 100) y += 2000;
    const f = new Date(Date.UTC(y, mo - 1, d));
    if (f.getUTCFullYear() !== y || f.getUTCMonth() !== mo - 1 || y < 2000 || y > 2100) return null;
    return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** Promedio de los pesos cargados, con dos decimales como lo mostraba la pantalla. */
export function promedioDe(pesos) {
    const vs = pesos.map(numero).filter((v) => v !== null && v > 0);
    return vs.length ? Math.round((vs.reduce((a, b) => a + b, 0) / vs.length) * 100) / 100 : '';
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

async function registrar(c, req, accion, entidad, entidadId, detalles) {
    await c.query(
        `INSERT INTO proceso_actividad (usuario, rol, accion, entidad, entidad_id, detalles)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
            req.usuario.nombre || req.usuario.usuario, req.rol, accion, entidad || null,
            entidadId == null ? null : String(entidadId), detalles || null,
        ]
    );
}

async function planillaCerrada() {
    const { rows } = await consultar('SELECT cerrado_en, cerrado_por FROM proceso_corte');
    return rows[0] || null;
}

/**
 * El control tal como lo guarda `raw`: la forma del doGet del Apps Script, que
 * es la que leen la pantalla y el informe gerencial, mas los campos de
 * limpiadores y las fotos por posicion.
 */
export function armarControl(d, { hoy, hora, analista, controlNum, fotos }) {
    const pesos = (Array.isArray(d.pesos) ? d.pesos : []).slice(0, 5);
    while (pesos.length < 5) pesos.push('');
    const pesosLimpios = pesos.map((p) => {
        const n = numero(p);
        return n === null ? '' : n;
    });
    const isLimp = d.maquina === 'Limpiadores';
    const hasDev = d.hasDev === true;
    const phNum = numero(d.ph);
    const ubicadas = [0, 1, 2].map((i) => fotos[i] || null);
    return {
        fecha: hoy,
        analista,
        orden: texto(d.orden, 60),
        lote: texto(d.lote, 60),
        vence: texto(d.vence, 30),
        maquina: texto(d.maquina, 60),
        presentacion: texto(d.presentacion, 120),
        granel: texto(d.granel, 60),
        codPT: texto(d.codPT, 60),
        controlNum,
        hora: HORA.test(texto(d.hora, 5)) ? texto(d.hora, 5) : hora,
        pesos: isLimp ? ['', '', '', '', ''] : pesosLimpios,
        promedio: isLimp ? '' : promedioDe(pesosLimpios),
        spec: texto(d.spec, 300),
        ph: isLimp || phNum === null ? '' : phNum,
        checks: isLimp ? [] : (Array.isArray(d.checks) ? d.checks : []).map((c) => texto(c, 40)).filter(Boolean).slice(0, 12),
        hasDev,
        devDesc: hasDev ? texto(d.devDesc, 500) : '',
        devQty: hasDev ? texto(d.devQty, 30) : '',
        isRep: hasDev && d.isRep === true,
        numFotos: ubicadas.filter(Boolean).length,
        obs: texto(d.obs, 1000),
        photoLinks: ubicadas.filter(Boolean),
        fotos: ubicadas,
        isLimp,
        limpDefects: isLimp
            ? (Array.isArray(d.limpDefects) ? d.limpDefects : []).map((x) => texto(x, 120)).filter(Boolean).slice(0, 60)
            : [],
        limpUds: isLimp ? texto(d.limpUds, 30) : '',
        limpMotivo: isLimp ? texto(d.limpMotivo, 500) : '',
        limpAccion: isLimp ? texto(d.limpAccion, 500) : '',
    };
}

/* ═══════════════════════════════════════════════════════════════════════════
   Sesion y lectura
   ═══════════════════════════════════════════════════════════════════════════ */

/** GET /api/control-en-proceso/sesion */
rutasControlEnProceso.get('/sesion', leer, async (req, res, next) => {
    try {
        const corte = await planillaCerrada();
        res.json({
            ok: true,
            usuario: req.usuario.usuario,
            nombre: req.usuario.nombre || req.usuario.usuario,
            permisos: PERMISOS_POR_ROL[req.rol] || [],
            planillaCerrada: Boolean(corte),
            cerradaEn: corte?.cerrado_en || null,
        });
    } catch (err) {
        next(err);
    }
});

/**
 * GET /api/control-en-proceso/controles
 * Todos los controles, del mas nuevo al mas viejo, con la forma del doGet.
 */
rutasControlEnProceso.get('/controles', leer, async (_req, res, next) => {
    try {
        const { rows } = await consultar(
            `SELECT raw FROM proceso_controles
             WHERE duplicado_de IS NULL
             ORDER BY (origen = 'app') DESC,
                      CASE WHEN origen = 'app' THEN id END DESC,
                      pos`
        );
        res.json({ status: 'ok', records: rows.map((f) => f.raw) });
    } catch (err) {
        next(err);
    }
});

/* ═══════════════════════════════════════════════════════════════════════════
   Carga
   ═══════════════════════════════════════════════════════════════════════════ */

/** POST /api/control-en-proceso/controles */
rutasControlEnProceso.post('/controles', cargar, async (req, res, next) => {
    const d = req.body || {};
    const idEnvio = texto(d.id_envio, 64);
    if (!/^[A-Za-z0-9-]{8,64}$/.test(idEnvio)) {
        return res.status(400).json({ ok: false, error: 'Falta el identificador del envío' });
    }
    const faltan = [
        ['maquina', 'la máquina'], ['presentacion', 'la presentación'], ['lote', 'el lote'],
        ['orden', 'la orden'], ['vence', 'el vencimiento'], ['granel', 'el código de granel'],
        ['codPT', 'el código PT'],
    ].filter(([k]) => !texto(d[k])).map(([, n]) => n);
    if (faltan.length) {
        return res.status(400).json({ ok: false, error: `Falta ${faltan.join(', ')}` });
    }
    // La linea Limpiadores (Fabuloso) tiene su propia app (Claudia, 18/09/2026).
    if (['limpiadores', 'fabuloso'].includes(texto(d.maquina).toLowerCase())) {
        return res.status(400).json({ ok: false, error: 'La línea Fabuloso / Limpiadores se controla en la app Control Fabuloso' });
    }
    const pesos = Array.isArray(d.pesos) ? d.pesos : [];
    if (pesos.some((p) => texto(p) !== '' && (numero(p) === null || numero(p) < 0 || numero(p) > 100000))) {
        return res.status(400).json({ ok: false, error: 'Hay un peso que no es un número válido' });
    }
    if (texto(d.ph) !== '' && (numero(d.ph) === null || numero(d.ph) < 0 || numero(d.ph) > 14)) {
        return res.status(400).json({ ok: false, error: 'El pH tiene que ser un número entre 0 y 14' });
    }
    const idsFoto = (Array.isArray(d.fotos) ? d.fotos : []).slice(0, 3)
        .map((x) => (x == null || x === '' ? null : Number(x)));
    if (idsFoto.some((x) => x !== null && !Number.isInteger(x))) {
        return res.status(400).json({ ok: false, error: 'Hay una foto no válida' });
    }
    if (!idsFoto[0] || !idsFoto[1]) {
        return res.status(400).json({ ok: false, error: 'Faltan las fotos obligatorias: sticker y lote/vencimiento' });
    }

    try {
        const resultado = await enTransaccion(async (c) => {
            await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['proceso-control']);

            const previo = await c.query('SELECT raw FROM proceso_controles WHERE id_envio = $1', [idEnvio]);
            if (previo.rows.length) return { record: previo.rows[0].raw, repetido: true };

            // Sin el OK de rotulo, desde el mediodia la orden no acepta mas
            // controles (lib/rotulos.js).
            const freno = await frenoDe(c, 'proceso', texto(d.orden, 60));
            if (freno) throw fallo(409, freno);

            // Cada orden tiene que tener al menos un pH, y se exige en su primer
            // control (Claudia, 18/09/2026).
            if (numero(d.ph) === null) {
                const { rows: antes } = await c.query(
                    'SELECT 1 FROM proceso_controles WHERE orden = $1 AND duplicado_de IS NULL LIMIT 1',
                    [texto(d.orden, 60)]
                );
                if (!antes.length) {
                    throw fallo(400, `Es el primer control de la orden ${texto(d.orden, 60)}: tiene que llevar pH`);
                }
            }

            const pedidas = idsFoto.filter((x) => x !== null);
            if (pedidas.length) {
                const { rows } = await c.query('SELECT id FROM proceso_fotos WHERE id = ANY($1)', [pedidas]);
                if (rows.length !== new Set(pedidas).size) throw fallo(400, 'Una de las fotos no se subió bien: volvé a sacarla');
            }

            const { rows: reloj } = await c.query(
                `SELECT (now() AT TIME ZONE $1)::date::text AS hoy,
                        to_char(now() AT TIME ZONE $1, 'HH24:MI') AS hora`,
                [ZONA]
            );
            const { hoy, hora } = reloj[0];
            const { rows: cuenta } = await c.query(
                'SELECT count(*)::int AS n FROM proceso_controles WHERE fecha = $1::date AND duplicado_de IS NULL',
                [hoy]
            );
            const analista = req.usuario.nombre || req.usuario.usuario;
            const record = armarControl(d, {
                hoy, hora, analista,
                controlNum: cuenta[0].n + 1,
                fotos: idsFoto.map((x) => (x === null ? null : `/api/control-en-proceso/fotos/${x}`)),
            });

            const { rows } = await c.query(
                `INSERT INTO proceso_controles
                    (pos, origen, fecha, analista, orden, lote, vence, maquina, presentacion,
                     granel, cod_pt, control_num, hora, promedio, spec, ph, has_dev,
                     dev_desc, dev_qty, is_rep, num_fotos, obs, raw,
                     registrado_por_id, registrado_en, id_envio)
                 VALUES (NULL, 'app', $1::date, $2, $3, $4, $5::date, $6, $7, $8, $9, $10, $11,
                         $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, now(), $23)
                 RETURNING id`,
                [
                    hoy, analista, record.orden, record.lote, venceAFecha(record.vence),
                    record.maquina, record.presentacion, record.granel, record.codPT,
                    record.controlNum, record.hora,
                    record.promedio === '' ? null : record.promedio,
                    record.spec || null, record.ph === '' ? null : record.ph, record.hasDev,
                    record.devDesc || null, record.devQty || null, record.isRep, record.numFotos,
                    record.obs || null, JSON.stringify(record), req.usuario.id, idEnvio,
                ]
            );
            const controlId = rows[0].id;

            const filas = record.pesos
                .map((v, i) => [controlId, i + 1, v === '' ? null : v, v === '' ? null : String(v)])
                .filter((f) => f[2] !== null);
            for (const f of filas) {
                await c.query(
                    'INSERT INTO proceso_pesos (control_id, muestra, valor_num, valor_texto) VALUES ($1, $2, $3, $4)',
                    f
                );
            }

            await registrar(c, req, 'control_nuevo', 'control', controlId,
                `${record.maquina} · ${record.presentacion} · lote ${record.lote} · #${record.controlNum}` +
                (record.hasDev ? ' · con desvío' : ''));
            // El primer control de la orden pide la segunda mirada de supervision
            const verificacion = await registrarControl(c, 'proceso', {
                orden: record.orden, fotoCaja: record.fotos[0], fotoEnvase: record.fotos[1],
                lote: record.lote, vence: record.vence,
                producto: [record.maquina, record.presentacion].filter(Boolean).join(' · '),
                codigo: record.codPT || '',
                analista, analistaId: req.usuario.id,
            });
            return { record, repetido: false, verificacion };
        });
        if (resultado.verificacion) avisarSupervision(resultado.verificacion, 'nueva').catch(() => {});
        delete resultado.verificacion;
        res.json({ ok: true, ...resultado });
    } catch (err) {
        responder(err, res, next);
    }
});

/** POST /api/control-en-proceso/fotos  { dataBase64, mime, nombre } */
rutasControlEnProceso.post('/fotos', cargar, async (req, res, next) => {
    const { dataBase64, mime, nombre } = req.body || {};
    const tipo = texto(mime, 60) || 'image/jpeg';
    if (!dataBase64) return res.status(400).json({ ok: false, error: 'Falta la imagen' });
    if (!TIPOS_FOTO.has(tipo)) return res.status(415).json({ ok: false, error: 'Solo se aceptan fotos JPG, PNG o WEBP' });

    const recibida = Buffer.from(String(dataBase64).replace(/^data:[^,]*,/, ''), 'base64');
    if (!recibida.length) return res.status(400).json({ ok: false, error: 'La imagen no es válida' });
    if (recibida.length > MAX_FOTO) return res.status(413).json({ ok: false, error: 'La foto supera los 5 MB' });
    const { bytes, tipo: tipoFinal } = await comprimirFoto(recibida, tipo);

    try {
        const id = await enTransaccion(async (c) => {
            const { rows } = await c.query(
                `INSERT INTO proceso_fotos (nombre, tipo, tamano, contenido, subida_por)
                 VALUES ($1, $2, $3, $4, $5) RETURNING id`,
                [(texto(nombre, 200) || `control_${Date.now()}`).replace(/\.\w+$/, '') + '.' + tipoFinal.split('/')[1], tipoFinal, bytes.length, bytes,
                    req.usuario.nombre || req.usuario.usuario]
            );
            await registrar(c, req, 'foto_subida', 'foto', rows[0].id, `${bytes.length} bytes`);
            return rows[0].id;
        });
        res.json({ ok: true, id: String(id), url: `/api/control-en-proceso/fotos/${id}` });
    } catch (err) {
        next(err);
    }
});

/** GET /api/control-en-proceso/fotos/:id */
rutasControlEnProceso.get('/fotos/:id', leer, async (req, res, next) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ ok: false, error: 'id invalido' });
    try {
        const { rows } = await consultar('SELECT nombre, tipo, contenido FROM proceso_fotos WHERE id = $1', [id]);
        if (!rows[0]) return res.status(404).json({ ok: false, error: 'no existe' });
        res.setHeader('Content-Type', rows[0].tipo);
        res.setHeader('Content-Disposition', `inline; filename="${String(rows[0].nombre).replace(/["\r\n]/g, '')}"`);
        res.setHeader('Cache-Control', 'private, max-age=86400');
        res.send(rows[0].contenido);
    } catch (err) {
        next(err);
    }
});

/* ═══════════════════════════════════════════════════════════════════════════
   Cierre de la planilla
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * POST /api/control-en-proceso/importar
 *   { cantidad, filas: [{ fila, hora, fotos: [3], limp? }], entrenamientos: [...], confirmar }
 *
 * Se hace una sola vez. Los controles ya estan en la base (los trae la
 * replica); lo que falta y solo tiene el Excel son los enlaces de las fotos -la
 * hoja los guarda en formulas HYPERLINK y el Apps Script devolvia el texto
 * "📷 Sticker"-, la hora legible, los campos de limpiadores y los
 * entrenamientos. Antes de completar se hace una ultima replica y se exige que
 * el Excel tenga exactamente los mismos controles: si alguien cargo algo
 * despues de descargarlo, se frena.
 *
 * Sin `confirmar` solo informa lo que haria.
 */
rutasControlEnProceso.post('/importar', administrar, async (req, res, next) => {
    const d = req.body || {};
    const cantidad = Number(d.cantidad);
    const filas = Array.isArray(d.filas) ? d.filas : [];
    const entrenamientos = Array.isArray(d.entrenamientos) ? d.entrenamientos : [];

    try {
        if (await planillaCerrada()) throw fallo(409, 'La planilla ya se cerró: la importación no se repite');
        if (!Number.isInteger(cantidad) || cantidad < 1) throw fallo(400, 'El Excel no trae controles');

        try {
            await sincronizarProceso();
        } catch (err) {
            throw fallo(502, `No se pudo hacer la última copia de la planilla (${err.message}). No se importó nada.`);
        }

        const { rows: n } = await consultar(
            "SELECT count(*)::int AS n FROM proceso_controles WHERE origen = 'planilla'"
        );
        if (n[0].n !== cantidad) {
            throw fallo(409,
                `El Excel tiene ${cantidad} controles y la planilla tiene hoy ${n[0].n}. ` +
                'Probablemente se cargó algo después de descargarlo: descargá el Excel de nuevo y repetí.');
        }

        const parches = [];
        for (const f of filas) {
            const fila = Number(f?.fila);
            if (!Number.isInteger(fila) || fila < 2 || fila > cantidad + 1) continue;
            const fotos = (Array.isArray(f.fotos) ? f.fotos : []).slice(0, 3)
                .map((u) => (URL_DRIVE.test(texto(u, 500)) ? texto(u, 500) : null));
            while (fotos.length < 3) fotos.push(null);
            const parche = { photoLinks: fotos.filter(Boolean), fotos };
            const hora = texto(f.hora, 5);
            if (HORA.test(hora)) parche.hora = hora;
            const l = f.limp;
            if (l && typeof l === 'object') {
                const defectos = (Array.isArray(l.defectos) ? l.defectos : []).map((x) => texto(x, 120)).filter(Boolean);
                if (defectos.length || texto(l.uds) || texto(l.motivo) || texto(l.accion)) {
                    Object.assign(parche, {
                        limpDefects: defectos.slice(0, 60), limpUds: texto(l.uds, 30),
                        limpMotivo: texto(l.motivo, 500), limpAccion: texto(l.accion, 500),
                    });
                }
            }
            parches.push({ fila, parche });
        }
        const ents = entrenamientos.map((e) => ({
            fecha: e?.fecha && !Number.isNaN(new Date(e.fecha).getTime()) ? new Date(e.fecha).toISOString() : null,
            analista: texto(e?.analista, 120), puntaje: numero(e?.puntaje), correctas: numero(e?.correctas),
            total: numero(e?.total), aprobado: texto(e?.aprobado, 10), detalle: texto(e?.detalle, 5000),
        })).filter((e) => e.analista || e.fecha);

        const resumen = {
            controles: cantidad,
            conFotos: parches.filter((p) => p.parche.photoLinks.length).length,
            fotos: parches.reduce((s, p) => s + p.parche.photoLinks.length, 0),
            conHora: parches.filter((p) => p.parche.hora).length,
            conLimpiadores: parches.filter((p) => p.parche.limpDefects).length,
            entrenamientos: ents.length,
        };
        if (d.confirmar !== true) return res.json({ ok: true, preview: resumen });

        await enTransaccion(async (c) => {
            await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['proceso-importar']);
            const ya = await c.query('SELECT 1 FROM proceso_corte');
            if (ya.rows.length) throw fallo(409, 'La planilla ya se cerró: la importación no se repite');

            let actualizados = 0;
            for (const { fila, parche } of parches) {
                const r = await c.query(
                    `UPDATE proceso_controles
                     SET raw = (raw::jsonb || $2::jsonb)::json,
                         hora = COALESCE($3, hora),
                         num_fotos = GREATEST(COALESCE(num_fotos, 0), $4)
                     WHERE origen = 'planilla' AND fila_hoja = $1`,
                    [fila, JSON.stringify(parche), parche.hora || null, parche.photoLinks.length]
                );
                actualizados += r.rowCount;
            }
            for (const e of ents) {
                await c.query(
                    `INSERT INTO proceso_entrenamientos (fecha, analista, puntaje, correctas, total, aprobado, detalle)
                     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
                    [e.fecha, e.analista || null, e.puntaje, e.correctas, e.total, e.aprobado || null, e.detalle || null]
                );
            }
            const detalle = JSON.stringify({ ...resumen, actualizados });
            await c.query(
                'INSERT INTO proceso_corte (cerrado_por, detalle) VALUES ($1, $2)',
                [req.usuario.nombre || req.usuario.usuario, detalle]
            );
            await registrar(c, req, 'planilla_cerrada', 'historial', null, detalle);
            resumen.actualizados = actualizados;
        });
        res.json({ ok: true, importado: resumen });
    } catch (err) {
        responder(err, res, next);
    }
});

/* ═══════════════════════════════════════════════════════════════════════════
   Copia de las fotos viejas de Drive
   ═══════════════════════════════════════════════════════════════════════════ */

/** GET /api/control-en-proceso/fotos-drive — cuantas faltan y como va la copia. */
rutasControlEnProceso.get('/fotos-drive', administrar, async (_req, res, next) => {
    try {
        res.json({ ok: true, ...(await contarPendientes()), trabajo: estadoCopia() });
    } catch (err) {
        next(err);
    }
});

/** POST /api/control-en-proceso/fotos-drive/copiar — la lanza en segundo plano. */
rutasControlEnProceso.post('/fotos-drive/copiar', administrar, async (req, res, next) => {
    try {
        if (!(await planillaCerrada())) {
            return res.status(409).json({ ok: false, error: 'Primero hay que cerrar la planilla' });
        }
        const trabajo = await iniciarCopia(req.usuario.nombre || req.usuario.usuario);
        res.json({ ok: true, trabajo });
    } catch (err) {
        next(err);
    }
});

/* ═══════════════════════════════════════════════════════════════════════════
   Ordenes de envasado: aprobacion e impresion (REG SOP LCC 200)
   ═══════════════════════════════════════════════════════════════════════════ */

const CODIGO_REGISTRO = 'REG SOP LCC 200';

/**
 * Las firmas de una orden: la de cada analista que cargo un control y la de
 * quien aprobo. Cada una es la que estaba vigente en ese momento (lib/firmas).
 *
 * Los controles que vienen de la planilla no tienen firma: la app vieja no
 * pedia ninguna. Se listan igual, con `sinFirma`, para que la hoja lo diga en
 * vez de dejar el renglon vacio como si faltara firmar.
 */
async function firmasDeOrden(filas, cierre) {
    const firmas = [];
    const vistos = new Set();
    for (const f of filas) {
        const nombre = f.analista || '';
        if (!nombre || vistos.has(nombre)) continue;
        vistos.add(nombre);
        const firma = f.registrado_por_id
            ? await firmaDe(f.registrado_por_id, f.registrado_en, nombre)
            : null;
        firmas.push({
            rol: 'Analista',
            nombre,
            firmadoEn: f.registrado_en || null,
            sinFirma: !firma,
            deLaPlanilla: f.origen !== 'app',
            ...(firma || {}),
        });
    }
    if (cierre) {
        const firma = await firmaDe(cierre.aprobada_por_id, cierre.aprobada_en, cierre.aprobada_por);
        firmas.push({
            rol: 'Aprobado por',
            nombre: cierre.aprobada_por,
            firmadoEn: cierre.aprobada_en,
            sinFirma: !firma,
            ...(firma || {}),
        });
    }
    return firmas;
}

/**
 * GET /api/control-en-proceso/ordenes?dias=30
 * Una fila por orden de envasado, con si esta aprobada. Es la pantalla desde
 * donde se aprueba y se imprime.
 */
rutasControlEnProceso.get('/ordenes', leer, async (req, res, next) => {
    const dias = Math.min(Math.max(Number(req.query.dias) || 30, 1), 365);
    try {
        const { rows } = await consultar(
            `SELECT c.orden,
                    count(*)::int                                   AS controles,
                    count(*) FILTER (WHERE c.has_dev)::int          AS con_desvio,
                    min(c.fecha)                                    AS desde,
                    max(c.fecha)                                    AS hasta,
                    max(c.lote)                                     AS lote,
                    max(c.maquina)                                  AS maquina,
                    max(c.presentacion)                             AS presentacion,
                    string_agg(DISTINCT c.analista, ', ')           AS analistas,
                    bool_or(c.origen = 'app')                  AS de_app,
                    o.aprobada_por, o.aprobada_en, o.notas
             FROM proceso_controles c
             LEFT JOIN proceso_ordenes o ON o.orden = c.orden
             WHERE c.duplicado_de IS NULL
               AND c.orden IS NOT NULL AND c.orden <> ''
               AND c.fecha >= (now() AT TIME ZONE $1)::date - $2::int
             GROUP BY c.orden, o.aprobada_por, o.aprobada_en, o.notas
             ORDER BY max(c.fecha) DESC, max(c.id) DESC`,
            [ZONA, dias]
        );
        res.json({
            ok: true,
            registro: CODIGO_REGISTRO,
            ordenes: rows.map((o) => ({
                orden: o.orden,
                controles: o.controles,
                conDesvio: o.con_desvio,
                desde: o.desde, hasta: o.hasta,
                lote: o.lote || '', maquina: o.maquina || '', presentacion: o.presentacion || '',
                analistas: o.analistas || '',
                // Las ordenes de la planilla vieja nunca tuvieron aprobacion: la pantalla
                // las muestra aparte para que no se confundan con lo pendiente de verdad.
                deApp: Boolean(o.de_app),
                aprobada: Boolean(o.aprobada_por),
                aprobadaPor: o.aprobada_por || '', aprobadaEn: o.aprobada_en || null,
                notas: o.notas || '',
            })),
        });
    } catch (err) {
        next(err);
    }
});

/* ═══════════════════════════════════════════════════════════════════════════
   Correccion de un valor mal cargado (migracion 058)
   ═══════════════════════════════════════════════════════════════════════════
   Claudia, 09/10/2026: al imprimir el registro completo las supervisoras tienen
   que poder corregir un valor mal cargado, pero dejando a la vista el que se
   habia puesto. El valor corregido se escribe en el control -asi el dashboard y
   el informe gerencial usan el dato bueno- y el anterior queda en
   proceso_correcciones, que es lo que la hoja impresa muestra tachado.

   `columna` es la columna propia de proceso_controles, que acompana a raw. La
   hora, la fecha, el analista, la orden y las fotos no se corrigen: la hora y
   el analista son la identidad del control y su firma, y la orden lo movería de
   registro. */
const CAMPOS_CORREGIBLES = {
    // El producto va primero: es lo que mas se corrige (Claudia, orden
    // 1069122: el producto no era el del codigo de producto ni el de la foto).
    presentacion: { etiqueta: 'Producto (presentación)', columna: 'presentacion', max: 120, cabecera: true },
    maquina: { etiqueta: 'Máquina (línea)', columna: 'maquina', max: 60, cabecera: true },
    codPT: { etiqueta: 'Código PT (producto)', columna: 'cod_pt', max: 60, cabecera: true },
    lote: { etiqueta: 'Lote', columna: 'lote', max: 60, cabecera: true },
    vence: { etiqueta: 'Vencimiento', columna: 'vence', fecha: true, max: 30, cabecera: true },
    granel: { etiqueta: 'Código de granel', columna: 'granel', max: 60, cabecera: true },
    spec: { etiqueta: 'Especificación', columna: 'spec', max: 300, vacio: true, cabecera: true },
    ph: { etiqueta: 'pH', columna: 'ph', numero: [0, 14], vacio: true },
    peso: { etiqueta: 'Peso', peso: true, numero: [0, 100000], vacio: true },
    obs: { etiqueta: 'Observaciones', columna: 'obs', max: 1000, vacio: true },
    devDesc: { etiqueta: 'Descripción del desvío', columna: 'dev_desc', max: 500, vacio: true },
    devQty: { etiqueta: 'Unidades con desvío', columna: 'dev_qty', max: 30, vacio: true },
};

/** El valor que hoy tiene el control, como texto. */
function valorActual(raw, campo, indice) {
    if (campo === 'peso') {
        const v = (Array.isArray(raw.pesos) ? raw.pesos : [])[indice - 1];
        return v === null || v === undefined ? '' : String(v);
    }
    const v = raw[campo];
    return v === null || v === undefined ? '' : String(v);
}

async function corregirValor(c, req, orden, d) {
    const campo = texto(d.campo, 40);
    const def = CAMPOS_CORREGIBLES[campo];
    if (!def) throw fallo(400, 'Ese dato no se puede corregir desde el registro');
    const indice = def.peso ? Number(d.indice) : null;
    if (def.peso && !(Number.isInteger(indice) && indice >= 1 && indice <= 5)) {
        throw fallo(400, 'Decí qué peso (1 a 5) se corrige');
    }
    const motivo = texto(d.motivo, 500);
    if (motivo.length < 5) throw fallo(400, 'Escribí por qué se corrige: queda en el registro');

    const { rows } = await c.query(
        `SELECT id, raw, control_num, analista FROM proceso_controles
         WHERE id = $1 AND orden = $2 AND duplicado_de IS NULL FOR UPDATE`,
        [Number(d.controlId) || 0, orden]
    );
    if (!rows.length) throw fallo(404, 'Ese control no es de esta orden');
    const fila = rows[0];

    let valor = texto(d.valor, def.max || 500);
    if (def.numero) {
        if (valor === '') {
            if (!def.vacio) throw fallo(400, `${def.etiqueta} no puede quedar vacío`);
        } else {
            const n = numero(valor);
            if (n === null || n < def.numero[0] || n > def.numero[1]) {
                throw fallo(400, `${def.etiqueta} tiene que ser un número entre ${def.numero[0]} y ${def.numero[1]}`);
            }
            valor = String(n);
        }
    } else if (valor === '' && !def.vacio) {
        throw fallo(400, `${def.etiqueta} no puede quedar vacío`);
    }
    if (def.fecha && valor !== '' && !venceAFecha(valor)) {
        throw fallo(400, 'El vencimiento no se entiende: escribilo como dd/mm/aaaa, mm/aaaa o aaaa-mm-dd');
    }

    const anterior = valorActual(fila.raw, campo, indice);
    if (anterior === valor) throw fallo(400, 'Ese valor es el que ya está cargado');

    /* Un lote o un vencimiento mal escrito esta igual de mal en todos los
       controles de la orden: se escriben una vez por control. Con `todos` se
       corrigen de una, y cada control recibe igual su propia correccion, que es
       lo que hace falta para que el registro se entienda. */
    const filas = [fila];
    if (def.cabecera && d.todos === true) {
        const { rows: hermanos } = await c.query(
            `SELECT id, raw, control_num FROM proceso_controles
             WHERE orden = $1 AND duplicado_de IS NULL AND id <> $2
             ORDER BY fecha, control_num, id FOR UPDATE`,
            [orden, fila.id]
        );
        for (const h of hermanos) {
            if (valorActual(h.raw, campo, null) === anterior) filas.push(h);
        }
    }
    for (const f of filas) await aplicar(c, f, { def, campo, indice, valor, motivo, orden, req });

    const nombreCampo = def.etiqueta + (def.peso ? ` ${indice}` : '');
    await registrar(c, req, 'valor_corregido', 'control', fila.id,
        `Orden ${orden} · ${filas.length > 1 ? `${filas.length} controles` : `control #${fila.control_num ?? ''}`} · ${nombreCampo}: ` +
        `"${anterior || '(vacío)'}" → "${valor || '(vacío)'}" · ${motivo}`);
    return { campo: nombreCampo, anterior, valor, corregidos: filas.length };
}

/** Escribe el valor corregido en un control y deja el anterior en el rastro. */
async function aplicar(c, fila, { def, campo, indice, valor, motivo, orden, req }) {
    const raw = { ...fila.raw };
    // El control queda con el valor bueno; el anterior va al rastro.
    if (def.peso) {
        const pesos = (Array.isArray(raw.pesos) ? raw.pesos : []).slice(0, 5);
        while (pesos.length < 5) pesos.push('');
        pesos[indice - 1] = valor === '' ? '' : numero(valor);
        raw.pesos = pesos;
        raw.promedio = promedioDe(pesos);
        await c.query(
            `INSERT INTO proceso_pesos (control_id, muestra, valor_num, valor_texto)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (control_id, muestra) DO UPDATE
                SET valor_num = EXCLUDED.valor_num, valor_texto = EXCLUDED.valor_texto`,
            [fila.id, indice, valor === '' ? null : numero(valor), valor === '' ? null : valor]
        );
        await c.query('UPDATE proceso_controles SET promedio = $2, raw = $3 WHERE id = $1',
            [fila.id, raw.promedio === '' ? null : raw.promedio, JSON.stringify(raw)]);
    } else {
        raw[campo] = def.numero && valor !== '' ? numero(valor) : valor;
        const valorColumna = def.fecha ? venceAFecha(valor)
            : def.numero ? (valor === '' ? null : numero(valor))
                : (valor === '' ? null : valor);
        await c.query(
            `UPDATE proceso_controles SET ${def.columna} = $2, raw = $3 WHERE id = $1`,
            [fila.id, valorColumna, JSON.stringify(raw)]
        );
    }

    await c.query(
        `INSERT INTO proceso_correcciones
            (control_id, orden, campo, indice, valor_anterior, valor_nuevo, motivo, usuario, usuario_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [fila.id, orden, campo, indice, valorActual(fila.raw, campo, indice), valor, motivo,
            req.usuario.nombre || req.usuario.usuario, req.usuario.id]
    );
}

/** Las correcciones de una orden, para la hoja impresa. */
async function correccionesDe(orden) {
    const { rows } = await consultar(
        `SELECT k.*, c.control_num FROM proceso_correcciones k
         JOIN proceso_controles c ON c.id = k.control_id
         WHERE k.orden = $1 ORDER BY k.ts, k.id`,
        [orden]
    );
    return rows.map((k) => ({
        id: k.id,
        controlId: k.control_id,
        controlNum: k.control_num,
        campo: k.campo,
        etiqueta: (CAMPOS_CORREGIBLES[k.campo]?.etiqueta || k.campo) + (k.indice ? ` ${k.indice}` : ''),
        indice: k.indice,
        anterior: k.valor_anterior || '',
        nuevo: k.valor_nuevo || '',
        motivo: k.motivo,
        usuario: k.usuario,
        ts: k.ts,
    }));
}

/** Los controles de una orden y su aprobacion, con las firmas para la hoja. */
async function armarOrden(orden) {
    const { rows } = await consultar(
        `SELECT id, raw, analista, registrado_por_id, registrado_en, origen
         FROM proceso_controles
         WHERE orden = $1 AND duplicado_de IS NULL
         ORDER BY fecha, control_num, id`,
        [orden]
    );
    if (!rows.length) throw fallo(404, 'No hay controles con esa orden');
    const { rows: cierres } = await consultar('SELECT * FROM proceso_ordenes WHERE orden = $1', [orden]);
    const cierre = cierres[0] || null;
    return {
        orden,
        registro: CODIGO_REGISTRO,
        aprobada: Boolean(cierre),
        aprobadaPor: cierre?.aprobada_por || '',
        aprobadaEn: cierre?.aprobada_en || null,
        notas: cierre?.notas || '',
        // El id va con cada control: es con lo que la pantalla pide una
        // correccion y con lo que la hoja ubica el valor corregido.
        controles: rows.map((f) => ({ ...f.raw, _id: f.id })),
        firmas: await firmasDeOrden(rows, cierre),
        rotulo: await rotuloDe('proceso', orden),
        correcciones: await correccionesDe(orden),
        // Los datos que la pantalla ofrece corregir, con su etiqueta.
        campos: Object.entries(CAMPOS_CORREGIBLES).map(([clave, def]) => ({
            clave, etiqueta: def.etiqueta, peso: Boolean(def.peso), cabecera: Boolean(def.cabecera),
        })),
    };
}

/** GET /api/control-en-proceso/ordenes/:orden */
rutasControlEnProceso.get('/ordenes/:orden', leer, async (req, res, next) => {
    try {
        res.json({ ok: true, ...(await armarOrden(texto(req.params.orden, 60))) });
    } catch (err) {
        responder(err, res, next);
    }
});

/**
 * GET /api/control-en-proceso/ordenes/:orden/impresion
 * Lo mismo, pero deja constancia: una copia en papel de un registro tiene que
 * poder rastrearse (igual que en graneles).
 */
rutasControlEnProceso.get('/ordenes/:orden/impresion', leer, async (req, res, next) => {
    try {
        const orden = texto(req.params.orden, 60);
        const datos = await armarOrden(orden);
        await enTransaccion((c) => registrar(c, req, 'imprimir', 'orden', orden,
            `${datos.controles.length} control(es) · ${datos.aprobada ? 'aprobada' : 'pendiente'}`));
        res.json({
            ok: true,
            ...datos,
            impreso: { por: req.usuario.nombre || req.usuario.usuario, en: new Date().toISOString() },
        });
    } catch (err) {
        responder(err, res, next);
    }
});

/**
 * POST /api/control-en-proceso/ordenes/:orden/aprobar  { notas }
 * Aprueban las administradoras (Antonella, Gloria y Claudia). Una orden
 * aprobada no se vuelve a aprobar: si hay que corregir algo, queda el rastro.
 */
rutasControlEnProceso.post('/ordenes/:orden/aprobar', aprobar, async (req, res, next) => {
    const orden = texto(req.params.orden, 60);
    const notas = texto(req.body?.notas, 1000);
    try {
        const resultado = await enTransaccion(async (c) => {
            await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['proceso-orden:' + orden]);
            const { rows: hay } = await c.query(
                'SELECT count(*)::int AS n FROM proceso_controles WHERE orden = $1 AND duplicado_de IS NULL',
                [orden]
            );
            if (!hay[0].n) throw fallo(404, 'No hay controles con esa orden');
            const { rows: ya } = await c.query('SELECT aprobada_por FROM proceso_ordenes WHERE orden = $1', [orden]);
            if (ya.length) throw fallo(409, `La orden ya fue aprobada por ${ya[0].aprobada_por}`);
            const rotulo = await rotuloDe('proceso', orden, c);
            if (rotulo && rotulo.estado !== 'ok') {
                throw fallo(409, 'Falta el OK de rótulo de esta orden: revisalo en la pestaña Rótulos antes de aprobarla');
            }
            await c.query(
                `INSERT INTO proceso_ordenes (orden, aprobada_por, aprobada_por_id, notas)
                 VALUES ($1, $2, $3, $4)`,
                [orden, req.usuario.nombre || req.usuario.usuario, req.usuario.id, notas || null]
            );
            await registrar(c, req, 'orden_aprobada', 'orden', orden,
                `${hay[0].n} control(es)${notas ? ' · ' + notas : ''}`);
            return { controles: hay[0].n };
        });
        res.json({ ok: true, orden, ...resultado });
    } catch (err) {
        responder(err, res, next);
    }
});

/**
 * POST /api/control-en-proceso/ordenes/:orden/correcciones
 *   { controlId, campo, indice, valor, motivo }
 * Corrige un valor mal cargado dejando el anterior a la vista en el registro.
 * Corrigen quienes aprueban (Antonella, Gloria, Claudia), antes o despues de la
 * aprobacion: una orden ya firmada tambien puede tener un dato mal, y lo que
 * pide BPF es que la correccion quede trazada, no que no se pueda hacer.
 */
rutasControlEnProceso.post('/ordenes/:orden/correcciones', aprobar, async (req, res, next) => {
    const orden = texto(req.params.orden, 60);
    try {
        const hecho = await enTransaccion(async (c) => {
            await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['proceso-orden:' + orden]);
            return corregirValor(c, req, orden, req.body || {});
        });
        res.json({ ok: true, orden, ...hecho, ...(await armarOrden(orden)) });
    } catch (err) {
        responder(err, res, next);
    }
});

/* Verificacion de rotulo por supervision (lib/rotulos.js) */
montarRutasRotulo(rutasControlEnProceso, 'proceso', { leer, cargar, aprobar });
