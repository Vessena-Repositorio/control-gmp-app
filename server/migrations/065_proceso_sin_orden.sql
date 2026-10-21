-- Los controles cargados sin orden de produccion se agrupaban todos juntos
-- (Claudia, 21/10/2026).
--
-- El N° de orden es obligatorio en la pantalla, asi que cuando la orden todavia
-- no se habia emitido la gente escribia "S/OP", "s/op", "orden sop" o un guion.
-- Como la orden es la clave con la que se agrupa, aprueba e imprime, todos esos
-- controles -de productos y lotes distintos- quedaban dentro de una sola orden
-- llamada "S/OP". El registro de aprobacion salia mezclado.
--
-- Aca se separan: cada uno pasa a "S/OP <codigo PT> · <lote>", que es lo que de
-- ahora en mas arma el servidor cuando no hay orden. Queda escrito en
-- proceso_correcciones, igual que cualquier otra correccion de un control.

-- Lo que se considera "sin orden": se le sacan los signos y se compara.
-- "S/OP", "s / o.p.", "ORDEN SOP", "-", "0" son todos lo mismo.
CREATE OR REPLACE FUNCTION proceso_es_sin_orden(t TEXT) RETURNS BOOLEAN AS $$
    SELECT regexp_replace(lower(coalesce(t, '')), '[^a-z0-9]', '', 'g') IN (
        '', 'sop', 'so', 'sn', 'sd', 'na', 'sinop', 'sinorden', 'ordensop',
        'ordenso', 'sinnumero', 'sinnro', 'sinoc', '0', '00', '000'
    );
$$ LANGUAGE sql IMMUTABLE;

DO $$
DECLARE
    afectados INT;
BEGIN
    CREATE TEMP TABLE proceso_reorden ON COMMIT DROP AS
    SELECT id,
           orden AS vieja,
           lote,
           'S/OP ' || coalesce(nullif(trim(cod_pt), ''), 'sin PT')
                   || ' · ' || coalesce(nullif(trim(lote), ''), 'sin lote') AS nueva
    FROM proceso_controles
    WHERE proceso_es_sin_orden(orden);

    SELECT count(*) INTO afectados FROM proceso_reorden;
    IF afectados = 0 THEN
        RAISE NOTICE 'No hay controles sin orden que separar';
        RETURN;
    END IF;
    RAISE NOTICE 'Separando % control(es) cargados sin orden', afectados;

    -- 1. El rastro, control por control.
    INSERT INTO proceso_correcciones (control_id, orden, campo, valor_anterior, valor_nuevo, motivo, usuario)
    SELECT r.id, r.nueva, 'orden', r.vieja, r.nueva,
           'Se cargaron sin orden de producción y quedaban agrupados en una sola orden: se separan por código PT y lote',
           'migración 065'
    FROM proceso_reorden r;

    -- 2. Si la "orden" vieja estaba aprobada, la aprobacion acompaña a cada una
    --    de las que salen de ella: esos controles se aprobaron de verdad.
    INSERT INTO proceso_ordenes (orden, aprobada_por, aprobada_por_id, aprobada_en, notas)
    SELECT DISTINCT r.nueva, o.aprobada_por, o.aprobada_por_id, o.aprobada_en,
           coalesce(o.notas || ' · ', '')
           || 'Aprobada como "' || r.vieja || '", antes de separar los controles por producto y lote'
    FROM proceso_reorden r
    JOIN proceso_ordenes o ON o.orden = r.vieja
    ON CONFLICT (orden) DO NOTHING;

    -- 3. La verificacion de rotulo se mueve solo cuando el lote lleva a una
    --    unica orden nueva. Si ese lote quedo repartido en varias -dos
    --    productos con el mismo numero de lote-, se deja como esta y la
    --    supervision la vuelve a pedir: mover la foto a la orden equivocada
    --    seria peor.
    UPDATE rotulo_verificaciones v
    SET orden = m.nueva
    FROM (
        SELECT vieja, lote, min(nueva) AS nueva
        FROM proceso_reorden
        GROUP BY vieja, lote
        HAVING count(DISTINCT nueva) = 1
    ) m
    WHERE v.app = 'proceso'
      AND v.orden = m.vieja
      AND trim(coalesce(v.lote, '')) = trim(coalesce(m.lote, ''))
      AND NOT EXISTS (
          SELECT 1 FROM rotulo_verificaciones w WHERE w.app = 'proceso' AND w.orden = m.nueva
      );

    -- 4. Las correcciones anteriores de esos controles apuntan a la orden nueva.
    UPDATE proceso_correcciones k
    SET orden = r.nueva
    FROM proceso_reorden r
    WHERE k.control_id = r.id AND k.orden = r.vieja;

    -- 5. Y recien ahora el control: la columna con la que se agrupa y el `raw`
    --    que se imprime, para que digan lo mismo.
    UPDATE proceso_controles c
    SET orden = r.nueva,
        raw = (raw::jsonb || jsonb_build_object('orden', r.nueva))::json
    FROM proceso_reorden r
    WHERE c.id = r.id;
END $$;

-- La fila vieja de proceso_ordenes ("S/OP" aprobada) queda sin controles. No se
-- borra: una aprobacion firmada no se borra, y la pantalla arma la lista desde
-- los controles, asi que no vuelve a aparecer.
