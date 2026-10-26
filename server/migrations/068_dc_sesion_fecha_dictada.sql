-- Los entrenamientos que ya se dieron en papel (Claudia, 26/10/2026: "tengo los
-- entrenamientos de los LCC para subir", con la lista de asistencia firmada).
--
-- Hasta ahora una sesion se abria y se cerraba el mismo dia y el registro iba a
-- Capacitaciones con la fecha de hoy. Para cargar lo que ya se dicto hace falta
-- guardar la fecha del papel, que es distinta del dia en que se carga: la
-- capacitacion ocurrio en su fecha, pero la firma electronica del capacitador
-- es de hoy. Las dos quedan a la vista; nada se antedata en silencio.
--
-- NULL = se dicto el dia que se abrio la sesion, que es el caso normal.
ALTER TABLE dc_sesiones ADD COLUMN IF NOT EXISTS fecha_dictada date;

COMMENT ON COLUMN dc_sesiones.fecha_dictada IS
    'Dia en que se dio la capacitacion, cuando no es el dia en que se cargo (lista firmada en papel). NULL = el dia que se abrio la sesion.';
