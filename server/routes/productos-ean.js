/**
 * Codigo de producto -> EAN 14 de la caja (migracion 048).
 *
 * Lo consultan Control en proceso y Fabuloso para mostrarle a la analista el
 * codigo que tiene que ver en la caja, y a quien aprueba para revisarlo. Es
 * una tabla chica -419 productos- asi que la pantalla la baja entera una vez
 * y la cruza en memoria; no hace falta pedir de a uno.
 *
 * Alcanza con tener sesion: no dice nada mas que lo que ya esta impreso en la
 * caja del producto.
 */
import { Router } from 'express';
import { consultar } from '../db.js';

export const rutasProductosEan = Router();

rutasProductosEan.get('/', async (req, res, next) => {
    if (!req.usuario) return res.status(401).json({ ok: false, error: 'sesión requerida' });
    try {
        const codigo = String(req.query.codigo || '').trim();
        if (codigo) {
            const { rows } = await consultar(
                'SELECT codigo, nombre, ean14, unidad FROM producto_ean WHERE codigo = $1', [codigo]
            );
            return res.json({ ok: true, producto: rows[0] || null });
        }
        const { rows } = await consultar(
            'SELECT codigo, nombre, ean14, unidad FROM producto_ean ORDER BY codigo'
        );
        // Indexado por codigo: es como lo usan las dos pantallas.
        const porCodigo = {};
        for (const f of rows) porCodigo[f.codigo] = { ean14: f.ean14, unidad: f.unidad, nombre: f.nombre };
        res.json({ ok: true, cantidad: rows.length, productos: porCodigo });
    } catch (err) {
        next(err);
    }
});
