-- ============================================================================
-- Datos Logisticos: medidas, pesos y pallet de la ficha tecnica de Henkel
-- ============================================================================
--
-- Claudia (05/11/2026) paso la ficha tecnica de Henkel ("FT de Vessena",
-- sacada de su SAP) con los 18 productos de Persil, Somat, Bref y Mas, y pidio
-- completar lo vacio y reemplazar lo distinto por el dato de Henkel: varios de
-- los cargados estaban mal (Bref con 0,01 kg por unidad, Mas Bebe 830 ml con 80
-- unidades por pallet en vez de 672).
--
-- Como se pasa cada dato:
--   - medidas de la unidad y de la caja: Henkel en mm, aca en cm
--   - peso PT: el peso bruto de la unidad (CON)
--   - unidades por caja y DUN14: los de la caja (SHU)
--   - cajas por piso: unidades por capa (LEV) / unidades por caja
--   - pisos: unidades por pallet (PAL) / unidades por capa
--   - peso de la caja vacia: caja llena menos sus unidades; Henkel no lo da
-- Separadores y film no vienen, y en los importados no se piden.
--
-- El SKU sale del cruce por EAN de la unidad; donde habia dos SKU con el mismo
-- EAN se tomo el activo. Solo se toca lo que difiere, queda en la bitacora que
-- cambio y de que valor, y la ficha ya aprobada que cambia vuelve a revision,
-- igual que si se editara a mano: lo que se le mando a Finanzas y lo que hay
-- tienen que coincidir.

CREATE TEMP TABLE henkel_ft (
    sku TEXT, dun TEXT, peso_pt NUMERIC, un_largo NUMERIC, un_ancho NUMERIC, un_alto NUMERIC,
    unidades_caja INT, caja_largo NUMERIC, caja_ancho NUMERIC, caja_alto NUMERIC, peso_caja NUMERIC,
    por_piso INT, estiba INT, unidades_pallet INT, origen TEXT
) ON COMMIT DROP;

INSERT INTO henkel_ft VALUES
    ('5972', '4015100353525', 1.272, 6.25, 11.8, 28.6, 6, 38.7, 12.6, 29.7, 0.292, 18, 3, 324, '2880286 Somat Ai1 Power Gel 6x1,072L'),
    ('6231', '17500459002131', 0.883, 16.5, 6.5, 26, 14, 40, 24.9, 25.6, 0.402, 12, 4, 672, '3030885 Dt Lq Persil Color 830ml'),
    ('6262', '17500459000489', 3.292, 19, 9.829, 28, 6, 39.6, 30.4, 34.9, 0.601, 9, 3, 162, '3031024 Dt Lq Persil Universal 3L'),
    ('6261', '17500459000496', 3.292, 19, 9.829, 28, 6, 39.6, 30.4, 34.9, 0.601, 9, 3, 162, '3031028 Dt Lq Persil Color 3L'),
    ('5970', '4015100360684', 0.969, 6.4, 12.8, 10.1, 5, 40, 15, 12.8, 0.177, 16, 7, 560, '3032124 Somat Classic Pulver 5x960g'),
    ('6265', '17500459000120', 7.272, 27.7, 14.6, 31, 3, 44.6, 28.2, 31.6, 0.556, 9, 3, 81, '3033191 Dt Lq Persil Universal 6.64L'),
    ('6256', '17500459002094', 0.883, 16.5, 6.5, 26, 14, 40, 24.9, 25.6, 0.402, 12, 4, 672, '3033852 Dt Lq Persil Universal 830ml'),
    ('5973', '4015100360844', 0.488, 4.8, 19.1, 12.8, 8, 39.8, 19.6, 12.9, 0.073, 12, 7, 672, '3034176 Somat Ai1 Extra 26 T. 8x431,6 g'),
    ('8002', '17501199410118', 0.077, 3.8, 12.7, 17, 10, 40, 13.1, 17.6, 0.154, 18, 9, 1620, '3035078 Bref WC SVR Poder Activo Pino 50gr'),
    ('8001', '17501199414130', 0.077, 3.8, 12.7, 17, 10, 40, 13.1, 17.6, 0.154, 18, 9, 1620, '3035079 Bref WC SVR Poder Activo Lavanda 50gr'),
    ('8003', '17501199410125', 0.077, 3.8, 12.7, 17, 10, 40, 13.1, 17.6, 0.154, 18, 9, 1620, '3036175 Bref WC SVR Poder Activo Brisa Mar 50gr'),
    ('5971', '4015100360615', 0.794, 5.5, 9.4, 28.1, 10, 29, 20, 29.5, 0.257, 16, 3, 480, '3040857 Somat Klarspueler 10x750ml'),
    ('6269', '17500459000106', 10.68, 27.7, 18.9, 31, 2, 40.1, 28.6, 32.8, 0.601, 9, 3, 54, '3054243 Dt Lq Persil Universal 10L - EX'),
    ('6270', '17406425000272', 0.153, 6.6, 10.2, 14.4, 40, 29.7, 24.6, 15.8, 0.35, 16, 6, 3840, '3054534 Persil Universal 140ml-GT'),
    ('8101', '17501199419302', 0.115, 3.28, 12.7, 17, 24, 40.4, 13.5, 18.3, 0.199, 18, 9, 3888, '3067353 Bref WC Duo-Cubos Original 100gr'),
    ('8100', '17501199419449', 0.115, 3.28, 12.7, 17, 24, 40.4, 13.5, 18.3, 0.199, 18, 9, 3888, '3067354 Bref WC Duo-Cubos Pino 100gr'),
    ('6297', '17500459001905', 0.874, 16.5, 6.5, 26, 14, 40, 24.9, 25.6, 0.402, 12, 4, 672, '3083507 MAS Bebe 830ml/14'),
    ('6296', '17501199416134', 2.021, 16.3, 9.43, 31.2, 9, 49.5, 28.7, 31.7, 0.613, 8, 3, 216, '3090347 MAS Bebe 1.83L/9');

-- La bitacora primero, mientras todavia estan los valores de antes.
INSERT INTO dl_actividad (usuario, rol, accion, sku, detalles)
SELECT 'Ficha técnica Henkel (migración 076)', NULL, 'producto_editado', p.sku,
       concat_ws(', ',
         CASE WHEN p.dun IS DISTINCT FROM h.dun THEN 'dun ' || coalesce(p.dun, '—') || ' → ' || h.dun END,
         CASE WHEN p.peso_pt IS DISTINCT FROM h.peso_pt THEN 'peso_pt ' || coalesce(p.peso_pt::text, '—') || ' → ' || h.peso_pt END,
         CASE WHEN p.un_largo IS DISTINCT FROM h.un_largo THEN 'un_largo ' || coalesce(p.un_largo::text, '—') || ' → ' || h.un_largo END,
         CASE WHEN p.un_ancho IS DISTINCT FROM h.un_ancho THEN 'un_ancho ' || coalesce(p.un_ancho::text, '—') || ' → ' || h.un_ancho END,
         CASE WHEN p.un_alto IS DISTINCT FROM h.un_alto THEN 'un_alto ' || coalesce(p.un_alto::text, '—') || ' → ' || h.un_alto END,
         CASE WHEN p.unidades_caja IS DISTINCT FROM h.unidades_caja THEN 'unidades_caja ' || coalesce(p.unidades_caja::text, '—') || ' → ' || h.unidades_caja END,
         CASE WHEN p.caja_largo IS DISTINCT FROM h.caja_largo THEN 'caja_largo ' || coalesce(p.caja_largo::text, '—') || ' → ' || h.caja_largo END,
         CASE WHEN p.caja_ancho IS DISTINCT FROM h.caja_ancho THEN 'caja_ancho ' || coalesce(p.caja_ancho::text, '—') || ' → ' || h.caja_ancho END,
         CASE WHEN p.caja_alto IS DISTINCT FROM h.caja_alto THEN 'caja_alto ' || coalesce(p.caja_alto::text, '—') || ' → ' || h.caja_alto END,
         CASE WHEN p.peso_caja IS DISTINCT FROM h.peso_caja THEN 'peso_caja ' || coalesce(p.peso_caja::text, '—') || ' → ' || h.peso_caja END,
         CASE WHEN p.por_piso IS DISTINCT FROM h.por_piso THEN 'por_piso ' || coalesce(p.por_piso::text, '—') || ' → ' || h.por_piso END,
         CASE WHEN p.estiba IS DISTINCT FROM h.estiba THEN 'estiba ' || coalesce(p.estiba::text, '—') || ' → ' || h.estiba END,
         CASE WHEN p.unidades_pallet IS DISTINCT FROM h.unidades_pallet THEN 'unidades_pallet ' || coalesce(p.unidades_pallet::text, '—') || ' → ' || h.unidades_pallet END)
       || ' · de ' || h.origen
       || CASE WHEN p.estado = 'aprobada' THEN ' · vuelve a revisión: la ficha ya había salido a Finanzas' ELSE '' END
FROM dl_productos p
JOIN henkel_ft h ON h.sku = p.sku
WHERE (p.dun, p.peso_pt, p.un_largo, p.un_ancho, p.un_alto, p.unidades_caja, p.caja_largo, p.caja_ancho,
       p.caja_alto, p.peso_caja, p.por_piso, p.estiba, p.unidades_pallet)
      IS DISTINCT FROM
      (h.dun, h.peso_pt, h.un_largo, h.un_ancho, h.un_alto, h.unidades_caja, h.caja_largo, h.caja_ancho,
       h.caja_alto, h.peso_caja, h.por_piso, h.estiba, h.unidades_pallet);

UPDATE dl_productos p
   SET dun = h.dun, peso_pt = h.peso_pt, un_largo = h.un_largo, un_ancho = h.un_ancho, un_alto = h.un_alto,
       unidades_caja = h.unidades_caja, caja_largo = h.caja_largo, caja_ancho = h.caja_ancho,
       caja_alto = h.caja_alto, peso_caja = h.peso_caja, por_piso = h.por_piso, estiba = h.estiba,
       unidades_pallet = h.unidades_pallet,
       -- El peso de la caja vacia no va en la ficha de Finanzas: solo ese no la manda a revision.
       estado = CASE WHEN p.estado = 'aprobada'
                      AND (p.dun, p.peso_pt, p.un_largo, p.un_ancho, p.un_alto, p.unidades_caja, p.caja_largo,
                           p.caja_ancho, p.caja_alto, p.por_piso, p.estiba, p.unidades_pallet)
                          IS DISTINCT FROM
                          (h.dun, h.peso_pt, h.un_largo, h.un_ancho, h.un_alto, h.unidades_caja, h.caja_largo,
                           h.caja_ancho, h.caja_alto, h.por_piso, h.estiba, h.unidades_pallet)
                     THEN 'pendiente' ELSE p.estado END,
       actualizado_por = 'Ficha técnica Henkel (migración 076)',
       actualizado_en = now()
  FROM henkel_ft h
 WHERE h.sku = p.sku
   AND (p.dun, p.peso_pt, p.un_largo, p.un_ancho, p.un_alto, p.unidades_caja, p.caja_largo, p.caja_ancho,
        p.caja_alto, p.peso_caja, p.por_piso, p.estiba, p.unidades_pallet)
       IS DISTINCT FROM
       (h.dun, h.peso_pt, h.un_largo, h.un_ancho, h.un_alto, h.unidades_caja, h.caja_largo, h.caja_ancho,
        h.caja_alto, h.peso_caja, h.por_piso, h.estiba, h.unidades_pallet);
