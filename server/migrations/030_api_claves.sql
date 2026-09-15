-- ============================================================================
-- Claves para que otros sistemas consulten datos sin sesion
-- ============================================================================
--
-- El sistema de produccion (software aparte, el que imprime la etiqueta QR con
-- lote y orden) necesita saber si un lote de granel ya puede pasar a envasado.
-- Para produccion ese momento es cuando el analista guardo el analisis
-- conforme, sin esperar la aprobacion documental (decision de Claudia,
-- 15/09/2026).
--
-- Un sistema no tiene usuario ni sesion: se le da una clave. Reglas:
--   * Se guarda solo la huella (sha256). La clave se muestra una vez al crearla.
--   * Cada clave tiene un alcance y sirve solo para eso: una clave de
--     'graneles:estado-lote' no lee resultados ni escribe nada.
--   * Revocar no borra: queda quien la creo, quien la revoco y cuando.

CREATE TABLE IF NOT EXISTS api_claves (
    id            BIGSERIAL PRIMARY KEY,
    nombre        TEXT NOT NULL,          -- para reconocerla: "Sistema de produccion"
    alcance       TEXT NOT NULL,          -- 'graneles:estado-lote'
    huella        TEXT NOT NULL UNIQUE,   -- sha256 hex de la clave
    prefijo       TEXT NOT NULL,          -- primeros caracteres, para identificarla sin verla entera
    creada_por    TEXT NOT NULL,
    creada_en     TIMESTAMPTZ NOT NULL DEFAULT now(),
    revocada_por  TEXT,
    revocada_en   TIMESTAMPTZ,
    ultimo_uso    TIMESTAMPTZ,
    usos          BIGINT NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS api_claves_alcance_idx ON api_claves (alcance, creada_en DESC);
