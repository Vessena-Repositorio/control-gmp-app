-- ============================================================================
-- Control de documentos: base, audit trail Part 11 y firma electronica
-- ============================================================================
--
-- Pedido de Claudia el 07/10/2026: reemplazar las carpetas de la red (Word y
-- PDF, revision pasando el papel, documentos vencidos) por un sistema con ciclo
-- de revision y aprobacion, entrenamiento y avisos, que cumpla 21 CFR Part 11.
--
-- Esta migracion es la etapa cero: las tablas del documento y sus versiones,
-- el audit trail y la firma electronica. El ciclo (tareas, plazos, correos),
-- la carga de archivos y el entrenamiento vienen despues y se apoyan en esto.
--
-- Prefijo dc_: la tabla `documentos` ya existe y es la replica de planillas de
-- sync-documentos.js. No tiene nada que ver con esto.
--
-- Tres reglas que se hacen cumplir EN LA BASE, no en la aplicacion, porque
-- Part 11 pide que el control no dependa de que el codigo se acuerde:
--   1. Todo alta o cambio en dc_documentos y dc_versiones deja una fila en
--      audit_trail, con quien, cuando, valor anterior y nuevo, y motivo. La
--      escribe un trigger; si la aplicacion no dice quien es, el cambio se
--      rechaza.
--   2. audit_trail y firmas_electronicas solo admiten INSERT. Cada fila del
--      audit trail lleva el hash de la anterior: borrar o retocar una rompe la
--      cadena y verificar_audit_trail() lo detecta.
--   3. Un documento o una version no se borran nunca (se anulan o pasan a
--      obsoletos), y el contenido de una version deja de poder cambiarse en
--      cuanto sale de borrador: lo que se firmo es lo que queda.

-- ---------------------------------------------------------------------------
-- Audit trail (general: otras apps lo pueden usar con el mismo trigger)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit_trail (
    id              BIGSERIAL PRIMARY KEY,
    -- Orden de la cadena de hashes. No se usa `id` porque la secuencia se toma
    -- antes del lock: dos transacciones simultaneas podrian encadenarse en un
    -- orden distinto al de sus ids.
    seq             BIGINT NOT NULL UNIQUE,
    -- Hora del servidor, la pone el trigger. Lo que mande la aplicacion se
    -- ignora: un registro no puede elegir su propia fecha.
    ts              TIMESTAMPTZ NOT NULL,
    usuario_id      BIGINT REFERENCES usuarios (id) ON DELETE RESTRICT,
    -- El nombre tal como era en ese momento: si mañana se corrige el nombre del
    -- usuario, el registro sigue diciendo quien fue entonces.
    usuario_nombre  TEXT NOT NULL,
    recurso         TEXT NOT NULL,
    tabla           TEXT NOT NULL,
    registro_id     TEXT NOT NULL,
    accion          TEXT NOT NULL CHECK (accion IN ('alta', 'modificacion', 'firma')),
    antes           JSONB,
    despues         JSONB,
    -- Solo los campos que cambiaron, { campo: { antes, despues } }: es lo que
    -- se muestra en pantalla.
    cambios         JSONB,
    motivo          TEXT,
    ip              TEXT,
    hash_anterior   TEXT,
    hash            TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS audit_trail_registro_idx ON audit_trail (tabla, registro_id, seq);
CREATE INDEX IF NOT EXISTS audit_trail_ts_idx       ON audit_trail (ts DESC);
CREATE INDEX IF NOT EXISTS audit_trail_usuario_idx  ON audit_trail (usuario_id, ts DESC);

-- El texto que se hashea. Es una funcion aparte para que el trigger y la
-- verificacion calculen exactamente lo mismo. jsonb::text es canonico (orden de
-- claves y espacios fijos), asi que el resultado es reproducible.
CREATE OR REPLACE FUNCTION audit_trail_huella(r audit_trail) RETURNS TEXT
LANGUAGE sql STABLE AS $$
    SELECT encode(sha256(convert_to(concat_ws('|',
        coalesce(r.hash_anterior, ''), r.seq::text,
        to_char(r.ts AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US'),
        coalesce(r.usuario_id::text, ''), r.usuario_nombre, r.recurso, r.tabla,
        r.registro_id, r.accion,
        coalesce(r.antes::text, ''), coalesce(r.despues::text, ''),
        coalesce(r.cambios::text, ''), coalesce(r.motivo, ''), coalesce(r.ip, '')
    ), 'UTF8')), 'hex')
$$;

CREATE OR REPLACE FUNCTION audit_trail_encadenar() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    previo audit_trail%ROWTYPE;
BEGIN
    -- Una sola transaccion a la vez agrega al audit trail, hasta su COMMIT. Sin
    -- esto dos inserciones simultaneas tomarian el mismo "anterior" y la cadena
    -- se bifurcaria. El volumen es de personas firmando, no de maquinas: el
    -- costo de serializar no se nota.
    PERFORM pg_advisory_xact_lock(4210772);

    SELECT * INTO previo FROM audit_trail ORDER BY seq DESC LIMIT 1;

    NEW.seq := coalesce(previo.seq, 0) + 1;
    NEW.ts := clock_timestamp();
    NEW.hash_anterior := previo.hash;
    NEW.hash := audit_trail_huella(NEW);
    RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS audit_trail_encadenar ON audit_trail;
CREATE TRIGGER audit_trail_encadenar BEFORE INSERT ON audit_trail
    FOR EACH ROW EXECUTE FUNCTION audit_trail_encadenar();

-- Registros que solo admiten INSERT. Se usa para audit_trail y para
-- firmas_electronicas.
CREATE OR REPLACE FUNCTION solo_agregar() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION '% no admite %: es un registro que solo se agrega (21 CFR 11.10(e))',
        TG_TABLE_NAME, TG_OP;
END $$;

DROP TRIGGER IF EXISTS audit_trail_inmutable ON audit_trail;
CREATE TRIGGER audit_trail_inmutable BEFORE UPDATE OR DELETE ON audit_trail
    FOR EACH ROW EXECUTE FUNCTION solo_agregar();
DROP TRIGGER IF EXISTS audit_trail_sin_truncate ON audit_trail;
CREATE TRIGGER audit_trail_sin_truncate BEFORE TRUNCATE ON audit_trail
    FOR EACH STATEMENT EXECUTE FUNCTION solo_agregar();

-- Recorre la cadena y devuelve las filas que no cierran. Vacio = integro.
-- Detecta una fila retocada (su hash no coincide), una borrada (salto de seq o
-- hash_anterior que no es el de la anterior) y una agregada a mano.
CREATE OR REPLACE FUNCTION verificar_audit_trail()
RETURNS TABLE (seq BIGINT, problema TEXT)
LANGUAGE sql STABLE AS $$
    WITH c AS (
        SELECT a.seq, a.hash, a.hash_anterior,
               audit_trail_huella(a) AS recalculado,
               lag(a.seq) OVER w AS seq_previa, lag(a.hash) OVER w AS hash_previo
        FROM audit_trail a
        WINDOW w AS (ORDER BY a.seq)
    )
    SELECT c.seq, CASE
        WHEN c.hash <> c.recalculado THEN 'el contenido no coincide con su hash'
        WHEN c.seq_previa IS NULL AND c.seq <> 1 THEN 'faltan registros al comienzo'
        WHEN c.seq_previa IS NOT NULL AND c.seq <> c.seq_previa + 1 THEN 'faltan registros antes de este'
        WHEN c.hash_anterior IS DISTINCT FROM c.hash_previo THEN 'no encadena con el registro anterior'
    END
    FROM c
    WHERE c.hash <> c.recalculado
       OR (c.seq_previa IS NULL AND c.seq <> 1)
       OR (c.seq_previa IS NOT NULL AND c.seq <> c.seq_previa + 1)
       OR c.hash_anterior IS DISTINCT FROM c.hash_previo
    ORDER BY c.seq
$$;

-- Trigger generico que audita una tabla. Argumentos:
--   TG_ARGV[0]  recurso (la app)
--   TG_ARGV[1]  campos que no se copian al audit trail, separados por coma
--               (contenido grande que ya se representa con su hash)
--
-- Quien hace el cambio lo dice la aplicacion con set_config(..., true) dentro
-- de la misma transaccion (lib/audit-trail.js). Sin eso el cambio se rechaza:
-- un registro GMP sin autor no puede existir.
CREATE OR REPLACE FUNCTION audit_registrar() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    excluidos TEXT[] := '{}';
    nombre    TEXT := nullif(current_setting('app.usuario_nombre', true), '');
    v_antes   JSONB;
    v_despues JSONB;
    v_cambios JSONB;
    v_accion  TEXT;
BEGIN
    IF TG_NARGS > 1 AND TG_ARGV[1] <> '' THEN
        excluidos := string_to_array(TG_ARGV[1], ',');
    END IF;
    IF nombre IS NULL THEN
        RAISE EXCEPTION 'cambio en % sin usuario identificado: toda modificacion debe ser atribuible', TG_TABLE_NAME;
    END IF;

    v_despues := to_jsonb(NEW) - excluidos;
    IF TG_OP = 'UPDATE' THEN
        v_antes := to_jsonb(OLD) - excluidos;
        SELECT jsonb_object_agg(k, jsonb_build_object('antes', v_antes -> k, 'despues', v_despues -> k))
          INTO v_cambios
          FROM jsonb_object_keys(v_despues) AS k
         WHERE v_antes -> k IS DISTINCT FROM v_despues -> k;
        -- Un UPDATE que no cambia nada no es un evento.
        IF v_cambios IS NULL THEN RETURN NEW; END IF;
        v_accion := 'modificacion';
    ELSIF TG_TABLE_NAME = 'firmas_electronicas' THEN
        v_accion := 'firma';
    ELSE
        v_accion := 'alta';
    END IF;

    INSERT INTO audit_trail (seq, ts, usuario_id, usuario_nombre, recurso, tabla, registro_id,
                             accion, antes, despues, cambios, motivo, ip, hash)
    VALUES (0, now(),  -- seq, ts y hash los pone audit_trail_encadenar
            nullif(current_setting('app.usuario_id', true), '')::bigint, nombre,
            TG_ARGV[0], TG_TABLE_NAME, (to_jsonb(NEW) ->> 'id'),
            v_accion, v_antes, v_despues, v_cambios,
            nullif(current_setting('app.motivo', true), ''),
            nullif(current_setting('app.ip', true), ''), '');
    RETURN NEW;
END $$;

-- Nada se borra. Se aplica a las tablas de documentos.
CREATE OR REPLACE FUNCTION sin_borrado() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'en % no se borra: se anula o se pasa a obsoleto', TG_TABLE_NAME;
END $$;

-- ---------------------------------------------------------------------------
-- Firma electronica (general: la usara cualquier app que firme)
-- ---------------------------------------------------------------------------
-- Una fila por firma. Cumple 11.50 (nombre impreso, fecha y hora, significado)
-- y 11.70 (la firma queda atada al registro: guarda el hash del contenido que
-- se firmo; si el contenido cambia, la firma deja de corresponder y se ve).
CREATE TABLE IF NOT EXISTS firmas_electronicas (
    id               BIGSERIAL PRIMARY KEY,
    usuario_id       BIGINT NOT NULL REFERENCES usuarios (id) ON DELETE RESTRICT,
    nombre           TEXT NOT NULL,     -- nombre impreso, como era al firmar
    usuario_txt      TEXT NOT NULL,     -- identificador con el que se autentico
    significado      TEXT NOT NULL,     -- autor | revisor | aprobador | ... (lib/firma-electronica.js)
    recurso          TEXT NOT NULL,
    tabla            TEXT NOT NULL,
    registro_id      TEXT NOT NULL,
    contenido_sha256 TEXT,
    comentario       TEXT,
    firmado_en       TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    ip               TEXT,
    user_agent       TEXT
);

CREATE INDEX IF NOT EXISTS firmas_electronicas_registro_idx
    ON firmas_electronicas (tabla, registro_id, firmado_en);
CREATE INDEX IF NOT EXISTS firmas_electronicas_usuario_idx
    ON firmas_electronicas (usuario_id, firmado_en DESC);

DROP TRIGGER IF EXISTS firmas_electronicas_inmutable ON firmas_electronicas;
CREATE TRIGGER firmas_electronicas_inmutable BEFORE UPDATE OR DELETE ON firmas_electronicas
    FOR EACH ROW EXECUTE FUNCTION solo_agregar();
DROP TRIGGER IF EXISTS firmas_electronicas_sin_truncate ON firmas_electronicas;
CREATE TRIGGER firmas_electronicas_sin_truncate BEFORE TRUNCATE ON firmas_electronicas
    FOR EACH STATEMENT EXECUTE FUNCTION solo_agregar();
DROP TRIGGER IF EXISTS firmas_electronicas_audit ON firmas_electronicas;
CREATE TRIGGER firmas_electronicas_audit AFTER INSERT ON firmas_electronicas
    FOR EACH ROW EXECUTE FUNCTION audit_registrar('firma-electronica', '');

-- Politica de claves para firmar (11.300). Una clave que vino de un sistema
-- viejo (PIN de 4 digitos en djb2, reescrito a scrypt en el login) sigue
-- sirviendo para entrar, pero no para firmar: para eso hay que haberla fijado
-- con la politica actual (12 caracteres minimo, POST /api/auth/clave). Esta
-- columna dice desde cuando, y sirve tambien para pedir que se renueve.
ALTER TABLE credenciales ADD COLUMN IF NOT EXISTS politica_desde TIMESTAMPTZ;

-- ---------------------------------------------------------------------------
-- Documentos
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS dc_tipos (
    codigo          TEXT PRIMARY KEY,   -- prefijo del codigo del documento
    nombre          TEXT NOT NULL,
    -- Cada cuanto vence un documento vigente: 3 años para todos (Claudia,
    -- 07/10/2026). Queda por tipo por si algun dia uno necesita otro plazo.
    meses_revision  INT NOT NULL DEFAULT 36 CHECK (meses_revision > 0),
    activo          BOOLEAN NOT NULL DEFAULT true
);

-- Los tipos del listado maestro LIS-SOP-DOC-001-E (hoja Parametros y los que
-- aparecen en el listado). El codigo del tipo es el comienzo del codigo del
-- documento: REG-SOP-AC-038-A es un REG-SOP.
INSERT INTO dc_tipos (codigo, nombre) VALUES
    ('SOP',     'Procedimiento estándar de operación'),
    ('AX-SOP',  'Anexo de SOP'),
    ('REG-SOP', 'Registro de SOP'),
    ('LIS-SOP', 'Listado de SOP'),
    ('PL-SOP',  'Plan de SOP'),
    ('PL',      'Plan'),
    ('PMV',     'Plan maestro de validación'),
    ('INS',     'Instructivo'),
    ('ESP',     'Especificación'),
    ('MAN',     'Manual'),
    ('RI',      'Reglamento interno'),
    ('SMF',     'Site Master File'),
    ('PRO',     'Procedimiento'),
    ('MET',     'Metodología analítica'),
    ('AX-MET',  'Anexo de metodología analítica'),
    ('AX-FORM', 'Anexo de formato'),
    ('AX-PC',   'Anexo de protocolo de calificación'),
    ('EXT',     'Documento externo')
ON CONFLICT (codigo) DO NOTHING;

CREATE TABLE IF NOT EXISTS dc_documentos (
    id               BIGSERIAL PRIMARY KEY,
    codigo           TEXT NOT NULL,          -- ej. SOP-AC-029
    titulo           TEXT NOT NULL,
    tipo             TEXT NOT NULL REFERENCES dc_tipos (codigo),
    area             TEXT,
    dueno_id         BIGINT REFERENCES usuarios (id),
    externo          BOOLEAN NOT NULL DEFAULT false,
    -- Si es null vale el plazo del tipo.
    meses_revision   INT CHECK (meses_revision > 0),
    proxima_revision DATE,
    -- Desde cuando se avisa el vencimiento. Null = desde el vencimiento mismo.
    -- Lo usa la importacion para los que llegan ya vencidos: se escalonan en 6
    -- meses en vez de mandar 72 avisos el primer dia (Claudia, 07/10/2026).
    -- Siguen viendose como vencidos.
    avisar_desde     DATE,
    creado_en        TIMESTAMPTZ NOT NULL DEFAULT now(),
    creado_por_id    BIGINT REFERENCES usuarios (id)
);

-- El codigo identifica al documento en el papel y en las conversaciones: no
-- puede haber dos, ni siquiera cambiando mayusculas.
CREATE UNIQUE INDEX IF NOT EXISTS dc_documentos_codigo_idx ON dc_documentos (upper(codigo));

CREATE TABLE IF NOT EXISTS dc_versiones (
    id                  BIGSERIAL PRIMARY KEY,
    documento_id        BIGINT NOT NULL REFERENCES dc_documentos (id) ON DELETE RESTRICT,
    -- La version como la escriben: 6.0, 1.02. Se guarda como numero para
    -- ordenar y para calcular la siguiente (piso + 1: despues de 6.0 va 7.0).
    numero              NUMERIC(8,3) NOT NULL CHECK (numero >= 0),
    -- borrador → en_revision → en_aprobacion → aprobado → en_entrenamiento →
    -- vigente → obsoleto. `anulado` es el final de un borrador que no siguio.
    estado              TEXT NOT NULL DEFAULT 'borrador' CHECK (estado IN (
                            'borrador', 'en_revision', 'en_aprobacion', 'aprobado',
                            'en_entrenamiento', 'vigente', 'obsoleto', 'anulado')),
    -- editor: escrito en la app (los SOP nuevos). archivo: Word o PDF subido
    -- (los existentes y los anexos). Decision del 07/10/2026.
    formato             TEXT NOT NULL CHECK (formato IN ('editor', 'archivo')),
    contenido_html      TEXT,
    contenido_sha256    TEXT,
    archivo_ruta        TEXT,     -- relativa al volumen de documentos
    archivo_nombre      TEXT,
    archivo_mime        TEXT,
    archivo_bytes       BIGINT,
    archivo_sha256      TEXT,
    pdf_ruta            TEXT,     -- el PDF oficial que se firma y se distribuye
    pdf_sha256          TEXT,
    resumen_cambios     TEXT,
    cc_codigo           TEXT,     -- control de cambios que la origina
    requiere_evaluacion BOOLEAN NOT NULL DEFAULT false,
    fecha_aprobacion    TIMESTAMPTZ,
    -- Quien aprobo la version. Para las que se aprueben en el sistema sale de
    -- la firma; para las importadas, que se firmaron en papel, del listado
    -- maestro. Es quien puede renovarla (ademas de Calidad).
    aprobado_por_id     BIGINT REFERENCES usuarios (id),
    -- Los nombres tal como estan en el listado. Varios ya no tienen usuario
    -- (personas que ya no estan en la empresa) y el dato no se puede perder.
    elaborado_por_nombre TEXT,
    revisado_por_nombre  TEXT,
    aprobado_por_nombre  TEXT,
    observaciones        TEXT,
    fecha_vigencia      DATE,
    fecha_obsoleto      TIMESTAMPTZ,
    creado_en           TIMESTAMPTZ NOT NULL DEFAULT now(),
    creado_por_id       BIGINT REFERENCES usuarios (id),
    UNIQUE (documento_id, numero)
);

-- Una sola revision en curso por documento, y una sola vigente.
CREATE UNIQUE INDEX IF NOT EXISTS dc_versiones_en_curso_idx ON dc_versiones (documento_id)
    WHERE estado IN ('borrador', 'en_revision', 'en_aprobacion', 'aprobado', 'en_entrenamiento');
CREATE UNIQUE INDEX IF NOT EXISTS dc_versiones_vigente_idx ON dc_versiones (documento_id)
    WHERE estado = 'vigente';
CREATE INDEX IF NOT EXISTS dc_versiones_estado_idx ON dc_versiones (estado);

-- Lo que se firmo no cambia, y cambiar un registro que ya no es borrador exige
-- motivo (11.10(e): el audit trail registra el porque).
CREATE OR REPLACE FUNCTION dc_versiones_guardia() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    -- Fuera de borrador el contenido queda congelado. La unica excepcion es
    -- adjuntar un archivo donde no habia ninguno: las versiones que vienen del
    -- listado maestro entran vigentes y su Word o PDF se sube despues. Eso
    -- completa el registro, no lo cambia; reemplazar uno ya cargado no se puede.
    IF OLD.estado <> 'borrador' AND (
           NEW.documento_id     IS DISTINCT FROM OLD.documento_id
        OR NEW.numero           IS DISTINCT FROM OLD.numero
        OR NEW.formato          IS DISTINCT FROM OLD.formato
        OR NEW.contenido_html   IS DISTINCT FROM OLD.contenido_html
        OR NEW.contenido_sha256 IS DISTINCT FROM OLD.contenido_sha256
        OR (OLD.archivo_sha256 IS NOT NULL AND (
                NEW.archivo_ruta   IS DISTINCT FROM OLD.archivo_ruta
             OR NEW.archivo_sha256 IS DISTINCT FROM OLD.archivo_sha256
             OR NEW.archivo_nombre IS DISTINCT FROM OLD.archivo_nombre))
        OR (OLD.pdf_sha256 IS NOT NULL AND (
                NEW.pdf_ruta       IS DISTINCT FROM OLD.pdf_ruta
             OR NEW.pdf_sha256     IS DISTINCT FROM OLD.pdf_sha256))) THEN
        RAISE EXCEPTION 'la version % del documento % ya no es borrador: su contenido no se puede cambiar',
            OLD.numero, OLD.documento_id;
    END IF;
    IF OLD.estado <> 'borrador' AND nullif(current_setting('app.motivo', true), '') IS NULL THEN
        RAISE EXCEPTION 'cambiar una version que no es borrador exige un motivo';
    END IF;
    RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS dc_versiones_guardia ON dc_versiones;
CREATE TRIGGER dc_versiones_guardia BEFORE UPDATE ON dc_versiones
    FOR EACH ROW EXECUTE FUNCTION dc_versiones_guardia();

-- Los datos del documento (titulo, dueño, plazo) se pueden corregir, pero
-- siempre con motivo.
CREATE OR REPLACE FUNCTION dc_documentos_guardia() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF nullif(current_setting('app.motivo', true), '') IS NULL THEN
        RAISE EXCEPTION 'cambiar los datos de un documento exige un motivo';
    END IF;
    RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS dc_documentos_guardia ON dc_documentos;
CREATE TRIGGER dc_documentos_guardia BEFORE UPDATE ON dc_documentos
    FOR EACH ROW EXECUTE FUNCTION dc_documentos_guardia();

DROP TRIGGER IF EXISTS dc_documentos_sin_borrado ON dc_documentos;
CREATE TRIGGER dc_documentos_sin_borrado BEFORE DELETE ON dc_documentos
    FOR EACH ROW EXECUTE FUNCTION sin_borrado();
DROP TRIGGER IF EXISTS dc_versiones_sin_borrado ON dc_versiones;
CREATE TRIGGER dc_versiones_sin_borrado BEFORE DELETE ON dc_versiones
    FOR EACH ROW EXECUTE FUNCTION sin_borrado();

DROP TRIGGER IF EXISTS dc_documentos_audit ON dc_documentos;
CREATE TRIGGER dc_documentos_audit AFTER INSERT OR UPDATE ON dc_documentos
    FOR EACH ROW EXECUTE FUNCTION audit_registrar('control-documentos', '');
-- El HTML del editor puede ser largo y se edita muchas veces en borrador: en el
-- audit trail queda su hash (contenido_sha256), no el texto entero. El texto de
-- cada version queda en la version misma, y la comparacion entre versiones se
-- hace sobre eso.
DROP TRIGGER IF EXISTS dc_versiones_audit ON dc_versiones;
CREATE TRIGGER dc_versiones_audit AFTER INSERT OR UPDATE ON dc_versiones
    FOR EACH ROW EXECUTE FUNCTION audit_registrar('control-documentos', 'contenido_html');

-- ---------------------------------------------------------------------------
-- Acceso
-- ---------------------------------------------------------------------------
-- Claudia y Gloria administran: son Calidad, y entre otras cosas pueden renovar
-- cualquier documento (07/10/2026). El resto se habilita con los roles del ciclo.
INSERT INTO usuario_recursos (usuario_id, recurso, rol)
SELECT u.id, 'control-documentos', r.rol
FROM (VALUES
    ('claudia.barlocco@vessena.com.uy', 'administrador'),
    ('gloria.nunez@vessena.com.uy',     'administrador')
) AS r(email, rol)
JOIN usuarios u ON lower(u.usuario) = r.email AND u.origen = 'vessena'
ON CONFLICT (usuario_id, recurso) DO NOTHING;

-- Aviso inmediato cuando alguien falla tres veces la clave al firmar (11.300(d)).
INSERT INTO notificacion_supervisores (recurso, notificacion, usuario_id, nota)
SELECT 'control-documentos', 'firma-bloqueada', u.id, 'firma electrónica bloqueada por intentos fallidos'
FROM usuarios u
WHERE lower(u.usuario) IN ('claudia.barlocco@vessena.com.uy', 'gloria.nunez@vessena.com.uy')
  AND u.origen = 'vessena'
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- Importaciones del listado maestro
-- ---------------------------------------------------------------------------
-- Constancia de cada carga desde LIS-SOP-DOC-001-E: quien, cuando, el hash de
-- la planilla y el resumen de lo que entro y lo que no. Asi se puede probar
-- de donde salio cada documento que no nacio en el sistema.
CREATE TABLE IF NOT EXISTS dc_importaciones (
    id              BIGSERIAL PRIMARY KEY,
    importado_en    TIMESTAMPTZ NOT NULL DEFAULT now(),
    importado_por   TEXT NOT NULL,
    archivo_nombre  TEXT,
    archivo_sha256  TEXT,
    resumen         JSONB NOT NULL
);

DROP TRIGGER IF EXISTS dc_importaciones_inmutable ON dc_importaciones;
CREATE TRIGGER dc_importaciones_inmutable BEFORE UPDATE OR DELETE ON dc_importaciones
    FOR EACH ROW EXECUTE FUNCTION solo_agregar();

ALTER TABLE dc_versiones ADD COLUMN IF NOT EXISTS importacion_id BIGINT REFERENCES dc_importaciones (id);
