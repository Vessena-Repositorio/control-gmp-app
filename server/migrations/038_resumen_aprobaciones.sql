-- Resumen mensual de ordenes sin aprobar (Claudia, 18/09/2026): el primer lunes
-- de cada mes, para controlar que las supervisoras hayan aprobado todo y que
-- ninguna orden quede sin la firma final. Le llega solo a Claudia.
INSERT INTO notificacion_supervisores (recurso, notificacion, usuario_id, nota)
SELECT 'aprobaciones', 'resumen-mensual', u.id,
       'ordenes de Control en proceso y Fabuloso sin aprobacion final'
FROM usuarios u
WHERE u.origen = 'vessena'
  AND lower(u.usuario) = 'claudia.barlocco@vessena.com.uy'
ON CONFLICT DO NOTHING;
