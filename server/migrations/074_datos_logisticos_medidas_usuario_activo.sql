-- ============================================================================
-- Datos Logisticos: el pedido de medidas, al usuario activo de Gloria
-- ============================================================================
--
-- Claudia probo el boton (05/11/2026) y dio "no hay a quien pedirle las
-- medidas cargado". Gloria y Antonella tienen un usuario por cada sistema del
-- que vinieron (usuarios es unica por origen y usuario), y las 071 a 073
-- cambiaban la fila por "un" usuario con ese correo, sin mirar cual: quedo
-- uno inactivo, y los avisos solo van a usuarios activos.
--
-- Las filas que habia se apartan con otro nombre de aviso (un DELETE se frena
-- en el deploy) y se carga una sola: el usuario activo de Gloria, el del
-- portal si hay. Mientras dure la prueba le llega a ella; para volver a
-- Antonella va otra migracion igual a esta con su correo.

UPDATE notificacion_supervisores
   SET notificacion = 'medidas-hasta-074'
 WHERE recurso = 'datos-logisticos' AND notificacion = 'medidas';

INSERT INTO notificacion_supervisores (recurso, notificacion, usuario_id, nota)
SELECT 'datos-logisticos', 'medidas', u.id, 'prueba del 05/11/2026: en lugar de Antonella'
FROM usuarios u
WHERE lower(u.usuario) = 'gloria.nunez@vessena.com.uy' AND u.activo
ORDER BY (u.origen = 'vessena') DESC, u.id
LIMIT 1
ON CONFLICT (recurso, notificacion, usuario_id) DO NOTHING;
