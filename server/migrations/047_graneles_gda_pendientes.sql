-- ============================================================================
-- Graneles: muestras de Fabuloso trabadas por el Glutaraldehído (GDA)
-- ============================================================================
--
-- El 21/09/2026 (migracion 042) se saco el Glutaraldehído de las fichas de los
-- 8 limpiadores Fabuloso porque el ensayo no se hace. Las muestras ya cargadas
-- no cambiaron: cada una guarda la FOTO de la especificacion con la que se
-- evaluo, y ahi el parametro seguia. Las que quedaron pendientes con ese
-- resultado vacio no se pueden aprobar: falta un resultado que ya no se hace.
--
-- Esto limpia SOLO esas: muestras pendientes en las que el Glutaraldehído esta
-- sin cargar. Se le quita el parametro a la foto y el renglon a los
-- resultados, y queda constancia en gra_actividad, una fila por muestra.
--
-- Lo que NO hace, a proposito:
--   * No toca muestras aprobadas ni rechazadas: son registros cerrados.
--   * No toca una muestra que SI tenga cargado el GDA: ese dato se hizo y se
--     informa.
--   * No aprueba nada. La aprobacion la firma una persona en la app.
--
-- La hora de fin se completa cuando quedo en blanco porque el analisis nunca
-- llego a estar "completo" a ojos del sistema: se usa la ultima modificacion
-- de la muestra, que es cuando efectivamente se termino de cargar.

-- 1) Constancia, antes de tocar los datos.
INSERT INTO gra_actividad (usuario, accion, entidad, detalle)
SELECT 'sistema', 'EDITAR', 'Muestra',
       m.lote || ' (' || m.producto_code || '): se quita el Glutaraldehído sin cargar, ' ||
       'el ensayo ya no se hace (migracion 042). Queda para aprobar.'
FROM gra_muestras m
WHERE m.estado = 'pending'
  AND EXISTS (SELECT 1 FROM jsonb_array_elements(m.resultados::jsonb) AS r
               WHERE r.value ->> 'paramName' ILIKE '%glutaraldeh%'
                 AND (r.value ->> 'pass') IS NULL);

-- 2) Hora de fin: la que nunca se marco porque faltaba ese resultado. Va ANTES
-- de limpiar, porque usa `actualizado_en`, que la limpieza pisa.
UPDATE gra_muestras m
   SET hora_fin = (m.actualizado_en AT TIME ZONE 'America/Montevideo')::time
 WHERE m.estado = 'pending'
   AND m.hora_fin IS NULL
   AND EXISTS (SELECT 1 FROM jsonb_array_elements(m.resultados::jsonb) AS r
                WHERE r.value ->> 'paramName' ILIKE '%glutaraldeh%'
                  AND (r.value ->> 'pass') IS NULL)
   -- Solo si lo unico que faltaba era el GDA: ningun otro resultado vacio ni
   -- retest pendiente.
   AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(m.resultados::jsonb) AS r
                    WHERE r.value ->> 'paramName' NOT ILIKE '%glutaraldeh%'
                      AND ((r.value ->> 'pass') IS NULL
                           OR ((r.value ->> 'pass') = 'false'
                               AND COALESCE(r.value ->> 'retestValue', '') = '')));

-- 3) Resultados: se saca el renglon del GDA vacio.
UPDATE gra_muestras m
   SET resultados = COALESCE((
           SELECT jsonb_agg(r ORDER BY n)
             FROM jsonb_array_elements(m.resultados::jsonb) WITH ORDINALITY AS t(r, n)
            WHERE r ->> 'paramName' NOT ILIKE '%glutaraldeh%'
       ), '[]'::jsonb),
       -- Foto de la especificacion: el parametro tampoco va mas.
       especificacion = jsonb_set(
           m.especificacion::jsonb, '{parameters}',
           COALESCE((
               SELECT jsonb_agg(p ORDER BY n)
                 FROM jsonb_array_elements(m.especificacion::jsonb -> 'parameters') WITH ORDINALITY AS t(p, n)
                WHERE p ->> 'name' NOT ILIKE '%glutaraldeh%'
           ), '[]'::jsonb)),
       actualizado_por = 'sistema (baja de GDA)',
       actualizado_en = now()
 WHERE m.estado = 'pending'
   AND EXISTS (SELECT 1 FROM jsonb_array_elements(m.resultados::jsonb) AS r
                WHERE r.value ->> 'paramName' ILIKE '%glutaraldeh%'
                  AND (r.value ->> 'pass') IS NULL);

