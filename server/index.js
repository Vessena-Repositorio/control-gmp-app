import express from 'express';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool, hayBase } from './db.js';
import { migrar } from './migrate.js';
import { rutasEnvases } from './routes/envases.js';
import { rutasProceso } from './routes/proceso.js';
import { rutasSao001 } from './routes/sao001.js';
import { rutasFabuloso } from './routes/fabuloso.js';
import { sincronizarEnvases } from './sync/sync-envases.js';
import { sincronizarProceso } from './sync/sync-proceso.js';
import { sincronizarSao001 } from './sync/sync-sao001.js';
import { sincronizarFabuloso } from './sync/sync-fabuloso.js';

const RAIZ = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PUERTO = Number(process.env.PORT) || 3000;

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '2mb' }));

// --- API ------------------------------------------------------------------
app.get('/api/salud', async (_req, res) => {
    // El sitio esta 'ok' aunque la base no: los .html se sirven igual. Lo que
    // este endpoint reporta es si la API puede responder datos.
    if (!hayBase) {
        return res.status(503).json({
            estado: 'sitio ok, api sin base',
            base: 'no configurada',
        });
    }
    try {
        await pool.query('SELECT 1');
        res.json({ estado: 'ok', base: 'conectada' });
    } catch (err) {
        res.status(503).json({
            estado: 'sitio ok, api degradada',
            base: 'sin conexion',
            error: err.message,
        });
    }
});

app.use('/api/envases', rutasEnvases);
app.use('/api/proceso', rutasProceso);
app.use('/api/sao001', rutasSao001);
app.use('/api/fabuloso', rutasFabuloso);

app.use('/api', (_req, res) => res.status(404).json({ error: 'endpoint inexistente' }));

// --- Estaticos ------------------------------------------------------------
// El repo tiene los .html en la raiz, junto a server/, package.json y .git.
// Servir la raiz entera los expondria, asi que solo se habilitan los .html:
// las apps son de un unico archivo y no tienen otros assets.
app.get(/.*/, (req, res, next) => {
    const crudo = req.path === '/' ? '/index.html' : req.path;

    // Se decodifica ANTES de validar: req.path conserva el porcentaje-encoding,
    // asi que buscar '..' sobre el crudo dejaria pasar un '%2e%2e%2f'.
    let ruta;
    try {
        ruta = decodeURIComponent(crudo);
    } catch {
        return res.status(400).end(); // encoding invalido
    }

    if (!ruta.toLowerCase().endsWith('.html')) return next();
    if (ruta.includes('\0')) return res.status(400).end();

    // Ademas de mirar la ruta, se confirma que el destino resuelto siga dentro
    // de la raiz. Es la garantia que no depende de adivinar todas las formas de
    // escribir un '..'.
    const destino = resolve(RAIZ, '.' + ruta);
    if (destino !== RAIZ && !destino.startsWith(RAIZ + sep)) {
        return res.status(400).end();
    }

    res.sendFile(destino, (err) => {
        if (err) next(err.status === 404 ? undefined : err);
    });
});

app.use((_req, res) => res.status(404).send('No encontrado'));

// --- Errores --------------------------------------------------------------
app.use((err, req, res, _next) => {
    console.error('[http]', req.method, req.originalUrl, '->', err.message);
    if (res.headersSent) return;
    // Que falte la base no es un error del servidor: es una configuracion
    // pendiente, y conviene que se distinga de un bug al mirar los logs.
    if (err.sinBase) {
        return res.status(503).json({ error: 'la API no tiene base de datos configurada' });
    }
    res.status(500).json({ error: 'error interno del servidor' });
});

// --- Arranque -------------------------------------------------------------
// Se escucha PRIMERO y recien despues se toca la base. El orden importa: las 21
// apps que todavia no dependen de Postgres tienen que quedar servidas aunque la
// base no responda. Nada de lo que pase aca abajo puede tumbar el proceso.
function arrancar() {
    app.listen(PUERTO, '0.0.0.0', () => {
        console.log(`[http] escuchando en :${PUERTO}`);
    });

    if (!hayBase) {
        console.warn('[arranque] sin base configurada: no se migra ni se replica');
        return;
    }

    migrar()
        .then(() => {
            const minutos = Number(process.env.SYNC_INTERVALO_MIN ?? 15);
            if (minutos <= 0) {
                console.log('[sync] replica periodica desactivada (SYNC_INTERVALO_MIN=0)');
                return;
            }
            // Cada dominio falla por separado: que un Apps Script este caido no
            // puede impedir que se repliquen los demas.
            const replicas = [
                ['envases', sincronizarEnvases],
                ['proceso', sincronizarProceso],
                ['sao001', sincronizarSao001],
                ['fabuloso', sincronizarFabuloso],
            ];
            const replicarTodo = () => {
                for (const [nombre, fn] of replicas) {
                    fn().catch((err) => console.error(`[sync:${nombre}]`, err.message));
                }
            };

            // Primera pasada al arrancar, para que un deploy nuevo no quede con
            // la base vacia hasta que venza el intervalo.
            replicarTodo();
            setInterval(replicarTodo, minutos * 60_000);
            console.log(`[sync] replicas cada ${minutos} min: ${replicas.map((r) => r[0]).join(', ')}`);
        })
        .catch((err) => {
            // Migracion fallida = la API queda inservible, pero el sitio sigue
            // sirviendo los .html. Se ve en GET /api/salud.
            console.error('[arranque] no se pudo preparar la base:', err.message);
            console.error('[arranque] el sitio sigue en pie; la API respondera con error');
        });
}

arrancar();

for (const senal of ['SIGTERM', 'SIGINT']) {
    process.on(senal, async () => {
        console.log(`[${senal}] cerrando`);
        if (pool) await pool.end().catch(() => {});
        process.exit(0);
    });
}
