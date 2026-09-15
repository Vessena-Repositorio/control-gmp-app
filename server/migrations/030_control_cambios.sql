-- ============================================================================
-- Control de Cambios: tablas propias, sembradas desde la replica
-- ============================================================================
--
-- Control de Cambios es lo ultimo que usa el Apps Script compartido con la app
-- vieja de No Conformidades (ORIGEN_NC). Mientras dependa de el, ese script no
-- se puede archivar, y hoy responde getAll_CC sin autenticacion. Depende de el
-- para cinco cosas: leer (getAll_CC), guardar (saveCC), borrar (deleteCC),
-- mandar el mail al asignar una tarea (notifyCC) y subir evidencias a Drive
-- (uploadImg).
--
-- Esta migracion es el lado del servidor SIN cortar: crea las tablas y copia lo
-- que la replica ya trajo. La app sigue escribiendo en el Apps Script hasta el
-- corte, asi que la copia se va a quedar vieja; el dia del corte se vuelve a
-- copiar con POST /api/control-cambios/resembrar, que se niega si la app ya
-- escribio algo aca.
--
-- ---------------------------------------------------------------------------
-- Una fila por cambio, y no un bloque con todos
-- ---------------------------------------------------------------------------
-- Estabilidad guardo todos sus estudios como un unico valor y le costo un
-- arreglo (5d3612e): dos personas guardando a la vez se pisaban. Aca cada cambio
-- es su fila, con `version` para detectar que otra persona lo guardo en el
-- medio.
--
-- El registro completo va en `datos` con los nombres de campo de la app. Solo se
-- promueve a columna lo que se filtra: numero, estado y año.
--
-- ---------------------------------------------------------------------------
-- Sin conversiones de fecha
-- ---------------------------------------------------------------------------
-- Las fechas vienen de una planilla. Un ::date sobre un valor invalido aborta la
-- migracion entera, y la migracion corre al arrancar el contenedor. El año se
-- saca con una expresion regular que solo devuelve digitos; los plazos de las
-- tareas se validan en JavaScript, en los avisos.

CREATE TABLE IF NOT EXISTS cc_cambios (
    -- El id lo genera la app (Date.now()) y se usa sin comillas en los
    -- manejadores de la pagina, asi que tiene que seguir siendo numerico.
    id              BIGINT PRIMARY KEY,
    numero          TEXT,
    estado          TEXT NOT NULL DEFAULT 'Solicitado',
    anio            INT,
    datos           JSONB NOT NULL,
    version         INT NOT NULL DEFAULT 1,
    creado_en       TIMESTAMPTZ NOT NULL DEFAULT now(),
    actualizado_en  TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- 'siembra desde la replica' mientras nadie la toque desde la app. Es lo que
    -- mira /resembrar para saber si todavia puede copiar sin pisar nada.
    actualizado_por TEXT
);

-- numero no es UNIQUE a proposito: los datos vienen de una planilla donde nada
-- impedia repetirlo, y una restriccion haria fallar la siembra. Los numeros
-- nuevos los asigna el servidor.
CREATE INDEX IF NOT EXISTS cc_cambios_estado_idx ON cc_cambios (estado);
CREATE INDEX IF NOT EXISTS cc_cambios_numero_idx ON cc_cambios (anio, numero);

-- Evidencias fotograficas nuevas. Las que ya estan en Drive no se tocan: archivar
-- el Apps Script no borra los archivos de Drive, y sus enlaces siguen en `datos`.
-- Las nuevas van a la base porque el contenedor no tiene disco persistente.
CREATE TABLE IF NOT EXISTS cc_adjuntos (
    id          BIGSERIAL PRIMARY KEY,
    cambio_id   BIGINT NOT NULL REFERENCES cc_cambios(id) ON DELETE CASCADE,
    nombre      TEXT NOT NULL,
    tipo        TEXT NOT NULL,
    tamano      INT  NOT NULL,
    contenido   BYTEA NOT NULL,
    subido_por  TEXT,
    subido_en   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS cc_adjuntos_cambio_idx ON cc_adjuntos (cambio_id, subido_en DESC);

-- Traza de la app. Solo se inserta: ninguna ruta la edita ni la borra.
CREATE TABLE IF NOT EXISTS cc_actividad (
    id       BIGSERIAL PRIMARY KEY,
    ts       TIMESTAMPTZ NOT NULL DEFAULT now(),
    usuario  TEXT,
    accion   TEXT NOT NULL,
    cambio   TEXT,
    detalle  TEXT
);

CREATE INDEX IF NOT EXISTS cc_actividad_ts_idx ON cc_actividad (ts DESC);

-- ---------------------------------------------------------------------------
-- Siembra desde la replica
-- ---------------------------------------------------------------------------
-- Un registro sin id numerico recibe uno sintetico, por encima de cualquier
-- Date.now() razonable, y se escribe tambien dentro de `datos` para que la app
-- lo encuentre.
INSERT INTO cc_cambios (id, numero, estado, anio, datos, actualizado_por)
SELECT x.id,
       x.raw->>'numero',
       coalesce(nullif(x.raw->>'estado', ''), 'Solicitado'),
       substring(x.raw->>'fechaSolicitud' from '^([0-9]{4})')::int,
       jsonb_set(x.raw, '{id}', to_jsonb(x.id)),
       'siembra desde la replica'
FROM (
    SELECT CASE WHEN d.raw->>'id' ~ '^[0-9]{1,15}$'
                THEN (d.raw->>'id')::bigint
                ELSE 900000000000000 + d.id
           END AS id,
           d.raw::jsonb AS raw
    FROM documentos d
    WHERE d.dominio = 'control_cambios'
      AND d.coleccion = 'ccs'
      AND json_typeof(d.raw) = 'object'
) x
ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Quien recibe la copia del resumen de tareas vencidas
-- ---------------------------------------------------------------------------
-- Decision de Claudia, 15/09/2026: Claudia y Gloria. Cada responsable recibe
-- ademas lo suyo, por el mail cargado en la tarea.
INSERT INTO notificacion_supervisores (recurso, notificacion, usuario_id, nota)
SELECT r.recurso, r.notificacion, u.id, r.nota
FROM (VALUES
    ('control-cambios', 'tareas-vencidas', 'claudia.barlocco@vessena.com.uy', 'responsable de calidad'),
    ('control-cambios', 'tareas-vencidas', 'gloria.nunez@vessena.com.uy',     'aseguramiento de calidad')
) AS r(recurso, notificacion, email, nota)
JOIN usuarios u ON lower(u.usuario) = lower(r.email)
ON CONFLICT (recurso, notificacion, usuario_id) DO NOTHING;
