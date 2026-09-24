-- ============================================================================
-- Gestión de Estándares (SOP-LCC-071 v2.0) — sale del Apps Script
-- ============================================================================
--
-- Pedido de Claudia (23/09/2026). La app vieja tenia login y contraseñas
-- propios en la planilla, y los adjuntos iban a Drive con "cualquiera con el
-- enlace". Aca: sesion del portal (recurso 'estandares', ya existia) y los
-- archivos en la base, detras de la sesion.
--
-- Se mantiene todo lo del SOP: los cinco registros (REG-A registro e
-- inspecciones, REG-B certificado con doble firma, REG-C listado de stock,
-- REG-D rotulo por envase, REG-E lote interno correlativo), las reglas de
-- vencimiento (6 meses MP/granel/PT, 12 meses certificado), los estados y el
-- audit trail con motivo obligatorio.
--
-- Los estados 'vencido' y 'proximo_a_vencer' NO se guardan: se calculan contra
-- la fecha de hoy, como hacia computeStatus_(). Guardarlos obligaria a correr
-- un proceso diario solo para mantenerlos al dia, y un dia sin correr dejaria
-- un vencido figurando como vigente.

CREATE TABLE IF NOT EXISTS est_lotes (
    numero         BIGINT PRIMARY KEY,           -- correlativo Vessena (venia de 1221)
    material       TEXT NOT NULL,
    lote_proveedor TEXT,
    observaciones  TEXT,
    emitido_por    TEXT,
    emitido_por_id BIGINT REFERENCES usuarios (id),
    emitido_en     TIMESTAMPTZ NOT NULL DEFAULT now(),
    origen         TEXT NOT NULL DEFAULT 'app'   -- 'app' | 'planilla'
);

CREATE TABLE IF NOT EXISTS est_estandares (
    id                BIGSERIAL PRIMARY KEY,
    codigo            TEXT NOT NULL UNIQUE,
    nombre            TEXT NOT NULL,
    tipo              TEXT NOT NULL CHECK (tipo IN ('mp', 'granel', 'pt', 'certificado')),
    proveedor         TEXT,
    lote_proveedor    TEXT,
    lote_interno      BIGINT,
    cantidad          TEXT,
    pureza            TEXT,
    conservacion      TEXT,
    ubicacion         TEXT,
    recepcion         DATE NOT NULL,
    vencimiento       DATE NOT NULL,
    reanalisis        DATE,
    fuera_de_stock_en DATE,
    envases           INT NOT NULL DEFAULT 1,
    coa_ref           TEXT,
    msds_ref          TEXT,
    notas             TEXT,                      -- REG-A: notas del registro
    observaciones     TEXT,

    -- Solo los estados definitivos o marcados a mano. El resto se calcula.
    estado            TEXT NOT NULL DEFAULT 'vigente'
                      CHECK (estado IN ('vigente', 'alterado', 'obsoleto', 'fuera_de_stock')),

    creado_por        TEXT,
    creado_por_id     BIGINT REFERENCES usuarios (id),
    creado_en         TIMESTAMPTZ NOT NULL DEFAULT now(),
    actualizado_por   TEXT,
    actualizado_en    TIMESTAMPTZ NOT NULL DEFAULT now(),
    origen            TEXT NOT NULL DEFAULT 'app',

    -- Ultimo umbral avisado (30, 15, 7, 1, 0): evita repetir el mismo correo.
    aviso_umbral      INT,
    aviso_en          TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS est_estandares_venc_idx ON est_estandares (vencimiento);

CREATE TABLE IF NOT EXISTS est_inspecciones (
    id           BIGSERIAL PRIMARY KEY,
    estandar_id  BIGINT NOT NULL REFERENCES est_estandares (id),
    fecha        DATE NOT NULL,
    conforme     BOOLEAN NOT NULL,
    observacion  TEXT,
    analista     TEXT,
    analista_id  BIGINT REFERENCES usuarios (id),
    creado_en    TIMESTAMPTZ NOT NULL DEFAULT now(),
    origen       TEXT NOT NULL DEFAULT 'app'
);

CREATE INDEX IF NOT EXISTS est_inspecciones_estandar_idx ON est_inspecciones (estandar_id, fecha DESC);

-- Un certificado por estandar, como en la app vieja.
CREATE TABLE IF NOT EXISTS est_certificados (
    estandar_id          BIGINT PRIMARY KEY REFERENCES est_estandares (id),
    analisis             DATE NOT NULL,
    ref_sustancia        TEXT,
    ref_codigo           TEXT,
    ref_pureza           TEXT,
    ref_vencimiento      DATE,
    tecnica              TEXT,
    reanalisis           DATE,
    vencimiento          DATE NOT NULL,
    ensayos              JSONB NOT NULL DEFAULT '[]',   -- [{aspecto, especificacion, resultado}]
    analista             TEXT,
    analista_id          BIGINT REFERENCES usuarios (id),
    firmado_analista_en  TIMESTAMPTZ,
    coordinador          TEXT,
    coordinador_id       BIGINT REFERENCES usuarios (id),
    firmado_coord_en     TIMESTAMPTZ,
    nota_coordinador     TEXT,
    origen               TEXT NOT NULL DEFAULT 'app'
);

-- CoA y MSDS. En la base y no en Drive: en Drive quedaban publicos por enlace.
CREATE TABLE IF NOT EXISTS est_adjuntos (
    id          BIGSERIAL PRIMARY KEY,
    estandar_id BIGINT NOT NULL REFERENCES est_estandares (id),
    clase       TEXT NOT NULL CHECK (clase IN ('coa', 'msds')),
    nombre      TEXT NOT NULL,
    tipo        TEXT NOT NULL,
    tamano      INT NOT NULL,
    contenido   BYTEA NOT NULL,
    subido_por  TEXT,
    subido_en   TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (estandar_id, clase)
);

CREATE TABLE IF NOT EXISTS est_actividad (
    id          BIGSERIAL PRIMARY KEY,
    ts          TIMESTAMPTZ NOT NULL DEFAULT now(),
    usuario     TEXT,
    accion      TEXT NOT NULL,
    entidad     TEXT,
    entidad_id  TEXT,
    motivo      TEXT,
    antes       JSONB,
    despues     JSONB
);

CREATE INDEX IF NOT EXISTS est_actividad_ts_idx ON est_actividad (ts DESC);

-- Marca de la importacion del historial: se hace una sola vez.
CREATE TABLE IF NOT EXISTS est_importacion (
    unica        BOOLEAN PRIMARY KEY DEFAULT true CHECK (unica),
    importado_en TIMESTAMPTZ NOT NULL DEFAULT now(),
    importado_por TEXT,
    detalle      TEXT
);

-- Antonella y Gloria firman como coordinadoras el certificado (REG-B): con
-- 'revisor' no podian aprobar. Claudia ya es administradora.
UPDATE usuario_recursos
   SET rol = 'aprobador'
 WHERE recurso = 'estandares'
   AND usuario_id IN (SELECT id FROM usuarios
                       WHERE lower(usuario) IN ('antonella.nunez@vessena.com.uy',
                                                'gloria.nunez@vessena.com.uy'));

-- Mismos destinatarios que hoy manda el Apps Script.
INSERT INTO notificacion_supervisores (recurso, notificacion, usuario_id, nota)
SELECT 'estandares', n.notificacion, u.id, n.nota
FROM (VALUES
    ('antonella.nunez@vessena.com.uy', 'vencimientos',    'avisos de 30, 15, 7, 1 día y vencido'),
    ('analista.minilab@vessena.com.uy', 'vencimientos',   'avisos de 30, 15, 7, 1 día y vencido'),
    ('claudia.barlocco@vessena.com.uy', 'resumen-semanal', 'resumen de los lunes')
) AS n(email, notificacion, nota)
JOIN usuarios u ON lower(u.usuario) = n.email AND u.origen = 'vessena'
ON CONFLICT DO NOTHING;
