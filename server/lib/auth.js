/**
 * Middleware para los endpoints que disparan una replica. Solo protege la
 * escritura: la lectura queda abierta, igual que lo estaban los Apps Script
 * que reemplazamos.
 */
export function exigirTokenSync(req, res, next) {
    const esperado = process.env.SYNC_TOKEN;
    if (!esperado) {
        return res.status(503).json({ error: 'SYNC_TOKEN no configurado en el servidor' });
    }
    if (req.get('x-sync-token') !== esperado) {
        return res.status(401).json({ error: 'token invalido' });
    }
    next();
}
