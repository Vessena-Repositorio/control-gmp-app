-- ============================================================================
-- Estabilidad: respaldo antes de cada escritura
-- ============================================================================
--
-- En la 017 quedo anotado que cada guardado reescribe la coleccion entera y
-- que "la ultima escritura pisa a la primera". El 11/09/2026 se vio el costo:
-- el catalogo perdia lo que se escribia en el formulario y un guardado piso
-- datos de productos que no se estaban editando. Sin ningun respaldo, no habia
-- forma de ver que habia antes.
--
-- Igual que en capacitaciones: no es un historial de cambios sino una red.
-- Cada vez que el servidor reescribe una coleccion guarda como estaba.

CREATE TABLE IF NOT EXISTS estabilidad_respaldos (
    id           BIGSERIAL PRIMARY KEY,
    clave        TEXT NOT NULL,
    valor        TEXT NOT NULL,
    guardado_en  TIMESTAMPTZ NOT NULL DEFAULT now(),
    guardado_por TEXT,
    motivo       TEXT
);

CREATE INDEX IF NOT EXISTS ix_estabilidad_respaldos_clave
    ON estabilidad_respaldos (clave, id DESC);

-- ---------------------------------------------------------------------------
-- Dos puntos de partida
-- ---------------------------------------------------------------------------
-- 1) La copia de la hoja de Google que trajo la replica hasta el corte del
--    07/09/2026. Es el ultimo estado conocido antes de que la app empezara a
--    escribir en Postgres, y sirve para ver que se perdio desde entonces. Las
--    filas siguen en `documentos` aunque la replica este apagada; se copian
--    aca para que la comparacion no dependa de que alguien las limpie.
INSERT INTO estabilidad_respaldos (clave, valor, guardado_por, motivo)
SELECT coleccion,
       json_agg(raw ORDER BY pos NULLS LAST, id)::text,
       'migracion 023',
       'copia de la replica de Google (corte 07/09/2026)'
FROM documentos
WHERE dominio = 'estabilidad'
GROUP BY coleccion;

-- 2) Como estan las colecciones ahora, antes de que el arreglo toque nada.
INSERT INTO estabilidad_respaldos (clave, valor, guardado_por, motivo)
SELECT clave, valor, 'migracion 023', 'estado al activar los respaldos'
FROM estabilidad_datos;
