import { sincronizarEnvases } from '../sync/sync-envases.js';
import { sincronizarProceso } from '../sync/sync-proceso.js';
import { sincronizarSao001 } from '../sync/sync-sao001.js';
import { sincronizarFabuloso } from '../sync/sync-fabuloso.js';
import { sincronizarDocumentos, DOMINIOS_DOCUMENTOS } from '../sync/sync-documentos.js';
import { sincronizarUsuarios } from '../sync/sync-usuarios.js';

/**
 * Registro unico de replicas. Es la fuente de verdad de que dominios existen:
 * de aca sale tanto el bucle que los replica como el chequeo de salud. Antes
 * estaban en dos listas distintas, asi que agregar un dominio y olvidarse de
 * sumarlo al chequeo dejaba un dominio replicando sin que nadie mirara si
 * fallaba.
 *
 * `dominios` es plural porque una replica puede cubrir varios: sincronizarDocumentos
 * trae los cinco de gestion en una sola pasada, pero cada uno se registra por
 * separado en sync_log.
 */
export const REPLICAS = [
    { nombre: 'envases', fn: sincronizarEnvases, dominios: ['envases'] },
    { nombre: 'proceso', fn: sincronizarProceso, dominios: ['proceso'] },
    { nombre: 'sao001', fn: sincronizarSao001, dominios: ['sao001'] },
    { nombre: 'fabuloso', fn: sincronizarFabuloso, dominios: ['fabuloso'] },
    { nombre: 'documentos', fn: sincronizarDocumentos, dominios: DOMINIOS_DOCUMENTOS },
    { nombre: 'usuarios', fn: sincronizarUsuarios, dominios: ['usuarios'] },
];

/** Todos los dominios que deberian tener una replica sana. */
export const DOMINIOS = REPLICAS.flatMap((r) => r.dominios);
