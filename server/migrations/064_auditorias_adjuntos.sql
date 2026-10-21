-- Evidencia de los hallazgos y de los planes de accion (Claudia, 21/10/2026):
-- fotos de la no conformidad, el procedimiento que se redacto, el certificado
-- de la capacitacion. Lo que prueba que la accion se hizo.
--
-- El archivo va al volumen de documentos (DOC_DIR), como en Control de
-- Documentos; aca queda solo la ficha. No se guarda dentro de la coleccion
-- JSON a proposito: adjuntar una foto no tiene por que chocar con alguien que
-- esta guardando la lista de hallazgos en ese momento.
--
-- La referencia es el CODIGO (HAL-0001, ACC-0001), no el id interno: es lo que
-- se ve en la pantalla y lo que sobrevive a una reimportacion.

CREATE TABLE IF NOT EXISTS aud_adjuntos (
    id          bigserial PRIMARY KEY,
    entidad     text NOT NULL CHECK (entidad IN ('hallazgo', 'accion', 'auditoria')),
    referencia  text NOT NULL,
    nombre      text NOT NULL,
    ruta        text NOT NULL,
    sha256      text NOT NULL,
    mime        text NOT NULL,
    bytes       bigint NOT NULL,
    nota        text,
    subido_por  text NOT NULL,
    subido_en   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS aud_adjuntos_ref ON aud_adjuntos (entidad, referencia);
