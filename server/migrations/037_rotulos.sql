-- ============================================================================
-- Verificacion de rotulo por supervision (Fabuloso y Control en proceso)
-- ============================================================================
--
-- Pedido de Claudia (18/09/2026): paso mas de una vez que el lote o el
-- vencimiento de una orden estaban mal y la analista no se dio cuenta. El
-- primer control de cada orden manda las fotos de caja y envase a Antonella,
-- Gloria y Claudia; una de ellas da el OK o pide la correccion del rotulo, todo
-- en la app porque las analistas estan en planta.
--
-- Desde las 12:00 (ROTULO_HORA_CORTE), una orden sin OK no acepta mas controles.
-- Una correccion no frena la orden: la analista sube las fotos corregidas y
-- vuelve a supervision. Si el error es critico (un vencimiento) se marca
-- reproceso.

CREATE TABLE IF NOT EXISTS rotulo_verificaciones (
    id              BIGSERIAL PRIMARY KEY,
    app             TEXT NOT NULL CHECK (app IN ('fabuloso', 'proceso')),
    orden           TEXT NOT NULL,
    estado          TEXT NOT NULL DEFAULT 'pendiente'
                    CHECK (estado IN ('pendiente', 'ok', 'correccion')),
    foto_caja       TEXT,
    foto_envase     TEXT,
    lote            TEXT,
    vence           TEXT,
    producto        TEXT,
    analista        TEXT,
    analista_id     BIGINT REFERENCES usuarios (id),
    creado_en       TIMESTAMPTZ NOT NULL DEFAULT now(),
    actualizado_en  TIMESTAMPTZ NOT NULL DEFAULT now(),
    revisado_por    TEXT,
    revisado_por_id BIGINT REFERENCES usuarios (id),
    revisado_en     TIMESTAMPTZ,
    comentario      TEXT,
    reproceso       BOOLEAN NOT NULL DEFAULT false,
    ultimo_pedido   TIMESTAMPTZ,
    UNIQUE (app, orden)
);

CREATE INDEX IF NOT EXISTS rotulo_estado_idx ON rotulo_verificaciones (estado, creado_en DESC);

-- Todo lo que paso con cada verificacion, en orden. Solo se inserta.
CREATE TABLE IF NOT EXISTS rotulo_eventos (
    id              BIGSERIAL PRIMARY KEY,
    verificacion_id BIGINT NOT NULL REFERENCES rotulo_verificaciones (id) ON DELETE CASCADE,
    ts              TIMESTAMPTZ NOT NULL DEFAULT now(),
    usuario         TEXT,
    accion          TEXT NOT NULL,   -- primer_control | ok | correccion | corregido | solicitud
    comentario      TEXT,
    foto_caja       TEXT,
    foto_envase     TEXT,
    reproceso       BOOLEAN
);

CREATE INDEX IF NOT EXISTS rotulo_eventos_idx ON rotulo_eventos (verificacion_id, ts);

-- Quienes revisan: Antonella, Gloria y Claudia.
INSERT INTO notificacion_supervisores (recurso, notificacion, usuario_id, nota)
SELECT 'rotulos', 'verificacion', u.id, 'OK de rotulo del primer control de cada orden'
FROM usuarios u
WHERE u.origen = 'vessena'
  AND lower(u.usuario) IN (
      'claudia.barlocco@vessena.com.uy',
      'antonella.nunez@vessena.com.uy',
      'gloria.nunez@vessena.com.uy'
  )
ON CONFLICT DO NOTHING;
