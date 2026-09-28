-- ============================================================================
-- Verificación de rótulo: el código de producto, para mostrar su EAN 14
-- ============================================================================
--
-- Pedido de Claudia (28/09/2026): en la tarjeta de Rótulos, donde Antonella,
-- Gloria o ella dan el OK, tiene que verse el EAN 14 de la caja y la
-- descripción del producto -por ejemplo "FABULOSO - LIMP LIQ MAR FRESCO BOT
-- 1 LT"-, que es justamente lo que se compara contra la foto de la caja.
--
-- La verificación guardaba `producto` como texto armado: en Fabuloso
-- "linea · codigo_pt" y en Control en proceso "maquina · presentacion". Con el
-- código aparte se cruza con producto_ean (migracion 048).

ALTER TABLE rotulo_verificaciones ADD COLUMN IF NOT EXISTS codigo TEXT;

-- Fabuloso: el codigo venia pegado en `producto`, despues del separador.
UPDATE rotulo_verificaciones v
   SET codigo = btrim(split_part(v.producto, '·', 2))
 WHERE v.codigo IS NULL
   AND v.app = 'fabuloso'
   AND btrim(split_part(v.producto, '·', 2)) <> '';

-- Control en proceso: nunca lo guardo; sale del primer control de esa orden.
UPDATE rotulo_verificaciones v
   SET codigo = sub.cod
  FROM (
        SELECT c.orden, min(c.raw ->> 'codPT') AS cod
          FROM proceso_controles c
         WHERE c.duplicado_de IS NULL AND COALESCE(c.raw ->> 'codPT', '') <> ''
         GROUP BY c.orden
       ) AS sub
 WHERE v.codigo IS NULL AND v.app = 'proceso' AND v.orden = sub.orden;
