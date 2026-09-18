-- ============================================================================
-- SAO-001: la carga pasa de la planilla de Google a la app
-- ============================================================================
--
-- Pedido de Claudia (18/09/2026). Decisiones suyas:
--   - Especificaciones: las del dashboard (PPQ-H2O-001 v2.0 + REG-SOP-LCC-095-A
--     v5.0). No se copian: el servidor las lee de dashboard_sao001.html
--     (lib/sao001-specs.js).
--   - Rango fisico: bloquea lo imposible (sao001_rangos, editable). Un OOS real
--     se guarda con comentario; si es fisicoquimico pide una segunda muestra de
--     confirmacion, si es micro solo el comentario.
--   - El micro se completa dias despues sobre la misma muestra.
--   - Cargan las analistas, sin aprobacion; toda correccion lleva motivo.
--   - Planilla del dia segun el plan de muestreo de la Fase 3 (sao001_puntos).
--
-- El dashboard sigue leyendo /api/sao001: el CSV historico congelado mas las
-- filas que se cargan aca, con las mismas columnas.

-- Puntos de muestreo y su plan. Descripcion, sistema y los textos de limites de
-- la planilla se completan desde el ultimo CSV la primera vez que hacen falta.
CREATE TABLE IF NOT EXISTS sao001_puntos (
    codigo           TEXT PRIMARY KEY,
    descripcion      TEXT,
    sistema          TEXT,
    orden            INT NOT NULL DEFAULT 0,
    activo           BOOLEAN NOT NULL DEFAULT true,
    limites          JSONB NOT NULL DEFAULT '{}',   -- textos de la planilla: "Min pH": "6.5", ...
    fq_frecuencia    TEXT CHECK (fq_frecuencia IN ('diaria', 'semanal', 'quincenal', 'mensual')),
    fq_dia           INT,                           -- 1 = lunes (ISO); diaria = lunes a sabado
    fq_parametros    TEXT[] NOT NULL DEFAULT '{}',
    micro_frecuencia TEXT CHECK (micro_frecuencia IN ('semanal', 'quincenal', 'mensual')),
    micro_dia        INT
);

INSERT INTO sao001_puntos (codigo, orden, activo, fq_frecuencia, fq_dia, fq_parametros, micro_frecuencia, micro_dia) VALUES
    ('P1',    1, true,  'semanal', 1, '{ph}',                        'semanal',   1),
    ('TM1',   2, true,  'diaria',  NULL, '{cloro}',                  'semanal',   1),
    ('TM2',   3, true,  'diaria',  NULL, '{cloro,ph}',               'semanal',   1),
    ('TM4',   4, true,  'diaria',  NULL, '{cloro,ph,dureza}',        'semanal',   1),
    ('TM5',   5, true,  'diaria',  NULL, '{cloro}',                  'semanal',   1),
    ('TM6',   6, true,  'diaria',  NULL, '{ozono}',                  'semanal',   1),
    ('TM7',   7, true,  NULL,      NULL, '{}',                       'quincenal', 1),
    ('TM8',   8, true,  'diaria',  NULL, '{ozono,cond,cloro,dureza}', 'semanal',  1),
    ('TM9',   9, true,  'diaria',  NULL, '{ozono,cond,cloro,dureza}', 'semanal',  1),
    ('TM10', 10, true,  NULL,      NULL, '{}',                       'semanal',   1),
    ('TM11', 11, true,  'diaria',  NULL, '{ozono}',                  'semanal',   1),
    ('POU1', 21, true,  NULL,      NULL, '{}',                       'quincenal', 1),
    ('POU2', 22, true,  NULL,      NULL, '{}',                       'quincenal', 1),
    ('POU3', 23, true,  NULL,      NULL, '{}',                       'mensual',   4),
    ('POU4', 24, true,  NULL,      NULL, '{}',                       'mensual',   4),
    ('POU5', 25, true,  NULL,      NULL, '{}',                       'mensual',   4),
    ('POU6', 26, true,  NULL,      NULL, '{}',                       'mensual',   4),
    ('POU7', 27, true,  NULL,      NULL, '{}',                       'quincenal', 2),
    ('POU8', 28, true,  NULL,      NULL, '{}',                       'quincenal', 2),
    ('POU9', 29, false, NULL,      NULL, '{}',                       'quincenal', 3),
    ('POU10',30, true,  NULL,      NULL, '{}',                       'quincenal', 3),
    ('POU11',31, true,  NULL,      NULL, '{}',                       'quincenal', 3),
    ('POU12',32, true,  NULL,      NULL, '{}',                       'mensual',   4),
    ('POU13',33, true,  NULL,      NULL, '{}',                       'quincenal', 3),
    ('POU14',34, true,  NULL,      NULL, '{}',                       'mensual',   4)
ON CONFLICT (codigo) DO NOTHING;

-- Rango fisico: fuera de esto el valor es imposible (un error de tipeo).
CREATE TABLE IF NOT EXISTS sao001_rangos (
    parametro     TEXT PRIMARY KEY,           -- ph | cond | cloro | ozono | micro | toc | dureza
    nombre        TEXT NOT NULL,
    unidad        TEXT,
    fis_min       NUMERIC NOT NULL,
    fis_max       NUMERIC NOT NULL,
    fisicoquimico BOOLEAN NOT NULL,           -- OOS fisicoquimico pide segunda muestra
    orden         INT NOT NULL
);

INSERT INTO sao001_rangos (parametro, nombre, unidad, fis_min, fis_max, fisicoquimico, orden) VALUES
    ('ph',     'pH',            '',              0, 14,      true,  1),
    ('cond',   'Conductividad', 'µS/cm',         0, 5000,    true,  2),
    ('cloro',  'Cloro total',   'mg/L',          0, 10,      true,  3),
    ('ozono',  'Ozono libre',   'mg/L',          0, 5,       true,  4),
    ('dureza', 'Dureza total',  'mg/L CaCO3',    0, 1000,    true,  5),
    ('toc',    'TOC',           'ppm (mg/L)',    0, 100,     true,  6),
    ('micro',  'Aerobios totales', 'ufc/100 mL', 0, 1000000, false, 7)
ON CONFLICT (parametro) DO NOTHING;

CREATE TABLE IF NOT EXISTS sao001_config (
    clave TEXT PRIMARY KEY,
    valor TEXT NOT NULL
);
INSERT INTO sao001_config (clave, valor) VALUES ('fase', '3') ON CONFLICT (clave) DO NOTHING;

-- Una fila por punto y muestreo (una segunda muestra es otra fila, vinculada).
CREATE TABLE IF NOT EXISTS sao001_registros (
    id                 BIGSERIAL PRIMARY KEY,
    fecha              DATE NOT NULL,
    punto              TEXT NOT NULL REFERENCES sao001_puntos (codigo),
    fase               TEXT,
    valores            JSONB NOT NULL DEFAULT '{}',    -- fisicoquimicos tal como se informan: {"ozono": "<0.1"}
    micro              TEXT,
    micro_esperado     BOOLEAN NOT NULL DEFAULT false, -- se tomo muestra de micro: el resultado llega despues
    micro_cargado_por  TEXT,
    micro_cargado_en   TIMESTAMPTZ,
    observaciones      TEXT,
    comentarios_oos    JSONB NOT NULL DEFAULT '{}',
    oos                TEXT[] NOT NULL DEFAULT '{}',   -- parametros fisicoquimicos fuera de especificacion
    segunda_de         BIGINT REFERENCES sao001_registros (id),
    segunda_pendiente  BOOLEAN NOT NULL DEFAULT false,
    confirmacion       JSONB NOT NULL DEFAULT '{}',    -- {"cloro": "confirmado" | "no confirmado"}
    registrado_por     TEXT,
    registrado_por_id  BIGINT REFERENCES usuarios (id),
    registrado_en      TIMESTAMPTZ NOT NULL DEFAULT now(),
    id_envio           TEXT UNIQUE,
    anulado            BOOLEAN NOT NULL DEFAULT false,
    anulado_motivo     TEXT
);

CREATE INDEX IF NOT EXISTS sao001_registros_fecha_idx ON sao001_registros (fecha DESC, punto);
CREATE INDEX IF NOT EXISTS sao001_registros_micro_idx ON sao001_registros (punto, fecha DESC)
    WHERE micro_esperado;

-- Correcciones: que valor habia, cual quedo, quien, cuando y por que.
CREATE TABLE IF NOT EXISTS sao001_cambios (
    id          BIGSERIAL PRIMARY KEY,
    registro_id BIGINT NOT NULL REFERENCES sao001_registros (id),
    ts          TIMESTAMPTZ NOT NULL DEFAULT now(),
    usuario     TEXT,
    campo       TEXT NOT NULL,
    antes       TEXT,
    despues     TEXT,
    motivo      TEXT NOT NULL
);

-- Cierre de la planilla: con esta fila la replica deja de bajar el CSV.
CREATE TABLE IF NOT EXISTS sao001_corte (
    unica       BOOLEAN PRIMARY KEY DEFAULT true CHECK (unica),
    cerrado_en  TIMESTAMPTZ NOT NULL DEFAULT now(),
    cerrado_por TEXT
);

-- Quien carga: las analistas; administran Claudia, Antonella y Gloria.
INSERT INTO usuario_recursos (usuario_id, recurso, rol)
SELECT u.id, 'sao001-carga', r.rol
FROM (VALUES
    ('claudia.barlocco@vessena.com.uy',  'administrador'),
    ('antonella.nunez@vessena.com.uy',   'administrador'),
    ('gloria.nunez@vessena.com.uy',      'administrador'),
    ('laboratorio@vessena.com.uy',       'operador'),
    ('analista.minilab@vessena.com.uy',  'operador')
) AS r(email, rol)
JOIN usuarios u ON lower(u.usuario) = lower(r.email) AND u.origen = 'vessena'
ON CONFLICT (usuario_id, recurso) DO NOTHING;
