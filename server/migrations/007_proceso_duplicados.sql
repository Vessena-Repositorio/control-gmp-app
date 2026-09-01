-- Los 4 pares de controles identicos que hay en la hoja de control en proceso
-- inflan los KPIs: cuentan dos veces en los totales y pesan doble en los
-- promedios de informe-gerencial.
--
-- Se marcan, NO se borran. En un sistema GMP el registro de que hubo un doble
-- envio es parte de la trazabilidad, y borrarlo dejaria la replica sin forma de
-- explicar por que tiene menos filas que la hoja. La API los excluye por
-- defecto y los devuelve si se los pide explicitamente.
--
-- El error sigue en la hoja de origen: esto no lo corrige alla.
ALTER TABLE proceso_controles ADD COLUMN IF NOT EXISTS huella TEXT;
ALTER TABLE proceso_controles ADD COLUMN IF NOT EXISTS duplicado_de INT;

COMMENT ON COLUMN proceso_controles.huella IS
    'sha256 del contenido del registro; dos iguales son el mismo control enviado dos veces';
COMMENT ON COLUMN proceso_controles.duplicado_de IS
    'pos de la primera aparicion de este mismo contenido; NULL si es la primera';

CREATE INDEX IF NOT EXISTS proceso_huella_idx ON proceso_controles (huella);

-- El indice parcial cubre la consulta habitual: todo menos los duplicados.
CREATE INDEX IF NOT EXISTS proceso_no_dup_idx ON proceso_controles (pos)
    WHERE duplicado_de IS NULL;
