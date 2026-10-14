-- ============================================================================
-- Control de documentos: matriz SOP x cargo y plan de capacitacion del puesto
-- ============================================================================
--
-- Claudia (14/10/2026). La matriz de capacitacion (Matriz-SOP-AC-039, hoja
-- "Matriz") dice, por cada SOP y cada cargo:
--   1  capacitacion prioritaria: el dia que la persona asume el cargo
--   2  no prioritaria: dentro de los 3 meses, o antes si le toca hacer la tarea
--   E / R / A  el cargo escribe, revisa o aprueba ese SOP
--
-- Cuando alguien asume un cargo (ingreso o cambio), se registra aca; su plan
-- de capacitacion sale de la matriz y lo hecho, de los registros de
-- Capacitaciones. Cuando sale una version nueva de un SOP, se capacita a
-- quienes tienen un cargo con 1 o 2 en ese SOP (ademas de los sectores
-- elegidos).
--
-- El cargo no esta en el padron de Capacitaciones (solo el sector) y no se lo
-- agrega ahi: la carga mensual de altas y bajas reescribe esas fichas.

CREATE TABLE IF NOT EXISTS dc_cargos (
    id      BIGSERIAL PRIMARY KEY,
    nombre  TEXT NOT NULL,
    orden   INT NOT NULL DEFAULT 100,
    activo  BOOLEAN NOT NULL DEFAULT true
);
CREATE UNIQUE INDEX IF NOT EXISTS dc_cargos_nombre_idx ON dc_cargos (lower(nombre));

-- Por codigo y no por documento: la matriz nombra SOP que todavia no estan
-- cargados (o con el codigo mal escrito), y no se pierden.
CREATE TABLE IF NOT EXISTS dc_matriz (
    id        BIGSERIAL PRIMARY KEY,
    cargo_id  BIGINT NOT NULL REFERENCES dc_cargos (id) ON DELETE RESTRICT,
    codigo    TEXT NOT NULL,
    valor     TEXT CHECK (valor IN ('1', '2', 'E', 'R', 'A', 'A/R', 'R/E')),  -- null = nada
    UNIQUE (cargo_id, codigo)
);
CREATE INDEX IF NOT EXISTS dc_matriz_codigo_idx ON dc_matriz (upper(codigo));

CREATE TABLE IF NOT EXISTS dc_personal_cargos (
    id              BIGSERIAL PRIMARY KEY,
    persona_nombre  TEXT NOT NULL,     -- como esta en el padron de Capacitaciones
    persona_ci      TEXT,
    cargo_id        BIGINT NOT NULL REFERENCES dc_cargos (id) ON DELETE RESTRICT,
    desde           DATE NOT NULL,
    hasta           DATE,              -- null = lo ocupa hoy
    creado_por_id   BIGINT REFERENCES usuarios (id),
    creado_en       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS dc_personal_cargos_persona_idx ON dc_personal_cargos (persona_nombre) WHERE hasta IS NULL;
CREATE INDEX IF NOT EXISTS dc_personal_cargos_cargo_idx ON dc_personal_cargos (cargo_id) WHERE hasta IS NULL;

DROP TRIGGER IF EXISTS dc_cargos_audit ON dc_cargos;
CREATE TRIGGER dc_cargos_audit AFTER INSERT OR UPDATE ON dc_cargos
    FOR EACH ROW EXECUTE FUNCTION audit_registrar('control-documentos', '');
DROP TRIGGER IF EXISTS dc_matriz_audit ON dc_matriz;
CREATE TRIGGER dc_matriz_audit AFTER INSERT OR UPDATE ON dc_matriz
    FOR EACH ROW EXECUTE FUNCTION audit_registrar('control-documentos', '');
DROP TRIGGER IF EXISTS dc_matriz_sin_borrado ON dc_matriz;
CREATE TRIGGER dc_matriz_sin_borrado BEFORE DELETE ON dc_matriz
    FOR EACH ROW EXECUTE FUNCTION sin_borrado();
DROP TRIGGER IF EXISTS dc_personal_cargos_audit ON dc_personal_cargos;
CREATE TRIGGER dc_personal_cargos_audit AFTER INSERT OR UPDATE ON dc_personal_cargos
    FOR EACH ROW EXECUTE FUNCTION audit_registrar('control-documentos', '');
DROP TRIGGER IF EXISTS dc_personal_cargos_sin_borrado ON dc_personal_cargos;
CREATE TRIGGER dc_personal_cargos_sin_borrado BEFORE DELETE ON dc_personal_cargos
    FOR EACH ROW EXECUTE FUNCTION sin_borrado();
