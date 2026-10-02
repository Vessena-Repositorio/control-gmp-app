-- ============================================================================
-- No Conformidades / Desvíos: Gloria pasa a administrar
-- ============================================================================
--
-- Pedido de Claudia (02/10/2026): Gloria tiene que poder borrar no
-- conformidades. Borrar exige el permiso `administrar`, que solo trae el rol
-- administrador, y Gloria estaba como operador desde la migracion 013.
--
-- En esta app `administrar` habilita exactamente esto: borrar NC, desvios,
-- CAPA y adjuntos, y la importacion inicial. No da acceso a datos de otras
-- apps: el rol es por recurso.
--
-- El borrado queda en la bitacora con el usuario que lo hizo, como antes.

INSERT INTO usuario_recursos (usuario_id, recurso, rol)
SELECT u.id, 'no-conformidades-desvios', 'administrador'
FROM usuarios u
WHERE lower(u.usuario) = 'gloria.nunez@vessena.com.uy'
ON CONFLICT (usuario_id, recurso) DO UPDATE SET rol = EXCLUDED.rol;
