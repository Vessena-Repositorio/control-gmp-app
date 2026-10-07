-- ============================================================================
-- Control de documentos: ciclo de revision y aprobacion con tareas y plazos
-- ============================================================================
--
-- Etapa 3 (Claudia, 07/10/2026). Quien envia una version a revision elige a
-- mano revisores y aprobadores; cada uno recibe una tarea con plazo (7 dias
-- por defecto) y la firma con usuario y clave. Firma quien tiene la tarea, no
-- quien tiene un rol: asi el jefe de un area puede revisar sin que haya que
-- darle permisos de antemano.
--
--   borrador --(autor firma y envia)--> en_revision --(firman todos los
--   revisores)--> en_aprobacion --(firman todos los aprobadores)--> aprobado
--   --> vigente en la fecha de vigencia (en_entrenamiento mientras tanto).
--   Un rechazo en cualquier paso vuelve a borrador y cancela lo pendiente.
--
-- Cada envio es una "ronda". Las firmas de una ronda rechazada quedan en el
-- registro pero no cuentan para la siguiente: la nueva ronda empieza de cero.
--
-- Nadie firma su propio documento: el autor no puede ser revisor ni aprobador
-- (lo controla la aplicacion al enviar, y lo advertia ya el listado en Excel).

ALTER TABLE dc_versiones ADD COLUMN IF NOT EXISTS ronda INT NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS dc_tareas (
    id            BIGSERIAL PRIMARY KEY,
    version_id    BIGINT NOT NULL REFERENCES dc_versiones (id) ON DELETE RESTRICT,
    ronda         INT NOT NULL,
    tipo          TEXT NOT NULL CHECK (tipo IN ('revision', 'aprobacion')),
    usuario_id    BIGINT NOT NULL REFERENCES usuarios (id) ON DELETE RESTRICT,
    -- Las de aprobacion nacen 'en_espera' y se activan cuando terminan las
    -- revisiones; recien ahi corre su plazo.
    plazo_dias    INT NOT NULL CHECK (plazo_dias > 0),
    vence_el      DATE,
    estado        TEXT NOT NULL DEFAULT 'pendiente' CHECK (estado IN (
                      'en_espera', 'pendiente', 'firmada', 'rechazada', 'cancelada')),
    firma_id      BIGINT REFERENCES firmas_electronicas (id),
    comentario    TEXT,
    creada_en     TIMESTAMPTZ NOT NULL DEFAULT now(),
    creada_por_id BIGINT REFERENCES usuarios (id),
    cerrada_en    TIMESTAMPTZ
);

-- Una persona tiene a lo sumo una tarea de cada tipo por ronda.
CREATE UNIQUE INDEX IF NOT EXISTS dc_tareas_unica_idx ON dc_tareas (version_id, ronda, tipo, usuario_id);
CREATE INDEX IF NOT EXISTS dc_tareas_abiertas_idx ON dc_tareas (usuario_id, vence_el)
    WHERE estado IN ('pendiente', 'en_espera');

DROP TRIGGER IF EXISTS dc_tareas_sin_borrado ON dc_tareas;
CREATE TRIGGER dc_tareas_sin_borrado BEFORE DELETE ON dc_tareas
    FOR EACH ROW EXECUTE FUNCTION sin_borrado();
DROP TRIGGER IF EXISTS dc_tareas_audit ON dc_tareas;
CREATE TRIGGER dc_tareas_audit AFTER INSERT OR UPDATE ON dc_tareas
    FOR EACH ROW EXECUTE FUNCTION audit_registrar('control-documentos', '');

-- Destinatarios de los resumenes de Calidad: el semanal (vencidos, por vencer
-- y tareas atrasadas) y los vencimientos de documentos cuyo aprobador no tiene
-- usuario en el sistema.
INSERT INTO notificacion_supervisores (recurso, notificacion, usuario_id, nota)
SELECT 'control-documentos', n.notificacion, u.id, n.nota
FROM (VALUES
    ('resumen-semanal', 'resumen semanal de documentos'),
    ('vencimientos',    'vencimientos de documentos sin aprobador con usuario')
) AS n(notificacion, nota)
CROSS JOIN usuarios u
WHERE lower(u.usuario) IN ('claudia.barlocco@vessena.com.uy', 'gloria.nunez@vessena.com.uy')
  AND u.origen = 'vessena'
ON CONFLICT DO NOTHING;
