-- ============================================================================
-- Devoluciones: primer dominio donde Postgres pasa a ser la fuente de verdad
-- ============================================================================
--
-- Hasta acá la app escribia en Sheets y Postgres era una copia. Desde este
-- corte es al reves: la app escribe acá, y la replica de este dominio se apaga
-- en el mismo movimiento.
--
-- El apagado NO es opcional. La replica borra de Postgres lo que no esta en la
-- hoja, asi que si siguiera corriendo, el primer registro cargado acá
-- desapareceria en la corrida siguiente. Ver lib/dominios.js.
--
-- Se eligio devoluciones para empezar porque es el de menor riesgo: 17
-- registros, sin notificaciones por mail, y lo usan dos personas.

CREATE TABLE IF NOT EXISTS dev_personas (
    nombre         TEXT PRIMARY KEY,
    creada         TIMESTAMPTZ NOT NULL DEFAULT now(),
    ultimo_ingreso TIMESTAMPTZ
);

-- Indice de meses analizados. Los escalares del resumen van como columnas
-- porque son lo que se consulta y compara entre meses.
CREATE TABLE IF NOT EXISTS dev_meses (
    mes         TEXT NOT NULL,
    anio        INT  NOT NULL,
    fecha       TIMESTAMPTZ,
    total_dev   NUMERIC,
    total_rot   NUMERIC,
    tasa_global NUMERIC,
    persona     TEXT,
    actualizado_en TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (mes, anio)
);

CREATE INDEX IF NOT EXISTS dev_meses_anio_idx ON dev_meses (anio DESC, mes);

-- Resultado del analisis de un mes. Los escalares son columnas; topCatDev,
-- topCatRot, criticos y motivosResumen quedan en JSON porque son estructuras
-- computadas por la app, no entidades con vida propia: normalizarlas obligaria
-- a rehacer el esquema cada vez que cambie el calculo.
CREATE TABLE IF NOT EXISTS dev_snapshots (
    mes             TEXT NOT NULL,
    anio            INT  NOT NULL,
    fecha_analisis  TIMESTAMPTZ,
    umbral          NUMERIC,
    corte           NUMERIC,
    total_dev       NUMERIC,
    total_rot       NUMERIC,
    sku_con_dev     INT,
    sku_con_rot     INT,
    suma_prom       NUMERIC,
    tasa_global     NUMERIC,
    criticos_dev    INT,
    criticos_rot    INT,
    unids_crit_dev  NUMERIC,
    unids_crit_rot  NUMERIC,
    detalle         JSON NOT NULL,   -- topCatDev, topCatRot, criticos, motivosResumen
    raw             JSON NOT NULL,   -- el snapshot completo, tal como lo manda la app
    persona         TEXT,
    actualizado_en  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (mes, anio)
);

CREATE INDEX IF NOT EXISTS dev_snapshots_anio_idx ON dev_snapshots (anio DESC, mes);

CREATE TABLE IF NOT EXISTS dev_motivos (
    mes            TEXT NOT NULL,
    anio           INT  NOT NULL,
    motivos        JSON NOT NULL,
    persona        TEXT,
    actualizado_en TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (mes, anio)
);

-- Datos crudos del mes que la app archiva al analizar. No los vuelve a leer,
-- pero son el respaldo de como se llego al resultado.
CREATE TABLE IF NOT EXISTS dev_mes_datos (
    mes            TEXT NOT NULL,
    anio           INT  NOT NULL,
    datos          JSON NOT NULL,
    persona        TEXT,
    actualizado_en TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (mes, anio)
);

-- Traza de uso propia de la app, aparte de la auditoria de login.
CREATE TABLE IF NOT EXISTS dev_actividad (
    id      BIGSERIAL PRIMARY KEY,
    ts      TIMESTAMPTZ NOT NULL DEFAULT now(),
    persona TEXT,
    accion  TEXT,
    mes     TEXT,
    anio    INT,
    detalle TEXT
);

CREATE INDEX IF NOT EXISTS dev_actividad_ts_idx ON dev_actividad (ts DESC);

-- ---------------------------------------------------------------------------
-- Carga inicial desde la replica que ya esta en `documentos`.
--
-- Se importa de ahi y no del Apps Script a proposito: `documentos` es una copia
-- fiel que ya se verifico, y asi el corte no depende de que Google responda en
-- ese momento.
-- ---------------------------------------------------------------------------

INSERT INTO dev_personas (nombre, creada, ultimo_ingreso)
SELECT d.raw->>'nombre',
       (d.raw->>'creada')::timestamptz,
       (d.raw->>'ultimoIngreso')::timestamptz
FROM documentos d
WHERE d.dominio = 'devoluciones' AND d.coleccion = 'personas'
  AND d.raw->>'nombre' IS NOT NULL
ON CONFLICT (nombre) DO NOTHING;

INSERT INTO dev_meses (mes, anio, fecha, total_dev, total_rot, tasa_global, persona)
SELECT d.raw->>'mes',
       (d.raw->>'anio')::int,
       (d.raw->>'fecha')::timestamptz,
       (d.raw->>'totalDev')::numeric,
       (d.raw->>'totalRot')::numeric,
       (d.raw->>'tasaGlobal')::numeric,
       d.raw->>'persona'
FROM documentos d
WHERE d.dominio = 'devoluciones' AND d.coleccion = 'meses'
  AND d.raw->>'mes' IS NOT NULL AND d.raw->>'anio' IS NOT NULL
ON CONFLICT (mes, anio) DO NOTHING;

INSERT INTO dev_snapshots (
    mes, anio, fecha_analisis, umbral, corte, total_dev, total_rot,
    sku_con_dev, sku_con_rot, suma_prom, tasa_global,
    criticos_dev, criticos_rot, unids_crit_dev, unids_crit_rot,
    detalle, raw
)
SELECT d.raw->>'mes',
       (d.raw->>'anio')::int,
       (d.raw->>'fechaAnalisis')::timestamptz,
       (d.raw->>'umbral')::numeric,
       (d.raw->>'corte')::numeric,
       (d.raw->>'totalDev')::numeric,
       (d.raw->>'totalRot')::numeric,
       (d.raw->>'skuConDev')::int,
       (d.raw->>'skuConRot')::int,
       (d.raw->>'sumaProm')::numeric,
       (d.raw->>'tasaGlobal')::numeric,
       (d.raw->>'criticosDev')::int,
       (d.raw->>'criticosRot')::int,
       (d.raw->>'unidsCritDev')::numeric,
       (d.raw->>'unidsCritRot')::numeric,
       json_build_object(
           'topCatDev',      d.raw->'topCatDev',
           'topCatRot',      d.raw->'topCatRot',
           'criticos',       d.raw->'criticos',
           'motivosResumen', d.raw->'motivosResumen'
       ),
       d.raw
FROM documentos d
WHERE d.dominio = 'devoluciones' AND d.coleccion = 'snapshots'
  AND d.raw->>'mes' IS NOT NULL AND d.raw->>'anio' IS NOT NULL
ON CONFLICT (mes, anio) DO NOTHING;
