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
| Envases y tapas | Apps Script `AKfycby0…` | `supervision-envases`, `panel-supervision-tapas` | `/api/envases` |
| Control en proceso | Apps Script `AKfycbxm…` | `informe-gerencial.html` | `/api/proceso` |
| SAO-001 (agua) | Apps Script `AKfycbxx…`, CSV | `dashboard_sao001.html` | `/api/sao001` |
| Fabuloso | Google Sheets gviz, CSV | `fabuloso_kpi_dashboard.html` | `/api/fabuloso` |

Además están replicados, sin que ningún dashboard los consuma todavía, los cinco
dominios de gestión: `no_conformidades`, `control_cambios`, `estabilidad`,
`capacitaciones` y `devoluciones`. Son **nueve dominios** en total, y
`/api/estado` los reporta a todos.

`dashboard_syso.html` no tiene datos que migrar: los trae embebidos en el
archivo. `control-calidad-workflow` quedó fuera de alcance (ver más abajo).

Las **apps de captura** (`control-en-proceso`, `control-calidad-envases`,
`fabuloso`) y las de gestión siguen leyendo y escribiendo en Apps Script. Eso es
deliberado: la réplica va en una sola dirección y Sheets sigue siendo la fuente
de verdad, así que apuntarlas a una copia de 15 minutos las haría ver rotas.

### Página de inicio

`index.html` es el portal de calidad, el que antes vivía en
`dashboard-calidad-vessena.html`. Esa ruta se conserva como redirección al
inicio, para no romper los favoritos que apuntan ahí.

Dos consecuencias de que el portal esté en la raíz:

- **La app de captura se movió a `control-en-proceso.html`.** Quien tenga la
  raíz marcada como favorito ahora cae en el portal y llega a la captura con un
  clic más.
- **La raíz pide login.** El portal tiene su propio acceso contra un Apps
  Script, así que entrar a la URL de siempre ya no muestra el formulario de
  control sino una pantalla de acceso.

Archivos retirados de `main` el 01/09/2026: `dashboard.html`,
`dashboard-calidad.html`, `dashboard-calidad-moderno.html`,
`panel-supervision-envases.html` y `guia-entrenamiento-gmp.html`. Siguen
disponibles en la rama `respaldo-pre-main-2026-09-01`.

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
- **GitHub Pages** sirve `main` sin backend. Cada app migrada detecta que está
  en `github.io` y usa el Apps Script.
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

### Los cuatro dominios en marcha

Primera réplica completa de todos, el 27/08/2026:

| Dominio | Replicó | Duración | Respuesta de la API |
|---|---|---|---|
| envases | 327 órdenes, 785 controles, 2 LCC, 7403 mediciones | 7,7 s | 35 ms |
| tapas | vacío (el origen todavía no tiene datos) | — | 8 ms |
| proceso | 2003 controles útiles, 6832 pesos, 4 duplicados | 4,5 s | 29 ms |
| sao001 | 12080 muestras, 2391 parámetros, 1 fecha saneada | 14,7 s | 12 ms |
| fabuloso | 1352 lotes, 15134 valores, 2 fechas descartadas | 4,3 s | 7 ms |

Las réplicas tardan segundos y las respuestas milisegundos, contra los segundos
que tardaba cada consulta a Apps Script. Todas quedan muy por debajo del
intervalo de 15 minutos, así que no se solapan.

Una advertencia para leer estos números: las variables `ORIGEN_*` solo entran al
proceso cuando el contenedor **arranca**. Guardarlas en Coolify no alcanza —
hace falta un redeploy o restart, o el sync sigue fallando con
`Falta ORIGEN_…`.

## Dónde corre cada cosa

Hay dos entornos, y no son "producción y staging" en el sentido habitual:

| | Sirve | Desde | Backend |
|---|---|---|---|
| **GitHub Pages** | producción, lo que usa la gente hoy | `main` | Apps Script + Sheets |
| **Coolify** | el entorno donde se prueba la migración | `migracion-postgres` | Postgres |

Pages sirve `main` por su cuenta, sin pasar por Coolify. Por eso cada app
migrada mira el hostname: en `github.io` usa Apps Script, en Coolify usa la API.
El mismo archivo funciona en los dos lados, y desde el 01/09/2026 `main` tiene
todo, así que Pages ya sirve el portal nuevo.

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
las apps migradas, que en `github.io` leen de Apps Script como siempre.

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

Cada app migrada elige el origen según dónde esté servida: la API en Coolify, el
Apps Script en GitHub Pages. Para volver atrás una sola, forzá en ese archivo:

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
- **Resuelto el 01/09/2026**: de las dos versiones del panel de supervisión de
  envases quedó `supervision-envases.html`. `panel-supervision-envases.html` se
  retiró de `main` y sigue en la rama de respaldo.

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

## Plan de corte a producción interna

Decidido el 01/09/2026: **producción pasa a servirse solo en la red interna**,
desde Coolify contra Postgres. Se deja de publicar en GitHub Pages y, al final,
de depender de Apps Script.

Tres decisiones que condicionan el resto:

- **Todo el acceso es desde planta.** Nadie consulta desde fuera de la red, así
  que no hace falta VPN ni publicar nada hacia afuera.
- **Hay backups automáticos de Postgres.** Es lo que permite que Postgres pase a
  ser fuente de verdad sin perder la retención que hoy da Google.
- **Coolify queda como punto único de falla**, riesgo aceptado a conciencia. Hoy
  Pages funciona como respaldo de lectura: si Coolify se cae, las apps se abren
  igual desde `github.io` contra Apps Script. Al apagarlo, esa red se pierde y
  una caída deja al sistema de calidad no disponible hasta que vuelva.

### El orden importa

Las dos mitades del corte tienen riesgos muy distintos y **no** se pueden hacer
juntas.

**1. Apagar GitHub Pages — se puede ya.** Coolify sirve los mismos archivos, y
las apps que escriben siguen funcionando: el HTML lo sirve Coolify y el POST
sigue yendo a Google. Verificado que no queda ningún enlace absoluto a
`github.io`; los chequeos `SIN_BACKEND` simplemente dejan de coincidir.
Conviene, eso sí, darle al servicio un nombre DNS en vez de la IP: el día que
Coolify reasigne la red, `192.168.30.15` deja de resolver y con él todo.

**2. Autenticación propia — antes que las escrituras.** Hoy el login del portal
corre contra Apps Script: `index.html` hace POST a Google para autenticar. O
sea que apagar Apps Script sin reemplazarlo no solo rompe las 10 apps que
escriben, deja sin pantalla de acceso al sistema entero. Y en GMP la firma del
analista es el registro: tiene que ser verificable antes de que Postgres reciba
escrituras.

**3. Escrituras a Postgres, dominio por dominio.** Cada dominio que corta apaga
su réplica en el mismo movimiento, para no tener dos fuentes escribiendo sobre
lo mismo. Conviene no empezar por `control-en-proceso`, que está en la línea
todo el turno.

**4. Retirar Apps Script y decidir qué pasa con las hojas.** Recién acá se puede
sacar el fallback `SIN_BACKEND` de las apps, que hasta entonces es el camino de
rollback.

### Qué sigue siendo reversible, y hasta cuándo

Mientras Apps Script siga publicado, el rollback de cualquier dashboard es una
línea: se fuerza `APPS_SCRIPT_URL` y vuelve a leer de Google, incluso servido
desde Coolify. Eso vale hasta el paso 4. Desde el paso 3, cada dominio que corta
deja de ser reversible en el momento en que se registra la primera escritura que
solo existe en Postgres.

## Fuera de alcance

**`control-calidad-workflow` no se migra.** Decisión del 01/09/2026.

Su Apps Script (`AKfycbz9sq6…`) responde 403 con la pantalla de permisos de
Google, así que la réplica no puede leerlo de forma anónima como los otros. El
proyecto no está en el Drive de Vessena —se revisaron los cinco que aparecen
ahí y ninguno lo contiene, ni como implementación archivada—, así que abrirlo
dependía de ubicar a quien lo publicó.

No bloquea nada: ningún dashboard consume ese dominio. La app sigue funcionando
igual contra su propia hoja, y queda en el portal.

Si algún día se quiere migrar, el camino más corto **no** es recuperar el Apps
Script sino publicar su planilla como CSV y replicarla con el patrón de
`fabuloso`, que ya lee una hoja de Google directo sin intermediario.

**La captura de `fabuloso`** tampoco está replicada, pero por otro motivo: usa
POST con token de sesión. Se destraba con un token de servicio en una variable
de entorno, no con credenciales personales. Sigue pendiente, no descartada.

## Lo que falta resolver

La réplica es de una sola dirección: **Sheets sigue siendo la fuente de
verdad**. Postgres todavía no recibe escrituras. Cuando migremos las apps de
captura hay que decidir el corte por dominio y apagar el sync de ese dominio en
el mismo movimiento, para no tener dos fuentes escribiendo sobre lo mismo.

Sigue pendiente lo de la autenticación que ya venía de antes: los endpoints de
Apps Script son públicos y sin token, y ahora `/api/envases` también expone los
datos sin autenticación. Para un sistema GMP con trazabilidad de analista hay
que resolverlo antes de mover las escrituras.
