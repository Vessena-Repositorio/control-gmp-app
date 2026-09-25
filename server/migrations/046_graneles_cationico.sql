-- ============================================================================
-- Graneles: aviso de catiónico fuera de especificación
-- ============================================================================
--
-- Pedido de Claudia (25/09/2026): en los suavizantes el catiónico
-- -"Contenido de materia activa (catiónico)", en los 7 graneles de suavizante-
-- se ensaya los sábados juntando los de toda la semana. Hasta entonces el lote
-- se envasa igual con el resto conforme, asi que si el catiónico vuelve fuera
-- de especificación el producto ya salio: el aviso tiene que ser inmediato y a
-- quienes aprueban, no esperar al resumen del lunes.
--
-- La cola "Pendiente catiónico" no necesita tabla: son las muestras pendientes
-- con ese parametro vacio y el resto cargado (lib/graneles-reglas.js).

INSERT INTO notificacion_supervisores (recurso, notificacion, usuario_id, nota)
SELECT 'aprobacion-graneles', 'cationico', u.id, n.nota
FROM (VALUES
    ('antonella.nunez@vessena.com.uy', 'catiónico fuera de especificación'),
    ('gloria.nunez@vessena.com.uy',    'catiónico fuera de especificación'),
    ('claudia.barlocco@vessena.com.uy', 'catiónico fuera de especificación')
) AS n(email, nota)
JOIN usuarios u ON lower(u.usuario) = n.email AND u.origen = 'vessena'
ON CONFLICT DO NOTHING;
