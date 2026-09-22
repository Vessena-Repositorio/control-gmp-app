-- ============================================================================
-- Graneles Fabuloso: se saca el parametro Glutaraldehido (GDA por HPLC)
-- ============================================================================
--
-- Pedido de Claudia el 21/09/2026: el ensayo no se hace, asi que no puede
-- figurar en la especificacion ni pedirse al cargar una muestra. Son los 8
-- limpiadores Fabuloso (G004400 a G004407), donde era el ultimo parametro de
-- la ficha:  Glutaraldehido, 0,04-0,06 % (G004405: 0,05-0,07 %).
--
-- Las muestras ya cargadas no se tocan: gra_muestras guarda una foto de la
-- especificacion con la que se aprobo el lote (esquema 025), asi que un lote
-- aprobado antes de hoy sigue mostrando e imprimiendo su GDA. Lo que cambia es
-- de aca en adelante.
--
-- Los ids de los demas parametros (<codigo>-<n>) quedan igual: el que se quita
-- es el ultimo, y el orden de los que siguen se preserva con WITH ORDINALITY.

UPDATE gra_especificaciones e
   SET parametros = coalesce(
           (SELECT jsonb_agg(p ORDER BY n)
              FROM jsonb_array_elements(e.parametros) WITH ORDINALITY AS t(p, n)
             WHERE p ->> 'name' NOT ILIKE '%glutaraldeh%'),
           '[]'::jsonb),
       actualizado_en = now(),
       actualizado_por = 'baja de GDA (no se hace) 21/09/2026'
 WHERE e.code IN ('G004400', 'G004401', 'G004402', 'G004403',
                  'G004404', 'G004405', 'G004406', 'G004407')
   AND EXISTS (SELECT 1
                 FROM jsonb_array_elements(e.parametros) AS p
                WHERE p.value ->> 'name' ILIKE '%glutaraldeh%');
