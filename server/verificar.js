// Compara el payload del Apps Script original contra el que devuelve nuestra API
// y reporta las diferencias. Es la prueba de que el corte es seguro: si esto da
// cero diferencias, cambiar la URL del dashboard no puede alterar lo que se ve.
//
// Uso:  node server/verificar.js [urlApi]
//       node server/verificar.js https://midominio.com
import { esEjecucionDirecta } from './lib/entrypoint.js';

const ORIGEN = process.env.ORIGEN_ENVASES;
const API = process.argv[2] || process.env.URL_API || 'http://localhost:3000';

async function traer(url, etiqueta) {
    const r = await fetch(url, { redirect: 'follow' });
    if (!r.ok) throw new Error(`${etiqueta}: HTTP ${r.status}`);
    return r.json();
}

/** Recorre dos objetos en paralelo y acumula las rutas donde difieren. */
function comparar(a, b, ruta, difs, limite = 40) {
    if (difs.length >= limite) return difs;

    if (a === b) return difs;

    if (a === null || b === null || typeof a !== typeof b || typeof a !== 'object') {
        // Los numeros pueden volver como string desde la base y viceversa; para
        // el dashboard son equivalentes, asi que no se reporta esa diferencia.
        if (a !== null && b !== null && String(a) === String(b)) return difs;
        difs.push({ ruta, origen: a, api: b });
        return difs;
    }

    if (Array.isArray(a) !== Array.isArray(b)) {
        difs.push({ ruta, origen: `array=${Array.isArray(a)}`, api: `array=${Array.isArray(b)}` });
        return difs;
    }

    if (Array.isArray(a)) {
        if (a.length !== b.length) {
            difs.push({ ruta: `${ruta}.length`, origen: a.length, api: b.length });
        }
        for (let i = 0; i < Math.min(a.length, b.length); i++) {
            comparar(a[i], b[i], `${ruta}[${i}]`, difs, limite);
        }
        return difs;
    }

    for (const clave of new Set([...Object.keys(a), ...Object.keys(b)])) {
        comparar(a[clave], b[clave], ruta ? `${ruta}.${clave}` : clave, difs, limite);
    }
    return difs;
}

/** Ordena las ordenes por id para que la comparacion no dependa del orden. */
function ordenar(datos) {
    const clonado = {
        ordenes: [...(datos.ordenes || [])].sort((x, y) => String(x.id).localeCompare(String(y.id))),
        lcc: [...(datos.lcc || [])].sort((x, y) => String(x.id).localeCompare(String(y.id))),
    };
    clonado.ordenes = clonado.ordenes.map((o) => ({
        ...o,
        controles: [...(o.controles || [])].sort((x, y) =>
            String(x.timestamp).localeCompare(String(y.timestamp))
        ),
    }));
    return clonado;
}

export async function verificar() {
    if (!ORIGEN) throw new Error('Falta ORIGEN_ENVASES en las variables de entorno.');

    console.log(`origen : ${ORIGEN}`);
    console.log(`api    : ${API}\n`);

    const [origen, api] = await Promise.all([
        traer(`${ORIGEN}?action=getAll`, 'origen'),
        traer(`${API}/api/envases?action=getAll`, 'api'),
    ]);

    const contar = (d) => ({
        ordenes: (d.ordenes || []).length,
        controles: (d.ordenes || []).reduce((a, o) => a + (o.controles?.length || 0), 0),
        lcc: (d.lcc || []).length,
    });

    const co = contar(origen);
    const ca = contar(api);
    console.log('conteos          origen    api');
    console.log(`  ordenes        ${String(co.ordenes).padStart(6)} ${String(ca.ordenes).padStart(6)}`);
    console.log(`  controles      ${String(co.controles).padStart(6)} ${String(ca.controles).padStart(6)}`);
    console.log(`  lcc            ${String(co.lcc).padStart(6)} ${String(ca.lcc).padStart(6)}\n`);

    const difs = comparar(ordenar(origen), ordenar(api), '', []);

    if (!difs.length) {
        console.log('OK: los payloads son equivalentes. El corte es seguro.');
        return { ok: true, difs: [] };
    }

    console.log(`ATENCION: ${difs.length} diferencia(s) (se muestran hasta 40):\n`);
    for (const d of difs) {
        console.log(`  ${d.ruta}`);
        console.log(`     origen: ${JSON.stringify(d.origen)?.slice(0, 90)}`);
        console.log(`     api   : ${JSON.stringify(d.api)?.slice(0, 90)}`);
    }
    return { ok: false, difs };
}

if (esEjecucionDirecta(import.meta.url)) {
    verificar()
        .then((r) => process.exit(r.ok ? 0 : 1))
        .catch((err) => {
            console.error('fallo:', err.message);
            process.exit(2);
        });
}
