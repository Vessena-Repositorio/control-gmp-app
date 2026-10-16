-- ============================================================================
-- Datos Logisticos: la ficha se arma sobre la plantilla de Finanzas
-- ============================================================================
--
-- Claudia (16/10/2026): "el formato de la ficha lo tengo que mantener, es a lo
-- que esta acostumbrada Marianela". La ficha que generaba la pantalla tenia los
-- mismos datos en las mismas celdas, pero sin el formato del formulario: los
-- titulos en amarillo, los recuadros, los anchos de columna y la hoja
-- Parametros con las listas.
--
-- Asi que la ficha deja de dibujarse y pasa a llenarse: se sube una vez
-- "PLANTILLA BASE.xlsx" -el formulario en blanco, con sus formulas- y cada
-- ficha es esa plantilla con los valores escritos en las celdas que van a mano.
-- Lo demas lo calculan las formulas del propio formulario, como hoy.
--
-- La plantilla no vive en el repositorio (es un formulario interno): se guarda
-- en el volumen de documentos, como los demas archivos. Cada vez que Finanzas
-- cambie el formulario, se sube la version nueva y las fichas salen con ese.

CREATE TABLE IF NOT EXISTS dl_plantilla (
    id         BIGSERIAL PRIMARY KEY,
    nombre     TEXT NOT NULL,
    ruta       TEXT NOT NULL,
    sha256     TEXT NOT NULL,
    mime       TEXT,
    bytes      INT,
    nota       TEXT,
    subida_por TEXT,
    subida_en  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Siempre se usa la ultima: las anteriores quedan por si hay que volver atras.
CREATE INDEX IF NOT EXISTS dl_plantilla_subida_idx ON dl_plantilla (subida_en DESC);
