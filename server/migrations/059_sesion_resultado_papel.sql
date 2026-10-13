-- ============================================================================
-- Sesiones de capacitacion: resultado de la evaluacion en papel
-- ============================================================================
--
-- Claudia (13/10/2026): en las capacitaciones grupales la prueba se toma en
-- papel en el momento. Quien se registra por lector o por la lista del padron
-- no "aprobo" por asistir: queda pendiente hasta que quien capacita corrige y
-- carga el resultado. Al cerrar, solo los aprobados pasan a Capacitaciones.
--
--   via = 'pantalla'     se registro el mismo leyendo por QR (con su puntaje)
--   via = 'capacitador'  lo registro quien capacita (lector o lista)
--   aprobado = null      asistio, falta el resultado de la evaluacion

-- El UPDATE de abajo pasa por el audit trail, que exige autor.
SELECT set_config('app.usuario_nombre', 'Sistema (migración 059)', true),
       set_config('app.motivo', 'resultado de la evaluación en papel: pendiente hasta que se cargue', true);

ALTER TABLE dc_sesion_asistentes ALTER COLUMN aprobado DROP NOT NULL;
ALTER TABLE dc_sesion_asistentes ADD COLUMN IF NOT EXISTS via TEXT NOT NULL DEFAULT 'pantalla'
    CHECK (via IN ('pantalla', 'capacitador'));

-- Los registrados por quien capacita no tienen respuestas en pantalla (la
-- lectura por QR guarda las respuestas, aunque sean 'null' en JSON). En las
-- sesiones que siguen abiertas vuelven a "pendiente"; las ya cerradas quedan
-- como se firmaron.
UPDATE dc_sesion_asistentes a SET via = 'capacitador'
WHERE a.respuestas IS NULL;
UPDATE dc_sesion_asistentes a SET aprobado = NULL
WHERE a.via = 'capacitador'
  AND a.sesion_id IN (SELECT id FROM dc_sesiones WHERE cerrada_en IS NULL);
