-- ============================================================================
-- Quien recibe el aviso de analisis pendientes de aprobacion
-- ============================================================================
--
-- Los controles semanales y quincenales que completa una analista quedan en
-- estado 'pendiente' esperando aprobacion, y hasta ahora nadie se enteraba: la
-- app no manda ningun correo. El pendiente se descubria mirando la pantalla.
--
-- Antonella figura como `operador` en control-calidad-envases, que es lo que
-- efectivamente hace ahi dentro, y sin embargo es quien aprueba. Igual que en
-- estabilidad: aprobar es una responsabilidad del proceso, no un nivel de
-- permiso, asi que el destinatario se declara y no se deduce del rol.

INSERT INTO notificacion_supervisores (recurso, notificacion, usuario_id, nota)
SELECT r.recurso, r.notificacion, u.id, r.nota
FROM (VALUES
    ('control-calidad-envases', 'pendientes-aprobacion',
     'antonella.nunez@vessena.com.uy', 'aprueba los analisis semanales y quincenales')
) AS r(recurso, notificacion, email, nota)
JOIN usuarios u ON lower(u.usuario) = lower(r.email)
ON CONFLICT (recurso, notificacion, usuario_id) DO NOTHING;
