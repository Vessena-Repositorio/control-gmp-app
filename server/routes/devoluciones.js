import { Router } from 'express';
import { consultar, enTransaccion } from '../db.js';
import { exigirPermiso } from '../lib/acceso.js';
import { auditar } from '../lib/sesiones.js';

export const rutasDevoluciones = Router();

// Primer dominio donde Postgres es la fuente de verdad: la app escribe aca y ya
// no en Sheets. Las respuestas conservan la forma que devolvia Apps Script
// ({ok:true, ...}) para que el cambio en la app sea solo la URL.

const leer = exigirPermiso('devoluciones', 'ver');
const escribir = exigirPermiso('devoluciones', 'cargar');

/** Clave de mes tal como la arma la app para indexar los snapshots. */
const claveMes = (mes, anio) => `${mes}_${anio}`;

function validarMes(mes, anio) {
    if (!mes || typeof mes !== 'string') return 'falta el mes';
    const n = Number(anio);
    // Rango amplio a proposito: acota lo absurdo sin discutirle al usuario que
    // año puede analizar.
    if (!Number.isInteger(n) || n < 2000 || n > 2100) return 'el año no es valido';
    return null;
}

// --- Lecturas --------------------------------------------------------------

rutasDevoluciones.get('/', leer, async (req, res, next) => {
    const accion = req.query.action;

    try {
        switch (accion) {
            case 'listMeses': {
                const { rows } = await consultar(
                    `SELECT mes, anio, fecha, total_dev AS "totalDev", total_rot AS "totalRot",
                            tasa_global AS "tasaGlobal", persona
                     FROM dev_meses ORDER BY anio DESC, mes`
                );
                return res.json({ ok: true, meses: rows });
            }

            case 'getAllSnapshots': {
                const { rows } = await consultar(
                    'SELECT mes, anio, raw FROM dev_snapshots ORDER BY anio DESC, mes'
                );
                // La app espera un objeto indexado por MES_ANIO, no una lista.
                const snapshots = {};
                for (const f of rows) snapshots[claveMes(f.mes, f.anio)] = f.raw;
                return res.json({ ok: true, snapshots });
            }

            case 'getMotivos': {
                const { rows } = await consultar(
                    'SELECT motivos FROM dev_motivos WHERE mes = $1 AND anio = $2',
                    [req.query.mes, Number(req.query.anio)]
                );
                return res.json({ ok: true, motivos: rows[0]?.motivos ?? {} });
            }

            case 'getPersonas': {
                const { rows } = await consultar(
                    `SELECT nombre, creada, ultimo_ingreso AS "ultimoIngreso"
                     FROM dev_personas ORDER BY nombre`
                );
                return res.json({ ok: true, personas: rows });
            }

            case 'getActividad': {
                const { rows } = await consultar(
                    `SELECT ts, persona, accion, mes, anio, detalle
                     FROM dev_actividad ORDER BY ts DESC LIMIT 200`
                );
                return res.json({ ok: true, actividad: rows });
            }

            default:
                return res.status(400).json({ ok: false, error: `accion no soportada: ${accion}` });
        }
    } catch (err) {
        next(err);
    }
});

// --- Escrituras ------------------------------------------------------------

rutasDevoluciones.post('/', escribir, async (req, res, next) => {
    const { action, mes, anio } = req.body || {};

    // La persona sale de la sesion, NO de lo que mande el navegador. Antes el
    // cliente elegia el nombre y podia poner cualquiera: con la firma como
    // parte del registro, eso no puede depender de lo que diga el cliente.
    const persona = req.usuario.nombre;

    try {
        switch (action) {
            case 'saveMes': {
                const err = validarMes(mes, anio);
                if (err) return res.status(400).json({ ok: false, error: err });

                const d = req.body.data || {};
                await enTransaccion(async (c) => {
                    await c.query(
                        `INSERT INTO dev_mes_datos (mes, anio, datos, persona)
                         VALUES ($1,$2,$3,$4)
                         ON CONFLICT (mes, anio) DO UPDATE SET
                            datos = EXCLUDED.datos, persona = EXCLUDED.persona,
                            actualizado_en = now()`,
                        [mes, Number(anio), JSON.stringify(d), persona]
                    );
                    await c.query(
                        `INSERT INTO dev_meses (mes, anio, fecha, total_dev, total_rot,
                                                tasa_global, persona)
                         VALUES ($1,$2, now(), $3,$4,$5,$6)
                         ON CONFLICT (mes, anio) DO UPDATE SET
                            fecha = now(), total_dev = EXCLUDED.total_dev,
                            total_rot = EXCLUDED.total_rot, tasa_global = EXCLUDED.tasa_global,
                            persona = EXCLUDED.persona, actualizado_en = now()`,
                        [mes, Number(anio), d.totalDev ?? null, d.totalRot ?? null,
                         d.tasaGlobal ?? null, persona]
                    );
                });

                await auditar(req, {
                    usuarioId: req.usuario.id, usuarioTxt: req.usuario.usuario,
                    accion: 'devoluciones_guardar_mes', recurso: 'devoluciones',
                    detalle: claveMes(mes, anio),
                });
                return res.json({ ok: true });
            }

            case 'saveSnapshot': {
                const err = validarMes(mes, anio);
                if (err) return res.status(400).json({ ok: false, error: err });

                const s = req.body.snapshot;
                if (!s || typeof s !== 'object') {
                    return res.status(400).json({ ok: false, error: 'falta el snapshot' });
                }

                await consultar(
                    `INSERT INTO dev_snapshots (
                        mes, anio, fecha_analisis, umbral, corte, total_dev, total_rot,
                        sku_con_dev, sku_con_rot, suma_prom, tasa_global,
                        criticos_dev, criticos_rot, unids_crit_dev, unids_crit_rot,
                        detalle, raw, persona)
                     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
                     ON CONFLICT (mes, anio) DO UPDATE SET
                        fecha_analisis = EXCLUDED.fecha_analisis, umbral = EXCLUDED.umbral,
                        corte = EXCLUDED.corte, total_dev = EXCLUDED.total_dev,
                        total_rot = EXCLUDED.total_rot, sku_con_dev = EXCLUDED.sku_con_dev,
                        sku_con_rot = EXCLUDED.sku_con_rot, suma_prom = EXCLUDED.suma_prom,
                        tasa_global = EXCLUDED.tasa_global, criticos_dev = EXCLUDED.criticos_dev,
                        criticos_rot = EXCLUDED.criticos_rot,
                        unids_crit_dev = EXCLUDED.unids_crit_dev,
                        unids_crit_rot = EXCLUDED.unids_crit_rot,
                        detalle = EXCLUDED.detalle, raw = EXCLUDED.raw,
                        persona = EXCLUDED.persona, actualizado_en = now()`,
                    [
                        mes, Number(anio),
                        s.fechaAnalisis ?? null, s.umbral ?? null, s.corte ?? null,
                        s.totalDev ?? null, s.totalRot ?? null,
                        s.skuConDev ?? null, s.skuConRot ?? null,
                        s.sumaProm ?? null, s.tasaGlobal ?? null,
                        s.criticosDev ?? null, s.criticosRot ?? null,
                        s.unidsCritDev ?? null, s.unidsCritRot ?? null,
                        JSON.stringify({
                            topCatDev: s.topCatDev ?? null,
                            topCatRot: s.topCatRot ?? null,
                            criticos: s.criticos ?? null,
                            motivosResumen: s.motivosResumen ?? null,
                        }),
                        JSON.stringify(s),
                        persona,
                    ]
                );

                await auditar(req, {
                    usuarioId: req.usuario.id, usuarioTxt: req.usuario.usuario,
                    accion: 'devoluciones_guardar_snapshot', recurso: 'devoluciones',
                    detalle: claveMes(mes, anio),
                });
                return res.json({ ok: true });
            }

            case 'saveMotivos': {
                const err = validarMes(mes, anio);
                if (err) return res.status(400).json({ ok: false, error: err });

                await consultar(
                    `INSERT INTO dev_motivos (mes, anio, motivos, persona)
                     VALUES ($1,$2,$3,$4)
                     ON CONFLICT (mes, anio) DO UPDATE SET
                        motivos = EXCLUDED.motivos, persona = EXCLUDED.persona,
                        actualizado_en = now()`,
                    [mes, Number(anio), JSON.stringify(req.body.motivos ?? {}), persona]
                );
                return res.json({ ok: true });
            }

            case 'logActividad': {
                await consultar(
                    `INSERT INTO dev_actividad (persona, accion, mes, anio, detalle)
                     VALUES ($1,$2,$3,$4,$5)`,
                    [persona, req.body.accion ?? null, mes || null,
                     anio ? Number(anio) : null, req.body.detalle ?? null]
                );
                return res.json({ ok: true });
            }

            case 'addPersona':
            case 'updateIngreso': {
                // Las dos hacen lo mismo ahora: registrar que esta persona uso
                // la app. El alta ya no la decide el cliente, porque quien
                // puede entrar lo define el padron de usuarios.
                await consultar(
                    `INSERT INTO dev_personas (nombre, ultimo_ingreso)
                     VALUES ($1, now())
                     ON CONFLICT (nombre) DO UPDATE SET ultimo_ingreso = now()`,
                    [persona]
                );
                return res.json({ ok: true, persona });
            }

            default:
                return res.status(400).json({ ok: false, error: `accion no soportada: ${action}` });
        }
    } catch (err) {
        console.error('[devoluciones]', action, '->', err.message);
        next(err);
    }
});
