-- ============================================================================
-- Datos Logisticos: el pedido de medidas le llega a Gloria, para probarlo
-- ============================================================================
--
-- Claudia (05/11/2026) quiere probar el boton "Enviar a Antonella" y Antonella
-- no trabaja hoy. Mientras tanto el aviso 'medidas' (migracion 070) va a
-- Gloria en lugar de Antonella.
--
-- Se cambia la persona y no se borra la fila: un DELETE en una migracion se
-- frena en el deploy. Para volver a Antonella va otra migracion que haga el
-- cambio al reves.

UPDATE notificacion_supervisores s
   SET usuario_id = g.id,
       nota = 'prueba del 05/11/2026: en lugar de Antonella'
  FROM usuarios a, usuarios g
 WHERE s.recurso = 'datos-logisticos'
   AND s.notificacion = 'medidas'
   AND s.usuario_id = a.id
   AND lower(a.usuario) = 'antonella.nunez@vessena.com.uy'
   AND lower(g.usuario) = 'gloria.nunez@vessena.com.uy';
