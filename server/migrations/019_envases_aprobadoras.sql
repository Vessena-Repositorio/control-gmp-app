-- ============================================================================
-- Quien aprueba los analisis de control de calidad de envases
-- ============================================================================
--
-- Los controles semanales y quincenales quedan en 'pendiente' esperando
-- aprobacion, pero hasta ahora nadie podia aprobarlos: la app mostraba el
-- estado y no existia la accion. Los tres que hay pendientes llevan entre 10 y
-- 24 dias esperando algo que no se podia hacer.
--
-- Las aprobadoras son Antonella, Gloria y Claudia. Claudia ya es
-- `administrador` en esta app, que incluye 'aprobar'. Las otras dos figuran
-- como `operador`, que es lo que hacen ahi dentro: cargan controles.
--
-- Pasan a `aprobador`, un rol nuevo que agrega 'aprobar' a lo que ya tenian.
-- La alternativa era hacerlas administradoras, y eso les daria tambien
-- 'administrar' y 'ver_crudo' solo para poder apretar un boton.

UPDATE usuario_recursos
   SET rol = 'aprobador'
 WHERE recurso = 'control-calidad-envases'
   AND usuario_id IN (
        SELECT id FROM usuarios
         WHERE lower(usuario) IN (
            'antonella.nunez@vessena.com.uy',
            'gloria.nunez@vessena.com.uy'
         )
   );
