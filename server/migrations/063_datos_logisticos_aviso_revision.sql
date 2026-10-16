-- ============================================================================
-- Datos Logisticos: avisar a quien revisa la ficha
-- ============================================================================
--
-- Claudia probo el circuito con un SKU y pregunto: "donde quedo, como se que
-- se le mando a Antonella". No se le mandaba nada: mandar a revisar solo
-- cambiaba el estado y Antonella se enteraba si entraba a la app.
--
-- El circuito que pidio tiene tres avisos y faltaba el primero:
--   revision   a quien revisa, cuando Gloria manda la ficha
--   finanzas   a Marianela, cuando se aprueba
--   ventas     a ventas y logistica, cuando ademas estan los dos papeles
--
-- Revisa Antonella; Claudia tambien lo recibe porque aprueba cuando Antonella
-- no esta.

INSERT INTO notificacion_supervisores (recurso, notificacion, usuario_id, nota)
SELECT 'datos-logisticos', 'revision', u.id, n.nota
FROM (VALUES
    ('antonella.nunez@vessena.com.uy', 'revisa las fichas'),
    ('claudia.barlocco@vessena.com.uy', 'aprueba cuando Antonella no está')
) AS n(usuario, nota)
JOIN usuarios u ON lower(u.usuario) = n.usuario
ON CONFLICT (recurso, notificacion, usuario_id) DO NOTHING;
