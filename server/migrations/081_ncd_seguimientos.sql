-- ============================================================================
-- CAPA: seguimiento de la acción mientras avanza
-- ============================================================================
--
-- Pedido de Claudia (16/11/2026). La acción tenia dos casillas de texto,
-- "verificacion de implementacion" y "verificacion de eficacia", que son de
-- cierre: se completan una sola vez, cuando la accion ya termino. Lo que no
-- habia era donde ir dejando constancia mientras la accion avanza -- que se
-- hizo el 20/11, que se hizo el 5/12, quien lo hizo -- y eso es justamente lo
-- que mira una auditoria para ver que la CAPA se gestiono y no que alguien
-- escribio el final de un tiron.
--
-- Una fila por anotacion, con su fecha. Solo se inserta: corregir una
-- anotacion vieja seria reescribir la historia, que es lo que el registro
-- viene a impedir. Borrar queda para quien administra la app (Claudia y
-- Gloria) y queda asentado en ncd_actividad, igual que la evidencia adjunta.
--
-- La fecha va aparte de creado_en a proposito: lo normal es anotar el lunes
-- algo que se hizo el viernes, y las dos cosas importan -- cuando paso y
-- cuando se registro.

CREATE TABLE IF NOT EXISTS ncd_seguimientos (
    id         BIGSERIAL PRIMARY KEY,
    capa_id    TEXT NOT NULL REFERENCES ncd_capa(id) ON DELETE CASCADE,
    fecha      DATE NOT NULL,
    texto      TEXT NOT NULL,
    usuario    TEXT,
    usuario_id BIGINT REFERENCES usuarios (id),
    creado_en  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- La ficha de una accion los pide todos juntos y en orden.
CREATE INDEX IF NOT EXISTS ncd_seguimientos_capa_idx
    ON ncd_seguimientos (capa_id, fecha DESC, id DESC);
