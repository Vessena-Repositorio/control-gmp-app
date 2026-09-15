-- ============================================================================
-- Firmas y muestras apuntando al usuario con el que la persona entra
-- ============================================================================
--
-- Una misma persona tiene varias filas en `usuarios`: la del portal (origen
-- 'vessena', con el nombre bien escrito) y las que trajeron las replicas de las
-- apps viejas ("Antonella Nuñez", "Monica Puñales", "claudia.barlocco"). La
-- 024 dio acceso a graneles a todas las filas con ese mail, asi que la pestaña
-- Firmas mostraba a cada persona dos o tres veces, y el 15/09/2026 dos firmas
-- se cargaron en filas con las que nadie entra. Al imprimir, la firma se busca
-- por el usuario de la sesion: esas firmas no iban a salir nunca.
--
-- El usuario "de ingreso" es el mismo que elige el login (routes/auth.js): por
-- mail, prefiriendo origen 'vessena'.

CREATE TEMP TABLE ingreso_de ON COMMIT DROP AS
SELECT DISTINCT ON (lower(usuario)) lower(usuario) AS clave, id AS ingreso_id
FROM usuarios
WHERE activo
ORDER BY lower(usuario), (origen = 'vessena') DESC, id;

-- Cada fila duplicada, con la fila de ingreso de esa persona.
CREATE TEMP TABLE a_ingreso ON COMMIT DROP AS
SELECT u.id AS usuario_id, i.ingreso_id
FROM usuarios u
JOIN ingreso_de i ON i.clave = lower(u.usuario)
WHERE u.id <> i.ingreso_id;

-- ---------------------------------------------------------------------------
-- Firmas
-- ---------------------------------------------------------------------------
-- Solo puede quedar una vigente por persona. Si la fila de ingreso ya tiene
-- una, o si hay varias entre los duplicados, se deja vigente la mas nueva y el
-- resto se cierra: nada se borra.
WITH candidatas AS (
    SELECT f.id, a.ingreso_id,
           row_number() OVER (PARTITION BY a.ingreso_id ORDER BY f.cargada_en DESC) AS orden
    FROM firmas f
    JOIN a_ingreso a ON a.usuario_id = f.usuario_id
    WHERE f.reemplazada_en IS NULL
)
UPDATE firmas f SET reemplazada_en = now()
FROM candidatas c
WHERE f.id = c.id
  AND (c.orden > 1
       OR EXISTS (SELECT 1 FROM firmas v
                  WHERE v.usuario_id = c.ingreso_id AND v.reemplazada_en IS NULL));

UPDATE firmas f SET usuario_id = a.ingreso_id
FROM a_ingreso a
WHERE f.usuario_id = a.usuario_id;

-- ---------------------------------------------------------------------------
-- Muestras
-- ---------------------------------------------------------------------------
-- La 028 asocio por nombre, y "Antonella Nuñez" coincidia con la fila
-- duplicada. Se pasan a la fila de ingreso.
UPDATE gra_muestras m SET analista_id = a.ingreso_id
FROM a_ingreso a WHERE m.analista_id = a.usuario_id;

UPDATE gra_muestras m SET aprobado_por_id = a.ingreso_id
FROM a_ingreso a WHERE m.aprobado_por_id = a.usuario_id;

-- Las que quedaron sin asociar (el nombre coincidia con dos filas), ahora
-- contra las filas de ingreso solamente.
WITH candidatos AS (
    SELECT lower(u.nombre) AS nombre, min(u.id) AS id, count(*) AS n
    FROM usuarios u
    JOIN ingreso_de i ON i.ingreso_id = u.id
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
    JOIN ingreso_de i ON i.ingreso_id = u.id
    JOIN usuario_recursos r ON r.usuario_id = u.id AND r.recurso = 'aprobacion-graneles'
    WHERE u.nombre IS NOT NULL
    GROUP BY lower(u.nombre)
)
UPDATE gra_muestras m SET aprobado_por_id = c.id
FROM candidatos c
WHERE m.aprobado_por_id IS NULL AND m.aprobado_por IS NOT NULL
  AND c.n = 1 AND c.nombre = lower(m.aprobado_por);

-- ---------------------------------------------------------------------------
-- Nombres, tal como los definio Claudia el 15/09/2026
-- ---------------------------------------------------------------------------
-- Van despues de asociar las muestras por nombre: esa asociacion compara con
-- el nombre que figura en cada registro, que es el que tenian al firmar.
-- Los registros ya firmados conservan el nombre con el que se firmaron.
UPDATE usuarios SET nombre = 'Antonella Nuñez'
WHERE origen = 'vessena' AND lower(usuario) = 'antonella.nunez@vessena.com.uy';
UPDATE usuarios SET nombre = 'Gloria Nuñez'
WHERE origen = 'vessena' AND lower(usuario) = 'gloria.nunez@vessena.com.uy';
UPDATE usuarios SET nombre = 'Mónica Puñales'
WHERE origen = 'vessena' AND lower(usuario) = 'laboratorio@vessena.com.uy';

-- Lorena Romero dejo de trabajar y la casilla analista.minilab@ la usa ahora
-- Alexis Araujo (se decidio mantener la misma casilla). Lo que firmo Lorena
-- sigue diciendo Lorena Romero, porque cada registro guarda el nombre como
-- texto. Se cierran las sesiones abiertas de esa casilla: una sesion vieja no
-- puede seguir firmando con el nombre nuevo.
UPDATE usuarios SET nombre = 'Alexis Araujo'
WHERE origen = 'vessena' AND lower(usuario) = 'analista.minilab@vessena.com.uy';

UPDATE sesiones SET cerrada_en = now()
WHERE cerrada_en IS NULL
  AND usuario_id IN (SELECT id FROM usuarios WHERE lower(usuario) = 'analista.minilab@vessena.com.uy');

-- ---------------------------------------------------------------------------
-- A nombre de quien esta cada firma
-- ---------------------------------------------------------------------------
-- Justamente porque un usuario puede pasar de una persona a otra, la firma
-- guarda el nombre de su dueña. Al imprimir solo se usa si coincide con el
-- nombre que figura en el registro: un ensayo de Lorena nunca sale con la
-- firma de Alexis.
ALTER TABLE firmas ADD COLUMN IF NOT EXISTS nombre TEXT;

UPDATE firmas f SET nombre = COALESCE(u.nombre, u.usuario)
FROM usuarios u
WHERE u.id = f.usuario_id AND f.nombre IS NULL;
