-- ============================================================================
-- Sesiones de capacitacion: pruebas en papel escaneadas y autocorregidas
-- ============================================================================
--
-- Claudia (13/10/2026): la evaluacion de cada procedimiento son 3 preguntas
-- de opcion multiple que se toman en papel. Desde la sesion se imprime una
-- hoja por persona (con su nombre, un QR que identifica sesion y persona, una
-- grilla de burbujas y la linea para su firma). Las hojas completas se
-- escanean, el navegador lee las burbujas contra el patron (la evaluacion de
-- la version) y quien capacita revisa y guarda el resultado.
--
-- El escaneo se guarda: es la evidencia de la prueba y lleva la firma de
-- cada operario.

CREATE TABLE IF NOT EXISTS dc_sesion_pruebas (
    id          BIGSERIAL PRIMARY KEY,
    sesion_id   BIGINT NOT NULL REFERENCES dc_sesiones (id) ON DELETE RESTRICT,
    nombre      TEXT NOT NULL,
    ruta        TEXT NOT NULL,
    sha256      TEXT NOT NULL,
    bytes       BIGINT NOT NULL,
    subido_por  TEXT NOT NULL,
    subido_en   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS dc_sesion_pruebas_sesion_idx ON dc_sesion_pruebas (sesion_id);

DROP TRIGGER IF EXISTS dc_sesion_pruebas_sin_borrado ON dc_sesion_pruebas;
CREATE TRIGGER dc_sesion_pruebas_sin_borrado BEFORE DELETE ON dc_sesion_pruebas
    FOR EACH ROW EXECUTE FUNCTION sin_borrado();
DROP TRIGGER IF EXISTS dc_sesion_pruebas_audit ON dc_sesion_pruebas;
CREATE TRIGGER dc_sesion_pruebas_audit AFTER INSERT OR UPDATE ON dc_sesion_pruebas
    FOR EACH ROW EXECUTE FUNCTION audit_registrar('control-documentos', '');
