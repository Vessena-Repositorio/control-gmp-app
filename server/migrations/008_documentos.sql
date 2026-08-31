-- ============================================================================
-- Almacen generico para los dominios que todavia no alimentan ningun dashboard
-- ============================================================================
--
-- Los cuatro dominios anteriores tienen tablas propias porque hay un dashboard
-- consultandolos y el modelo importa. Estos cinco (no conformidades, control de
-- cambios, estabilidad, capacitaciones, devoluciones) no los consulta nadie
-- desde Postgres todavia: sus apps leen y escriben en su propia hoja.
--
-- Inventarles cinco esquemas a medida ahora seria fijar decisiones de modelado
-- sobre datos que nadie va a consultar, y que habria que rehacer cuando se
-- sepa como se van a usar. Lo que si hace falta hoy es que el dato este en
-- Postgres y no se pierda. Por eso se guarda el registro completo, con su
-- identidad, y la normalizacion se hace cuando haya quien la use.
--
-- `raw` es JSON y no JSONB por lo mismo que en el resto: preserva el registro
-- exactamente como lo mando el origen. Para consultar adentro alcanza con
-- raw::jsonb en la consulta.

CREATE TABLE IF NOT EXISTS documentos (
    id              BIGSERIAL PRIMARY KEY,
    dominio         TEXT NOT NULL,   -- no_conformidades | control_cambios | ...
    coleccion       TEXT NOT NULL,   -- ncs | ccs | productos | R | snapshots | ...
    clave_natural   TEXT NOT NULL,   -- id del registro, o 'pos:<n>' si no tiene
    pos             INT,             -- posicion en el origen, para replay ordenado
    raw             JSON NOT NULL,
    sincronizado_en TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (dominio, coleccion, clave_natural)
);

CREATE INDEX IF NOT EXISTS documentos_dominio_idx ON documentos (dominio, coleccion, pos);
