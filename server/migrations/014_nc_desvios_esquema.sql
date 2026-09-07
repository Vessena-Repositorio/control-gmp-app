-- ============================================================================
-- No Conformidades y Desvios: Postgres como fuente de verdad
-- ============================================================================
--
-- La app nacio guardando en localStorage. Eso no sirve acá por dos razones que
-- no son de gusto: los datos quedaban en el navegador de quien los cargaba, asi
-- que dos personas no veian lo mismo; y el audit trail vivia en el mismo lugar
-- que los datos que audita, donde cualquiera lo edita desde la consola. Un
-- registro de auditoria que el auditado puede reescribir no es un registro.
--
-- Ademas hacen falta adjuntos (foto o PDF como evidencia de una accion), y
-- localStorage tiene ~5 MB para toda la app: una sola foto de celular la llena.
--
-- ---------------------------------------------------------------------------
-- Por que columnas y JSON a la vez
-- ---------------------------------------------------------------------------
-- Los formularios de esta app todavia se estan ajustando. Si cada campo fuera
-- una columna, cada cambio de un formulario pediria una migracion nueva. Asi
-- que se separan dos cosas:
--
--   - Columnas: lo que se filtra, ordena o reporta (codigo, fase, fechas,
--     clasificacion, sector). Es lo que las consultas necesitan indexado.
--   - `datos` JSONB: el resto del formulario, con los mismos nombres de campo
--     que usa la app, para que el servidor devuelva el registro ya armado y
--     agregar o sacar un campo no toque la base.
--
-- La linea entre las dos no es estetica: si mañana hace falta filtrar por algo
-- que hoy vive en `datos`, se promueve a columna con una migracion. Al reves
-- casi nunca conviene.

-- ---------------------------------------------------------------------------
-- No conformidades
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ncd_nc (
    -- El id lo genera la app y se respeta: asi un registro importado conserva
    -- su identidad y las CAPA que lo referencian siguen apuntando bien.
    id              TEXT PRIMARY KEY,
    code            TEXT NOT NULL UNIQUE,
    phase           TEXT NOT NULL,

    -- Año de apertura. Es columna propia y no se deriva en la consulta porque
    -- el selector de año del sidebar filtra todo el sistema y conviene que ese
    -- filtro golpee un indice.
    anio            INT,

    open_date       DATE,
    incident_date   DATE,
    close_date      DATE,
    sector          TEXT,
    source          TEXT,
    classification  TEXT,
    severity        TEXT,
    probability     TEXT,

    datos           JSONB NOT NULL DEFAULT '{}'::jsonb,

    creado_en       TIMESTAMPTZ NOT NULL DEFAULT now(),
    actualizado_en  TIMESTAMPTZ NOT NULL DEFAULT now(),
    actualizado_por TEXT
);

CREATE INDEX IF NOT EXISTS ncd_nc_anio_idx  ON ncd_nc (anio DESC, open_date DESC);
CREATE INDEX IF NOT EXISTS ncd_nc_phase_idx ON ncd_nc (phase);

-- ---------------------------------------------------------------------------
-- Desvios
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ncd_desvios (
    id              TEXT PRIMARY KEY,
    code            TEXT NOT NULL UNIQUE,
    phase           TEXT NOT NULL,
    anio            INT,
    fecha           DATE,
    close_date      DATE,
    sector          TEXT,

    -- Critico / No Critico. Booleano y no texto porque la app ya lo trata como
    -- booleano y los informes cuentan sobre el.
    critico         BOOLEAN NOT NULL DEFAULT false,
    decision        TEXT,
    prioridad       TEXT,

    datos           JSONB NOT NULL DEFAULT '{}'::jsonb,

    creado_en       TIMESTAMPTZ NOT NULL DEFAULT now(),
    actualizado_en  TIMESTAMPTZ NOT NULL DEFAULT now(),
    actualizado_por TEXT
);

CREATE INDEX IF NOT EXISTS ncd_desvios_anio_idx  ON ncd_desvios (anio DESC, fecha DESC);
CREATE INDEX IF NOT EXISTS ncd_desvios_phase_idx ON ncd_desvios (phase);

-- ---------------------------------------------------------------------------
-- Acciones (CAPA)
-- ---------------------------------------------------------------------------
-- Una accion cuelga de una NC o de un desvio, nunca de las dos. Las acciones
-- que se escriben desde la etapa de Implementacion de un desvio (que / quien /
-- cuando) son filas de esta misma tabla con dev_id: asi heredan las alertas de
-- vencimiento y el seguimiento en vez de ser texto suelto que nadie controla.
CREATE TABLE IF NOT EXISTS ncd_capa (
    id                TEXT PRIMARY KEY,
    code              TEXT NOT NULL UNIQUE,

    -- SET NULL y no CASCADE: si alguien borra una NC, sus acciones quedan
    -- huerfanas pero visibles. Perder la accion y su evidencia porque se borro
    -- el registro padre es justo lo que no puede pasar en un sistema GMP.
    nc_id             TEXT REFERENCES ncd_nc(id)      ON DELETE SET NULL,
    dev_id            TEXT REFERENCES ncd_desvios(id) ON DELETE SET NULL,

    tipo              TEXT,
    descripcion       TEXT,
    responsable       TEXT,
    responsable_email TEXT,
    due_date          DATE,
    estado            TEXT NOT NULL DEFAULT 'Abierto',

    datos             JSONB NOT NULL DEFAULT '{}'::jsonb,

    creado_en         TIMESTAMPTZ NOT NULL DEFAULT now(),
    actualizado_en    TIMESTAMPTZ NOT NULL DEFAULT now(),
    actualizado_por   TEXT,

    -- Una accion cuelga de una cosa o de la otra, no de ambas ni de ninguna.
    CONSTRAINT ncd_capa_un_solo_padre CHECK (
        (nc_id IS NOT NULL AND dev_id IS NULL) OR
        (nc_id IS NULL AND dev_id IS NOT NULL) OR
        (nc_id IS NULL AND dev_id IS NULL)
    )
);

-- El panel de alertas busca las no cerradas por fecha de vencimiento: es la
-- consulta mas frecuente de la app.
CREATE INDEX IF NOT EXISTS ncd_capa_vencimiento_idx ON ncd_capa (estado, due_date);
CREATE INDEX IF NOT EXISTS ncd_capa_nc_idx          ON ncd_capa (nc_id);
CREATE INDEX IF NOT EXISTS ncd_capa_dev_idx         ON ncd_capa (dev_id);

-- ---------------------------------------------------------------------------
-- Evidencia adjunta a una accion
-- ---------------------------------------------------------------------------
-- El contenido va en la base y no en disco porque el contenedor no tiene
-- volumen persistente: un archivo escrito en el sistema de archivos desaparece
-- en el proximo deploy. Ademas asi un backup trae la accion y su evidencia
-- juntas, que para GMP es lo que importa.
--
-- Las fotos se reducen en el navegador antes de subirse (lado del cliente), asi
-- que lo tipico son cientos de KB y no varios MB.
CREATE TABLE IF NOT EXISTS ncd_adjuntos (
    id          BIGSERIAL PRIMARY KEY,

    -- Aca si CASCADE: un adjunto no tiene sentido sin su accion, y a diferencia
    -- de la accion no es un registro con vida propia.
    capa_id     TEXT NOT NULL REFERENCES ncd_capa(id) ON DELETE CASCADE,

    nombre      TEXT NOT NULL,
    tipo        TEXT NOT NULL,      -- content-type declarado
    tamano      INT  NOT NULL,      -- bytes, para mostrarlo sin leer el blob
    contenido   BYTEA NOT NULL,

    subido_por  TEXT,
    subido_en   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ncd_adjuntos_capa_idx ON ncd_adjuntos (capa_id, subido_en DESC);

-- ---------------------------------------------------------------------------
-- Audit trail de la app
-- ---------------------------------------------------------------------------
-- Aparte de la tabla `auditoria`, que registra login y accesos. Esta guarda lo
-- que le importa a la app: altas, ediciones, cambios de fase y de estado.
--
-- Solo se inserta. No hay ruta que actualice ni borre filas de esta tabla, y esa
-- es toda la garantia de inmutabilidad que da el diseño: lo que la hace confiable
-- es que ya no vive en el navegador de quien la escribe.
CREATE TABLE IF NOT EXISTS ncd_actividad (
    id       BIGSERIAL PRIMARY KEY,
    ts       TIMESTAMPTZ NOT NULL DEFAULT now(),
    usuario  TEXT,
    accion   TEXT NOT NULL,
    entidad  TEXT,
    detalle  TEXT
);

CREATE INDEX IF NOT EXISTS ncd_actividad_ts_idx ON ncd_actividad (ts DESC);
