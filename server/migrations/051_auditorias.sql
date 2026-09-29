-- ============================================================================
-- Auditorías (SOP-AC-035 V4.0) — la app sale del navegador
-- ============================================================================
--
-- Pedido de Claudia (29/09/2026). Hasta ahora el QMS Audit Tracker era un HTML
-- suelto que guardaba todo en el localStorage del navegador: lo que cargaba una
-- no lo veía otra, se perdía al limpiar el navegador, y el acceso era un
-- usuario "admin" con la contraseña escrita en el archivo. Los datos del año
-- terminaron viviendo dentro del propio HTML.
--
-- Acá: una sola base para todas, sesión del portal y auditoría de cambios.
--
-- Por qué una tabla de colecciones y no una tabla por entidad: la pantalla
-- trabaja con listas completas en memoria -auditorías, hallazgos, acciones- y
-- las guarda enteras. Partirlas en tablas obligaría a reescribir toda la
-- pantalla; guardarlas como documento mantiene la app tal cual, que es lo que
-- ya saben usar. El volumen lo permite: 7 auditorías, 26 hallazgos.
--
-- El riesgo de guardar listas enteras es pisarse entre dos personas -pasó en
-- Estabilidad, migracion 023-: por eso cada colección lleva `version`, el
-- servidor la exige al guardar y rechaza si alguien guardó mientras tanto. La
-- app avisa y recarga en vez de perder el trabajo del otro.

CREATE TABLE IF NOT EXISTS aud_colecciones (
    nombre          TEXT PRIMARY KEY,          -- auditorias | hallazgos | acciones | ...
    datos           JSONB NOT NULL DEFAULT '[]'::jsonb,
    version         BIGINT NOT NULL DEFAULT 1,
    actualizado_por TEXT,
    actualizado_en  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Bitácora: quién cambió qué y cuándo. Solo se inserta.
CREATE TABLE IF NOT EXISTS aud_actividad (
    id         BIGSERIAL PRIMARY KEY,
    ts         TIMESTAMPTZ NOT NULL DEFAULT now(),
    usuario    TEXT,
    accion     TEXT NOT NULL,
    entidad    TEXT,
    detalle    TEXT
);

CREATE INDEX IF NOT EXISTS aud_actividad_ts_idx ON aud_actividad (ts DESC);

-- Marca de la importación del año 2026, que se hace una sola vez.
CREATE TABLE IF NOT EXISTS aud_importacion (
    unica         BOOLEAN PRIMARY KEY DEFAULT true CHECK (unica),
    importado_en  TIMESTAMPTZ NOT NULL DEFAULT now(),
    importado_por TEXT,
    detalle       TEXT
);

-- Roles: Claudia administra; Gloria y Antonella cargan y aprueban; el resto
-- del laboratorio no entra. Se puede cambiar sin tocar codigo.
INSERT INTO usuario_recursos (usuario_id, recurso, rol)
SELECT u.id, 'auditorias', r.rol
FROM (VALUES
    ('claudia.barlocco@vessena.com.uy',  'administrador'),
    ('gloria.nunez@vessena.com.uy',      'aprobador'),
    ('antonella.nunez@vessena.com.uy',   'aprobador')
) AS r(email, rol)
JOIN usuarios u ON lower(u.usuario) = r.email AND u.origen = 'vessena'
ON CONFLICT (usuario_id, recurso) DO NOTHING;

-- Destinatarios de los tres avisos que pidio Claudia.
INSERT INTO notificacion_supervisores (recurso, notificacion, usuario_id, nota)
SELECT 'auditorias', n.notificacion, u.id, n.nota
FROM (VALUES
    ('claudia.barlocco@vessena.com.uy', 'acciones-vencidas',  'acciones de auditoría vencidas'),
    ('gloria.nunez@vessena.com.uy',     'acciones-vencidas',  'acciones de auditoría vencidas'),
    ('claudia.barlocco@vessena.com.uy', 'auditorias-del-mes', 'auditorías planificadas del mes'),
    ('gloria.nunez@vessena.com.uy',     'auditorias-del-mes', 'auditorías planificadas del mes'),
    ('claudia.barlocco@vessena.com.uy', 'informe-pendiente',  'auditorías ejecutadas sin informe'),
    ('gloria.nunez@vessena.com.uy',     'informe-pendiente',  'auditorías ejecutadas sin informe')
) AS n(email, notificacion, nota)
JOIN usuarios u ON lower(u.usuario) = n.email AND u.origen = 'vessena'
ON CONFLICT DO NOTHING;
