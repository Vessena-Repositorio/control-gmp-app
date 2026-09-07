-- ============================================================================
-- Estabilidad: Postgres pasa a ser la fuente de verdad
-- ============================================================================
--
-- La app guarda con un modelo clave -> valor: `gWrite('studies', [...])` manda
-- el arreglo entero serializado, y `gRead()` devuelve todas las claves de una.
-- Se replica ese contrato tal cual en vez de normalizar los estudios en tablas,
-- por dos razones:
--
--   - El cambio del lado del cliente queda en cambiar la URL. Normalizar
--     obligaria a reescribir como lee y escribe toda la app, que es mucho mas
--     superficie para romper en un corte que ya toca datos de calidad.
--   - El esquema de un estudio de estabilidad todavia se mueve (checkpoints con
--     condiciones, sin condiciones, T0). Fijarlo en columnas ahora pediria una
--     migracion por cada ajuste del formulario.
--
-- Normalizar sigue siendo posible despues, y con menos riesgo: una vez que los
-- datos entran por nuestra API, se pueden ir promoviendo campos a columnas sin
-- que la app se entere.
--
-- ---------------------------------------------------------------------------
-- Lo que este modelo NO resuelve
-- ---------------------------------------------------------------------------
-- Cada guardado reescribe la coleccion completa, asi que si dos personas editan
-- estudios distintos al mismo tiempo, la ultima escritura pisa a la primera.
-- El Apps Script tiene exactamente el mismo problema y nadie lo noto, asi que
-- esto no empeora nada. Queda anotado porque ahora si se puede arreglar: el
-- guardado toma un lock y, cuando haga falta, se le agrega control de version.

CREATE TABLE IF NOT EXISTS estabilidad_datos (
    clave           TEXT PRIMARY KEY,
    valor           TEXT NOT NULL,          -- JSON serializado, como lo manda la app
    actualizado_en  TIMESTAMPTZ NOT NULL DEFAULT now(),
    actualizado_por TEXT
);

-- ---------------------------------------------------------------------------
-- Siembra desde la replica
-- ---------------------------------------------------------------------------
-- Los datos ya estan en Postgres: la replica los guardo en `documentos`, una
-- fila por estudio. Se los vuelve a juntar en el arreglo que espera la app, para
-- que el corte no dependa de una descarga mas desde Google -que podria fallar o
-- traer algo distinto justo en el momento del corte-.
--
-- El orden importa: `pos` conserva el orden original de la hoja, que es el que
-- la app espera al abrir la lista.
INSERT INTO estabilidad_datos (clave, valor, actualizado_por)
SELECT coleccion,
       json_agg(raw ORDER BY pos NULLS LAST, id)::text,
       'siembra desde la replica'
FROM documentos
WHERE dominio = 'estabilidad'
GROUP BY coleccion
ON CONFLICT (clave) DO NOTHING;
