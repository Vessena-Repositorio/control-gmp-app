/**
 * Capacitaciones — lectura y escritura.
 *
 * Reemplaza al Apps Script. Se conserva su contrato: la app lee las cuatro
 * colecciones de una y las vuelve a escribir enteras, asi que el cambio del
 * lado del cliente es cambiar la URL y poco mas.
 *
 * Dos diferencias que NO son cosmeticas:
 *
 *   - El `saveAll` del Apps Script no pedia autenticacion: cualquiera con la URL
 *     podia reemplazar los 3.130 registros de capacitacion de la planta. Aca
 *     hace falta sesion y permiso de carga sobre el recurso.
 *
 *   - Cada escritura declara sobre que version se hizo. El guardado completo no
 *     puede distinguir "borre esto a proposito" de "me quede sin datos y estoy
 *     mandando lo que tengo", y eso ultimo paso de verdad el 09/09/2026: la app
 *     se quedo sin localStorage, cayo a sus 172 registros de demostracion y los
 *     escribio encima de los 3.130 reales, en silencio. Con version, quien
 *     guarda sobre una lectura vieja recibe un 409 y tiene que volver a leer.
 */
import { Router } from 'express';
import { consultar, enTransaccion } from '../db.js';
import { exigirPermiso } from '../lib/acceso.js';
import { enviarRecordatorioManual } from '../lib/avisos-capacitaciones.js';

export const rutasCapacitaciones = Router();

const RECURSO = 'capacitaciones';
const leer = exigirPermiso(RECURSO, 'ver');
const escribir = exigirPermiso(RECURSO, 'cargar');

// Las cuatro colecciones de la app. El almacen es generico, pero aceptar
// cualquier clave lo convertiria en un deposito abierto que crece sin control.
const CLAVES = ['R', 'PL', 'PE', 'AUDIT'];
const ES_CLAVE = new Set(CLAVES);

/**
 * Cuanto puede encoger una coleccion en un solo guardado antes de que se pida
 * confirmacion explicita. Una baja de personal saca una fila; una carga masiva
 * agrega cientos. Perder la mitad de golpe no es una edicion: es un accidente.
 *
 * No bloquea -hay casos legitimos, como limpiar un plan viejo- pero obliga a
 * decir `confirmarBorrado: true`, o sea a que alguien lo haya querido.
 */
const CAIDA_SOSPECHOSA = 0.5;
const MINIMO_PARA_MIRAR = 20;   // debajo de esto, cualquier variacion es normal

/** GET /api/capacitaciones/datos — las cuatro colecciones y su version. */
rutasCapacitaciones.get('/datos', leer, async (_req, res, next) => {
    try {
        const { rows } = await consultar(
            'SELECT clave, valor, version FROM capacitaciones_datos'
        );
        const salida = {};
        const versiones = {};
        for (const f of rows) {
            try {
                salida[f.clave] = JSON.parse(f.valor);
            } catch {
                // Una coleccion ilegible no puede tumbar la lectura de las otras
                // tres: se devuelve vacia y se dice cual fallo, en vez de que la
                // app reciba un error suelto y no sepa que le falta.
                salida[f.clave] = [];
                salida._ilegibles = (salida._ilegibles || []).concat(f.clave);
            }
            versiones[f.clave] = Number(f.version);
        }
        for (const k of CLAVES) if (!(k in salida)) { salida[k] = []; versiones[k] = 0; }
        res.json({ ok: true, ...salida, _versiones: versiones });
    } catch (err) {
        next(err);
    }
});

/**
 * POST /api/capacitaciones/datos
 *   { R, PL, PE, AUDIT, versiones: {R: n, ...}, confirmarBorrado?: true }
 *
 * Se mandan las colecciones que cambiaron; las que no vengan no se tocan.
 */
rutasCapacitaciones.post('/datos', escribir, async (req, res, next) => {
    const cuerpo = req.body || {};
    const versiones = cuerpo.versiones || {};
    const confirmar = cuerpo.confirmarBorrado === true;

    const aGuardar = CLAVES.filter((k) => Array.isArray(cuerpo[k]));
    if (!aGuardar.length) {
        return res.status(400).json({
            error: 'no vino ninguna coleccion (R, PL, PE, AUDIT) como arreglo',
        });
    }

    try {
        const resultado = await enTransaccion(async (c) => {
            // Un solo lock para las cuatro: se guardan juntas y tienen que
            // quedar consistentes entre si. Con un lock por clave, dos guardados
            // simultaneos podrian entrelazarse y dejar R de uno con PE del otro.
            await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['capacitaciones']);

            const { rows } = await c.query(
                'SELECT clave, valor, version FROM capacitaciones_datos WHERE clave = ANY($1)',
                [aGuardar]
            );
            const actual = new Map(rows.map((f) => [f.clave, f]));

            // --- 1) ¿alguien escribio en el medio? --------------------------
            const desfasadas = [];
            for (const k of aGuardar) {
                const enBase = actual.get(k);
                const tiene = enBase ? Number(enBase.version) : 0;
                const dice = Number(versiones[k]);
                // Sin version declarada no se acepta: es la forma que tenia el
                // Apps Script de escribir, y es justamente la que queremos que
                // deje de existir.
                if (!Number.isFinite(dice)) {
                    desfasadas.push({ clave: k, motivo: 'no declaro version', version: tiene });
                } else if (dice !== tiene) {
                    desfasadas.push({ clave: k, motivo: 'otra persona guardo despues', version: tiene, declarada: dice });
                }
            }
            if (desfasadas.length) {
                return { conflicto: true, desfasadas };
            }

            // --- 2) ¿se esta perdiendo la mitad de algo? --------------------
            const encogen = [];
            if (!confirmar) {
                for (const k of aGuardar) {
                    const enBase = actual.get(k);
                    if (!enBase) continue;
                    let antes;
                    try { antes = JSON.parse(enBase.valor); } catch { continue; }
                    if (!Array.isArray(antes) || antes.length < MINIMO_PARA_MIRAR) continue;
                    const ahora = cuerpo[k].length;
                    if (ahora < antes.length * CAIDA_SOSPECHOSA) {
                        encogen.push({ clave: k, antes: antes.length, ahora });
                    }
                }
            }
            if (encogen.length) {
                return { encogen: true, colecciones: encogen };
            }

            // --- 3) respaldo y escritura -----------------------------------
            const guardadas = {};
            for (const k of aGuardar) {
                const enBase = actual.get(k);
                if (enBase) {
                    await c.query(
                        `INSERT INTO capacitaciones_respaldos (clave, valor, version, guardado_por, motivo)
                         VALUES ($1, $2, $3, $4, $5)`,
                        [k, enBase.valor, enBase.version, req.usuario.nombre,
                         confirmar ? 'antes de un guardado confirmado' : 'antes de guardar']
                    );
                }
                const texto = JSON.stringify(cuerpo[k]);
                const { rows: r2 } = await c.query(
                    `INSERT INTO capacitaciones_datos (clave, valor, version, actualizado_por)
                     VALUES ($1, $2, 1, $3)
                     ON CONFLICT (clave) DO UPDATE
                        SET valor = EXCLUDED.valor,
                            version = capacitaciones_datos.version + 1,
                            actualizado_en = now(),
                            actualizado_por = EXCLUDED.actualizado_por
                     RETURNING version`,
                    [k, texto, req.usuario.nombre]
                );
                guardadas[k] = { version: Number(r2[0].version), filas: cuerpo[k].length };
            }
            return { ok: true, guardadas };
        });

        if (resultado.conflicto) {
            // 409 y no 400: no esta mal formado, esta desactualizado. La app
            // tiene que releer y reintentar, no corregir lo que mando.
            return res.status(409).json({
                error: 'la version cambio desde que leiste',
                desfasadas: resultado.desfasadas,
                queHacer: 'volve a leer /api/capacitaciones/datos y aplica tus cambios sobre eso',
            });
        }
        if (resultado.encogen) {
            return res.status(409).json({
                error: 'el guardado borraria mas de la mitad de una coleccion',
                colecciones: resultado.colecciones,
                queHacer: 'si es a proposito, repeti el guardado con confirmarBorrado: true',
            });
        }
        res.json(resultado);
    } catch (err) {
        next(err);
    }
});


/**
 * POST /api/capacitaciones/resembrar  { forzar?: true }
 *
 * Vuelve a armar las colecciones desde lo que la replica trajo de la hoja.
 *
 * La siembra inicial corre una sola vez, en la migracion. Si despues se corrige
 * algo en la hoja -por ejemplo dos registros que compartian id y por eso la
 * replica guardaba uno solo- ese arreglo no llega solo a la tabla nueva. Sin
 * esta ruta habria que esperar al corte y confiar en que la primera escritura
 * de la app lo tape, que es exactamente la clase de "se arregla despues" que ya
 * nos costo caro.
 *
 * Se niega si alguna coleccion fue escrita por la app: a partir de ahi Postgres
 * es la fuente de verdad y la hoja quedo congelada, asi que resembrar seria
 * volver atras y perder lo cargado desde el corte. `forzar: true` lo permite
 * igual, pero deja respaldo de lo que pisa.
 */
rutasCapacitaciones.post('/resembrar', escribir, async (req, res, next) => {
    const forzar = (req.body || {}).forzar === true;
    const MARCAS_DE_SIEMBRA = ['siembra desde la replica', 'coleccion vacia al sembrar', 'resembrado desde la replica'];

    try {
        const resultado = await enTransaccion(async (c) => {
            await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['capacitaciones']);

            const { rows: actuales } = await c.query(
                'SELECT clave, valor, version, actualizado_por FROM capacitaciones_datos'
            );
            const tocadas = actuales
                .filter((f) => !MARCAS_DE_SIEMBRA.includes(String(f.actualizado_por || '')))
                .map((f) => f.clave);

            if (tocadas.length && !forzar) {
                return { yaEscritas: tocadas };
            }

            // Lo que la replica tiene hoy, rearmado en el arreglo que espera la
            // app. `pos` conserva el orden original de la hoja.
            const { rows: desdeReplica } = await c.query(
                `SELECT coleccion, json_agg(raw ORDER BY pos NULLS LAST, id)::text AS valor
                 FROM documentos
                 WHERE dominio = 'capacitaciones'
                 GROUP BY coleccion`
            );
            if (!desdeReplica.length) {
                return { sinReplica: true };
            }

            const previas = new Map(actuales.map((f) => [f.clave, f]));
            const cambios = {};
            for (const f of desdeReplica) {
                if (!ES_CLAVE.has(f.coleccion)) continue;
                const antes = previas.get(f.coleccion);
                if (antes) {
                    await c.query(
                        `INSERT INTO capacitaciones_respaldos (clave, valor, version, guardado_por, motivo)
                         VALUES ($1, $2, $3, $4, $5)`,
                        [f.coleccion, antes.valor, antes.version, req.usuario.nombre, 'antes de resembrar']
                    );
                }
                const { rows: r2 } = await c.query(
                    `INSERT INTO capacitaciones_datos (clave, valor, version, actualizado_por)
                     VALUES ($1, $2, 1, 'resembrado desde la replica')
                     ON CONFLICT (clave) DO UPDATE
                        SET valor = EXCLUDED.valor,
                            version = capacitaciones_datos.version + 1,
                            actualizado_en = now(),
                            actualizado_por = EXCLUDED.actualizado_por
                     RETURNING version`,
                    [f.coleccion, f.valor]
                );
                let cuantos = null;
                try { cuantos = JSON.parse(f.valor).length; } catch { /* se informa null */ }
                let antesCuantos = null;
                if (antes) { try { antesCuantos = JSON.parse(antes.valor).length; } catch { /* idem */ } }
                cambios[f.coleccion] = { antes: antesCuantos, ahora: cuantos, version: Number(r2[0].version) };
            }
            return { ok: true, cambios };
        });

        if (resultado.yaEscritas) {
            return res.status(409).json({
                error: 'estas colecciones ya se escribieron desde la app',
                colecciones: resultado.yaEscritas,
                queHacer: 'despues del corte la hoja quedo congelada: resembrar volveria atras. Si aun asi hace falta, mandá forzar: true',
            });
        }
        if (resultado.sinReplica) {
            return res.status(409).json({ error: 'la replica no tiene datos de capacitaciones' });
        }
        res.json(resultado);
    } catch (err) {
        next(err);
    }
});
/**
 * GET /api/capacitaciones/respaldos — que hay para volver atras.
 *
 * Solo la lista, sin el contenido: son cuatro colecciones enteras y devolverlas
 * todas juntas seria varios megabytes para contestar "¿que respaldos hay?".
 */
rutasCapacitaciones.get('/respaldos', leer, async (req, res, next) => {
    try {
        const clave = String(req.query.clave || '');
        const { rows } = await consultar(
            `SELECT id, clave, version, guardado_en, guardado_por, motivo,
                    length(valor) AS bytes
             FROM capacitaciones_respaldos
             WHERE ($1 = '' OR clave = $1)
             ORDER BY guardado_en DESC
             LIMIT 50`,
            [clave]
        );
        res.json({ ok: true, respaldos: rows });
    } catch (err) {
        next(err);
    }
});

/** GET /api/capacitaciones/respaldos/:id — el contenido de uno. */
rutasCapacitaciones.get('/respaldos/:id', leer, async (req, res, next) => {
    try {
        const { rows } = await consultar(
            'SELECT clave, valor, version, guardado_en, guardado_por FROM capacitaciones_respaldos WHERE id = $1',
            [Number(req.params.id)]
        );
        if (!rows.length) return res.status(404).json({ error: 'no existe ese respaldo' });
        const f = rows[0];
        let datos;
        try { datos = JSON.parse(f.valor); } catch { datos = null; }
        res.json({ ok: true, clave: f.clave, version: Number(f.version),
                   guardado_en: f.guardado_en, guardado_por: f.guardado_por, datos });
    } catch (err) {
        next(err);
    }
});

/**
 * POST /api/capacitaciones/recordatorio/:id — manda el recordatorio de una
 * partida a su responsable, a pedido de una persona.
 *
 * Hace falta permiso de carga. El destinatario lo decide el servidor con lo que
 * hay guardado en el plan: del pedido solo se toma el id.
 */
rutasCapacitaciones.post('/recordatorio/:id', escribir, async (req, res, next) => {
    try {
        const r = await enviarRecordatorioManual(req.params.id);
        if (!r.ok) return res.status(400).json(r);
        res.json(r);
    } catch (err) {
        next(err);
    }
});
