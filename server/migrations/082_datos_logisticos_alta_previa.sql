-- ============================================================================
-- Datos Logisticos: el producto cuyo alta ya estaba hecha
-- ============================================================================
--
-- Pedido de Claudia (16/11/2026): "tengo que ingresar un producto que ya tiene
-- el alta de producto y no me deja porque cuando ingreso me quiere generar el
-- alta".
--
-- El circuito de la app supone que el alta se hace aca: borrador -> a revisar
-- (la app arma la ficha en Excel) -> aprobada (la ficha sale a Marianela, que
-- la carga en iDempiere). Para un producto que YA esta dado de alta en
-- iDempiere no habia salida: aprobar exige la ficha en Excel y, al aprobar,
-- sale el correo pidiendo un alta que ya existe.
--
-- Entonces se puede declarar que el alta ya estaba hecha. La ficha queda
-- cerrada -asi los datos logisticos valen y el aviso a Ventas puede salir- y a
-- Finanzas no se le manda nada. Queda asentado quien lo declaro, cuando y de
-- donde salio el alta, porque es lo que explica por que esa ficha esta
-- aprobada sin correo a Finanzas.
--
-- Si mas adelante cambia un dato de la ficha, el producto vuelve a revision
-- como cualquier otro: ahi si Finanzas tiene que enterarse, porque el alta que
-- ya existe en iDempiere queda vieja. Ese correo va como actualizacion.

ALTER TABLE dl_productos
    ADD COLUMN IF NOT EXISTS alta_previa_en   TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS alta_previa_por  TEXT,
    ADD COLUMN IF NOT EXISTS alta_previa_nota TEXT;

COMMENT ON COLUMN dl_productos.alta_previa_en IS
    'Cuando se declaro que el alta de este producto ya estaba hecha fuera de la app. NULL = el alta se hace aca.';
