-- ============================================================================
-- Control en proceso: aprobacion por orden de envasado (REG SOP LCC 200)
-- ============================================================================
--
-- Pedido de Claudia (17/09/2026): que se pueda imprimir y firmar, como en
-- Fabuloso. Se firma la orden de envasado entera, no cada control: son unos
-- quince controles por orden.
--
-- Firma el analista que cargo cada control (la firma vigente de la tabla
-- `firmas` cuando lo cargo) y firma quien aprueba: Antonella, Gloria o Claudia,
-- que son las administradoras del recurso.

CREATE TABLE IF NOT EXISTS proceso_ordenes (
    orden           TEXT PRIMARY KEY,
    aprobada_por    TEXT NOT NULL,
    aprobada_por_id BIGINT REFERENCES usuarios (id),
    aprobada_en     TIMESTAMPTZ NOT NULL DEFAULT now(),
    notas           TEXT
);

-- Aviso diario de las 8: las ordenes de dias anteriores sin aprobar. Los mismos
-- destinatarios que aprueban.
INSERT INTO notificacion_supervisores (recurso, notificacion, usuario_id, nota)
SELECT 'control-en-proceso', 'pendientes-aprobacion', u.id,
       'ordenes de envasado sin aprobar (control en proceso)'
FROM usuarios u
WHERE u.origen = 'vessena'
  AND lower(u.usuario) IN (
      'claudia.barlocco@vessena.com.uy',
      'antonella.nunez@vessena.com.uy',
      'gloria.nunez@vessena.com.uy'
  )
ON CONFLICT DO NOTHING;
