-- ============================================================================
-- Datos Logisticos: entran Mónica y Melani
-- ============================================================================
--
-- Pedido de Claudia (13/11/2026): Mónica y Melani tienen que tener acceso a
-- Datos Logisticos. Hasta ahora la app la tenian calidad (Claudia y Gloria
-- administran, Antonella aprueba) y logistica y ventas como vista.
--
-- Entran como `operador`, que es el rol que ya tienen en control en proceso,
-- envases, estabilidad, graneles y SAO-001: ven y cargan. Pueden completar lo
-- que figura pendiente en la ficha -- las medidas, los pesos, las unidades por
-- caja -- y marcar "no aplica", que es trabajo de laboratorio porque hay que
-- medir y pesar el envase. Lo que no pueden es aprobar: la ficha sigue yendo a
-- Antonella o a Claudia, y recien al aprobarse sale a Finanzas.
--
-- Mónica entra con la casilla del laboratorio y Melani con la del minilab (ver
-- la 010 y la 033). El portal ya lo tienen desde la 010, no hace falta aca.

INSERT INTO usuario_recursos (usuario_id, recurso, rol)
SELECT u.id, r.recurso, r.rol
FROM (VALUES
    ('laboratorio@vessena.com.uy',      'datos-logisticos', 'operador'),
    ('analista.minilab@vessena.com.uy', 'datos-logisticos', 'operador')
) AS r(usuario, recurso, rol)
JOIN usuarios u ON lower(u.usuario) = r.usuario
ON CONFLICT (usuario_id, recurso) DO UPDATE SET rol = EXCLUDED.rol;
