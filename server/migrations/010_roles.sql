-- ============================================================================
-- Padron propio: las cinco personas del relevamiento, con su rol por app
-- ============================================================================
--
-- Reemplaza a los padrones dispersos de Apps Script, que quedaron sin migrar
-- porque no eran legibles o porque sus hashes ya son publicos. Se crean de cero
-- con credenciales nuevas.
--
-- El rol es POR APP y no global: del relevamiento sale que Gloria y Antonella
-- son administradoras en el portal y en control en proceso, operadoras en
-- envases, y revisoras en estabilidad y fabuloso. Un rol unico no lo
-- representaria sin darle a alguien mas permisos de los que le corresponden.
--
-- Que puede hacer cada rol NO esta acá: eso es politica y vive en
-- lib/permisos.js, para que se revise en un diff. Acá esta quien tiene que rol.

ALTER TABLE credenciales DROP CONSTRAINT IF EXISTS credenciales_esquema_check;
ALTER TABLE credenciales ADD CONSTRAINT credenciales_esquema_check
    CHECK (esquema IN ('djb2', 'sha256', 'scrypt'));

CREATE TABLE IF NOT EXISTS usuario_recursos (
    id         BIGSERIAL PRIMARY KEY,
    usuario_id BIGINT NOT NULL REFERENCES usuarios (id) ON DELETE CASCADE,
    recurso    TEXT NOT NULL,
    rol        TEXT NOT NULL CHECK (rol IN ('administrador', 'revisor', 'operador', 'vista')),
    UNIQUE (usuario_id, recurso)
);

CREATE INDEX IF NOT EXISTS usuario_recursos_usuario_idx ON usuario_recursos (usuario_id);
CREATE INDEX IF NOT EXISTS usuario_recursos_recurso_idx ON usuario_recursos (recurso, rol);

-- Las cinco personas. El mail es la identidad: aunque 'laboratorio@' y
-- 'analista.minilab@' parezcan genericos, cada uno lo usa una sola persona
-- (Monica y Lorena respectivamente), y eso es lo que permite que la firma de un
-- control identifique a alguien.
--
-- Sin credencial: las claves se cargan aparte, para que no queden en el
-- repositorio. Hasta entonces estos usuarios no pueden entrar.
INSERT INTO usuarios (origen, usuario, email, nombre, rol, activo, creado_en)
VALUES
    ('vessena', 'claudia.barlocco@vessena.com.uy', 'claudia.barlocco@vessena.com.uy', 'Claudia Barlocco',  'administrador', true, now()),
    ('vessena', 'gloria.nunez@vessena.com.uy',     'gloria.nunez@vessena.com.uy',     'Gloria Núñez',      'administrador', true, now()),
    ('vessena', 'antonella.nunez@vessena.com.uy',  'antonella.nunez@vessena.com.uy',  'Antonella Núñez',   'administrador', true, now()),
    ('vessena', 'laboratorio@vessena.com.uy',      'laboratorio@vessena.com.uy',      'Mónica Puñales',    'operador',      true, now()),
    ('vessena', 'analista.minilab@vessena.com.uy', 'analista.minilab@vessena.com.uy', 'Lorena Romero',     'operador',      true, now())
ON CONFLICT (origen, usuario) DO NOTHING;

-- Rol por app, tal como sale del relevamiento.
--
-- Notas de traduccion, donde el texto pedia interpretacion:
--   * informe-gerencial: "rol administrador solo, no lo ven los analistas".
--   * sao001 y fabuloso-kpi: se pidio 'operador' para Gloria y Antonella, pero
--     son dashboards sin acciones, asi que operador y vista habilitan lo mismo.
--     Se respeta la palabra pedida.
--   * supervision-envases y panel-supervision-tapas: "solo visual", de ahi
--     'vista' incluso para Claudia.
--   * portal: Monica y Lorena entran como operador porque solo ven LCC; que
--     vean solo esa seccion lo resuelve el portal segun el rol.
INSERT INTO usuario_recursos (usuario_id, recurso, rol)
SELECT u.id, r.recurso, r.rol
FROM (VALUES
    -- Claudia: administradora en todo lo que tiene acciones.
    ('claudia.barlocco@vessena.com.uy', 'portal',                  'administrador'),
    ('claudia.barlocco@vessena.com.uy', 'control-en-proceso',      'administrador'),
    ('claudia.barlocco@vessena.com.uy', 'control-calidad-envases', 'administrador'),
    ('claudia.barlocco@vessena.com.uy', 'no-conformidades',        'administrador'),
    ('claudia.barlocco@vessena.com.uy', 'control-cambios',         'administrador'),
    ('claudia.barlocco@vessena.com.uy', 'estabilidad',             'administrador'),
    ('claudia.barlocco@vessena.com.uy', 'capacitaciones',          'administrador'),
    ('claudia.barlocco@vessena.com.uy', 'devoluciones',            'administrador'),
    ('claudia.barlocco@vessena.com.uy', 'fabuloso-captura',        'administrador'),
    ('claudia.barlocco@vessena.com.uy', 'estandares',              'administrador'),
    ('claudia.barlocco@vessena.com.uy', 'informe-gerencial',       'administrador'),
    ('claudia.barlocco@vessena.com.uy', 'dashboard-sao001',        'administrador'),
    ('claudia.barlocco@vessena.com.uy', 'fabuloso-kpi',            'administrador'),
    ('claudia.barlocco@vessena.com.uy', 'supervision-envases',     'vista'),
    ('claudia.barlocco@vessena.com.uy', 'panel-supervision-tapas', 'vista'),

    -- Gloria: administradora donde ve el dato crudo, operadora o revisora donde no.
    ('gloria.nunez@vessena.com.uy', 'portal',                  'administrador'),
    ('gloria.nunez@vessena.com.uy', 'control-en-proceso',      'administrador'),
    ('gloria.nunez@vessena.com.uy', 'control-calidad-envases', 'operador'),
    ('gloria.nunez@vessena.com.uy', 'no-conformidades',        'operador'),
    ('gloria.nunez@vessena.com.uy', 'control-cambios',         'operador'),
    ('gloria.nunez@vessena.com.uy', 'estabilidad',             'revisor'),
    ('gloria.nunez@vessena.com.uy', 'capacitaciones',          'administrador'),
    ('gloria.nunez@vessena.com.uy', 'devoluciones',            'administrador'),
    ('gloria.nunez@vessena.com.uy', 'fabuloso-captura',        'revisor'),
    ('gloria.nunez@vessena.com.uy', 'estandares',              'revisor'),
    ('gloria.nunez@vessena.com.uy', 'informe-gerencial',       'administrador'),
    ('gloria.nunez@vessena.com.uy', 'dashboard-sao001',        'operador'),
    ('gloria.nunez@vessena.com.uy', 'fabuloso-kpi',            'operador'),
    ('gloria.nunez@vessena.com.uy', 'supervision-envases',     'vista'),
    ('gloria.nunez@vessena.com.uy', 'panel-supervision-tapas', 'vista'),

    -- Antonella: igual que Gloria, salvo capacitaciones y devoluciones, donde
    -- el relevamiento dice explicitamente "solo Gloria y yo".
    ('antonella.nunez@vessena.com.uy', 'portal',                  'administrador'),
    ('antonella.nunez@vessena.com.uy', 'control-en-proceso',      'administrador'),
    ('antonella.nunez@vessena.com.uy', 'control-calidad-envases', 'operador'),
    ('antonella.nunez@vessena.com.uy', 'no-conformidades',        'operador'),
    ('antonella.nunez@vessena.com.uy', 'control-cambios',         'operador'),
    ('antonella.nunez@vessena.com.uy', 'estabilidad',             'revisor'),
    ('antonella.nunez@vessena.com.uy', 'fabuloso-captura',        'revisor'),
    ('antonella.nunez@vessena.com.uy', 'estandares',              'revisor'),
    ('antonella.nunez@vessena.com.uy', 'informe-gerencial',       'administrador'),
    ('antonella.nunez@vessena.com.uy', 'dashboard-sao001',        'operador'),
    ('antonella.nunez@vessena.com.uy', 'fabuloso-kpi',            'operador'),
    ('antonella.nunez@vessena.com.uy', 'supervision-envases',     'vista'),
    ('antonella.nunez@vessena.com.uy', 'panel-supervision-tapas', 'vista'),

    -- Monica: carga en planta. En el portal solo ve LCC.
    ('laboratorio@vessena.com.uy', 'portal',                  'operador'),
    ('laboratorio@vessena.com.uy', 'control-en-proceso',      'operador'),
    ('laboratorio@vessena.com.uy', 'control-calidad-envases', 'operador'),
    ('laboratorio@vessena.com.uy', 'estabilidad',             'operador'),
    ('laboratorio@vessena.com.uy', 'fabuloso-captura',        'operador'),
    ('laboratorio@vessena.com.uy', 'estandares',              'operador'),

    -- Lorena: igual que Monica.
    ('analista.minilab@vessena.com.uy', 'portal',                  'operador'),
    ('analista.minilab@vessena.com.uy', 'control-en-proceso',      'operador'),
    ('analista.minilab@vessena.com.uy', 'control-calidad-envases', 'operador'),
    ('analista.minilab@vessena.com.uy', 'estabilidad',             'operador'),
    ('analista.minilab@vessena.com.uy', 'fabuloso-captura',        'operador'),
    ('analista.minilab@vessena.com.uy', 'estandares',              'operador')
) AS r(usuario, recurso, rol)
JOIN usuarios u ON u.origen = 'vessena' AND u.usuario = r.usuario
ON CONFLICT (usuario_id, recurso) DO NOTHING;
