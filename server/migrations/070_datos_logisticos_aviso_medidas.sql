-- ============================================================================
-- Datos Logisticos: pedirle a Control de Calidad las medidas y los pesos
-- ============================================================================
--
-- Gloria arma la ficha con lo que tiene, y las medidas, los pesos y el
-- paletizado los mide Control de Calidad. Claudia (05/11/2026): "deberia de
-- ver un boton que sea enviar a Antonella para que los complete".
--
-- El boton manda el aviso 'medidas' a quien este cargado aca.

INSERT INTO notificacion_supervisores (recurso, notificacion, usuario_id, nota)
SELECT 'datos-logisticos', 'medidas', u.id, n.nota
FROM (VALUES
    ('antonella.nunez@vessena.com.uy', 'completa medidas y pesos')
) AS n(usuario, nota)
JOIN usuarios u ON lower(u.usuario) = n.usuario
ON CONFLICT (recurso, notificacion, usuario_id) DO NOTHING;
