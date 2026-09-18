-- ============================================================================
-- LCC de envases: la analista carga y firma, Antonella o Gloria aprueban y
-- firman, y recien ahi se imprime (mismo circuito que Control en proceso).
-- ============================================================================
--
-- La firma de la aprobadora ya estaba: envases_aprobaciones guarda usuario y
-- nombre (020). Faltaba la de la analista: quien envio el control completo,
-- tomada de la sesion al guardar. Los LCC de la planilla vieja no la tienen y
-- la hoja impresa lo dice.
--
-- Correos (pedido de Claudia, 18/09/2026):
--   * Antonella: cada vez que se envia un LCC completo (lcc-aprobacion) y los
--     lunes la lista de lo pendiente (pendientes-aprobacion).
--   * Claudia: los lunes el resumen de lo pendiente de Antonella o Gloria
--     (resumen-aprobaciones).
--   * Se quita el recordatorio diario de LCC que tocan (recordatorio-lcc): lo
--     atrasado pasa al resumen de los lunes.

CREATE TABLE IF NOT EXISTS envases_lcc_firmas (
    control_clave TEXT PRIMARY KEY,
    usuario_id    BIGINT REFERENCES usuarios (id),
    firmado_por   TEXT NOT NULL,
    firmado_en    TIMESTAMPTZ NOT NULL DEFAULT now()
);

DELETE FROM notificacion_supervisores
 WHERE recurso = 'control-calidad-envases' AND notificacion = 'recordatorio-lcc';

INSERT INTO notificacion_supervisores (recurso, notificacion, usuario_id, nota)
SELECT 'control-calidad-envases', n.notificacion, u.id, n.nota
FROM (VALUES
    ('antonella.nunez@vessena.com.uy', 'lcc-aprobacion',        'control LCC completo para aprobar'),
    ('antonella.nunez@vessena.com.uy', 'pendientes-aprobacion', 'los lunes, LCC pendientes de aprobar'),
    ('claudia.barlocco@vessena.com.uy', 'resumen-aprobaciones', 'los lunes, resumen de lo pendiente')
) AS n(email, notificacion, nota)
JOIN usuarios u ON lower(u.usuario) = n.email AND u.origen = 'vessena'
ON CONFLICT DO NOTHING;
