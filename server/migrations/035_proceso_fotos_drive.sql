-- Copia al servidor de las fotos viejas de control en proceso, que estaban en
-- Google Drive (pedido de Claudia, 17/09/2026). Cada control conserva el enlace
-- original en raw.fotosDrive; raw.fotos pasa a apuntar a la copia.

-- De que archivo de Drive salio cada foto copiada. Unico: si la copia se corta
-- y se vuelve a lanzar, no se baja dos veces la misma foto.
ALTER TABLE proceso_fotos ADD COLUMN IF NOT EXISTS origen_url TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS proceso_fotos_origen_idx
    ON proceso_fotos (origen_url) WHERE origen_url IS NOT NULL;

-- Las que no se pudieron bajar. Despues de tres intentos se dejan de pedir y
-- el control sigue mostrando el enlace a Drive.
CREATE TABLE IF NOT EXISTS proceso_fotos_fallidas (
    url             TEXT PRIMARY KEY,
    intentos        INT NOT NULL DEFAULT 1,
    error           TEXT,
    ultimo_intento  TIMESTAMPTZ NOT NULL DEFAULT now()
);
