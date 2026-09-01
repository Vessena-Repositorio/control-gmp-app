-- ============================================================================
-- Dominio: SAO-001, validacion del sistema de agua (PQ / PPQ-H2O-001)
-- Origen actual: Apps Script AKfycbxx... que devuelve CSV, no JSON
-- Lee: dashboard_sao001.html
-- ============================================================================

-- El dashboard hace resp.text() y parsea el CSV el mismo, asi que para que siga
-- funcionando sin tocarle el render hay que devolverle el texto exacto. Se
-- guarda literal, igual que `raw` en los dominios JSON: regenerar el CSV desde
-- las columnas obligaria a reproducir las reglas de entrecomillado y cualquier
-- diferencia rompeeria el parseo del dashboard.
CREATE TABLE IF NOT EXISTS sao001_snapshot (
    id            BIGSERIAL PRIMARY KEY,
    csv           TEXT NOT NULL,
    filas         INT NOT NULL,
    bytes         INT NOT NULL,
    descargado_en TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Copia normalizada, para poder consultar por SQL sin volver a parsear el CSV.
-- No la usa ningun dashboard todavia.
CREATE TABLE IF NOT EXISTS sao001_muestras (
    id            BIGSERIAL PRIMARY KEY,
    pos           INT NOT NULL UNIQUE,   -- fila en el CSV = identidad
    punto         TEXT,                  -- columna '*' (P1, TM1, ...)
    comentarios   TEXT,
    sistema       TEXT,
    fecha         DATE,
    fases         TEXT,
    observaciones TEXT
);

CREATE INDEX IF NOT EXISTS sao001_fecha_idx   ON sao001_muestras (fecha DESC);
CREATE INDEX IF NOT EXISTS sao001_punto_idx   ON sao001_muestras (punto);
CREATE INDEX IF NOT EXISTS sao001_sistema_idx ON sao001_muestras (sistema);

-- Cada parametro medido trae valor y sus limites en columnas separadas del CSV
-- (Min pH / pH / Max. pH, y asi). En filas se consulta mucho mejor que en 18
-- columnas, y permite agregar parametros sin migrar el esquema.
CREATE TABLE IF NOT EXISTS sao001_parametros (
    id          BIGSERIAL PRIMARY KEY,
    muestra_id  BIGINT NOT NULL REFERENCES sao001_muestras (id) ON DELETE CASCADE,
    parametro   TEXT NOT NULL,           -- ph | conductividad | cloro | ozono | micro | toc | dureza
    valor_num   NUMERIC,
    valor_texto TEXT,
    limite_min  NUMERIC,
    limite_max  NUMERIC,
    UNIQUE (muestra_id, parametro)
);

CREATE INDEX IF NOT EXISTS sao001_param_idx ON sao001_parametros (parametro, valor_num)
    WHERE valor_num IS NOT NULL;

-- Fuera de especificacion, calculado una sola vez en la base.
CREATE INDEX IF NOT EXISTS sao001_param_fuera_idx ON sao001_parametros (parametro)
    WHERE valor_num IS NOT NULL
      AND ((limite_min IS NOT NULL AND valor_num < limite_min)
        OR (limite_max IS NOT NULL AND valor_num > limite_max));
