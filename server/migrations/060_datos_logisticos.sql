-- ============================================================================
-- Datos Logisticos PT: la ficha de alta de producto sale del portal
-- ============================================================================
--
-- Pedido de Claudia (16/10/2026). La app de datos logisticos la habia armado
-- otra persona como artefacto de Claude: los datos vivian en la nube de Claude
-- o, si se abria el HTML descargado, en el navegador de esa PC, con usuarios y
-- contrasenas propios. Cada quien veia lo suyo.
--
-- Aca queda con la sesion del portal, los permisos por recurso y los datos en
-- Postgres, como el resto de la suite. Lo que la app hacia y se conserva:
-- calcular el pallet, marcar datos pendientes y exportar en formato ASU.
--
-- Lo que se agrega:
--   * la clasificacion que pide la ficha de alta (categoria, linea, sublinea,
--     familia, marca y las unidades de medida), que el ERP no tiene cargada;
--   * los registros sanitarios (habilitacion MSP) con su documento y su
--     historico de renovaciones;
--   * el circuito de la ficha: Gloria la arma, Antonella o Claudia la aprueban
--     y recien ahi sale sola a Finanzas (Marianela). Si despues cambia un
--     dato, vuelve a revision y al aprobarse sale como actualizacion;
--   * los avisos automaticos, que hoy son un correo que alguien arma a mano.

CREATE TABLE IF NOT EXISTS dl_productos (
    sku                TEXT PRIMARY KEY,
    descripcion        TEXT NOT NULL,
    grupo              TEXT,                 -- Nacionales | Importados
    categoria          TEXT,
    marca              TEXT,
    activo             BOOLEAN NOT NULL DEFAULT true,
    nota               TEXT,

    -- Codigos y vida util
    ean                TEXT,                 -- EAN 13 de la unidad
    dun                TEXT,                 -- DUN 14 de la caja o funda
    pack_gtins         TEXT,
    vida_meses         INT,

    -- Unidad de venta
    peso_pt            NUMERIC,              -- kg
    un_largo           NUMERIC,              -- cm
    un_ancho           NUMERIC,
    un_alto            NUMERIC,
    contenido          NUMERIC,
    contenido_um       TEXT,
    presentacion       TEXT,

    -- Caja o funda
    unidades_caja      INT,
    cod_caja           TEXT,
    tipo_empaque       TEXT,
    caja_largo         NUMERIC,              -- cm
    caja_ancho         NUMERIC,
    caja_alto          NUMERIC,
    peso_caja          NUMERIC,              -- kg, vacia

    -- Pallet
    por_piso           INT,
    estiba             INT,
    unidades_pallet    INT,
    separadores        INT,
    film_unidad        NUMERIC,
    acostada           BOOLEAN,

    -- Almacenamiento (formato ASU)
    temp_cerrado       TEXT,
    temp_abierto       TEXT,
    gpc                TEXT,

    -- Clasificacion de la ficha de alta (listas de la hoja "Parametros")
    categoria_producto TEXT,
    linea              TEXT,
    sublinea           TEXT,
    familia            TEXT,
    subfamilia         TEXT,
    um_base            TEXT,
    um_destino         TEXT,
    tipo_producto      TEXT,
    categoria_impuesto TEXT,
    impuesto_cv        TEXT,

    -- Habilitacion MSP vigente. El historico esta en dl_registros.
    msp                BOOLEAN,
    msp_numero         TEXT,
    msp_vence          DATE,

    -- Ciclo de la ficha
    estado             TEXT NOT NULL DEFAULT 'borrador'
                       CHECK (estado IN ('borrador', 'pendiente', 'aprobada')),
    armada_por         TEXT,
    armada_en          TIMESTAMPTZ,
    aprobada_por       TEXT,
    aprobada_por_id    BIGINT REFERENCES usuarios (id),
    aprobada_en        TIMESTAMPTZ,
    rechazo            TEXT,                 -- lo que dijo quien la devolvio
    ficha_version      INT NOT NULL DEFAULT 0,
    enviada_finanzas_en TIMESTAMPTZ,
    enviada_ventas_en  TIMESTAMPTZ,

    -- Lo que la app vieja guardaba y no tiene columna: marcas de correcciones
    -- ya aplicadas, datos marcados "no aplica", confirmaciones, y si el alta
    -- en iDempiere ya se habia confirmado alla.
    extra              JSONB NOT NULL DEFAULT '{}'::jsonb,

    creado_en          TIMESTAMPTZ NOT NULL DEFAULT now(),
    actualizado_en     TIMESTAMPTZ NOT NULL DEFAULT now(),
    actualizado_por    TEXT
);

CREATE INDEX IF NOT EXISTS dl_productos_estado_idx ON dl_productos (estado);
CREATE INDEX IF NOT EXISTS dl_productos_activo_idx ON dl_productos (activo) WHERE activo;
CREATE INDEX IF NOT EXISTS dl_productos_vence_idx  ON dl_productos (msp_vence) WHERE msp_vence IS NOT NULL;

-- Archivos: la ficha generada, el certificado MSP, la ficha de seguridad y el
-- documento de cada registro sanitario. El contenido vive en el volumen
-- (lib/almacen-documentos.js); aca queda donde esta y quien lo subio.
CREATE TABLE IF NOT EXISTS dl_documentos (
    id          BIGSERIAL PRIMARY KEY,
    sku         TEXT NOT NULL REFERENCES dl_productos (sku) ON DELETE CASCADE,
    tipo        TEXT NOT NULL CHECK (tipo IN ('ficha', 'certificado', 'seguridad', 'registro')),
    nombre      TEXT NOT NULL,
    ruta        TEXT NOT NULL,
    sha256      TEXT NOT NULL,
    mime        TEXT,
    bytes       INT,
    subido_por  TEXT,
    subido_en   TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- false cuando lo reemplaza uno nuevo: el anterior no se borra.
    vigente     BOOLEAN NOT NULL DEFAULT true
);

CREATE INDEX IF NOT EXISTS dl_documentos_sku_idx ON dl_documentos (sku, tipo, vigente);

-- Registros sanitarios (habilitacion MSP). Una renovacion es una fila nueva:
-- la anterior queda, que es lo que pide una auditoria.
CREATE TABLE IF NOT EXISTS dl_registros (
    id           BIGSERIAL PRIMARY KEY,
    sku          TEXT NOT NULL REFERENCES dl_productos (sku) ON DELETE CASCADE,
    numero       TEXT NOT NULL,
    emitido      DATE,
    vence        DATE NOT NULL,
    documento_id BIGINT REFERENCES dl_documentos (id),
    nota         TEXT,
    cargado_por  TEXT,
    cargado_en   TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- Cuando se aviso que estaba por vencer, para no avisar todos los dias.
    avisado_en   TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS dl_registros_sku_idx   ON dl_registros (sku, vence DESC);
CREATE INDEX IF NOT EXISTS dl_registros_vence_idx ON dl_registros (vence);

-- Bitacora de la app: solo se inserta.
CREATE TABLE IF NOT EXISTS dl_actividad (
    id         BIGSERIAL PRIMARY KEY,
    ts         TIMESTAMPTZ NOT NULL DEFAULT now(),
    usuario    TEXT,
    rol        TEXT,
    accion     TEXT NOT NULL,
    sku        TEXT,
    detalles   TEXT
);

CREATE INDEX IF NOT EXISTS dl_actividad_ts_idx  ON dl_actividad (ts DESC);
CREATE INDEX IF NOT EXISTS dl_actividad_sku_idx ON dl_actividad (sku, ts DESC);

-- Las personas de fuera de calidad que esta app toca. Sin credencial, como las
-- de la 010: reciben los correos, y entrar solo pueden cuando se les cargue la
-- clave aparte. Los correos salen de la app vieja, confirmados por Claudia.
INSERT INTO usuarios (origen, usuario, email, nombre, rol, activo, creado_en)
VALUES
    ('vessena', 'marianela.guillen@vessena.com.uy', 'marianela.guillen@vessena.com.uy', 'Marianela Guillén', 'vista', true, now()),
    ('vessena', 'viviana.alanis@vessena.com.uy',    'viviana.alanis@vessena.com.uy',    'Viviana Alanís',    'vista', true, now()),
    ('vessena', 'fabricio.ferraro@vessena.com.uy',  'fabricio.ferraro@vessena.com.uy',  'Fabricio Ferraro',  'vista', true, now()),
    ('vessena', 'info@vessena.com.uy',              'info@vessena.com.uy',              'Gisela Garay',      'vista', true, now())
ON CONFLICT (origen, usuario) DO NOTHING;

-- Quien entra. Calidad arma y aprueba; logistica y ventas miran y exportan,
-- que es lo que hacian con el usuario propio de la app vieja. Marianela no
-- entra a la app: recibe la ficha por correo.
INSERT INTO usuario_recursos (usuario_id, recurso, rol)
SELECT u.id, r.recurso, r.rol
FROM (VALUES
    ('claudia.barlocco@vessena.com.uy', 'datos-logisticos', 'administrador'),
    ('gloria.nunez@vessena.com.uy',     'datos-logisticos', 'administrador'),
    ('antonella.nunez@vessena.com.uy',  'datos-logisticos', 'aprobador'),
    ('viviana.alanis@vessena.com.uy',   'datos-logisticos', 'vista'),
    ('fabricio.ferraro@vessena.com.uy', 'datos-logisticos', 'vista'),
    ('info@vessena.com.uy',             'datos-logisticos', 'vista'),
    ('viviana.alanis@vessena.com.uy',   'portal',           'vista'),
    ('fabricio.ferraro@vessena.com.uy', 'portal',           'vista'),
    ('info@vessena.com.uy',             'portal',           'vista')
) AS r(usuario, recurso, rol)
JOIN usuarios u ON lower(u.usuario) = r.usuario
ON CONFLICT (usuario_id, recurso) DO NOTHING;

-- A quien le llega cada aviso de esta app:
--   finanzas      la ficha aprobada (Marianela, que la carga en iDempiere)
--   ventas        el producto ya esta disponible, con los tres adjuntos
--   vencimientos  habilitaciones MSP por vencer (Claudia, un mes antes)
INSERT INTO notificacion_supervisores (recurso, notificacion, usuario_id, nota)
SELECT 'datos-logisticos', n.notificacion, u.id, n.nota
FROM (VALUES
    ('finanzas',     'marianela.guillen@vessena.com.uy', 'carga el alta en iDempiere'),
    ('ventas',       'fabricio.ferraro@vessena.com.uy',  'ventas'),
    ('ventas',       'viviana.alanis@vessena.com.uy',    'logística'),
    ('ventas',       'info@vessena.com.uy',              'logística'),
    ('vencimientos', 'claudia.barlocco@vessena.com.uy',  'pedido de Claudia: un mes antes')
) AS n(notificacion, usuario, nota)
JOIN usuarios u ON lower(u.usuario) = n.usuario
ON CONFLICT (recurso, notificacion, usuario_id) DO NOTHING;
