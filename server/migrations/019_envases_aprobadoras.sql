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

-- ---------------------------------------------------------------------------
-- Primero la restriccion, o el UPDATE de abajo no entra
-- ---------------------------------------------------------------------------
-- La lista de roles validos esta en DOS lugares: PERMISOS_POR_ROL en
-- lib/permisos.js -que es la politica- y este CHECK, que es lo que la base
-- acepta. Agregar el rol solo en el codigo hace que la migracion falle contra
-- la restriccion vieja, que es exactamente lo que paso la primera vez.
--
-- Se deja el CHECK igual: es la red que evita que un rol mal escrito entre a la
-- tabla y despues no coincida con ningun permiso, quedando la persona sin
-- acceso sin que nada lo delate.
ALTER TABLE usuario_recursos DROP CONSTRAINT IF EXISTS usuario_recursos_rol_check;
ALTER TABLE usuario_recursos ADD CONSTRAINT usuario_recursos_rol_check
    CHECK (rol IN ('administrador', 'revisor', 'aprobador', 'operador', 'vista'));

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
