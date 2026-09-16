-- ============================================================================
-- Control Fabuloso (captura): de Apps Script a Postgres
-- ============================================================================
--
-- La app de control de atributos en linea (SOP-LCC-200 v3.0, reemplaza al
-- REG-SOP-LCC-200-A en papel) guardaba todo en una planilla por medio de un
-- Apps Script con usuarios y contraseñas propios, fotos y firmas en Drive, y
-- estaba publicada en GitHub Pages. Pasa al portal como el resto (decisiones de
-- Claudia, 16/09/2026):
--
--   * Entra con la sesion del portal. Las mismas personas que el portal; no hay
--     usuarios externos.
--   * Aprueban y cierran ordenes Claudia, Antonella y Gloria.
--   * La firma sale de la tabla `firmas` (028). Las firmas dibujadas en la app
--     vieja quedan como enlace, para los registros de antes.
--   * Las fotos nuevas se guardan en la base; las viejas siguen en Drive.
--
-- Las reglas son las del Apps Script, sin cambios: QR, rangos, estado inicial,
-- orden cerrada que no acepta mas controles, fotos obligatorias y checklist.

-- ---------------------------------------------------------------------------
-- Catalogo de defectos
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS fab_defectos (
    codigo          TEXT PRIMARY KEY,
    descripcion     TEXT NOT NULL,
    clasificacion   TEXT NOT NULL CHECK (clasificacion IN ('Leve', 'Moderado', 'Crítico')),
    grupo           TEXT,
    activo          BOOLEAN NOT NULL DEFAULT true,
    actualizado_en  TIMESTAMPTZ NOT NULL DEFAULT now(),
    actualizado_por TEXT
);

-- ---------------------------------------------------------------------------
-- Muestreos (cada control)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS fab_muestreos (
    id                   TEXT PRIMARY KEY,          -- MUE-aaaammdd-hhmmss-nnn, como el Apps Script
    registrado_en        TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- Quien cargo: la persona del portal. En lo importado queda el usuario de
    -- la app vieja ("claudia", "monica") y analista_id vacio.
    analista_id          BIGINT REFERENCES usuarios (id),
    analista_usuario     TEXT,
    analista_nombre      TEXT NOT NULL,
    linea                TEXT,
    orden_envasado       TEXT NOT NULL,
    lote                 TEXT NOT NULL,
    codigo_pt            TEXT,
    fecha_muestreo       TEXT,
    hora_muestreo        TEXT,
    n_muestras           INT NOT NULL,
    dc                   INT NOT NULL DEFAULT 0,
    dm                   INT NOT NULL DEFAULT 0,
    dl                   INT NOT NULL DEFAULT 0,
    qr                   NUMERIC(8, 2) NOT NULL,
    calidad_rango        TEXT NOT NULL,
    unidades_retiradas   INT NOT NULL DEFAULT 0,
    motivo_retiro        TEXT,
    acciones_correctivas TEXT,
    -- [{codigo, cantidad, descripcion, clasificacion}]. Descripcion y
    -- clasificacion se copian al guardar: si mañana se reclasifica un defecto,
    -- este control sigue diciendo con que clasificacion se calculo su QR. Lo
    -- importado trae solo codigo y cantidad, como lo guardaba la planilla.
    defectos             JSONB NOT NULL DEFAULT '[]'::jsonb,
    fotos                JSONB NOT NULL DEFAULT '[]'::jsonb,   -- URLs de evidencia
    foto_rotulo          TEXT,
    foto_lote            TEXT,
    estado               TEXT NOT NULL,             -- Controlado | Retenido | Aprobado | Rechazado
    aprobado_por         TEXT,
    aprobado_por_id      BIGINT REFERENCES usuarios (id),
    aprobado_en          TIMESTAMPTZ,
    notas_aprobador      TEXT,
    origen               TEXT NOT NULL DEFAULT 'app' CHECK (origen IN ('app', 'apps-script'))
);

CREATE INDEX IF NOT EXISTS fab_muestreos_orden_idx ON fab_muestreos (orden_envasado, registrado_en);
CREATE INDEX IF NOT EXISTS fab_muestreos_fecha_idx ON fab_muestreos (registrado_en DESC);

-- ---------------------------------------------------------------------------
-- Ordenes aprobadas y cerradas
-- ---------------------------------------------------------------------------
-- En la planilla el cierre estaba repetido en cada fila de la orden. Aca es un
-- registro propio: que exista es que la orden esta cerrada, y la clave
-- primaria impide cerrarla dos veces.
CREATE TABLE IF NOT EXISTS fab_ordenes (
    orden_envasado     TEXT PRIMARY KEY,
    aprobada_por       TEXT NOT NULL,
    aprobada_por_id    BIGINT REFERENCES usuarios (id),
    aprobada_en        TIMESTAMPTZ NOT NULL DEFAULT now(),
    notas              TEXT,
    checklist_lote     BOOLEAN NOT NULL,
    checklist_vence    BOOLEAN NOT NULL,
    checklist_producto BOOLEAN NOT NULL,
    origen             TEXT NOT NULL DEFAULT 'app' CHECK (origen IN ('app', 'apps-script'))
);

-- ---------------------------------------------------------------------------
-- Fotos nuevas
-- ---------------------------------------------------------------------------
-- En la base porque el contenedor no tiene disco persistente. Llegan ya
-- comprimidas por el navegador (800 px, ~100-150 KB).
CREATE TABLE IF NOT EXISTS fab_fotos (
    id          BIGSERIAL PRIMARY KEY,
    nombre      TEXT,
    tipo        TEXT NOT NULL,
    tamano      INT NOT NULL,
    contenido   BYTEA NOT NULL,
    referencia  TEXT,
    subida_por  TEXT,
    subida_en   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Auditoria de la app
-- ---------------------------------------------------------------------------
-- Solo se inserta. Lo importado conserva usuario, rol y fecha originales.
CREATE TABLE IF NOT EXISTS fab_actividad (
    id          BIGSERIAL PRIMARY KEY,
    ts          TIMESTAMPTZ NOT NULL DEFAULT now(),
    usuario     TEXT,
    rol         TEXT,
    accion      TEXT NOT NULL,
    entidad     TEXT,
    entidad_id  TEXT,
    detalles    TEXT,
    user_agent  TEXT,
    origen      TEXT NOT NULL DEFAULT 'app' CHECK (origen IN ('app', 'apps-script'))
);

CREATE INDEX IF NOT EXISTS fab_actividad_ts_idx ON fab_actividad (ts DESC);

-- ---------------------------------------------------------------------------
-- Firmas dibujadas en la app vieja
-- ---------------------------------------------------------------------------
-- Solo para imprimir los registros importados: son de usuarios de la app vieja
-- ("claudia", "monica"), no de personas del portal.
CREATE TABLE IF NOT EXISTS fab_firmas_legado (
    usuario    TEXT PRIMARY KEY,
    nombre     TEXT,
    firma_url  TEXT NOT NULL
);

-- ---------------------------------------------------------------------------
-- Catalogo inicial (setup() del Apps Script, extraido del REG-SOP-LCC-200-A)
-- ---------------------------------------------------------------------------
-- La importacion de la planilla lo actualiza con las clasificaciones vigentes.
INSERT INTO fab_defectos (codigo, descripcion, clasificacion, grupo, actualizado_por)
VALUES
    ('D01', 'Ausencia de Trazabilidad', 'Crítico', 'Trazabilidad', 'migracion 032'),
    ('D02', 'Stickers con fecha incorrecta de envasado', 'Crítico', 'Trazabilidad', 'migracion 032'),
    ('D03', 'Producto Sin etiqueta', 'Crítico', 'Etiqueta', 'migracion 032'),
    ('D04', 'Producto con Etiqueta equivocada', 'Crítico', 'Etiqueta', 'migracion 032'),
    ('D05', 'Envase perforado', 'Crítico', 'Envase', 'migracion 032'),
    ('D06', 'Envase con bajo nivel de llenado', 'Crítico', 'Envase', 'migracion 032'),
    ('D07', 'Botella sin tapa', 'Crítico', 'Tapa', 'migracion 032'),
    ('D08', 'Fuga de producto por la tapa', 'Crítico', 'Tapa', 'migracion 032'),
    ('D09', 'Fuga de producto por rotura de envases', 'Crítico', 'Envase', 'migracion 032'),
    ('D10', 'Ausencia de etiquetas con código en fundas', 'Crítico', 'Etiqueta', 'migracion 032'),
    ('D11', 'Pallet con productos mezclados', 'Crítico', 'Palletizado', 'migracion 032'),
    ('D12', 'Incoherencias en Vencimientos de Packs', 'Crítico', 'Trazabilidad', 'migracion 032'),
    ('D13', 'Producto con Etiqueta rota', 'Moderado', 'Etiqueta', 'migracion 032'),
    ('D14', 'Etiqueta con defectos de impresión', 'Moderado', 'Etiqueta', 'migracion 032'),
    ('D15', 'Etiqueta descentrada', 'Moderado', 'Etiqueta', 'migracion 032'),
    ('D16', 'Etiqueta con arrugas (pliegues) / mal pegada / burbujas de aire', 'Moderado', 'Etiqueta', 'migracion 032'),
    ('D17', 'Etiqueta despegada / abierta en costura', 'Moderado', 'Etiqueta', 'migracion 032'),
    ('D18', 'Etiquetas solapadas / superpuestas', 'Moderado', 'Etiqueta', 'migracion 032'),
    ('D19', 'Envase golpeado o envase hundido', 'Moderado', 'Envase', 'migracion 032'),
    ('D20', 'Envase deformado en el panel', 'Moderado', 'Envase', 'migracion 032'),
    ('D21', 'Color fuera de estándar', 'Crítico', 'Producto', 'migracion 032'),
    ('D22', 'Tapa mal colocada (con gorro)', 'Moderado', 'Tapa', 'migracion 032'),
    ('D23', 'Tapa rota', 'Moderado', 'Tapa', 'migracion 032'),
    ('D24', 'Fundas mal armadas (desalineadas)', 'Moderado', 'Palletizado', 'migracion 032'),
    ('D25', 'Paletizado Incorrecto', 'Moderado', 'Palletizado', 'migracion 032'),
    ('D26', 'Cajas mal cerradas', 'Moderado', 'Palletizado', 'migracion 032'),
    ('D27', 'Producto Turbio fuera de especificación de aspecto', 'Crítico', 'Producto', 'migracion 032'),
    ('D28', 'Producto con sedimentación', 'Crítico', 'Producto', 'migracion 032'),
    ('D29', 'Etiqueta sucia / envase sucio', 'Leve', 'Etiqueta', 'migracion 032'),
    ('D30', 'Envase sucio (ídem para tapas)', 'Leve', 'Envase', 'migracion 032'),
    ('D31', 'Envase con rebabas', 'Leve', 'Envase', 'migracion 032'),
    ('D32', 'Tapa rayada', 'Leve', 'Tapa', 'migracion 032'),
    ('D33', 'Tapa sucia', 'Leve', 'Tapa', 'migracion 032'),
    ('D34', 'Tapa floja', 'Leve', 'Tapa', 'migracion 032'),
    ('D35', 'Picos de pallets (pallets incompletos) con falta de film strech', 'Leve', 'Palletizado', 'migracion 032'),
    ('D36', 'Poco film strech en la parte superior del pallet', 'Leve', 'Palletizado', 'migracion 032'),
    ('D37', 'Cajas deformadas (por tensión del filmstrech)', 'Leve', 'Palletizado', 'migracion 032'),
    ('D38', 'Esquinas de pallet sin filmstrech', 'Leve', 'Palletizado', 'migracion 032'),
    ('D39', 'Pallets defectuosos en muy mal estado, tacos rotos', 'Leve', 'Palletizado', 'migracion 032'),
    ('D40', 'Estiba de pallets defectuosas', 'Leve', 'Palletizado', 'migracion 032')
ON CONFLICT (codigo) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Perfiles en el portal
-- ---------------------------------------------------------------------------
-- Aprueban Claudia, Antonella y Gloria (antes Gloria y Antonella eran
-- revisoras, que no aprueba). Mónica y Alexis cargan muestreos. Solo en el
-- usuario con el que se entra (origen 'vessena').
INSERT INTO usuario_recursos (usuario_id, recurso, rol)
SELECT u.id, 'fabuloso-captura', r.rol
FROM (VALUES
    ('claudia.barlocco@vessena.com.uy',  'administrador'),
    ('antonella.nunez@vessena.com.uy',   'administrador'),
    ('gloria.nunez@vessena.com.uy',      'administrador'),
    ('laboratorio@vessena.com.uy',       'operador'),
    ('analista.minilab@vessena.com.uy',  'operador')
) AS r(email, rol)
JOIN usuarios u ON lower(u.usuario) = lower(r.email) AND u.origen = 'vessena'
ON CONFLICT (usuario_id, recurso) DO UPDATE SET rol = EXCLUDED.rol;

-- ---------------------------------------------------------------------------
-- Reporte diario (10:00): los mismos destinatarios que el Apps Script
-- ---------------------------------------------------------------------------
INSERT INTO notificacion_supervisores (recurso, notificacion, usuario_id, nota)
SELECT 'fabuloso-captura', 'reporte-diario', u.id, 'reporte diario de Fabuloso (antes REPORT_RECIPIENTS del Apps Script)'
FROM usuarios u
WHERE u.origen = 'vessena'
  AND lower(u.usuario) IN ('antonella.nunez@vessena.com.uy',
                           'gloria.nunez@vessena.com.uy',
                           'claudia.barlocco@vessena.com.uy')
ON CONFLICT (recurso, notificacion, usuario_id) DO NOTHING;
