-- ============================================================================
-- Quien recibe los avisos de muestras de granel sin aprobar
-- ============================================================================
--
-- Pedido por Claudia el 14/09/2026:
--
--   * Antonella aprueba los lotes. Cada dia habil le llega lo que quedo
--     pendiente de dias anteriores, para que no se le pase ninguno.
--   * Claudia sigue el estado. Los lunes le llega el resumen de la semana, por
--     si algo quedo sin aprobar.
--
-- Como en envases, el destinatario se declara y no se deduce del rol: las tres
-- administradoras pueden aprobar, pero la que aprueba en el dia a dia es
-- Antonella.

INSERT INTO notificacion_supervisores (recurso, notificacion, usuario_id, nota)
SELECT r.recurso, r.notificacion, u.id, r.nota
FROM (VALUES
    ('aprobacion-graneles', 'pendientes-aprobacion',
     'antonella.nunez@vessena.com.uy', 'aprueba los lotes de granel'),
    ('aprobacion-graneles', 'resumen-semanal',
     'claudia.barlocco@vessena.com.uy', 'sigue el estado, resumen de los lunes')
) AS r(recurso, notificacion, email, nota)
JOIN usuarios u ON lower(u.usuario) = lower(r.email)
ON CONFLICT (recurso, notificacion, usuario_id) DO NOTHING;
