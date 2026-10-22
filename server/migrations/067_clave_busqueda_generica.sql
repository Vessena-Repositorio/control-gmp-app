-- La misma clave de busqueda de la migracion 066, pero con nombre generico:
-- la usan los modulos que no son Fabuloso (el primero, No Conformidades y
-- Desvios) y llamarla `fab_` en No Conformidades no se entiende al leerla.
--
-- `fab_clave_busqueda` queda como esta: la usa el endpoint de muestreos de
-- Fabuloso y renombrarla seria romperlo sin necesidad. Son dos nombres para la
-- misma cuenta, que es mejor que una sola funcion con un nombre que miente.
--
-- Minuscula, sin tildes, sin signos y sin espacios. El orden importa: si se
-- limpiara antes de sacar la tilde, la letra con tilde se perderia entera
-- -"Pampillón" quedaba "pampilln"- y el nombre no se encontraba nunca
-- (Claudia, 22/10/2026: "no veo los controles de setiembre"). La misma cuenta
-- la hace la app antes de mandar el texto.
CREATE OR REPLACE FUNCTION clave_busqueda(t TEXT) RETURNS TEXT AS $$
    SELECT regexp_replace(
        translate(lower(coalesce(t, '')),
                  'áàäâãéèëêíìïîóòöôõúùüûñç',
                  'aaaaaeeeeiiiiooooouuuunc'),
        '[^a-z0-9]', '', 'g');
$$ LANGUAGE sql IMMUTABLE;
