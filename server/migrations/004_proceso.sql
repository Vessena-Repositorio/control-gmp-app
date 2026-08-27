-- ============================================================================
-- Dominio: control en proceso (pesos, pH, checks por control de linea)
-- Origen actual: Apps Script AKfycbxm... (sin parametros)
-- Escribe: index.html   Leen: informe-gerencial.html
-- ============================================================================
--
-- A diferencia de envases, este origen devuelve una lista plana de registros
-- sin ningun id. Y no hay combinacion de campos que sirva de clave: sobre 2007
-- registros hay 4 pares COMPLETAMENTE identicos entre si, hasta la hora al
-- segundo. Son controles enviados dos veces por el operario, algo que el
-- POST con mode:'no-cors' de index.html favorece, porque no puede confirmar
-- que guardo y la gente reintenta.
--
-- Por eso la identidad es la POSICION en la hoja, que es lo unico que
-- distingue esos duplicados y ademas conserva el orden del payload. La hoja se
-- usa como bitacora que solo crece, asi que la posicion es estable.

CREATE TABLE IF NOT EXISTS proceso_controles (
    id            BIGSERIAL PRIMARY KEY,
    pos           INT NOT NULL UNIQUE,       -- posicion en el origen = identidad
    fecha         DATE,
    analista      TEXT,
    orden         TEXT,
    lote          TEXT,
    vence         DATE,
    maquina       TEXT,
    presentacion  TEXT,
    granel        TEXT,
    cod_pt        TEXT,
    control_num   INT,
    hora          TEXT,
    promedio      NUMERIC,
    spec          TEXT,
    ph            NUMERIC,
    has_dev       BOOLEAN,
    dev_desc      TEXT,
    dev_qty       TEXT,
    is_rep        BOOLEAN,
    num_fotos     INT,
    obs           TEXT,
    raw           JSON NOT NULL,             -- registro original, para replay exacto
    sincronizado_en TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS proceso_fecha_idx    ON proceso_controles (fecha DESC);
CREATE INDEX IF NOT EXISTS proceso_maquina_idx  ON proceso_controles (maquina);
CREATE INDEX IF NOT EXISTS proceso_lote_idx     ON proceso_controles (lote);
CREATE INDEX IF NOT EXISTS proceso_analista_idx ON proceso_controles (analista);
CREATE INDEX IF NOT EXISTS proceso_dev_idx      ON proceso_controles (has_dev) WHERE has_dev;

-- Los pesos son el dato que analiza informe-gerencial, asi que salen del JSON a
-- filas propias. Los checks y los links de fotos quedan solo en raw: son
-- etiquetas, no metricas.
CREATE TABLE IF NOT EXISTS proceso_pesos (
    id          BIGSERIAL PRIMARY KEY,
    control_id  BIGINT NOT NULL REFERENCES proceso_controles (id) ON DELETE CASCADE,
    muestra     INT NOT NULL,               -- 1..5
    valor_num   NUMERIC,
    valor_texto TEXT,
    UNIQUE (control_id, muestra)
);

CREATE INDEX IF NOT EXISTS proceso_pesos_control_idx ON proceso_pesos (control_id);
CREATE INDEX IF NOT EXISTS proceso_pesos_valor_idx   ON proceso_pesos (valor_num)
    WHERE valor_num IS NOT NULL;
