/**
 * Programa de Estabilidad — lectura, escritura y avisos.
 *
 * Reemplaza al Apps Script. Se conserva su contrato clave -> valor para que el
 * cambio del lado de la app sea cambiar la URL y poco mas.
 *
 * Una diferencia que NO es cosmetica: el Apps Script exponia
 * `{action:'email', to, subject, body}` sin autenticacion, asi que cualquiera
 * con la URL podia mandar cualquier texto a cualquier direccion firmado como
 * Vessena. Aca el cliente dice QUE PASO -se asigno, se aprobo, se rechazo- y el
 * servidor decide a quien le escribe y que dice. No hay forma de pedirle que
 * mande otra cosa.
 */
import { Router } from 'express';
import { consultar, enTransaccion } from '../db.js';
import { exigirPermiso } from '../lib/acceso.js';
import { enviar, hayCorreo } from '../lib/correo.js';
import { supervisoresDe, unir } from '../lib/destinatarios.js';
import { firmaDe, nombreComparable } from '../lib/firmas.js';

export const rutasEstabilidad = Router();

const RECURSO = 'estabilidad';
const leer = exigirPermiso(RECURSO, 'ver');
const escribir = exigirPermiso(RECURSO, 'cargar');

const BASE = (process.env.URL_PUBLICA || 'http://192.168.30.15:3000').replace(/\/+$/, '');
const PREFIJO = '[LCC Estabilidad] ';

// Claves permitidas. El almacen es generico, pero aceptar cualquier clave lo
// convertiria en un deposito abierto donde cualquiera con permiso de carga
// puede guardar lo que quiera y hacerlo crecer sin control.
const CLAVES = new Set(['studies', 'productos', 'auditLog', 'config']);

/**
 * Cuanto puede encoger una coleccion en un solo guardado. Borrar un producto o
 * un estudio saca uno; perder la mitad de golpe no es una edicion, es una app
 * que arranco sin datos y esta escribiendo lo poco que tiene encima de todo.
 * La app no tiene ninguna accion que haga eso a proposito, asi que se rechaza.
 */
const CAIDA_SOSPECHOSA = 0.5;
const MINIMO_PARA_MIRAR = 4;

/**
 * Guarda como estaba una coleccion antes de reescribirla. Cada guardado pisa la
 * coleccion entera, asi que sin esto un error se lleva puesto lo anterior sin
 * dejar forma de volver: es lo que paso el 11/09/2026 con el catalogo.
 */
async function respaldar(c, clave, valor, quien, motivo) {
    await c.query(
        `INSERT INTO estabilidad_respaldos (clave, valor, guardado_por, motivo)
         VALUES ($1, $2, $3, $4)`,
        [clave, valor, quien, motivo]
    );
}

/** La coleccion como esta en la base, ya bloqueada para esta transaccion. */
async function leerColeccion(c, clave) {
    await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['estabilidad:' + clave]);
    const { rows } = await c.query('SELECT valor FROM estabilidad_datos WHERE clave = $1', [clave]);
    const valor = rows.length ? rows[0].valor : null;
    let lista = [];
    if (valor != null) {
        try { lista = JSON.parse(valor); } catch { lista = null; }
    }
    if (!Array.isArray(lista)) {
        // Mejor no tocar nada que "arreglar" una coleccion que no se entiende.
        const e = new Error(`${clave} en la base no es una lista`);
        e.estado = 500;
        throw e;
    }
    return { valor, lista };
}

async function escribirColeccion(c, clave, lista, quien) {
    await c.query(
        `INSERT INTO estabilidad_datos (clave, valor, actualizado_por)
         VALUES ($1, $2, $3)
         ON CONFLICT (clave) DO UPDATE
            SET valor = EXCLUDED.valor,
                actualizado_en = now(),
                actualizado_por = EXCLUDED.actualizado_por`,
        [clave, JSON.stringify(lista), quien]
    );
}

/** GET /api/estabilidad/datos — todas las claves, como las devolvia el doGet. */
rutasEstabilidad.get('/datos', leer, async (_req, res, next) => {
    try {
        const { rows } = await consultar('SELECT clave, valor FROM estabilidad_datos');
        const salida = {};
        for (const f of rows) salida[f.clave] = f.valor;
        res.json(salida);
    } catch (err) {
        next(err);
    }
});

/**
 * POST /api/estabilidad/datos  { key, value }
 * `value` llega serializado, igual que se lo mandaba al Apps Script.
 */
rutasEstabilidad.post('/datos', escribir, async (req, res, next) => {
    const { key, value } = req.body || {};

    if (!CLAVES.has(key)) {
        return res.status(400).json({ error: `clave no permitida: ${key}` });
    }
    if (typeof value !== 'string') {
        return res.status(400).json({ error: 'value tiene que ser el JSON ya serializado' });
    }
    // Se valida que sea JSON antes de guardarlo: si entra algo roto, la app
    // deja de abrir y recuperarlo pide meterse en la base a mano.
    try {
        JSON.parse(value);
    } catch {
        return res.status(400).json({ error: 'value no es JSON valido' });
    }

    try {
        const r = await enTransaccion(async (c) => {
            // Serializa los guardados entre si. Cada escritura reescribe la
            // coleccion completa, asi que dos simultaneas se pisarian.
            await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['estabilidad:' + key]);
            const { rows } = await c.query('SELECT valor FROM estabilidad_datos WHERE clave = $1', [key]);
            const antes = rows.length ? rows[0].valor : null;

            if (antes != null) {
                let viejo, nuevo;
                try { viejo = JSON.parse(antes); nuevo = JSON.parse(value); } catch { viejo = null; }
                if (Array.isArray(viejo) && Array.isArray(nuevo) &&
                    viejo.length >= MINIMO_PARA_MIRAR &&
                    nuevo.length < viejo.length * CAIDA_SOSPECHOSA) {
                    return { encoge: { antes: viejo.length, ahora: nuevo.length } };
                }
                if (antes === value) return { igual: true };
                await respaldar(c, key, antes, req.usuario.nombre, 'antes de guardar');
            }
            await c.query(
                `INSERT INTO estabilidad_datos (clave, valor, actualizado_por)
                 VALUES ($1, $2, $3)
                 ON CONFLICT (clave) DO UPDATE
                    SET valor = EXCLUDED.valor,
                        actualizado_en = now(),
                        actualizado_por = EXCLUDED.actualizado_por`,
                [key, value, req.usuario.nombre]
            );
            return {};
        });
        if (r.encoge) {
            console.warn(`[estabilidad] guardado rechazado: ${key} pasaba de ${r.encoge.antes} a ${r.encoge.ahora} · ${req.usuario.nombre}`);
            return res.status(409).json({
                error: `el guardado dejaba ${key} con ${r.encoge.ahora} de ${r.encoge.antes}. ` +
                    'No se guardo nada: recarga la pagina y volve a intentar.',
            });
        }
        res.json({ ok: true, clave: key, bytes: value.length });
    } catch (err) {
        next(err);
    }
});

// ---------------------------------------------------------------------------
// Productos del catalogo, de a uno
// ---------------------------------------------------------------------------
// La app mandaba el catalogo entero en cada guardado, armado con lo que tenia
// en memoria. Si esa copia estaba vieja -otra persona guardo en el medio, o el
// refresco automatico la reemplazo mientras el formulario seguia abierto- el
// guardado pisaba productos que no se habian tocado, o se perdia la edicion.
// Aca el cliente manda UN producto y el servidor lo ubica en la lista actual.

function textoPlano(v) {
    return typeof v === 'string' ? v.trim() : '';
}

/** POST /api/estabilidad/producto  { producto: {...} } — crea o reemplaza por id. */
rutasEstabilidad.post('/producto', escribir, async (req, res, next) => {
    const p = req.body?.producto;
    if (!p || typeof p !== 'object' || Array.isArray(p)) {
        return res.status(400).json({ error: 'falta el producto' });
    }
    const id = textoPlano(p.id);
    if (!id) return res.status(400).json({ error: 'el producto no tiene id' });
    if (!textoPlano(p.producto)) return res.status(400).json({ error: 'falta el nombre del producto' });

    try {
        const r = await enTransaccion(async (c) => {
            const { valor, lista } = await leerColeccion(c, 'productos');
            const i = lista.findIndex((x) => String(x?.id) === id);
            const accion = i >= 0 ? 'actualizado' : 'creado';
            if (valor != null) {
                await respaldar(c, 'productos', valor, req.usuario.nombre,
                    `antes de ${i >= 0 ? 'editar' : 'crear'} ${id} (${textoPlano(p.producto)})`);
            }
            if (i >= 0) lista[i] = p; else lista.push(p);
            await escribirColeccion(c, 'productos', lista, req.usuario.nombre);
            return { accion, lista };
        });
        console.log(`[estabilidad] producto ${r.accion}: ${id} · ${req.usuario.nombre}`);
        res.json({ ok: true, accion: r.accion, productos: r.lista });
    } catch (err) {
        next(err);
    }
});

/** DELETE /api/estabilidad/producto/:id */
rutasEstabilidad.delete('/producto/:id', escribir, async (req, res, next) => {
    const id = String(req.params.id || '');
    try {
        const r = await enTransaccion(async (c) => {
            const { valor, lista } = await leerColeccion(c, 'productos');
            const cual = lista.find((x) => String(x?.id) === id);
            if (!cual) return { noEsta: true };
            await respaldar(c, 'productos', valor, req.usuario.nombre,
                `antes de eliminar ${id} (${textoPlano(cual.producto)})`);
            const quedan = lista.filter((x) => String(x?.id) !== id);
            await escribirColeccion(c, 'productos', quedan, req.usuario.nombre);
            return { lista: quedan };
        });
        if (r.noEsta) return res.status(404).json({ error: 'ese producto ya no esta en el catalogo' });
        console.log(`[estabilidad] producto eliminado: ${id} · ${req.usuario.nombre}`);
        res.json({ ok: true, productos: r.lista });
    } catch (err) {
        next(err);
    }
});

/**
 * POST /api/estabilidad/auditoria  { evento: {...} }
 *
 * Agrega un evento a la auditoria. Antes la app reescribia la auditoria entera
 * con su copia en memoria, que no se refrescaba nunca: cada evento de una
 * persona borraba los que otra habia registrado desde que abrio la pagina.
 * Agregar del lado del servidor no pisa nada, asi que no hace falta respaldo.
 */
rutasEstabilidad.post('/auditoria', escribir, async (req, res, next) => {
    const ev = req.body?.evento;
    if (!ev || typeof ev !== 'object' || Array.isArray(ev)) {
        return res.status(400).json({ error: 'falta el evento' });
    }
    if (JSON.stringify(ev).length > 200000) {
        return res.status(413).json({ error: 'el evento es demasiado grande' });
    }
    // Quien y cuando los pone el servidor: en una auditoria no alcanza con lo
    // que el navegador dice de si mismo. `user` y `ts` quedan como venian
    // porque la pestaña de auditoria los muestra.
    const evento = { ...ev, registradoPor: req.usuario.nombre, registradoEn: new Date().toISOString() };
    try {
        const total = await enTransaccion(async (c) => {
            const { lista } = await leerColeccion(c, 'auditLog');
            lista.push(evento);
            await escribirColeccion(c, 'auditLog', lista, req.usuario.nombre);
            return lista.length;
        });
        res.json({ ok: true, total });
    } catch (err) {
        next(err);
    }
});


/**
 * GET /api/estabilidad/firmas/:id — las firmas del informe de un estudio.
 *
 * El informe se imprime y se archiva: tiene que llevar la firma de quien
 * analizo y la de quien aprobo (Claudia, 02/11/2026). Hasta ahora salian tres
 * renglones en blanco para firmar a mano.
 *
 * De donde sale cada una:
 * · Analista: el responsable del estudio.
 * · Aprobado por: quien aprobo. Los estudios aprobados antes de hoy no guardan
 *   el nombre -solo la fecha-, asi que se busca en el registro de auditoria,
 *   donde el servidor anota quien hizo cada cosa.
 *
 * El nombre se cruza contra los usuarios con la misma comparacion que el resto
 * de la app, y la firma es la vigente en el momento de la aprobacion. La que no
 * se encuentra se devuelve igual, marcada: en la hoja sale el renglon para
 * firmar a mano en vez de un recuadro vacio sin explicacion.
 */
rutasEstabilidad.get('/firmas/:id', leer, async (req, res, next) => {
    const id = String(req.params.id);
    try {
        const { rows } = await consultar(
            "SELECT clave, valor FROM estabilidad_datos WHERE clave IN ('studies', 'auditLog')"
        );
        const por = {};
        for (const f of rows) {
            try { por[f.clave] = typeof f.valor === 'string' ? JSON.parse(f.valor) : f.valor; }
            catch { por[f.clave] = []; }
        }
        const estudios = Array.isArray(por.studies) ? por.studies : [];
        const s = estudios.find((x) => x && String(x.id) === id);
        if (!s) return res.status(404).json({ error: 'Estudio no encontrado' });

        const aprobado = s.stage === 5 || s.approvedManually === true;
        let quienAprobo = s.aprobadoPor || '';
        let cuandoAprobo = s.aprobadoEn || s.fechaAprobacion || null;
        if (aprobado && !quienAprobo) {
            const log = Array.isArray(por.auditLog) ? por.auditLog : [];
            const ev = log.filter((e) => e && e.tipo === 'aprobacion' && String(e.id) === id).pop();
            if (ev) {
                quienAprobo = ev.registradoPor || ev.user || '';
                cuandoAprobo = ev.registradoEn || ev.ts || cuandoAprobo;
            }
        }

        /* Del nombre escrito en el estudio al usuario, para poder traer su firma.
           Graneles guarda el id del usuario en el registro, asi que ahi la firma
           sale derecho; aca solo hay un nombre escrito a mano, y las firmas son
           las mismas -la tabla `firmas`, por usuario-. Entonces se cruza el
           nombre: igual, despues sin tildes ni signos, y por ultimo sin las
           variantes de escritura que no cambian como suena (k/c, g/j, z/s, v/b,
           y/i, h muda, letras dobles), aceptando solo si encaja uno solo.

           Resuelto el usuario, la firma se pide con el nombre del usuario y no
           con el del estudio: firmaDe exige que coincidan, y quien firma es la
           persona, no como la escribieron en el estudio. */
        const fon = (s) => nombreComparable(s)
            .replace(/ph/g, 'f').replace(/h/g, '')
            .replace(/qu/g, 'c').replace(/k/g, 'c')
            .replace(/g([ei])/g, 'j$1')
            .replace(/z/g, 's').replace(/x/g, 's')
            .replace(/v/g, 'b').replace(/y/g, 'i')
            .replace(/ll/g, 'i')
            .replace(/(.)\1+/g, '$1');
        const { rows: usuarios } = await consultar('SELECT id, nombre FROM usuarios');
        const usuarioDe = (nombre) => {
            const k = nombreComparable(nombre);
            if (!k) return null;
            const exacto = usuarios.find((u) => nombreComparable(u.nombre) === k);
            if (exacto) return exacto;
            const partes = String(nombre).trim().split(/\s+/).map(nombreComparable).filter((x) => x.length > 2);
            if (!partes.length) return null;
            let cands = usuarios.filter((u) => {
                const ku = nombreComparable(u.nombre);
                return partes.every((x) => ku.includes(x));
            });
            const pf = partes.map(fon);
            const fonCands = usuarios.filter((u) => {
                const ku = fon(u.nombre);
                return pf.every((x) => ku.includes(x));
            });
            if (cands.length !== 1) cands = fonCands;
            // Con una sola palabra -"Micaela"- no alcanza con que sea unica tal
            // cual escrita: "Micaela" y "Mikaela" son dos personas distintas que
            // suenan igual, y firmar con el nombre equivocado es peor que dejar
            // el renglon en blanco (Claudia, 02/11/2026).
            if (partes.length === 1 && fonCands.length !== 1) return null;
            return cands.length === 1 ? cands[0] : null;
        };
        const armar = async (rol, nombre, instante) => {
            const limpio = String(nombre || '').trim();
            if (!limpio) return { rol, nombre: '', sinFirma: true, pendiente: true };
            const u = usuarioDe(limpio);
            const f = u ? await firmaDe(u.id, instante, u.nombre) : null;
            return {
                rol, nombre: u ? u.nombre : limpio, firmadoEn: instante || null,
                sinFirma: !f, sinUsuario: !u,
                // Si el estudio lo escribe distinto que el portal, se dice: en la
                // hoja firmada tiene que poder verse de donde salio la firma.
                comoFigura: u && nombreComparable(u.nombre) !== nombreComparable(limpio) ? limpio : '',
                ...(f || {}),
            };
        };

        const firmas = [
            await armar('Analista', s.responsable, s.fechaInicio || cuandoAprobo),
            await armar('Aprobado por · Dirección Técnica', aprobado ? quienAprobo : '', cuandoAprobo),
        ];
        res.json({ ok: true, aprobado, firmas });
    } catch (err) {
        next(err);
    }
});

// ---------------------------------------------------------------------------
// Respaldos
// ---------------------------------------------------------------------------

/** GET /api/estabilidad/respaldos[?clave=productos] — que hay para volver atras. */
rutasEstabilidad.get('/respaldos', leer, async (req, res, next) => {
    const clave = req.query.clave ? String(req.query.clave) : null;
    try {
        const { rows } = await consultar(
            `SELECT id, clave, guardado_en, guardado_por, motivo, length(valor) AS bytes
             FROM estabilidad_respaldos
             WHERE ($1::text IS NULL OR clave = $1)
             ORDER BY id DESC
             LIMIT 300`,
            [clave]
        );
        res.json({ ok: true, respaldos: rows });
    } catch (err) {
        next(err);
    }
});

/** GET /api/estabilidad/respaldos/:id — el contenido de uno. */
rutasEstabilidad.get('/respaldos/:id', leer, async (req, res, next) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'id invalido' });
    try {
        const { rows } = await consultar(
            'SELECT clave, valor, guardado_en, guardado_por, motivo FROM estabilidad_respaldos WHERE id = $1',
            [id]
        );
        if (!rows.length) return res.status(404).json({ error: 'no existe ese respaldo' });
        const f = rows[0];
        res.json({ ok: true, clave: f.clave, guardado_en: f.guardado_en,
            guardado_por: f.guardado_por, motivo: f.motivo, datos: JSON.parse(f.valor) });
    } catch (err) {
        next(err);
    }
});

/** Clave estable de un elemento, aunque alguno haya quedado sin id. */
function claveDe(x, i) {
    if (x?.id) return 'id:' + x.id;
    if (x?.codigo) return 'cod:' + x.codigo;
    if (x?.producto) return 'nom:' + x.producto;
    return 'pos:' + i;
}

function resumen(v) {
    if (Array.isArray(v)) return `(${v.length} elementos)`;
    if (v && typeof v === 'object') return '(objeto)';
    return v == null ? '' : String(v);
}

/**
 * GET /api/estabilidad/comparar?clave=productos[&respaldo=ID]
 *
 * Que cambio entre un respaldo y lo que hay ahora, producto por producto. Sin
 * `respaldo` compara contra la copia de la hoja de Google del corte (07/09), que
 * es el ultimo estado conocido antes de que la app escribiera en Postgres.
 * Solo lectura: sirve para decidir que recuperar, no recupera nada.
 */
rutasEstabilidad.get('/comparar', leer, async (req, res, next) => {
    const clave = String(req.query.clave || 'productos');
    if (!['productos', 'studies'].includes(clave)) {
        return res.status(400).json({ error: 'solo se comparan productos o studies' });
    }
    try {
        const { rows: resp } = req.query.respaldo
            ? await consultar(
                'SELECT id, valor, guardado_en, motivo FROM estabilidad_respaldos WHERE id = $1 AND clave = $2',
                [Number(req.query.respaldo), clave])
            : await consultar(
                `SELECT id, valor, guardado_en, motivo FROM estabilidad_respaldos
                 WHERE clave = $1 AND motivo LIKE 'copia de la replica%'
                 ORDER BY id LIMIT 1`, [clave]);
        if (!resp.length) return res.status(404).json({ error: 'no hay respaldo para comparar' });

        const { rows: act } = await consultar('SELECT valor FROM estabilidad_datos WHERE clave = $1', [clave]);
        const antes = JSON.parse(resp[0].valor) || [];
        const ahora = act.length ? JSON.parse(act[0].valor) || [] : [];

        const mapaAntes = new Map(antes.map((x, i) => [claveDe(x, i), x]));
        const mapaAhora = new Map(ahora.map((x, i) => [claveDe(x, i), x]));
        const nombre = (x) => x?.producto ? `${x.producto}${x.lote ? ' · lote ' + x.lote : ''}` : '';

        const faltan = [], nuevos = [], cambiados = [];
        for (const [k, a] of mapaAntes) {
            const n = mapaAhora.get(k);
            if (!n) { faltan.push({ clave: k, nombre: nombre(a) }); continue; }
            const cambios = [];
            for (const campo of new Set([...Object.keys(a || {}), ...Object.keys(n || {})])) {
                const va = resumen(a?.[campo]), vn = resumen(n?.[campo]);
                if (va !== vn) cambios.push({ campo, antes: va, ahora: vn });
            }
            if (cambios.length) cambiados.push({ clave: k, nombre: nombre(n) || nombre(a), cambios });
        }
        for (const [k, n] of mapaAhora) if (!mapaAntes.has(k)) nuevos.push({ clave: k, nombre: nombre(n) });

        res.json({
            ok: true,
            respaldo: { id: resp[0].id, guardado_en: resp[0].guardado_en, motivo: resp[0].motivo },
            cantidades: { antes: antes.length, ahora: ahora.length },
            faltan, nuevos, cambiados,
        });
    } catch (err) {
        next(err);
    }
});

// ---------------------------------------------------------------------------
// Avisos disparados por la app
// ---------------------------------------------------------------------------

function esc(s) {
    return String(s ?? '').replace(/[&<>"]/g, (c) =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function enlace(id, texto) {
    return `<a href="${BASE}/estabilidad.html#study=${encodeURIComponent(id)}" ` +
        `style="display:inline-block;margin:12px 0;padding:10px 20px;background:#0E6B67;` +
        `color:#fff;text-decoration:none;border-radius:6px;font-weight:bold">` +
        `${texto || 'Abrir estudio →'}</a>`;
}

const PIE = '<p style="color:#5B6B6E;font-size:12px">Programa de Estabilidad — LCC / Vessena S.A.</p></div>';

function cuerpoAsignacion(s) {
    const cps = (s.checkpoints || []).map((cp) =>
        `<li><strong>${esc(cp.codigo)}</strong> (Mes ${esc(cp.mes)}) — ${esc(cp.fechaProgramada)}</li>`).join('');
    const spec = (s.specParams || []).map((p) => `<li>${esc(p.p)}: ${esc(p.e)}</li>`).join('');
    const fila = (k, v) =>
        `<tr><td style="padding:4px 12px 4px 0;color:#5B6B6E">${k}</td><td>${v}</td></tr>`;

    return `<div style="font-family:Arial,sans-serif;max-width:600px">` +
        `<h2 style="color:#0A4F4C">Nueva asignación: Estudio de Estabilidad</h2>` +
        `<p>Se te asignó el siguiente estudio:</p>` +
        `<table style="border-collapse:collapse;font-size:14px;margin:10px 0">` +
        fila('Producto', `<strong>${esc(s.producto)}</strong>`) +
        fila('Lote', `<strong>${esc(s.lote)}</strong>`) +
        fila('Tipo', esc(s.tipoEstudio)) +
        fila('Inicio', esc(s.fechaInicio)) +
        fila('Creado por', esc(s.responsable || '—')) +
        `</table>` +
        `<h3 style="color:#0A4F4C">Especificación</h3><ul>${spec || '<li>Ver en la plataforma</li>'}</ul>` +
        `<h3 style="color:#0A4F4C">Cronograma de muestreo</h3><ul>${cps}</ul>` +
        enlace(s.id) + PIE;
}

function cuerpoAprobado(s) {
    return `<div style="font-family:Arial;max-width:600px">` +
        `<h2 style="color:#357A55">✓ Estudio APROBADO</h2>` +
        `<p>Producto: <strong>${esc(s.producto)}</strong> — Lote: <strong>${esc(s.lote)}</strong></p>` +
        `<p>El estudio fue aprobado por Dirección Técnica el ${esc(s.fechaAprobacion)}.</p>` +
        enlace(s.id) + PIE;
}

function cuerpoRechazado(s, motivo) {
    return `<div style="font-family:Arial;max-width:600px">` +
        `<h2 style="color:#B03A2E">✗ Estudio RECHAZADO</h2>` +
        `<p>Producto: <strong>${esc(s.producto)}</strong> — Lote: <strong>${esc(s.lote)}</strong></p>` +
        `<p><strong>Motivo:</strong> ${esc(motivo)}</p>` +
        `<p>Corregir y volver a enviar el informe.</p>` +
        enlace(s.id, 'Ver estudio rechazado →') + PIE;
}

/** Busca el estudio en nuestros propios datos: el cliente solo manda el id. */
async function estudio(id) {
    const { rows } = await consultar(
        `SELECT valor FROM estabilidad_datos WHERE clave = 'studies'`
    );
    if (!rows.length) return null;
    let lista;
    try { lista = JSON.parse(rows[0].valor); } catch { return null; }
    return (Array.isArray(lista) ? lista : []).find((s) => String(s?.id) === String(id)) || null;
}

/**
 * POST /api/estabilidad/aviso  { tipo, estudioId, motivo?, nuevo? }
 *
 * tipo: 'asignacion' | 'aprobado' | 'rechazado'
 *
 * El cliente no elige destinatarios ni texto: manda que paso y sobre que
 * estudio. Es la diferencia con el endpoint que reemplaza.
 */
rutasEstabilidad.post('/aviso', escribir, async (req, res, next) => {
    const { tipo, estudioId, motivo, nuevo } = req.body || {};

    if (!['asignacion', 'aprobado', 'rechazado'].includes(tipo)) {
        return res.status(400).json({ error: 'tipo de aviso desconocido' });
    }
    if (!estudioId) return res.status(400).json({ error: 'falta estudioId' });
    if (!hayCorreo) return res.status(503).json({ error: 'el correo no esta configurado' });

    try {
        const s = await estudio(estudioId);
        if (!s) return res.status(404).json({ error: 'no se encontro el estudio' });

        const supervision = await supervisoresDe(RECURSO, tipo);
        let para, asunto, html;

        if (tipo === 'asignacion') {
            para = unir(s.emailAnalista, supervision);
            asunto = nuevo
                ? `Asignación: ${s.producto} (${s.tipoEstudio}, Lote ${s.lote})`
                : `Asignación: ${s.producto} (Lote ${s.lote})`;
            html = cuerpoAsignacion(s);
        } else if (tipo === 'aprobado') {
            para = unir(s.emailAnalista, supervision);
            asunto = `✓ APROBADO: ${s.producto} (Lote ${s.lote})`;
            html = cuerpoAprobado(s);
        } else {
            // El rechazo va al analista y a quien creo el estudio. En el Apps
            // Script eran dos envios con el mismo texto; aca es uno solo con los
            // dos destinatarios, sin repetir si son la misma persona.
            para = unir([s.emailAnalista, s.emailCreador].filter(Boolean).join(','), supervision);
            asunto = `✗ RECHAZADO: ${s.producto} (Lote ${s.lote})`;
            html = cuerpoRechazado(s, motivo || 'sin motivo indicado');
        }

        if (!para.length) return res.json({ ok: true, enviado: false, motivo: 'sin destinatarios' });

        const r = await enviar({ para, asunto: PREFIJO + asunto, html, texto: asunto });
        res.json({ ok: true, enviado: true, para, ...r });
    } catch (err) {
        console.error('[estabilidad] aviso fallo:', err.message);
        next(err);
    }
});

/** GET /api/estabilidad/estado — que hay guardado y de cuando. */
rutasEstabilidad.get('/estado', leer, async (_req, res, next) => {
    try {
        const { rows } = await consultar(
            `SELECT clave, length(valor) AS bytes, actualizado_en, actualizado_por
             FROM estabilidad_datos ORDER BY clave`
        );
        res.json({ claves: rows });
    } catch (err) {
        next(err);
    }
});
