-- ============================================================================
-- Datos Logisticos: el pedido de medidas vuelve a Antonella
-- ============================================================================
--
-- Deshace la migracion 071, que lo habia pasado a Gloria para que Claudia
-- probara el boton (05/11/2026). Mismo cambio, al reves.

UPDATE notificacion_supervisores s
   SET usuario_id = a.id,
       nota = 'completa medidas y pesos'
  FROM usuarios a, usuarios g
 WHERE s.recurso = 'datos-logisticos'
   AND s.notificacion = 'medidas'
   AND s.usuario_id = g.id
   AND lower(g.usuario) = 'gloria.nunez@vessena.com.uy'
   AND lower(a.usuario) = 'antonella.nunez@vessena.com.uy';
