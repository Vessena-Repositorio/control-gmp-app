-- ============================================================================
-- Identidades y credenciales, para no tener que recrear usuarios en el corte
-- ============================================================================
--
-- Los padrones estan repartidos en varios sistemas y cada uno guarda la clave
-- con su propio esquema. Migrarlos verbatim conservaria el acceso pero tambien
-- la debilidad: `estabilidad` hashea el PIN con djb2, que es una funcion para
-- tablas de dispersion, no de contraseñas. Un PIN de 4 digitos se revierte
-- probando 10.000 combinaciones.
--
-- Por eso la credencial guarda el ESQUEMA junto al valor. El login verifica
-- contra el esquema que haya, y en el primer acceso exitoso reescribe la
-- credencial a uno fuerte. Nadie queda afuera y el esquema debil se drena solo
-- a medida que la gente entra.

CREATE TABLE IF NOT EXISTS usuarios (
    id        BIGSERIAL PRIMARY KEY,
    origen    TEXT NOT NULL,   -- de que sistema vino: estabilidad | envases | portal | ...
    usuario   TEXT NOT NULL,   -- identificador con el que se loguea
    email     TEXT,
    nombre    TEXT,
    rol       TEXT,
    activo    BOOLEAN NOT NULL DEFAULT true,
    creado_en TIMESTAMPTZ,
    sincronizado_en TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- La clave incluye el origen a proposito. Unificar a la misma persona entre
    -- sistemas es una decision de negocio, no algo que deba resolver el sync:
    -- 'claudia' en envases y 'claudia.barlocco@vessena.com.uy' en estabilidad
    -- probablemente sean la misma persona, pero fusionarlas en silencio
    -- mezclaria roles y permisos de sistemas distintos.
    UNIQUE (origen, usuario)
);

CREATE INDEX IF NOT EXISTS usuarios_usuario_idx ON usuarios (lower(usuario));
CREATE INDEX IF NOT EXISTS usuarios_email_idx   ON usuarios (lower(email));
CREATE INDEX IF NOT EXISTS usuarios_activo_idx  ON usuarios (activo) WHERE activo;

CREATE TABLE IF NOT EXISTS credenciales (
    id            BIGSERIAL PRIMARY KEY,
    usuario_id    BIGINT NOT NULL UNIQUE REFERENCES usuarios (id) ON DELETE CASCADE,

    -- djb2      : el hash de PIN de estabilidad, NO criptografico
    -- sha256    : sha256 sin sal, del portal y de envases
    -- scrypt    : el destino; el unico apto para contraseñas
    esquema       TEXT NOT NULL CHECK (esquema IN ('djb2', 'sha256', 'scrypt')),
    valor         TEXT NOT NULL,
    migrado_en    TIMESTAMPTZ,   -- cuando se reescribio a scrypt
    actualizado_en TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS credenciales_esquema_idx ON credenciales (esquema);

COMMENT ON COLUMN credenciales.esquema IS
    'Esquema con el que esta guardado `valor`. Los que no son scrypt vienen del sistema viejo y se reescriben en el primer login exitoso.';
