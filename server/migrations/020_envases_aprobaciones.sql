-- ============================================================================
-- Aprobacion de controles de calidad de envases
-- ============================================================================
--
-- La aprobacion no puede vivir en la planilla: el `updateLCC` del Apps Script
-- responde {success:true, message:'Control guardado'} y descarta las
-- mediciones. Se probo de punta a punta -guardar y releer- y el campo vuelve a
-- 'pendiente'. Mientras eso siga asi, cualquier aprobacion escrita ahi se
-- pierde sin avisar.
--
-- Vive aca, y ademas es mejor lugar:
--
--   - El permiso se puede exigir de verdad. En la pantalla el boton se puede
--     esconder, pero esconder no es impedir; el servidor si impide.
--   - Queda un registro consultable por SQL, con quien y cuando, en vez de un
--     campo adentro de un JSON adentro de una celda.
--   - No depende de codigo que no controlamos.
--
-- La contra, asumida: el control sigue en la planilla y su `_aprobado` de ahi
-- queda desactualizado. Quien mire la planilla directo va a ver 'pendiente'.
-- Se resuelve cuando esta app corte su escritura a Postgres.

CREATE TABLE IF NOT EXISTS envases_aprobaciones (
    -- Misma clave natural que usa la replica: 'lcc:<id>' | 'orden:<id>:<ts>'.
    -- Asi la aprobacion se puede cruzar con `controles` sin inventar un id
    -- paralelo que despues haya que mantener en dos lados.
    control_clave TEXT PRIMARY KEY,

    -- Se guardan las dos cosas: el usuario para poder cruzar, y el nombre tal
    -- como estaba al aprobar. Si mañana alguien cambia de apellido o se da de
    -- baja, el registro tiene que seguir diciendo quien firmo ese dia.
    usuario_id    BIGINT REFERENCES usuarios (id),
    aprobado_por  TEXT NOT NULL,

    aprobado_en   TIMESTAMPTZ NOT NULL DEFAULT now(),
    nota          TEXT
);

CREATE INDEX IF NOT EXISTS envases_aprobaciones_fecha_idx
    ON envases_aprobaciones (aprobado_en DESC);
