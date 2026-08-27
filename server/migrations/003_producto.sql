-- El endpoint de envases sirve dos productos por acciones distintas:
-- getAll (envases) y getAllTapas (tapas). Hoy tapas viene vacio, pero los ids
-- son epoch en milisegundos generados en hojas separadas: cuando empiecen a
-- cargar tapas, dos ordenes creadas en el mismo milisegundo colisionarian y una
-- sobrescribiria a la otra sin aviso. Por eso la identidad pasa a ser
-- (producto, id) en vez de solo id.
ALTER TABLE ordenes   ADD COLUMN IF NOT EXISTS producto TEXT NOT NULL DEFAULT 'envases';
ALTER TABLE controles ADD COLUMN IF NOT EXISTS producto TEXT NOT NULL DEFAULT 'envases';

-- La clave foranea vieja apunta a ordenes(id); hay que soltarla antes de tocar
-- la primaria y rehacerla sobre el par. No se pierde ninguna fila.
ALTER TABLE controles DROP CONSTRAINT IF EXISTS controles_orden_id_fkey;
ALTER TABLE ordenes   DROP CONSTRAINT IF EXISTS ordenes_pkey;
ALTER TABLE ordenes   ADD PRIMARY KEY (producto, id);

-- Los controles de LCC tienen orden_id NULL. Con MATCH SIMPLE (el default), una
-- foranea compuesta con alguna columna NULL se considera satisfecha, asi que
-- siguen entrando sin problema.
ALTER TABLE controles ADD CONSTRAINT controles_orden_fk
    FOREIGN KEY (producto, orden_id) REFERENCES ordenes (producto, id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS ordenes_producto_idx   ON ordenes (producto);
CREATE INDEX IF NOT EXISTS controles_producto_idx ON controles (producto, origen);
