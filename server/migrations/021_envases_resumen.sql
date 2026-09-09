-- ============================================================================
-- Quien recibe el resumen de estado (sin la lista para trabajar)
-- ============================================================================
--
-- Son dos necesidades distintas y conviene no mezclarlas:
--
--   `pendientes-aprobacion` -> Antonella. La lista de lo que tiene que aprobar,
--      con dias de espera. Es un correo para actuar.
--   `resumen-aprobaciones`  -> Claudia. Cuantos hay, cual es el mas viejo y que
--      se aprobo. Es un correo para saber como viene, no para hacer.
--
-- Mandarle la lista operativa a quien solo necesita el estado hace que la
-- empiece a hojear, y el dia que si tiene que actuar sobre ella ya la mira
-- distinto.

INSERT INTO notificacion_supervisores (recurso, notificacion, usuario_id, nota)
SELECT r.recurso, r.notificacion, u.id, r.nota
FROM (VALUES
    ('control-calidad-envases', 'resumen-aprobaciones',
     'claudia.barlocco@vessena.com.uy', 'sigue el estado, no aprueba en el dia a dia')
) AS r(recurso, notificacion, email, nota)
JOIN usuarios u ON lower(u.usuario) = lower(r.email)
ON CONFLICT (recurso, notificacion, usuario_id) DO NOTHING;
