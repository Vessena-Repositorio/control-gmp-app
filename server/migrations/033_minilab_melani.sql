-- Alexis Araujo dejo de trabajar (17/09/2026) y la casilla
-- analista.minilab@ la usa ahora Melani Pampillón, igual que se hizo cuando
-- paso de Lorena Romero a Alexis (029).
--
-- Lo que firmo Alexis sigue diciendo Alexis Araujo: cada registro guarda el
-- nombre como texto, y firmaDe() solo usa una firma si esta a nombre de quien
-- figura en el registro, asi que un ensayo de Alexis nunca sale con la firma
-- de Melani ni al reves.
UPDATE usuarios SET nombre = 'Melani Pampillón'
WHERE origen = 'vessena' AND lower(usuario) = 'analista.minilab@vessena.com.uy';

-- Una sesion abierta por Alexis no puede seguir cargando ni firmando con el
-- nombre de Melani. La clave se cambia aparte (POST /api/usuarios/clave):
-- nunca va en una migracion.
UPDATE sesiones SET cerrada_en = now()
WHERE cerrada_en IS NULL
  AND usuario_id IN (SELECT id FROM usuarios WHERE lower(usuario) = 'analista.minilab@vessena.com.uy');
