-- ============================================================================
-- Control de documentos: entrenamiento antes de la vigencia
-- ============================================================================
--
-- Etapa 4 (Claudia, 07/10/2026). Un procedimiento aprobado no sirve si quien
-- lo tiene que aplicar no lo conoce. El entrenamiento NO se carga dos veces:
--
--   - La matriz dice que sectores del padron de Capacitaciones tienen que
--     capacitarse en cada documento (dc_documentos.capacitar_sectores).
--   - Cada version dice como (modo_capacitacion):
--       lectura     — "leido y comprendido" con firma electronica, para quien
--                     tiene usuario; el resto, con un registro en Capacitaciones
--       presencial  — capacitacion registrada en la app de Capacitaciones con
--                     el codigo del documento en "Codigo Doc."
--       no_requiere — cambio menor (formato, redaccion) que no cambia la tarea
--   - El avance se calcula cruzando el padron con los registros de
--     Capacitaciones (por codigo de documento) y con las firmas de lectura.
--
-- La version aprobada espera en `en_entrenamiento` hasta su fecha de vigencia;
-- Calidad puede ponerla vigente antes si el entrenamiento ya esta completo.

ALTER TABLE dc_documentos ADD COLUMN IF NOT EXISTS capacitar_sectores TEXT[] NOT NULL DEFAULT '{}';

ALTER TABLE dc_versiones ADD COLUMN IF NOT EXISTS modo_capacitacion TEXT
    CHECK (modo_capacitacion IN ('lectura', 'presencial', 'no_requiere'));
