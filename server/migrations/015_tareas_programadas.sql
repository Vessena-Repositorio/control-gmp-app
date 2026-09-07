-- ============================================================================
-- Tareas diarias: registro de la ultima corrida
-- ============================================================================
--
-- Los avisos por correo no pueden depender de un setInterval a secas. El
-- contenedor reinicia en cada deploy, y una tarea atada al arranque mandaria
-- otra tanda de correos cada vez que se despliega. Con dos deploys en una
-- mañana, la gente recibe el mismo aviso tres veces y deja de leerlos.
--
-- Asi que la corrida se ancla al DIA, no al proceso: la tarea consulta si ya
-- corrio hoy y no vuelve a hacerlo. Sobrevive a reinicios y a que haya mas de
-- una instancia levantada.
CREATE TABLE IF NOT EXISTS tarea_diaria (
    nombre          TEXT PRIMARY KEY,
    ultimo_dia      DATE,
    ultima_corrida  TIMESTAMPTZ,
    detalle         TEXT
);
