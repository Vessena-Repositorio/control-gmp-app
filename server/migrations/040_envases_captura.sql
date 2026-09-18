-- ============================================================================
-- Control de Calidad Envases y Tapas: la app escribe en Postgres
-- ============================================================================
--
-- Hasta el 18/09/2026 control-calidad-envases.html leia y escribia en el Apps
-- Script de la planilla, y el servidor solo la replicaba (ordenes, controles,
-- mediciones) para los dashboards. Esas tablas pasan a ser la fuente de verdad:
-- la app escribe ahi con la misma forma (raw) que devolvia el Apps Script, asi
-- /api/envases y los dashboards no cambian.
--
-- El cambio se hace con "Cerrar planilla" (envases_corte): hasta entonces la
-- pantalla sigue usando Google, y el servidor puede desplegarse cuando sea.

-- Lo que el Apps Script borraba de verdad, aca queda marcado.
ALTER TABLE ordenes   ADD COLUMN IF NOT EXISTS eliminado_en  TIMESTAMPTZ;
ALTER TABLE ordenes   ADD COLUMN IF NOT EXISTS eliminado_por TEXT;
ALTER TABLE controles ADD COLUMN IF NOT EXISTS eliminado_en  TIMESTAMPTZ;
ALTER TABLE controles ADD COLUMN IF NOT EXISTS eliminado_por TEXT;

CREATE TABLE IF NOT EXISTS envases_corte (
    unica       BOOLEAN PRIMARY KEY DEFAULT true CHECK (unica),
    cerrado_en  TIMESTAMPTZ NOT NULL DEFAULT now(),
    cerrado_por TEXT,
    detalle     TEXT
);

-- Bitacora de la app: solo se inserta.
CREATE TABLE IF NOT EXISTS envases_actividad (
    id          BIGSERIAL PRIMARY KEY,
    ts          TIMESTAMPTZ NOT NULL DEFAULT now(),
    usuario     TEXT,
    accion      TEXT NOT NULL,
    producto    TEXT,
    entidad_id  TEXT,
    detalles    TEXT
);

-- Aviso de control LCC completo (antes lo mandaba el Apps Script a Antonella)
-- y recordatorio diario de LCC de FAB-1L / FAB-2L (Antonella y Claudia).
INSERT INTO notificacion_supervisores (recurso, notificacion, usuario_id, nota)
SELECT 'control-calidad-envases', n.notificacion, u.id, n.nota
FROM (VALUES
    ('antonella.nunez@vessena.com.uy', 'lcc-aprobacion',   'control LCC completo para aprobar'),
    ('antonella.nunez@vessena.com.uy', 'recordatorio-lcc', 'LCC semanal/quincenal de FAB-1L y FAB-2L'),
    ('claudia.barlocco@vessena.com.uy', 'recordatorio-lcc', 'LCC semanal/quincenal de FAB-1L y FAB-2L')
) AS n(email, notificacion, nota)
JOIN usuarios u ON lower(u.usuario) = n.email AND u.origen = 'vessena'
ON CONFLICT DO NOTHING;
