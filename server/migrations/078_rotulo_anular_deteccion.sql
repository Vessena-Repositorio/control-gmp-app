-- Anular una deteccion de error de impresion.
--
-- Claudia, 09/11/2026: hizo una deteccion de prueba sobre una orden real para
-- ver si andaba, y quedo en el registro de esa orden un "requiere reproceso"
-- que no corresponde. El historial de rotulo no se edita ni se borra -es parte
-- del registro- asi que lo que faltaba era poder anular el movimiento: queda,
-- tachado, con el motivo y quien lo anulo.
--
-- Solo se anulan las detecciones (las que abre la analista cuando la lectura de
-- la foto encuentra un error de impresion). Un OK o una correccion pedida por
-- supervision no se anulan: se resuelven con el movimiento siguiente.
--
-- Anulada la deteccion, se deshace tambien lo que habia dejado: si la
-- verificacion seguia en "correccion" por culpa de esa deteccion, vuelve al
-- estado anterior -al OK que tenia, o a pendiente- y se limpian el comentario y
-- la marca de reproceso. Y deja de contar en las detecciones de la orden.

ALTER TABLE rotulo_eventos ADD COLUMN IF NOT EXISTS anulado_en     TIMESTAMPTZ;
ALTER TABLE rotulo_eventos ADD COLUMN IF NOT EXISTS anulado_por    TEXT;
ALTER TABLE rotulo_eventos ADD COLUMN IF NOT EXISTS anulado_motivo TEXT;
