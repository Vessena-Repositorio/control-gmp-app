-- ============================================================================
-- Control en proceso: correccion de un valor mal cargado, con el original
-- ============================================================================
--
-- Pedido de Claudia (09/10/2026): al imprimir el registro completo de una
-- orden, las supervisoras (Antonella, Gloria, Claudia) tienen que poder
-- corregir un valor mal cargado -un lote, un vencimiento, un peso- pero
-- dejando a la vista cual fue el valor que se habia puesto.
--
-- Es la regla de BPF para un registro: el dato equivocado no se borra, queda
-- legible, y al lado va el correcto con quien lo corrigio, cuando y por que.
--
-- Esta tabla es el rastro: solo se inserta, nunca se actualiza ni se borra.
-- El valor corregido si se escribe en proceso_controles (raw y la columna, y
-- proceso_pesos si es un peso) para que la pantalla, el dashboard y el informe
-- gerencial muestren el dato bueno; el que se habia cargado vive aca.

CREATE TABLE IF NOT EXISTS proceso_correcciones (
    id             BIGSERIAL PRIMARY KEY,
    control_id     BIGINT NOT NULL REFERENCES proceso_controles (id) ON DELETE CASCADE,
    orden          TEXT NOT NULL,
    campo          TEXT NOT NULL,          -- clave del dato (lote, vence, peso...)
    indice         INT,                    -- muestra del peso (1..5); NULL en los demas
    valor_anterior TEXT,                   -- lo que estaba cargado ('' si estaba vacio)
    valor_nuevo    TEXT,
    motivo         TEXT NOT NULL,
    usuario        TEXT NOT NULL,
    usuario_id     BIGINT REFERENCES usuarios (id),
    ts             TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS proceso_correcciones_orden_idx   ON proceso_correcciones (orden, ts);
CREATE INDEX IF NOT EXISTS proceso_correcciones_control_idx ON proceso_correcciones (control_id, ts);
