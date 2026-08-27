-- ============================================================================
-- Dominio: KPIs de Fabuloso (rendimiento, merma, analisis por lote)
-- Origen actual: Google Sheets directo via gviz (no Apps Script), formato CSV
-- Lee: fabuloso_kpi_dashboard.html
-- ============================================================================

-- Mismo criterio que SAO-001: el dashboard parsea el CSV el mismo, y gviz
-- entrecomilla TODOS los campos, asi que regenerarlo desde columnas seria
-- fragil. Se guarda literal y se le devuelve tal cual.
CREATE TABLE IF NOT EXISTS fabuloso_snapshot (
    id            BIGSERIAL PRIMARY KEY,
    csv           TEXT NOT NULL,
    filas         INT NOT NULL,
    bytes         INT NOT NULL,
    descargado_en TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Copia normalizada. La hoja es una tabla ancha de produccion por lote, con
-- columnas que van cambiando (hay 6 sin encabezado al final). En vez de fijar
-- 26 columnas que se desactualizan, se guardan los identificadores y el resto
-- pasa a filas clave/valor, igual que `mediciones` en envases.
CREATE TABLE IF NOT EXISTS fabuloso_lotes (
    id              BIGSERIAL PRIMARY KEY,
    pos             INT NOT NULL UNIQUE,   -- fila en el CSV = identidad
    clave           TEXT,                  -- columna 'V', el identificador compuesto
    codigo          TEXT,
    descripcion     TEXT,
    lote            TEXT,
    fecha_envasado  DATE,
    raw_fila        JSON NOT NULL
);

CREATE INDEX IF NOT EXISTS fabuloso_lote_idx   ON fabuloso_lotes (lote);
CREATE INDEX IF NOT EXISTS fabuloso_codigo_idx ON fabuloso_lotes (codigo);
CREATE INDEX IF NOT EXISTS fabuloso_fecha_idx  ON fabuloso_lotes (fecha_envasado DESC);

CREATE TABLE IF NOT EXISTS fabuloso_valores (
    id          BIGSERIAL PRIMARY KEY,
    lote_id     BIGINT NOT NULL REFERENCES fabuloso_lotes (id) ON DELETE CASCADE,
    columna     TEXT NOT NULL,             -- encabezado tal cual viene en la hoja
    valor_num   NUMERIC,
    valor_texto TEXT,
    UNIQUE (lote_id, columna)
);

CREATE INDEX IF NOT EXISTS fabuloso_valores_col_idx ON fabuloso_valores (columna, valor_num)
    WHERE valor_num IS NOT NULL;
