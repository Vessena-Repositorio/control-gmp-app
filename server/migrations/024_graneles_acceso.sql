-- ============================================================================
-- Acceso a la app de Aprobacion de Graneles
-- ============================================================================
--
-- El LCC recibe una muestra por lote de granel, la analiza contra la
-- especificacion del producto y alguien con firma aprueba o rechaza el lote.
--
-- Roles definidos por Claudia el 14/09/2026:
--
--   * Claudia, Antonella y Gloria: administradoras. Cargan, aprueban o rechazan
--     lotes, editan especificaciones y pueden borrar.
--   * Lorena y Monica: operadoras. Cargan muestras y resultados, no aprueban.
--
-- Monica entra con la casilla del laboratorio y Lorena con la del minilab (ver
-- 010_roles.sql).

INSERT INTO usuario_recursos (usuario_id, recurso, rol)
SELECT u.id, r.recurso, r.rol
FROM (VALUES
    ('claudia.barlocco@vessena.com.uy',  'aprobacion-graneles', 'administrador'),
    ('antonella.nunez@vessena.com.uy',   'aprobacion-graneles', 'administrador'),
    ('gloria.nunez@vessena.com.uy',      'aprobacion-graneles', 'administrador'),
    ('analista.minilab@vessena.com.uy',  'aprobacion-graneles', 'operador'),
    ('laboratorio@vessena.com.uy',       'aprobacion-graneles', 'operador')
) AS r(email, recurso, rol)
JOIN usuarios u ON lower(u.usuario) = lower(r.email)
ON CONFLICT (usuario_id, recurso) DO NOTHING;
