-- ============================================================================
-- Graneles Fabuloso: se saca la Densidad
-- ============================================================================
--
-- Pedido de Claudia el 21/09/2026: en el granel no se mide; la densidad se
-- controla despues, en el producto terminado. Son los mismos 8 limpiadores
-- Fabuloso de la 042 (G004400 a G004407), donde figuraba como
-- "Densidad (informativa)" 0,994-1,004 g/mL, objetivo 0,999 -en G004400,
-- "Densidad" con objetivo 0,999 y sin rango-.
--
-- Igual que con el GDA: las muestras ya cargadas no cambian, porque
-- gra_muestras guarda la foto de la especificacion con la que se aprobo el
-- lote (esquema 025). Los ids de los demas parametros viajan dentro del JSON,
-- asi que sacar uno del medio no los corre.

UPDATE gra_especificaciones e
   SET parametros = coalesce(
           (SELECT jsonb_agg(p ORDER BY n)
              FROM jsonb_array_elements(e.parametros) WITH ORDINALITY AS t(p, n)
             WHERE p ->> 'name' NOT ILIKE '%densidad%'),
           '[]'::jsonb),
       actualizado_en = now(),
       actualizado_por = 'baja de densidad (se mide en PT) 21/09/2026'
 WHERE e.code IN ('G004400', 'G004401', 'G004402', 'G004403',
                  'G004404', 'G004405', 'G004406', 'G004407')
   AND EXISTS (SELECT 1
                 FROM jsonb_array_elements(e.parametros) AS p
                WHERE p.value ->> 'name' ILIKE '%densidad%');
