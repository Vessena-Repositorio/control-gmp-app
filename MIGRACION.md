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

Los cuatro dominios que alimentan dashboards están replicados. **Todos los
dashboards leen de Postgres.**

| Dominio | Origen | Sirve a | Endpoint |
|---|---|---|---|
| Envases y tapas | Apps Script `AKfycby0…` | `dashboard.html` + 3 paneles | `/api/envases` |
| Control en proceso | Apps Script `AKfycbxm…` | `informe-gerencial.html` | `/api/proceso` |
| SAO-001 (agua) | Apps Script `AKfycbxx…`, CSV | `dashboard_sao001.html` | `/api/sao001` |
| Fabuloso | Google Sheets gviz, CSV | `fabuloso_kpi_dashboard.html` | `/api/fabuloso` |

Sin datos que migrar: `dashboard-calidad.html` y `dashboard_syso.html` traen los
datos embebidos en el archivo, y `dashboard-calidad-moderno` / `-vessena` son
portales, no consumidores de datos.

Siguen en Apps Script las **apps de captura** (`control-en-proceso`,
`control-calidad-envases`, `control-calidad-workflow`, `fabuloso`) y los
registros de gestión (`no_conformidades`, `control_cambios`, `devoluciones`,
`capacitaciones`, `estabilidad`). Eso es deliberado: la réplica va en una sola
dirección y Sheets sigue siendo la fuente de verdad.

### Página de inicio

`index.html` es el selector de aplicaciones. La app de captura que estaba en la
raíz se movió a `control-en-proceso.html`; **quien tenga la raíz marcada como
favorito ahora cae en el portal** y llega a la captura con un clic más.

Cada tarjeta indica de dónde salen sus datos, decidido en tiempo de ejecución:
la misma app marcada como Postgres en Coolify aparece como Google Sheets
servida desde Pages, porque ahí es lo que realmente hace.

## Arquitectura

Un solo servicio Node sirve los `.html` **y** la API en el mismo origen, así que
no hay CORS y un commit sigue siendo un deploy.

```
server/
  index.js              servidor: API + estáticos + arranque de las réplicas
  db.js                 pool de Postgres
  migrate.js            aplica migrations/*.sql una sola vez, con lock
  verificar.js          compara Apps Script contra la API
  lib/mediciones.js     parser de la bolsa dinámica de mediciones (envases)
  lib/csv.js            parser de CSV, para los orígenes que no dan JSON
  lib/origen.js         descarga y normalización de tipos de hoja de cálculo
  lib/auth.js           token de los endpoints que disparan réplicas
  routes/               un router por dominio: envases, proceso, sao001, fabuloso
  sync/                 un replicador por dominio, con la misma estructura
  migrations/*.sql      esquema; se aplican solas al arrancar
```

Cada dominio replica y falla por separado: que un Apps Script esté caído no
impide que se repliquen los demás.

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

Ya está hecho en el recurso actual. Queda documentado para poder reconstruirlo,
y porque los mismos pasos aplican al corte final. `MIGRACIONES_DESTRUCTIVAS` se
deja sin configurar (ver "Automatización").

1. **Cambiar el build pack** del recurso de estático a **Dockerfile**. El
   `Dockerfile` de la raíz ya está listo. El puerto es el 3000.

2. **Variables de entorno** (ver `.env.example`):

   | Variable | Valor |
   |---|---|
   | `DATABASE_URL` | la que expone el servicio Postgres de Coolify |
   | `ORIGEN_ENVASES` | Apps Script de envases y tapas |
   | `ORIGEN_PROCESO` | Apps Script de control en proceso |
   | `ORIGEN_SAO001` | Apps Script de SAO-001 (devuelve CSV) |
   | `ORIGEN_FABULOSO` | hoja de Google gviz de Fabuloso (CSV) |
   | `SYNC_TOKEN` | uno largo y aleatorio, para el sync manual |
   | `SYNC_INTERVALO_MIN` | `15` |
   | `DATABASE_SSL` | `true` solo si tu Postgres exige TLS |

   Los cuatro valores de `ORIGEN_*` están en `.env.example`. Si falta alguno,
   ese dominio no replica y su dashboard queda sin datos — pero los demás
   siguen funcionando, y se ve en `/api/<dominio>/estado` como
   `ultimoSync: null`.

3. **Deploy.** Al arrancar, el servidor aplica las migraciones y corre la primera
   réplica solo. No hace falta ningún paso manual.

4. **Verificar** que la réplica quedó completa:

```bash
curl http://192.168.30.15:3000/api/envases/estado
```

Los conteos tienen que coincidir con los del origen. Al 27/08/2026 eran 327
órdenes, 784 controles, 2 LCC y ~7.400 mediciones, pero crecen: en planta cargan
todo el tiempo.

5. **Confirmar que el corte es seguro** — compara el payload viejo contra el
   nuevo y falla si difieren en algo:

```bash
ORIGEN_ENVASES="https://script.google.com/macros/s/AKfycby0.../exec" npm run verificar http://192.168.30.15:3000
```

Compara **por clave, no byte a byte**. Los dos payloads no son binariamente
idénticos: el origen pone `controles` antes de `createdAt` y la API lo agrega al
final. El orden de claves en JSON no tiene significado y todo consumidor accede
por nombre, así que no se replica. Un `cmp` daría un falso negativo; el
verificador da OK.

Si aparecen diferencias en `controles.length`, casi seguro es deriva: alguien
cargó un control después del último sync. Forzá una réplica y repetí:

```bash
curl -X POST http://192.168.30.15:3000/api/envases/sync -H "x-sync-token: TU_TOKEN"
```

Verificado el 27/08/2026: **0 diferencias** sobre 327 órdenes, 784 controles y
2 LCC.

## Dónde corre cada cosa

Hay dos entornos, y no son "producción y staging" en el sentido habitual:

| | Sirve | Desde | Backend |
|---|---|---|---|
| **GitHub Pages** | producción, lo que usa la gente hoy | `main` | Apps Script + Sheets |
| **Coolify** | el entorno donde se prueba la migración | `migracion-postgres` | Postgres |

Producción **no pasa por Coolify**: Pages sirve `main` por su cuenta. Por eso
mientras el trabajo viva en la rama, nadie en planta ve el cambio, y por eso
`dashboard.html` mira el hostname — en `github.io` usa Apps Script, en Coolify
usa `/api/envases`. El mismo archivo funciona bien en los dos lados.

Hay **un solo recurso de Coolify**. La rama que construye se elige en Coolify,
no en el workflow: el webhook despliega la rama que ese recurso tenga
configurada. Hoy es `migracion-postgres`.

### El corte final

Cuando la migración esté validada:

1. Mergear `migracion-postgres` a `main`.
2. Apuntar el recurso de Coolify a `main`.
3. Decidir qué pasa con Pages. Es la decisión de fondo, porque hoy **es** la
   producción: o se retira y Coolify pasa a serlo, o se queda como respaldo de
   solo lectura contra Apps Script.

Mientras Pages siga siendo producción, mergear a `main` es seguro: Pages sirve
`dashboard.html`, que en `github.io` lee de Apps Script como siempre.

## Automatización

El ciclo completo es automático. Un push dispara:

```
push -> GitHub Actions -> webhook Coolify -> build -> arranque
                                                        │
                                    migraciones pendientes (solas)
                                                        │
                                              primera réplica
                                                        │
                                  Actions verifica que quedó sano
```

El workflow escucha `main` y `migracion-postgres`, pero **la rama que se
construye la decide Coolify**, no el workflow: el webhook despliega la que el
recurso tenga configurada. Por eso después del corte no hay que tocar nada acá,
solo cambiar la rama en Coolify.

Para agregar una migración: crear el `.sql` en `server/migrations/` y
commitear. Nada más — se aplica sola en el deploy.

### Migraciones

Se aplican solas al arrancar. Para agregar una: crear
`server/migrations/003_loquesea.sql` y commitear. Se aplican en orden
alfabético, una sola vez cada una, y quedan registradas en `_migraciones`.

Tres cosas que hacen que sea seguro dejarlas automáticas:

- **Cada una en su transacción.** Si la tercera falla, las dos anteriores quedan
  aplicadas y registradas; no queda un esquema a medio aplicar.
- **Advisory lock.** Si Coolify levanta dos contenedores a la vez o un redeploy
  se superpone con el anterior, ambos verían `_migraciones` vacía y aplicarían
  el mismo `.sql` dos veces. El segundo espera y después las encuentra hechas.
- **Las destructivas no se aplican solas.** `DROP TABLE`, `DROP COLUMN`,
  `TRUNCATE`, `DELETE FROM` y `ALTER COLUMN ... TYPE` cortan el arranque con un
  mensaje. Para aplicar una hay que hacer backup y levantar el deploy con
  `MIGRACIONES_DESTRUCTIVAS=true`. En un sistema GMP el histórico no se
  recupera solo, y una migración se aplica sin que nadie la mire en ese momento.

Si una migración falla, **el sitio no se cae**: los `.html` se siguen sirviendo
y la API queda en error. Se ve en `GET /api/salud` y en rojo en Actions.

### Verificación post-deploy

`.github/scripts/verificar-deploy.sh` espera a que el servicio vuelva y exige
que el último sync haya terminado en `ok`, con hasta ~7 min de margen. Sin esto,
un deploy que rompe la base se vería igual de verde que uno exitoso.

Necesita la variable de repositorio `URL_APP` en
*Settings > Secrets and variables > Actions > Variables*. Si no están, avisa y
sigue sin fallar.

### Secretos y variables

| Nombre | Tipo | Para qué |
|---|---|---|
| `COOLIFY_WEBHOOK` | secret | dispara el deploy (ya existía) |
| `COOLIFY_TOKEN` | secret | autenticación del webhook (ya existía) |
| `URL_APP` | variable | verificación post-deploy — si falta, se omite |

`URL_APP` es la base del servicio en Coolify, sin barra final. Hoy
`http://192.168.30.15:3000`. Va como *variable*, no como secreto: no es
sensible y así se lee en los logs de Actions.

## Operación

| Acción | Cómo |
|---|---|
| Salud del servicio | `GET /api/salud` |
| Frescura del dato | `GET /api/<dominio>/estado` |
| Forzar una réplica | `POST /api/<dominio>/sync` con header `x-sync-token` |
| Réplica desde la consola | `npm run sync` (todas) o `npm run sync:<dominio>` |

`<dominio>` es `envases`, `proceso`, `sao001` o `fabuloso`.

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

## Hallazgos en los datos de origen

Problemas que aparecieron al replicar. La réplica los maneja, pero **el error
sigue en la hoja**: acá no se escribe al origen. Cada uno se avisa en el log en
cada corrida, así que solo deja de aparecer cuando alguien lo corrige allá.

El criterio es tolerar lo que tiene una única interpretación posible, y nunca en
silencio: en GMP un saneamiento invisible es peor que el dato sucio.

- **4 controles duplicados** en control en proceso: pares de registros idénticos
  hasta la hora al segundo, sobre 2007. Son controles enviados dos veces, algo
  que favorece el `POST` con `mode:'no-cors'` de la app de captura, que no puede
  confirmar que guardó y lleva a reintentar. **Manejado**: se marcan y se
  excluyen de la API, ver abajo.
- **Una fecha corrupta** en SAO-001: `15/07//2026`, con doble barra.
  **Manejado**: el parser tolera separadores repetidos y la interpreta como
  `2026-07-15`, avisando en cada sync.
- **`supervision-envases.html` y `panel-supervision-envases.html`** difieren en
  54 líneas y tienen el mismo título. Parecen dos versiones vivas del mismo
  panel. Ambas están en el portal hasta que se decida cuál queda.

### Controles duplicados

Se marcan, **no se borran**: la evidencia de que hubo un doble envío es parte de
la trazabilidad, y borrarlos dejaría la réplica sin poder explicar por qué tiene
menos filas que la hoja.

Dos registros con el mismo contenido son el mismo control enviado dos veces —
no hay forma de que dos controles distintos coincidan en todos los campos,
incluida la hora al segundo. Se compara por un sha256 del contenido con las
claves ordenadas, así que la huella no depende del orden en que llegan.

`/api/proceso` los excluye, que es lo que corrige el KPI: contarlos dos veces
inflaba los totales y sesgaba los promedios de `informe-gerencial`. Siguen en la
base y se consultan:

```bash
curl http://192.168.30.15:3000/api/proceso/duplicados          # con fila de la hoja
curl "http://192.168.30.15:3000/api/proceso?incluirDuplicados=1"
```

`/api/proceso/estado` distingue `controles` (útiles), `duplicados` y
`filas_en_origen`, para que la diferencia contra la hoja sea explicable.

Al 27/08/2026 son 4 sobre 2007 filas, todos en filas consecutivas de la hoja
(418=417, 1104=1103, 1127=1126, 1145=1144). Esto significa que
`informe-gerencial` muestra **2003 controles y no 2007**: es la única diferencia
deliberada contra el origen en toda la migración.

## Lo que falta resolver

La réplica es de una sola dirección: **Sheets sigue siendo la fuente de
verdad**. Postgres todavía no recibe escrituras. Cuando migremos las apps de
captura hay que decidir el corte por dominio y apagar el sync de ese dominio en
el mismo movimiento, para no tener dos fuentes escribiendo sobre lo mismo.

Sigue pendiente lo de la autenticación que ya venía de antes: los endpoints de
Apps Script son públicos y sin token, y ahora `/api/envases` también expone los
datos sin autenticación. Para un sistema GMP con trazabilidad de analista hay
que resolverlo antes de mover las escrituras.
