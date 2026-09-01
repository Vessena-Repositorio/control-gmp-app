-- El origen devuelve las filas en el orden de la hoja de calculo, que no
-- siempre es cronologico: hay ordenes y controles cuyo createdAt/timestamp
-- esta invertido respecto de su posicion. Ordenar por fecha en la API producia
-- un payload con elementos intercambiados de lugar.
--
-- dashboard.html re-ordena por timestamp donde le importa, asi que no lo
-- afectaba. Pero los paneles de supervision que faltan migrar comparten este
-- endpoint, y no conviene que dependan de una diferencia sutil de orden.
-- Guardando la posicion de origen el payload se replica tal cual.
ALTER TABLE ordenes   ADD COLUMN IF NOT EXISTS pos INT;
ALTER TABLE controles ADD COLUMN IF NOT EXISTS pos INT;

CREATE INDEX IF NOT EXISTS ordenes_pos_idx   ON ordenes (pos);
CREATE INDEX IF NOT EXISTS controles_pos_idx ON controles (orden_id, pos);

-- El contador `controles` del log sumaba tambien los registros LCC (783 = 781
-- de orden + 2 LCC), que no coincidia con los totales del endpoint /estado.
-- Se separan para que el numero del log signifique lo que dice.
ALTER TABLE sync_log ADD COLUMN IF NOT EXISTS lcc INT DEFAULT 0;
