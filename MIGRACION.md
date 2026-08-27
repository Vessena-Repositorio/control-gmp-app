# Migración de Apps Script/Sheets a Postgres

Migración secuencial del backend. Estrategia: **réplica de lectura primero**.

Postgres se llena replicando los endpoints de Apps Script que ya existen. Los
dashboards se pasan a leer de Postgres de a uno. Las apps de captura siguen
escribiendo en Sheets sin tocarse, así que en planta no cambia nada hasta que
les toque su turno.

```
  apps de captura ──escriben──> Apps Script + Sheets
                                      │
                                      │ replica (cada 15 min)
                                      ▼
                                  Postgres
                                      │
                                      │ /api/envases
                                      ▼
                                  dashboards
```

## Estado

| Dominio | Origen | Estado |
|---|---|---|
| Envases y tapas | `AKfycby0…` | replicado — `dashboard.html` migrado |
| Control en proceso | `AKfycbxm…` | pendiente |
| No conformidades / cambios | `AKfycbwi…` | pendiente |
| Estabilidad, capacitaciones, fabuloso, devoluciones, SAO-001, workflow | 1 endpoint c/u | pendiente |

Aún leen de Apps Script: `panel-supervision-envases.html`,
`panel-supervision-tapas.html` y `supervision-envases.html`. Comparten el
endpoint de envases, así que ya podrían pasarse a `/api/envases` — se dejan para
el paso siguiente, para que el primer corte tenga un solo archivo que revertir.

## Arquitectura

Un solo servicio Node sirve los `.html` **y** la API en el mismo origen, así que
no hay CORS y un commit sigue siendo un deploy.

```
server/
  index.js              servidor: API + estáticos + arranque del sync
  db.js                 pool de Postgres
  migrate.js            aplica server/migrations/*.sql una sola vez
  verificar.js          compara Apps Script contra la API
  lib/mediciones.js     parser de la bolsa dinámica de mediciones
  routes/envases.js     GET /api/envases, /estado, POST /sync
  sync/sync-envases.js  réplica Apps Script -> Postgres
  migrations/001_envases.sql
```

Solo se sirven archivos `.html` desde la raíz. `server/`, `package.json` y
`.git` quedan fuera del alcance del servidor de estáticos.

### Modelo de datos

`ordenes` → `controles` → `mediciones`.

Dos decisiones que conviene conocer antes de tocar el esquema:

- **Los controles no traen `id`.** Los 781 del origen vienen con `id` vacío. La
  clave natural es `orden:<ordenId>:<timestamp>` (única en los 781 registros) y
  `lcc:<id>` para los LCC. Por eso el sync es idempotente.
- **`raw` es `JSON`, no `JSONB`.** `JSONB` reordena claves y descarta
  duplicados; `raw` existe para devolver el payload exactamente como lo mandaba
  Apps Script. Las consultas van por las columnas normalizadas y por
  `mediciones`, nunca dentro de `raw`.

La tabla `mediciones` desarma claves como `arr_peso_cav1` en
`fase=arr, parametro=peso, cavidad=1`, y expande los arrays de muestras de LCC a
una fila por muestra. Con los datos actuales son ~7.400 filas. Todavía ningún
dashboard la usa: está lista para los que vengan.

Ojo con `num_cavidad`: guarda listas como `"1,2,3,4"`. El parser solo acepta
punto como separador decimal, porque si aceptara coma `"1,2"` se guardaría como
`1.2` y ensuciaría los promedios.

## Qué sigue funcionando durante la migración

Nada de lo que anda hoy se apaga. Concretamente:

- **Las 21 apps que no migramos** se sirven exactamente en las mismas URLs. El
  servidor Node entrega los `.html` de la raíz igual que el sitio estático:
  `/index.html`, `/estabilidad.html`, etc. no cambian.
- **Las apps de captura** siguen escribiendo en Apps Script y Sheets. No se les
  tocó una línea.
- **GitHub Pages** sigue sirviendo todo desde `main` sin backend. `dashboard.html`
  detecta que está en `github.io` y usa el Apps Script.
- **Si Postgres se cae o no está configurado, el sitio no se cae.** El servidor
  escucha primero y toca la base después; un fallo de base deja la API en 503 y
  los `.html` se siguen sirviendo. Sin `DATABASE_URL` el proceso arranca igual.

Esto último es una diferencia importante contra un sitio estático, que no puede
fallar: el servidor está escrito para que un problema de base nunca voltee las
apps que no dependen de la base.

## Puesta en marcha en Coolify

Conviene probarlo en un recurso aparte antes de tocar producción. Ver
"Estrategia de deploy" más abajo.

1. **Cambiar el build pack** del recurso de estático a **Dockerfile**. El
   `Dockerfile` de la raíz ya está listo. El puerto es el 3000.

2. **Variables de entorno** (ver `.env.example`):

   | Variable | Valor |
   |---|---|
   | `DATABASE_URL` | la que expone el servicio Postgres de Coolify |
   | `ORIGEN_ENVASES` | `https://script.google.com/macros/s/AKfycby0…/exec` |
   | `SYNC_TOKEN` | uno largo y aleatorio, para el sync manual |
   | `SYNC_INTERVALO_MIN` | `15` |
   | `DATABASE_SSL` | `true` solo si tu Postgres exige TLS |

3. **Deploy.** Al arrancar, el servidor aplica las migraciones y corre la primera
   réplica solo. No hace falta ningún paso manual.

4. **Verificar** que la réplica quedó completa:

```bash
curl https://TU-DOMINIO/api/envases/estado
```

Con los datos de hoy tiene que dar 327 órdenes, 781 controles, 2 LCC y ~7.400
mediciones.

5. **Confirmar que el corte es seguro** — compara el payload viejo contra el
   nuevo y falla si difieren en algo:

```bash
ORIGEN_ENVASES="https://script.google.com/macros/s/AKfycby0.../exec" npm run verificar https://TU-DOMINIO
```

## Estrategia de deploy

El trabajo va en la rama **`migracion-postgres`**, no en `main`.

`.github/workflows/deploy.yml` dispara el webhook de Coolify **solo en push a
`main`**, así que empujar la rama no toca producción. Eso da lugar a validar el
servicio Node completo antes de que nadie en planta vea el cambio.

1. Push de `migracion-postgres`. Producción sigue igual: `main` no se movió.
2. En Coolify, crear un **recurso nuevo** apuntando a esa rama, con build pack
   Dockerfile, su propio dominio y las variables de entorno de arriba. El
   recurso de producción no se toca.
3. Validar contra ese dominio: `/api/envases/estado` y `npm run verificar`.
4. Recién cuando dé bien, pasar producción a Dockerfile, cargarle las variables
   y mergear a `main`.

El orden del paso 4 importa: **primero las variables, después el merge**. Si se
mergea antes, el deploy automático levanta el servicio sin `DATABASE_URL`; el
sitio sigue en pie y las 21 apps andan, pero `dashboard.html` va a mostrar error
hasta que se configure, porque en el dominio de Coolify pide `/api/envases` y no
hay base detrás.

## Operación

| Acción | Cómo |
|---|---|
| Salud del servicio | `GET /api/salud` |
| Frescura del dato | `GET /api/envases/estado` |
| Forzar una réplica | `POST /api/envases/sync` con header `x-sync-token` |
| Réplica desde la consola | `npm run sync` |

Cada corrida queda registrada en la tabla `sync_log` con su duración, sus
conteos y el error si falló.

Si el origen devuelve cero órdenes y cero LCC, el sync **aborta sin tocar la
base**: un origen vacío casi siempre es una falla transitoria de Apps Script, y
no tiene que vaciar los dashboards.

## Rollback

`dashboard.html` elige el origen según dónde esté servido: usa `/api/envases` en
Coolify y el Apps Script en GitHub Pages. Para volver atrás, en
`dashboard.html` forzá:

```js
const GOOGLE_SCRIPT_URL = APPS_SCRIPT_URL;
```

Es un archivo y una línea. No hay fallback automático a propósito: si la API
falla tiene que verse el error, no quedar tapado leyendo de la fuente vieja.

## Lo que falta resolver

La réplica es de una sola dirección: **Sheets sigue siendo la fuente de
verdad**. Postgres todavía no recibe escrituras. Cuando migremos las apps de
captura hay que decidir el corte por dominio y apagar el sync de ese dominio en
el mismo movimiento, para no tener dos fuentes escribiendo sobre lo mismo.

Sigue pendiente lo de la autenticación que ya venía de antes: los endpoints de
Apps Script son públicos y sin token, y ahora `/api/envases` también expone los
datos sin autenticación. Para un sistema GMP con trazabilidad de analista hay
que resolverlo antes de mover las escrituras.
