-- ============================================================================
-- Sesiones y auditoria
-- ============================================================================

CREATE TABLE IF NOT EXISTS sesiones (
    id          BIGSERIAL PRIMARY KEY,

    -- Se guarda el sha256 del token, no el token. Asi una copia de la base no
    -- alcanza para hacerse pasar por nadie: el valor que viaja en la cookie
    -- nunca queda escrito.
    token_hash  TEXT NOT NULL UNIQUE,

    usuario_id  BIGINT NOT NULL REFERENCES usuarios (id) ON DELETE CASCADE,
    creada_en   TIMESTAMPTZ NOT NULL DEFAULT now(),
    expira_en   TIMESTAMPTZ NOT NULL,
    cerrada_en  TIMESTAMPTZ,
    ip          TEXT,
    user_agent  TEXT
);

CREATE INDEX IF NOT EXISTS sesiones_usuario_idx ON sesiones (usuario_id);
CREATE INDEX IF NOT EXISTS sesiones_vivas_idx   ON sesiones (expira_en)
    WHERE cerrada_en IS NULL;

-- Traza de quien hizo que y cuando. En GMP la firma del analista es parte del
-- registro, asi que los intentos fallidos tambien se guardan: sin ellos no se
-- puede distinguir un olvido de contraseña de alguien probando claves.
CREATE TABLE IF NOT EXISTS auditoria (
    id         BIGSERIAL PRIMARY KEY,
    ts         TIMESTAMPTZ NOT NULL DEFAULT now(),
    usuario_id BIGINT REFERENCES usuarios (id) ON DELETE SET NULL,

    -- Se guarda tambien el texto tal como se intento entrar: si el usuario no
    -- existe no hay usuario_id, y sin esto no quedaria rastro de que se probo.
    usuario_txt TEXT,

    accion     TEXT NOT NULL,   -- login_ok | login_fallido | logout | cambio_clave | ...
    recurso    TEXT,
    detalle    TEXT,
    ip         TEXT,
    user_agent TEXT
);

CREATE INDEX IF NOT EXISTS auditoria_ts_idx      ON auditoria (ts DESC);
CREATE INDEX IF NOT EXISTS auditoria_usuario_idx ON auditoria (usuario_id, ts DESC);
CREATE INDEX IF NOT EXISTS auditoria_accion_idx  ON auditoria (accion, ts DESC);
