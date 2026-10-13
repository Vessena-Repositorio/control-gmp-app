-- ============================================================================
-- Control de documentos: lectura con QR, evaluacion y QR fijo de consulta
-- ============================================================================
--
-- Pedido de Claudia (13/10/2026): los operarios de planta no tienen usuario
-- ni computadora. Para que se capaciten en un procedimiento:
--
--   Sesion de lectura: Claudia, Gloria o Antonella abren una sesion sobre una
--   version y muestran su QR. Cada operario lo escanea, lee el documento en
--   pantalla (sin descarga), contesta la evaluacion si la hay y se identifica
--   con el codigo de su credencial. Al cerrar, quien capacito FIRMA la lista
--   con su usuario y clave y los aprobados quedan como capacitacion en su
--   legajo (coleccion R de Capacitaciones).
--
--   Por que firma quien capacita y no el operario: el codigo de la credencial
--   identifica pero no es una firma electronica (no es secreto). Quien
--   capacita da fe de quien estuvo, como hoy con la planilla REG-SOP-AC-039-A.
--
--   QR fijo: un QR por documento, para pegar en el puesto, que siempre abre la
--   version vigente para leer. Reemplaza a las copias impresas que quedan
--   obsoletas en planta.

-- QR fijo por documento. Se genera al pedirlo; un token largo y aleatorio.
ALTER TABLE dc_documentos ADD COLUMN IF NOT EXISTS qr_token TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS dc_documentos_qr_idx ON dc_documentos (qr_token) WHERE qr_token IS NOT NULL;

-- Evaluacion de la version: [{ texto, opciones: [..], correcta: indice }].
-- Es material de capacitacion, no contenido firmado: se puede cargar despues
-- de aprobada, pero no cambiar una vez que alguien la contesto.
ALTER TABLE dc_versiones ADD COLUMN IF NOT EXISTS evaluacion JSONB;
ALTER TABLE dc_versiones ADD COLUMN IF NOT EXISTS puntaje_minimo INT NOT NULL DEFAULT 80
    CHECK (puntaje_minimo BETWEEN 0 AND 100);

CREATE TABLE IF NOT EXISTS dc_sesiones (
    id                BIGSERIAL PRIMARY KEY,
    version_id        BIGINT NOT NULL REFERENCES dc_versiones (id) ON DELETE RESTRICT,
    token             TEXT NOT NULL UNIQUE,
    lugar             TEXT,
    abierta_por_id    BIGINT NOT NULL REFERENCES usuarios (id),
    abierta_en        TIMESTAMPTZ NOT NULL DEFAULT now(),
    vence_en          TIMESTAMPTZ NOT NULL,
    cerrada_en        TIMESTAMPTZ,
    firma_id          BIGINT REFERENCES firmas_electronicas (id),
    horas             NUMERIC(4,2),
    registros_creados INT
);

CREATE TABLE IF NOT EXISTS dc_sesion_asistentes (
    id              BIGSERIAL PRIMARY KEY,
    sesion_id       BIGINT NOT NULL REFERENCES dc_sesiones (id) ON DELETE RESTRICT,
    persona_nombre  TEXT NOT NULL,     -- como esta en el padron de Capacitaciones
    persona_sector  TEXT,
    identificador   TEXT NOT NULL,     -- el codigo que se leyo o escribio
    puntaje         INT,               -- null si la version no tiene evaluacion
    aprobado        BOOLEAN NOT NULL,
    intentos        INT NOT NULL DEFAULT 1,
    respuestas      JSONB,
    confirmado_en   TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (sesion_id, persona_nombre)
);

-- Codigo de la credencial de cada persona. Claudia consigue la lista; si el
-- codigo coincide con la cedula o el numero de funcionario del padron, no
-- hace falta cargar nada.
CREATE TABLE IF NOT EXISTS personal_codigos (
    codigo      TEXT PRIMARY KEY,
    ci          TEXT,
    nro         TEXT,
    nombre      TEXT,
    cargado_en  TIMESTAMPTZ NOT NULL DEFAULT now(),
    cargado_por TEXT
);

DROP TRIGGER IF EXISTS dc_sesiones_sin_borrado ON dc_sesiones;
CREATE TRIGGER dc_sesiones_sin_borrado BEFORE DELETE ON dc_sesiones
    FOR EACH ROW EXECUTE FUNCTION sin_borrado();
DROP TRIGGER IF EXISTS dc_sesiones_audit ON dc_sesiones;
CREATE TRIGGER dc_sesiones_audit AFTER INSERT OR UPDATE ON dc_sesiones
    FOR EACH ROW EXECUTE FUNCTION audit_registrar('control-documentos', 'token');
DROP TRIGGER IF EXISTS dc_sesion_asistentes_sin_borrado ON dc_sesion_asistentes;
CREATE TRIGGER dc_sesion_asistentes_sin_borrado BEFORE DELETE ON dc_sesion_asistentes
    FOR EACH ROW EXECUTE FUNCTION sin_borrado();
DROP TRIGGER IF EXISTS dc_sesion_asistentes_audit ON dc_sesion_asistentes;
CREATE TRIGGER dc_sesion_asistentes_audit AFTER INSERT OR UPDATE ON dc_sesion_asistentes
    FOR EACH ROW EXECUTE FUNCTION audit_registrar('control-documentos', '');

-- Quien capacita: Claudia y Gloria ya administran; Antonella pasa a aprobar
-- en el modulo (si hoy solo tiene vista por haber tenido una tarea).
INSERT INTO usuario_recursos (usuario_id, recurso, rol)
SELECT u.id, 'control-documentos', 'aprobador'
FROM usuarios u
WHERE lower(u.usuario) = 'antonella.nunez@vessena.com.uy' AND u.origen = 'vessena'
ON CONFLICT (usuario_id, recurso) DO UPDATE SET rol = 'aprobador'
WHERE usuario_recursos.rol = 'vista';
