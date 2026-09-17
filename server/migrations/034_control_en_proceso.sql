-- ============================================================================
-- Control en proceso: la app escribe en Postgres (sale del Apps Script)
-- ============================================================================
--
-- Hasta el 17/09/2026 control-en-proceso.html mandaba cada control al Apps
-- Script con un POST no-cors -sin poder saber si se guardo- y el servidor solo
-- replicaba la hoja para el informe gerencial. Ahora la app escribe aca, con la
-- sesion del portal, y la hoja queda cerrada despues de una ultima replica.
--
-- Los controles nuevos van a la MISMA tabla que la replica: el informe
-- gerencial lee /api/proceso y no tiene que enterarse del cambio.
--
--   origen = 'planilla'  filas de la hoja (identidad: pos, como antes)
--   origen = 'app'       filas cargadas desde la app (pos NULL, id_envio)

ALTER TABLE proceso_controles ALTER COLUMN pos DROP NOT NULL;
ALTER TABLE proceso_controles ADD COLUMN IF NOT EXISTS origen TEXT NOT NULL DEFAULT 'planilla';
-- Fila de la hoja (1 = encabezado). doGet devolvia la hoja al reves, asi que
-- pos 0 es la ultima fila: fila = cantidad - pos + 1.
ALTER TABLE proceso_controles ADD COLUMN IF NOT EXISTS fila_hoja INT;
ALTER TABLE proceso_controles ADD COLUMN IF NOT EXISTS registrado_por_id BIGINT REFERENCES usuarios (id);
ALTER TABLE proceso_controles ADD COLUMN IF NOT EXISTS registrado_en TIMESTAMPTZ;
-- Lo genera la pantalla por cada control: si el envio se reintenta, no se
-- guarda dos veces. Es lo que la hoja no podia hacer (ver 007).
ALTER TABLE proceso_controles ADD COLUMN IF NOT EXISTS id_envio TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS proceso_id_envio_idx
    ON proceso_controles (id_envio) WHERE id_envio IS NOT NULL;
CREATE INDEX IF NOT EXISTS proceso_origen_idx ON proceso_controles (origen, id);

-- Fotos de los controles nuevos. Las viejas quedan como enlace a Drive.
CREATE TABLE IF NOT EXISTS proceso_fotos (
    id          BIGSERIAL PRIMARY KEY,
    nombre      TEXT NOT NULL,
    tipo        TEXT NOT NULL,
    tamano      INT NOT NULL,
    contenido   BYTEA NOT NULL,
    subida_por  TEXT,
    subida_en   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Bitacora de la app: solo se inserta.
CREATE TABLE IF NOT EXISTS proceso_actividad (
    id          BIGSERIAL PRIMARY KEY,
    ts          TIMESTAMPTZ NOT NULL DEFAULT now(),
    usuario     TEXT,
    rol         TEXT,
    accion      TEXT NOT NULL,
    entidad     TEXT,
    entidad_id  TEXT,
    detalles    TEXT
);

-- Resultados del cuestionario de entrenamiento (hoja "Entrenamientos").
CREATE TABLE IF NOT EXISTS proceso_entrenamientos (
    id          BIGSERIAL PRIMARY KEY,
    fecha       TIMESTAMPTZ,
    analista    TEXT,
    puntaje     NUMERIC,
    correctas   INT,
    total       INT,
    aprobado    TEXT,
    detalle     TEXT,
    origen      TEXT NOT NULL DEFAULT 'planilla'
);

-- Cierre de la planilla. Con esta fila la replica deja de tocar la tabla: la
-- hoja ya no es la fuente de verdad y el Apps Script se archiva.
CREATE TABLE IF NOT EXISTS proceso_corte (
    unica       BOOLEAN PRIMARY KEY DEFAULT true CHECK (unica),
    cerrado_en  TIMESTAMPTZ NOT NULL DEFAULT now(),
    cerrado_por TEXT,
    detalle     TEXT
);

-- Quien carga controles: Mónica y analista.minilab@ ya son operadoras (010).
