-- ============================================================================
-- Control de documentos: codificacion automatica de documentos nuevos
-- ============================================================================
--
-- La regla, sacada del listado maestro LIS-SOP-DOC-001-E (Claudia, 14/10/2026):
--
--   1. Documentos principales (SOP, INS, PL, MAN, RI, PRO, SMF, MET, POL):
--      TIPO-AREA-NNN con UNA sola numeracion para todos, sin importar area ni
--      tipo (SOP-LCC-046, SOP-AC-047, INS-PR-209). Ultimo usado: 264.
--   2. Especificaciones: ESP-AREA-NNN con numeracion propia (ESP-COM-046
--      convive con SOP-LCC-046). Ultima: 300.
--   3. Plan maestro de validacion: PMV-NNN, numeracion propia, sin area.
--   4. Derivados (anexos, registros, listados, planes de un documento):
--      PREFIJO-<codigo del padre>-<letra>, con una serie de letras por cada
--      prefijo y padre: REG-SOP-AC-039-A..E, AX-SOP-AC-039-A.
--   5. Siempre el siguiente al ultimo: los huecos no se reutilizan (un codigo
--      que existio en papel no puede volver a nombrar otra cosa).
--
-- Los documentos externos no se codifican: llevan el codigo de su origen.

-- secuencia: que numeracion usa ('general', 'esp', 'pmv'); null = no numera.
-- deriva_de: tipo del documento padre (para anexos/registros); null = no deriva.
-- con_area: si el codigo lleva area.
ALTER TABLE dc_tipos ADD COLUMN IF NOT EXISTS secuencia TEXT;
ALTER TABLE dc_tipos ADD COLUMN IF NOT EXISTS deriva_de TEXT;
ALTER TABLE dc_tipos ADD COLUMN IF NOT EXISTS con_area BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE dc_tipos ADD COLUMN IF NOT EXISTS orden INT NOT NULL DEFAULT 100;

INSERT INTO dc_tipos (codigo, nombre) VALUES ('AX-ESP', 'Anexo de especificación')
ON CONFLICT (codigo) DO NOTHING;

UPDATE dc_tipos SET secuencia = 'general', con_area = true, orden = o.orden
FROM (VALUES ('SOP', 1), ('INS', 2), ('PL', 3), ('MAN', 4), ('RI', 5), ('PRO', 6), ('MET', 7), ('POL', 8), ('SMF', 9))
     AS o(codigo, orden)
WHERE dc_tipos.codigo = o.codigo;
UPDATE dc_tipos SET secuencia = 'esp', con_area = true, orden = 20 WHERE codigo = 'ESP';
UPDATE dc_tipos SET secuencia = 'pmv', con_area = false, orden = 30 WHERE codigo = 'PMV';
UPDATE dc_tipos SET deriva_de = d.padre, con_area = false, orden = d.orden
FROM (VALUES ('REG-SOP', 'SOP', 40), ('AX-SOP', 'SOP', 41), ('LIS-SOP', 'SOP', 42), ('PL-SOP', 'SOP', 43),
             ('AX-ESP', 'ESP', 44), ('AX-MET', 'MET', 45))
     AS d(codigo, padre, orden)
WHERE dc_tipos.codigo = d.codigo;
UPDATE dc_tipos SET con_area = false, orden = 90 WHERE codigo IN ('EXT', 'AX-FORM', 'AX-PC');

-- Areas del codigo. Los nombres salen de las carpetas de la red y de la hoja
-- Instrucciones del listado.
CREATE TABLE IF NOT EXISTS dc_areas (
    codigo  TEXT PRIMARY KEY,
    nombre  TEXT NOT NULL,
    activa  BOOLEAN NOT NULL DEFAULT true
);

INSERT INTO dc_areas (codigo, nombre) VALUES
    ('AC',   'Aseguramiento de Calidad'),
    ('LCC',  'Laboratorio de Control de Calidad'),
    ('MIC',  'Microbiología'),
    ('PR',   'Producción'),
    ('EQU',  'Equipos'),
    ('MAN',  'Mantenimiento'),
    ('SAN',  'Limpieza y Sanitización'),
    ('MP',   'Materias Primas'),
    ('COM',  'Compras / Componentes y material de empaque'),
    ('DOM',  'Domisanitarios'),
    ('COS',  'Cosméticos'),
    ('PLA',  'Plásticos'),
    ('LOG',  'Logística, depósito y distribución'),
    ('DEP',  'Depósitos'),
    ('GEN',  'Generales'),
    ('DOC',  'Documental'),
    ('DIR',  'Dirección'),
    ('SEG',  'Seguridad y Medio Ambiente (SYSO)'),
    ('IT',   'Informática'),
    ('VEN',  'Ventas y Marketing'),
    ('RRHH', 'Recursos Humanos'),
    ('FIN',  'Finanzas')
ON CONFLICT (codigo) DO NOTHING;
