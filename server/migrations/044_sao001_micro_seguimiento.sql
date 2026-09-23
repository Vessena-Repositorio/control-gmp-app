-- ============================================================================
-- SAO-001: micro fuera de especificacion -> 3 muestreos inmediatos del punto
-- ============================================================================
--
-- Pedido de Claudia (23/09/2026): cuando el recuento supera el MAXIMO de micro
-- de ese punto, hay que muestrearlo enseguida 3 veces seguidas para ver como
-- esta. Los 3 se crean juntos como pendientes y se completan a medida que
-- salen los resultados.
--
-- Si alguno de esos 3 vuelve a superar el maximo, no se piden mas muestreos:
-- se pide la LIMPIEZA INMEDIATA del punto. Registrada la limpieza, se vuelven
-- a pedir 3 muestreos para verificar como quedo.
--
-- El nivel de alerta no dispara nada de esto: solo el maximo (decision suya).

ALTER TABLE sao001_registros ADD COLUMN IF NOT EXISTS seguimiento_de BIGINT REFERENCES sao001_registros (id);
ALTER TABLE sao001_registros ADD COLUMN IF NOT EXISTS seguimiento_n  INT;

-- Un muestreo inmediato pedido. Queda pendiente hasta que se carga su muestra.
CREATE TABLE IF NOT EXISTS sao001_seguimientos (
    id            BIGSERIAL PRIMARY KEY,
    punto         TEXT   NOT NULL REFERENCES sao001_puntos (codigo),
    origen_id     BIGINT NOT NULL REFERENCES sao001_registros (id),
    n             INT    NOT NULL,          -- 1, 2 o 3
    motivo        TEXT,                     -- 'micro' | 'limpieza'
    creado_en     TIMESTAMPTZ NOT NULL DEFAULT now(),
    registro_id   BIGINT REFERENCES sao001_registros (id),
    completado_en TIMESTAMPTZ,
    UNIQUE (origen_id, n)
);

CREATE INDEX IF NOT EXISTS sao001_seguimientos_pend_idx
    ON sao001_seguimientos (punto, n) WHERE registro_id IS NULL;

-- La limpieza que se pide cuando el punto vuelve a dar alto en el seguimiento.
CREATE TABLE IF NOT EXISTS sao001_limpiezas (
    id            BIGSERIAL PRIMARY KEY,
    punto         TEXT   NOT NULL REFERENCES sao001_puntos (codigo),
    origen_id     BIGINT NOT NULL UNIQUE REFERENCES sao001_registros (id),
    solicitada_en TIMESTAMPTZ NOT NULL DEFAULT now(),
    hecha_en      TIMESTAMPTZ,
    hecha_por     TEXT,
    detalle       TEXT
);
