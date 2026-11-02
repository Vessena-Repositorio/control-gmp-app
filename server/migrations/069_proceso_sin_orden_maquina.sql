-- La clave de los controles sin orden pasa de codigo PT a maquina
-- (Claudia, 02/11/2026: "dejemos maquina lote asi lo identifico").
--
-- La migracion 065 armo "S/OP <codigo PT> · <lote>" para los controles que se
-- cargan antes de que se emita la orden. En la planta la identifican por la
-- maquina, no por el codigo de producto, asi que la clave pasa a ser
-- "S/OP <maquina> · <lote>". Lo de siempre: una orden de verdad no se toca.
--
-- Se reescriben solo las que armo la regla anterior -las que empiezan con
-- "S/OP "- y queda el rastro en proceso_correcciones, como cualquier otra
-- correccion de un control.

DO $$
DECLARE
    afectados INT;
BEGIN
    CREATE TEMP TABLE proceso_reorden_maq ON COMMIT DROP AS
    SELECT id,
           orden AS vieja,
           lote,
           'S/OP ' || coalesce(nullif(trim(maquina), ''), 'sin máquina')
                   || ' · ' || coalesce(nullif(trim(lote), ''), 'sin lote') AS nueva
    FROM proceso_controles
    WHERE orden LIKE 'S/OP %';

    DELETE FROM proceso_reorden_maq WHERE nueva = vieja;

    SELECT count(*) INTO afectados FROM proceso_reorden_maq;
    IF afectados = 0 THEN
        RAISE NOTICE 'No hay controles sin orden que repasar';
        RETURN;
    END IF;
    RAISE NOTICE 'Repasando % control(es) sin orden: la clave pasa a la maquina', afectados;

    INSERT INTO proceso_correcciones (control_id, orden, campo, valor_anterior, valor_nuevo, motivo, usuario)
    SELECT r.id, r.nueva, 'orden', r.vieja, r.nueva,
           'Los controles sin orden de producción se identifican por máquina y lote, no por código de producto',
           'migración 069'
    FROM proceso_reorden_maq r;

    -- La aprobacion acompaña: esos controles se aprobaron de verdad.
    INSERT INTO proceso_ordenes (orden, aprobada_por, aprobada_por_id, aprobada_en, notas)
    SELECT DISTINCT r.nueva, o.aprobada_por, o.aprobada_por_id, o.aprobada_en,
           coalesce(o.notas || ' · ', '')
           || 'Aprobada como "' || r.vieja || '", antes de pasar la clave a máquina y lote'
    FROM proceso_reorden_maq r
    JOIN proceso_ordenes o ON o.orden = r.vieja
    ON CONFLICT (orden) DO NOTHING;

    -- La verificacion de rotulo se mueve solo si esa orden vieja lleva a una
    -- sola nueva: si se repartio en varias, mover la foto a la equivocada
    -- seria peor que dejarla donde esta.
    UPDATE rotulo_verificaciones v
    SET orden = m.nueva
    FROM (
        SELECT vieja, min(nueva) AS nueva
        FROM proceso_reorden_maq
        GROUP BY vieja
        HAVING count(DISTINCT nueva) = 1
    ) m
    WHERE v.app = 'proceso'
      AND v.orden = m.vieja
      AND NOT EXISTS (
          SELECT 1 FROM rotulo_verificaciones w WHERE w.app = 'proceso' AND w.orden = m.nueva
      );

    UPDATE proceso_correcciones k
    SET orden = r.nueva
    FROM proceso_reorden_maq r
    WHERE k.control_id = r.id AND k.orden = r.vieja;

    UPDATE proceso_controles c
    SET orden = r.nueva,
        raw = (raw::jsonb || jsonb_build_object('orden', r.nueva))::json
    FROM proceso_reorden_maq r
    WHERE c.id = r.id;
END $$;
