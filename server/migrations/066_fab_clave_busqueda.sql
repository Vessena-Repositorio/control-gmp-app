-- Buscar un muestreo de Fabuloso por lote, orden, codigo PT o analista lo hace
-- ahora el servidor sobre toda la tabla, no la pantalla sobre la tanda que
-- quedo cargada (Claudia, 22/10/2026: "no veo los controles de setiembre").
--
-- Esta es la clave con la que se compara: minuscula, sin tildes, sin signos y
-- sin espacios. El orden importa: si se limpiara antes de sacar la tilde, la
-- letra con tilde se perderia entera -"Pérez" quedaba "prez"- y el nombre no se
-- encontraba nunca. La misma cuenta la hace la app antes de mandar el texto.
CREATE OR REPLACE FUNCTION fab_clave_busqueda(t TEXT) RETURNS TEXT AS $$
    SELECT regexp_replace(
        translate(lower(coalesce(t, '')),
                  'áàäâãéèëêíìïîóòöôõúùüûñç',
                  'aaaaaeeeeiiiiooooouuuunc'),
        '[^a-z0-9]', '', 'g');
$$ LANGUAGE sql IMMUTABLE;
