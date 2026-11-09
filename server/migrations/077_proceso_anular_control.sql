-- Anular un control cargado por error.
--
-- Claudia, 09/11/2026: cargo un control de prueba para ver si andaba la lectura
-- de las fotos y pregunto como lo borraba. No se borra: un control guardado es
-- un registro. Lo que faltaba era poder anularlo, que es otra cosa -queda, con
-- el motivo, quien lo anulo y cuando, tachado en el registro y afuera de los
-- promedios-.
--
-- Lo puede hacer supervision (permiso de aprobar), igual que corregir un valor
-- mal cargado (migracion 058).
--
-- La anulacion tambien se escribe dentro de raw, que es lo que la pantalla lee:
-- asi el control anulado se ve tachado sin tener que cambiar la forma de lo que
-- devuelve el servidor.

ALTER TABLE proceso_controles ADD COLUMN IF NOT EXISTS anulado_en     TIMESTAMPTZ;
ALTER TABLE proceso_controles ADD COLUMN IF NOT EXISTS anulado_por    TEXT;
ALTER TABLE proceso_controles ADD COLUMN IF NOT EXISTS anulado_por_id INT;
ALTER TABLE proceso_controles ADD COLUMN IF NOT EXISTS anulado_motivo TEXT;

CREATE INDEX IF NOT EXISTS proceso_anulado_idx ON proceso_controles (anulado_en)
    WHERE anulado_en IS NOT NULL;
