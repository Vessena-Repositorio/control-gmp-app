-- ============================================================================
-- Aprobacion de Graneles: especificaciones, muestras y actividad
-- ============================================================================
--
-- La app nacio guardando en localStorage, igual que NC-Desvios, y por las
-- mismas razones no puede quedar asi: cada analista veia su propia bitacora, y
-- la firma de quien aprobaba era un texto libre que cualquiera escribia. Acá la
-- firma sale de la sesion.

-- ---------------------------------------------------------------------------
-- Especificaciones de producto
-- ---------------------------------------------------------------------------
-- Un granel por fila, identificado por su codigo G. Los parametros van en JSONB
-- y no en tabla propia: siempre se leen y se editan con su especificacion, y la
-- estadistica se hace en el navegador sobre los resultados de las muestras.
CREATE TABLE IF NOT EXISTS gra_especificaciones (
    id              TEXT PRIMARY KEY,
    code            TEXT NOT NULL UNIQUE,
    name            TEXT NOT NULL,
    category        TEXT,
    brand           TEXT,
    doc_ref         TEXT,
    doc_version     TEXT,

    -- [{id, name, type, method, unit, min, max, target, note}]
    parametros      JSONB NOT NULL DEFAULT '[]'::jsonb,

    -- El resto de la ficha: vida util, marcas comerciales, nota del documento,
    -- con los nombres de campo de la app.
    datos           JSONB NOT NULL DEFAULT '{}'::jsonb,

    creado_en       TIMESTAMPTZ NOT NULL DEFAULT now(),
    actualizado_en  TIMESTAMPTZ NOT NULL DEFAULT now(),
    actualizado_por TEXT
);

-- ---------------------------------------------------------------------------
-- Muestras analizadas
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS gra_muestras (
    id              TEXT PRIMARY KEY,

    -- Un lote se analiza una sola vez. Si hace falta repetir un parametro, eso
    -- es el retest dentro de la misma muestra, no una muestra nueva.
    lote            TEXT NOT NULL UNIQUE,

    -- Sin FK a gra_especificaciones a proposito: la especificacion se puede
    -- editar o borrar, y la muestra no puede perder contra que se evaluo.
    producto_code   TEXT NOT NULL,

    -- Foto de la especificacion al crear la muestra. Si mañana se corrige un
    -- rango, un lote aprobado ayer tiene que seguir mostrando el rango con el
    -- que se aprobo, no el nuevo.
    especificacion  JSONB NOT NULL,

    fecha           DATE NOT NULL,
    analista        TEXT NOT NULL,
    hora_fabrica    TIME,
    hora_ingreso    TIME,
    hora_fin        TIME,

    -- [{paramId, paramName, type, value, pass, retestValue, retestPass}]
    resultados      JSONB NOT NULL DEFAULT '[]'::jsonb,
    observaciones   TEXT,

    -- Los valores son los de la app, para no traducir en cada lectura.
    estado          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (estado IN ('pending', 'approved', 'rejected')),
    aprobado_por    TEXT,
    aprobado_en     TIMESTAMPTZ,

    creado_por      TEXT,
    creado_en       TIMESTAMPTZ NOT NULL DEFAULT now(),
    actualizado_en  TIMESTAMPTZ NOT NULL DEFAULT now(),
    actualizado_por TEXT
);

CREATE INDEX IF NOT EXISTS gra_muestras_fecha_idx    ON gra_muestras (fecha DESC, creado_en DESC);
CREATE INDEX IF NOT EXISTS gra_muestras_estado_idx   ON gra_muestras (estado);
CREATE INDEX IF NOT EXISTS gra_muestras_producto_idx ON gra_muestras (producto_code, fecha);

-- ---------------------------------------------------------------------------
-- Audit trail de la app
-- ---------------------------------------------------------------------------
-- Solo se inserta: ninguna ruta actualiza ni borra filas de esta tabla.
CREATE TABLE IF NOT EXISTS gra_actividad (
    id       BIGSERIAL PRIMARY KEY,
    ts       TIMESTAMPTZ NOT NULL DEFAULT now(),
    usuario  TEXT,
    accion   TEXT NOT NULL,
    entidad  TEXT,
    detalle  TEXT
);

CREATE INDEX IF NOT EXISTS gra_actividad_ts_idx ON gra_actividad (ts DESC);
