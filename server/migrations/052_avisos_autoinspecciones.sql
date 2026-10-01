-- ============================================================================
-- Aviso de autoinspecciones (SOP-AC-035)
-- ============================================================================
--
-- Pedido de Claudia (01/10/2026). Las autoinspecciones se hacen cuatro veces al
-- año -febrero, mayo, agosto y noviembre- y cada sector tiene su día dentro del
-- mes. No había ningún aviso: había que acordarse.
--
-- El aviso sale el primer día hábil de esos meses con la lista completa, y
-- vuelve a salir los lunes mientras queden sectores sin hacer.
--
-- Los meses y los sectores salen de la configuración de la app, así que se
-- cambian desde la pantalla y no acá.

INSERT INTO notificacion_supervisores (recurso, notificacion, usuario_id, nota)
SELECT 'auditorias', 'autoinspecciones', u.id, 'autoinspecciones del trimestre'
FROM (VALUES
    ('claudia.barlocco@vessena.com.uy'),
    ('gloria.nunez@vessena.com.uy'),
    ('antonella.nunez@vessena.com.uy')
) AS n(email)
JOIN usuarios u ON lower(u.usuario) = n.email AND u.origen = 'vessena'
ON CONFLICT DO NOTHING;
