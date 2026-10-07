-- ============================================================================
-- Firma electronica: reconocer las claves individuales que ya existen
-- ============================================================================
--
-- La 054 habilita a firmar solo con una clave fijada con la politica actual
-- (credenciales.politica_desde), y solo la marcaba el cambio de clave hecho
-- desde ese dia. Pero el personal ya tiene claves individuales: las genero el
-- servidor (POST /api/usuarios/clave, scrypt, 12+ caracteres) y despues cada
-- uno la cambio (POST /api/auth/clave, 12+ caracteres). Ninguno de esos dos
-- caminos acepta una clave corta, asi que esas claves cumplen (Claudia,
-- 07/10/2026).
--
-- La unica clave scrypt que NO cumple es la que salio de reescribir un PIN
-- viejo en el login (djb2/sha256 → scrypt): sigue siendo el PIN. Ese camino
-- deja 'rehash_credencial' en la auditoria en el mismo instante en que toca
-- la credencial. Si el ultimo cambio de la credencial coincide con un rehash,
-- se deja sin marcar; todas las demas scrypt se marcan desde su ultimo cambio.
UPDATE credenciales c
SET politica_desde = c.actualizado_en
WHERE c.esquema = 'scrypt'
  AND c.politica_desde IS NULL
  AND NOT EXISTS (
      SELECT 1 FROM auditoria a
      WHERE a.usuario_id = c.usuario_id
        AND a.accion = 'rehash_credencial'
        AND a.ts >= c.actualizado_en - interval '1 minute'
  );
