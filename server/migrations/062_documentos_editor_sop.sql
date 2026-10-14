-- ============================================================================
-- Control de documentos: SOP escritos en la app con el formato AX-SOP-DOC-001-B
-- ============================================================================
--
-- Claudia (14/10/2026): crear el documento dentro de la app y que salga con el
-- formato de procedimiento. El contenido se guarda por secciones (las diez de
-- AX-SOP-DOC-001-B "Formato de SOPs" V2.0) en `contenido_json`; el PDF lo arma
-- el servidor (lib/formato-sop.js) con el encabezado, las tablas de firmas, el
-- indice y el historico de cambios, que salen del propio sistema.
--
-- La firma se hace sobre el hash del contenido (contenido_sha256). El PDF
-- oficial se genera al aprobar, con los nombres y fechas de las firmas, y
-- queda como pdf_ruta de la version: completar un PDF que faltaba esta
-- permitido; reemplazarlo, no.

ALTER TABLE dc_versiones ADD COLUMN IF NOT EXISTS contenido_json JSONB;

-- El contenido por secciones tambien queda congelado fuera de borrador. Misma
-- funcion que la 054, con contenido_json agregado.
CREATE OR REPLACE FUNCTION dc_versiones_guardia() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF OLD.estado <> 'borrador' AND (
           NEW.documento_id     IS DISTINCT FROM OLD.documento_id
        OR NEW.numero           IS DISTINCT FROM OLD.numero
        OR NEW.formato          IS DISTINCT FROM OLD.formato
        OR NEW.contenido_html   IS DISTINCT FROM OLD.contenido_html
        OR NEW.contenido_json   IS DISTINCT FROM OLD.contenido_json
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

-- El contenido por secciones es grande y se guarda muchas veces en borrador:
-- en el audit trail queda su hash, como con contenido_html.
DROP TRIGGER IF EXISTS dc_versiones_audit ON dc_versiones;
CREATE TRIGGER dc_versiones_audit AFTER INSERT OR UPDATE ON dc_versiones
    FOR EACH ROW EXECUTE FUNCTION audit_registrar('control-documentos', 'contenido_html,contenido_json');
