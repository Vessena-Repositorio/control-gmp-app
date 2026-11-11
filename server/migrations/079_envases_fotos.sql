-- Fotos de los controles de orden en Control de Calidad Envases.
--
-- Claudia, 11/11/2026: en los controles cada dos horas de una orden de soplado,
-- cuando la analista ve algo raro lo escribe en Observaciones y nada mas. Si ve
-- una rebaba, una deformacion o un envase sucio, la foto vale mas que el texto
-- y despues no hay forma de reconstruirla.
--
-- Misma forma que las fotos de Fabuloso (fab_fotos, migracion 032) y las de
-- Control en proceso (proceso_fotos): la imagen va a la base ya comprimida
-- (lib/comprimir-foto.js), y el control guarda la URL en su `raw.fotos`.
--
-- `referencia` queda con la orden y el control a los que pertenece, para poder
-- rastrear una foto desde la imagen hacia atras.

CREATE TABLE IF NOT EXISTS envases_fotos (
    id          BIGSERIAL PRIMARY KEY,
    nombre      TEXT,
    tipo        TEXT NOT NULL,
    tamano      INT NOT NULL,
    contenido   BYTEA NOT NULL,
    referencia  TEXT,
    subida_por  TEXT,
    subida_en   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS envases_fotos_ref_idx ON envases_fotos (referencia);
