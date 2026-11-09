-- ============================================================================
-- Datos Logisticos: pedirle a Control de Calidad las medidas y los pesos
-- ============================================================================
--
-- Gloria arma la ficha con lo que tiene, y las medidas, los pesos y el
-- paletizado los mide Control de Calidad. Claudia (05/11/2026): "deberia de
-- ver un boton que sea enviar a Antonella para que los complete".
--
-- El boton manda el aviso 'medidas' a quien este cargado aca.

-- Un solo usuario: el activo de Antonella, el del portal si hay. Cada persona
-- tiene un usuario por sistema del que vino (05/11/2026).
INSERT INTO notificacion_supervisores (recurso, notificacion, usuario_id, nota)
SELECT 'datos-logisticos', 'medidas', u.id, 'completa medidas y pesos'
FROM usuarios u
WHERE lower(u.usuario) = 'antonella.nunez@vessena.com.uy' AND u.activo
ORDER BY (u.origen = 'vessena') DESC, u.id
LIMIT 1
ON CONFLICT (recurso, notificacion, usuario_id) DO NOTHING;
