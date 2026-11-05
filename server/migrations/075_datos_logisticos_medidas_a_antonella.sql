-- ============================================================================
-- Datos Logisticos: el pedido de medidas vuelve a Antonella
-- ============================================================================
--
-- Claudia termino la prueba con Gloria (05/11/2026): "quedo bien". Lo mismo
-- que la 074, al reves: se aparta la fila de Gloria y se carga el usuario
-- activo de Antonella, el del portal si hay.

UPDATE notificacion_supervisores
   SET notificacion = 'medidas-hasta-075'
 WHERE recurso = 'datos-logisticos' AND notificacion = 'medidas';

INSERT INTO notificacion_supervisores (recurso, notificacion, usuario_id, nota)
SELECT 'datos-logisticos', 'medidas', u.id, 'completa medidas y pesos'
FROM usuarios u
WHERE lower(u.usuario) = 'antonella.nunez@vessena.com.uy' AND u.activo
ORDER BY (u.origen = 'vessena') DESC, u.id
LIMIT 1
ON CONFLICT (recurso, notificacion, usuario_id) DO NOTHING;
