-- ============================================================================
-- Firmas registradas, y quien firmo cada muestra de granel
-- ============================================================================
--
-- La hoja impresa de cada ensayo (REG-SOP-AC-029) va al dossier fisico y
-- lleva la firma de quien analizo y de quien aprobo o rechazo. La firma
-- electronica es la sesion; la imagen de la firma manuscrita es como se
-- representa en el papel. Las imagenes las carga un administrador (decision de
-- Claudia, 15/09/2026).
--
-- Una firma no se pisa: reemplazarla cierra la anterior (`reemplazada_en`) y
-- agrega otra. Asi un ensayo firmado en marzo se sigue imprimiendo con la firma
-- y el cargo que la persona tenia en marzo, aunque en setiembre cambie.
--
-- La tabla no es de graneles: la firma es de la persona, y otras apps que
-- impriman registros la pueden usar.

CREATE TABLE IF NOT EXISTS firmas (
    id              BIGSERIAL PRIMARY KEY,
    usuario_id      BIGINT NOT NULL REFERENCES usuarios (id) ON DELETE RESTRICT,
    cargo           TEXT NOT NULL,
    -- data URL (image/png o image/jpeg en base64). Son imagenes chicas y se
    -- guardan en la base porque el contenedor no tiene disco persistente.
    imagen          TEXT NOT NULL,
    cargada_por     TEXT NOT NULL,
    cargada_en      TIMESTAMPTZ NOT NULL DEFAULT now(),
    reemplazada_en  TIMESTAMPTZ
);

-- Una sola firma vigente por persona.
CREATE UNIQUE INDEX IF NOT EXISTS firmas_vigente_idx
    ON firmas (usuario_id) WHERE reemplazada_en IS NULL;
CREATE INDEX IF NOT EXISTS firmas_usuario_idx ON firmas (usuario_id, cargada_en);

-- ---------------------------------------------------------------------------
-- Quien firmo cada muestra, como usuario y no solo como nombre escrito
-- ---------------------------------------------------------------------------
-- `analista` y `aprobado_por` guardan el nombre, que es lo que se muestra y lo
-- que quedo registrado. Para encontrar la firma hace falta la persona: dos
-- usuarios pueden llamarse igual, y un nombre se puede corregir.
ALTER TABLE gra_muestras ADD COLUMN IF NOT EXISTS analista_id     BIGINT REFERENCES usuarios (id);
ALTER TABLE gra_muestras ADD COLUMN IF NOT EXISTS aprobado_por_id BIGINT REFERENCES usuarios (id);

-- Las muestras cargadas antes de esta migracion se asocian por nombre, solo
-- cuando el nombre corresponde a una unica persona con acceso a la app. Si hay
-- dos con el mismo nombre queda sin asociar: mejor imprimir sin imagen que con
-- la firma de otra persona.
WITH candidatos AS (
    SELECT lower(u.nombre) AS nombre, min(u.id) AS id, count(*) AS n
    FROM usuarios u
    JOIN usuario_recursos r ON r.usuario_id = u.id AND r.recurso = 'aprobacion-graneles'
    WHERE u.nombre IS NOT NULL
    GROUP BY lower(u.nombre)
)
UPDATE gra_muestras m SET analista_id = c.id
FROM candidatos c
WHERE m.analista_id IS NULL AND c.n = 1 AND c.nombre = lower(m.analista);

WITH candidatos AS (
    SELECT lower(u.nombre) AS nombre, min(u.id) AS id, count(*) AS n
    FROM usuarios u
    JOIN usuario_recursos r ON r.usuario_id = u.id AND r.recurso = 'aprobacion-graneles'
    WHERE u.nombre IS NOT NULL
    GROUP BY lower(u.nombre)
)
UPDATE gra_muestras m SET aprobado_por_id = c.id
FROM candidatos c
WHERE m.aprobado_por_id IS NULL AND m.aprobado_por IS NOT NULL
  AND c.n = 1 AND c.nombre = lower(m.aprobado_por);
