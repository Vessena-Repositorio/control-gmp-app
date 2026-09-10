-- ============================================================================
-- Capacitaciones: Postgres pasa a ser la fuente de verdad
-- ============================================================================
--
-- La app guarda con `saveAll` y manda las cuatro colecciones enteras: R (los
-- registros), PL (el plan), PE (el personal) y AUDIT (la auditoria). Se replica
-- ese contrato en vez de normalizar, por lo mismo que en estabilidad: el cambio
-- del lado del cliente queda en cambiar la URL, y normalizar obligaria a
-- reescribir como lee y escribe toda la app justo en el corte, que es cuando
-- menos conviene mover cosas.
--
-- Normalizar sigue siendo posible despues y con menos riesgo: una vez que los
-- datos entran por nuestra API se pueden promover campos a columnas sin que la
-- app se entere.
--
-- ---------------------------------------------------------------------------
-- Por que esta tabla SI lleva version, y la de estabilidad no
-- ---------------------------------------------------------------------------
-- En estabilidad se dejo anotado que "la ultima escritura pisa a la primera" y
-- que el Apps Script tenia el mismo problema, asi que no empeoraba nada.
--
-- Aca no alcanza con anotarlo, porque ya nos paso. El 09/09/2026 la app se
-- quedo sin datos en localStorage, cayo a los 172 registros de demostracion que
-- traia el codigo, y `saveAll` los escribio encima de los 3.130 reales. No hubo
-- ningun aviso: el guardado completo no puede distinguir "me borraron todo" de
-- "borraron todo a proposito".
--
-- `version` sube en cada escritura. Quien guarda tiene que decir cual leyo; si
-- no coincide con la que hay, la escritura se rechaza y el cliente vuelve a
-- leer. Eso convierte "el ultimo gana" en "el segundo se entera", que es lo
-- unico que hace falta para que dos personas trabajando a la vez no se pisen.

CREATE TABLE IF NOT EXISTS capacitaciones_datos (
    clave           TEXT PRIMARY KEY,       -- R, PL, PE, AUDIT
    valor           TEXT NOT NULL,          -- JSON serializado, como lo manda la app
    version         BIGINT NOT NULL DEFAULT 1,
    actualizado_en  TIMESTAMPTZ NOT NULL DEFAULT now(),
    actualizado_por TEXT
);

-- ---------------------------------------------------------------------------
-- Respaldo de cada escritura completa
-- ---------------------------------------------------------------------------
-- Un registro de capacitacion es evidencia GMP: si se pierde, no se reconstruye
-- preguntando. Cada vez que se reescribe una coleccion se guarda como quedaba
-- antes, con quien la escribio y cuando.
--
-- No es un historial de cambios -no dice que se modifico- sino una red: permite
-- volver al estado anterior sin depender de que alguien tuviera la pestaña
-- abierta. Con lo que ocupan las cuatro colecciones, guardar cada version es
-- barato al lado de lo que cuesta perder una.
CREATE TABLE IF NOT EXISTS capacitaciones_respaldos (
    id           BIGSERIAL PRIMARY KEY,
    clave        TEXT NOT NULL,
    valor        TEXT NOT NULL,
    version      BIGINT NOT NULL,
    guardado_en  TIMESTAMPTZ NOT NULL DEFAULT now(),
    guardado_por TEXT,
    motivo       TEXT
);

CREATE INDEX IF NOT EXISTS ix_capacitaciones_respaldos_clave
    ON capacitaciones_respaldos (clave, guardado_en DESC);

-- ---------------------------------------------------------------------------
-- Siembra desde la replica
-- ---------------------------------------------------------------------------
-- Los datos ya estan en Postgres: la replica los guardo en `documentos`, una
-- fila por registro. Se los vuelve a juntar en el arreglo que espera la app,
-- para que el corte no dependa de una descarga mas desde Google, que podria
-- fallar o traer algo distinto justo en el momento del corte.
--
-- `pos` conserva el orden original de la hoja, que es el que la app espera.
INSERT INTO capacitaciones_datos (clave, valor, actualizado_por)
SELECT coleccion,
       json_agg(raw ORDER BY pos NULLS LAST, id)::text,
       'siembra desde la replica'
FROM documentos
WHERE dominio = 'capacitaciones'
GROUP BY coleccion
ON CONFLICT (clave) DO NOTHING;

-- Las cuatro colecciones tienen que existir aunque vengan vacias: si una falta,
-- la app recibe undefined y no sabe distinguir "no hay plan cargado" de "no se
-- pudo leer el plan".
INSERT INTO capacitaciones_datos (clave, valor, actualizado_por)
SELECT c, '[]', 'coleccion vacia al sembrar'
FROM (VALUES ('R'), ('PL'), ('PE'), ('AUDIT')) AS t(c)
ON CONFLICT (clave) DO NOTHING;
