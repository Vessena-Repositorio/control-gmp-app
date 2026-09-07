-- ============================================================================
-- Quien supervisa cada app, a efectos de notificaciones
-- ============================================================================
--
-- Hoy esta lista vive escrita en el codigo, y en estabilidad esta escrita DOS
-- veces: `SUPERVISION` en el Apps Script y `CC_EMAILS` en estabilidad.html.
-- Coinciden por ahora; nada garantiza que sigan coincidiendo.
--
-- La duplicacion no es un descuido, es consecuencia de donde se decide el
-- destinatario: el navegador arma el correo y el script le suma la supervision,
-- asi que dos capas deciden y cada una necesita su copia de la lista. Cuando el
-- servidor sea el unico que decide, la copia del frontend deja de existir.
--
-- ---------------------------------------------------------------------------
-- Por que no se deduce del rol
-- ---------------------------------------------------------------------------
-- Seria mas elegante -sin lista que mantener- pero es incorrecto: recibir
-- notificaciones y poder hacer cosas en la app son dos ejes distintos.
-- Antonella es `revisor` en estabilidad, que es lo que efectivamente hace ahi
-- dentro, y recibe todos los avisos porque es responsable del proceso. Ser
-- responsable de un proceso no es un permiso.
--
-- En capacitaciones la lista coincide hoy con los `administrador` (Gloria y
-- Claudia), pero es casualidad y no regla: deducirla del rol funcionaria hasta
-- el dia que a alguien le cambie el rol por un motivo ajeno, y las
-- notificaciones cambiarian solas, en silencio, como efecto secundario.
--
-- ---------------------------------------------------------------------------
-- Por que apunta a usuario_id y no guarda el correo
-- ---------------------------------------------------------------------------
-- La direccion sale de `usuarios`, asi que no puede quedar desactualizada en
-- dos lugares; y quien se da de baja (activo = false) deja de recibir sin que
-- nadie tenga que acordarse de sacarlo de una lista. Un aviso que sigue
-- llegando a alguien que ya no esta es el sintoma tipico de una lista suelta.

CREATE TABLE IF NOT EXISTS notificacion_supervisores (
    -- El recurso, con los mismos nombres que usa lib/permisos.js.
    recurso      TEXT NOT NULL,

    -- Que avisos de ese recurso recibe. '*' son todos: es el caso de
    -- estabilidad, donde la supervision es del proceso entero y no de un aviso
    -- puntual. Capacitaciones necesita la otra granularidad -Gloria y Claudia
    -- reciben el aviso de inducciones pendientes, no los recordatorios del
    -- plan-, asi que ahi se nombra la notificacion.
    notificacion TEXT NOT NULL DEFAULT '*',

    usuario_id   BIGINT NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,

    creado_en    TIMESTAMPTZ NOT NULL DEFAULT now(),
    nota         TEXT,

    PRIMARY KEY (recurso, notificacion, usuario_id)
);

CREATE INDEX IF NOT EXISTS notificacion_supervisores_recurso_idx
    ON notificacion_supervisores (recurso, notificacion);

-- ---------------------------------------------------------------------------
-- Estado actual, tal cual esta hoy en los Apps Script
-- ---------------------------------------------------------------------------
-- Se siembra con exactamente quienes reciben hoy. El requisito es que al migrar
-- cada aviso siga llegando a las mismas personas, asi que esto no es una
-- oportunidad para reordenar destinatarios: es una transcripcion.

INSERT INTO notificacion_supervisores (recurso, notificacion, usuario_id, nota)
SELECT r.recurso, r.notificacion, u.id, r.nota
FROM (VALUES
    -- SUPERVISION del Apps Script de estabilidad + CC_EMAILS de estabilidad.html.
    -- Alcanza a los 8 avisos, incluido el consolidado de muestreos incompletos,
    -- que hoy tiene a estas dos personas escritas aparte por fuera de
    -- sendEmail_. Bajo este modelo es la misma regla y no dos mecanismos.
    ('estabilidad',    '*',                       'claudia.barlocco@vessena.com.uy',  'responsable de calidad'),
    ('estabilidad',    '*',                       'antonella.nunez@vessena.com.uy',   'responsable del proceso de estabilidad'),

    -- HR_ALERTS_TO del Apps Script de capacitaciones. Solo el aviso semanal de
    -- inducciones pendientes: los recordatorios del plan van al responsable de
    -- cada item y no llevan copia.
    ('capacitaciones', 'inducciones-pendientes',  'claudia.barlocco@vessena.com.uy',  'responsable de calidad'),
    ('capacitaciones', 'inducciones-pendientes',  'gloria.nunez@vessena.com.uy',      'responsable del proceso de capacitaciones')
) AS r(recurso, notificacion, email, nota)
JOIN usuarios u ON lower(u.usuario) = lower(r.email)
ON CONFLICT (recurso, notificacion, usuario_id) DO NOTHING;
