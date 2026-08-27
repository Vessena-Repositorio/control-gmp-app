-- ============================================================================
-- Dominio: control de calidad de envases y tapas (soplado + LCC)
-- Origen actual: Apps Script AKfycby0... (?action=getAll)
-- Consumen: dashboard.html, panel-supervision-envases.html,
--           panel-supervision-tapas.html, supervision-envases.html
-- ============================================================================

CREATE TABLE IF NOT EXISTS ordenes (
    id            BIGINT PRIMARY KEY,          -- id de origen (epoch ms)
    numero_orden  TEXT,
    envase        TEXT,
    fecha         DATE,
    operador      TEXT,
    analista      TEXT,
    maquina       TEXT,
    turno         TEXT,
    estado        TEXT,
    campaign_id   BIGINT,
    creado_en     TIMESTAMPTZ,
    raw           JSON NOT NULL,               -- registro original sin controles
    sincronizado_en TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ordenes_fecha_idx  ON ordenes (fecha DESC);
CREATE INDEX IF NOT EXISTS ordenes_envase_idx ON ordenes (envase);
CREATE INDEX IF NOT EXISTS ordenes_estado_idx ON ordenes (estado);

-- Nota sobre `raw`: se usa JSON y no JSONB a proposito. JSONB reordena las
-- claves y descarta duplicados; `raw` existe para poder devolver el payload
-- exactamente como lo mandaba Apps Script. Las consultas no entran a `raw`:
-- para eso estan las columnas normalizadas y la tabla `mediciones`.

-- Un control puede colgar de una orden (soplado) o ser autonomo (LCC).
CREATE TABLE IF NOT EXISTS controles (
    id            BIGSERIAL PRIMARY KEY,
    clave_natural TEXT NOT NULL UNIQUE,        -- 'orden:<ordenId>:<ts>' | 'lcc:<id>'
    origen        TEXT NOT NULL CHECK (origen IN ('orden', 'lcc')),
    orden_id      BIGINT REFERENCES ordenes (id) ON DELETE CASCADE,
    ext_id        BIGINT,                      -- id propio, solo LCC
    envase        TEXT,                        -- propio en LCC, heredado en orden
    tipo          TEXT,                        -- arranque | proceso | semanal | quincenal
    fecha         DATE,
    hora          TEXT,
    operador      TEXT,
    analista      TEXT,
    turno         TEXT,
    observaciones TEXT,
    ts            TIMESTAMPTZ NOT NULL,        -- timestamp del registro
    raw           JSON NOT NULL,               -- control original completo
    sincronizado_en TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- Un control de orden exige orden_id; uno de LCC exige ext_id.
    CONSTRAINT controles_origen_coherente CHECK (
        (origen = 'orden' AND orden_id IS NOT NULL) OR
        (origen = 'lcc'   AND ext_id   IS NOT NULL)
    )
);

CREATE INDEX IF NOT EXISTS controles_orden_idx  ON controles (orden_id);
CREATE INDEX IF NOT EXISTS controles_fecha_idx  ON controles (fecha DESC);
CREATE INDEX IF NOT EXISTS controles_tipo_idx   ON controles (tipo);
CREATE INDEX IF NOT EXISTS controles_origen_idx ON controles (origen);

-- Las mediciones llegan como bolsa dinamica de claves. Se normalizan aca para
-- que los dashboards futuros consulten por SQL en vez de recorrer objetos.
--   arr_peso_cav1            -> fase=arr,  parametro=peso,      cavidad=1
--   proc_Base sin deformacion-> fase=proc, parametro=Base sin deformacion
--   _maquinaParada           -> fase=meta, parametro=maquinaParada
-- Los arrays (muestras multiples de LCC) generan una fila por muestra.
CREATE TABLE IF NOT EXISTS mediciones (
    id          BIGSERIAL PRIMARY KEY,
    control_id  BIGINT NOT NULL REFERENCES controles (id) ON DELETE CASCADE,
    clave       TEXT NOT NULL,                 -- clave cruda, tal cual el origen
    fase        TEXT,                          -- arr | proc | semanal | ... | meta
    parametro   TEXT,
    cavidad     INT,
    muestra     INT NOT NULL DEFAULT 1,
    valor_texto TEXT,
    valor_num   NUMERIC,                       -- solo si el valor es numerico real
    UNIQUE (control_id, clave, muestra)
);

CREATE INDEX IF NOT EXISTS mediciones_control_idx   ON mediciones (control_id);
CREATE INDEX IF NOT EXISTS mediciones_parametro_idx ON mediciones (fase, parametro);
CREATE INDEX IF NOT EXISTS mediciones_num_idx       ON mediciones (parametro, valor_num)
    WHERE valor_num IS NOT NULL;

-- Bitacora de sincronizaciones, para saber si el dato que se ve esta fresco.
CREATE TABLE IF NOT EXISTS sync_log (
    id          BIGSERIAL PRIMARY KEY,
    dominio     TEXT NOT NULL,
    iniciado_en TIMESTAMPTZ NOT NULL DEFAULT now(),
    fin_en      TIMESTAMPTZ,
    estado      TEXT NOT NULL DEFAULT 'corriendo',  -- corriendo | ok | error
    ordenes     INT DEFAULT 0,
    controles   INT DEFAULT 0,
    mediciones  INT DEFAULT 0,
    error       TEXT
);

CREATE INDEX IF NOT EXISTS sync_log_dominio_idx ON sync_log (dominio, iniciado_en DESC);
