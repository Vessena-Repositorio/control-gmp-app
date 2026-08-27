import { pathToFileURL } from 'node:url';

/**
 * true si el modulo se esta ejecutando directamente (node archivo.js) y no
 * importado por otro. Comparar strings de rutas no sirve en Windows por las
 * barras invertidas, por eso se normaliza a URL.
 */
export function esEjecucionDirecta(metaUrl) {
    if (!process.argv[1]) return false;
    return metaUrl === pathToFileURL(process.argv[1]).href;
}
