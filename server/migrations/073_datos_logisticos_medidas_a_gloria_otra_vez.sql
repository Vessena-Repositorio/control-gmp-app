-- ============================================================================
-- Datos Logisticos: el pedido de medidas vuelve a Gloria hasta terminar la prueba
-- ============================================================================
--
-- La 072 lo devolvio a Antonella antes de tiempo: Claudia (05/11/2026) queria
-- volver "cuando termine la prueba". Mismo cambio que la 071. Al terminar va
-- otra migracion al reves, como la 072.

UPDATE notificacion_supervisores s
   SET usuario_id = g.id,
       nota = 'prueba del 05/11/2026: en lugar de Antonella'
  FROM usuarios a, usuarios g
 WHERE s.recurso = 'datos-logisticos'
   AND s.notificacion = 'medidas'
   AND s.usuario_id = a.id
   AND lower(a.usuario) = 'antonella.nunez@vessena.com.uy'
   AND lower(g.usuario) = 'gloria.nunez@vessena.com.uy';
