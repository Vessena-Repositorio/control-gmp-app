-- ============================================================================
-- Acceso a la app de No Conformidades y Desvios
-- ============================================================================
--
-- App nueva, separada de `no-conformidades`: cubre el ciclo completo del
-- SOP-AC-036 (analisis 5M, matriz de criticidad, desvios de produccion e
-- informe para el comite) que la anterior no tiene. Las dos conviven.
--
-- Los roles espejan los que cada persona ya tiene en `no-conformidades`: es la
-- misma gente haciendo el mismo trabajo, asi que no hay razon para que el
-- permiso difiera. Si con el tiempo diverge, se corrige con otra migracion.
--
-- Todavia no hay tablas de datos para esta app: guarda en el navegador. Esta
-- migracion solo abre la puerta; la persistencia compartida viene despues.

INSERT INTO usuario_recursos (usuario_id, recurso, rol)
SELECT u.id, r.recurso, r.rol
FROM (VALUES
    ('claudia.barlocco@vessena.com.uy',  'no-conformidades-desvios', 'administrador'),
    ('gloria.nunez@vessena.com.uy',      'no-conformidades-desvios', 'operador'),
    ('antonella.nunez@vessena.com.uy',   'no-conformidades-desvios', 'operador')
) AS r(email, recurso, rol)
JOIN usuarios u ON lower(u.usuario) = lower(r.email)
ON CONFLICT (usuario_id, recurso) DO NOTHING;
