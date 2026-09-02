/**
 * Que puede hacer cada rol. Es politica, no dato: vive en el codigo para que
 * quede versionada y se pueda revisar en un diff. Quien tiene que rol en que
 * app si es dato, y vive en la tabla usuario_recursos.
 *
 * Los roles salen del relevamiento del 02/09/2026: administrador, revisor,
 * operador y vista son los cuatro que aparecen en los requerimientos.
 */
export const PERMISOS_POR_ROL = {
    // Ve todo, incluido el dato crudo, y administra la app.
    administrador: ['ver', 'cargar', 'revisar', 'aprobar', 'ver_crudo', 'administrar'],

    // Revisa lo que cargan los operadores, pero no aprueba ni ve el dato crudo.
    revisor: ['ver', 'cargar', 'revisar'],

    // Carga datos en el turno.
    operador: ['ver', 'cargar'],

    // Solo mira. Es el rol de los dashboards que no tienen acciones.
    vista: ['ver'],
};

export const ROLES = Object.keys(PERMISOS_POR_ROL);

/**
 * Recursos protegidos. El nombre no es el archivo .html a proposito: si mañana
 * se renombra un archivo, los permisos no se caen.
 */
export const RECURSOS = [
    'portal',
    'control-en-proceso',
    'control-calidad-envases',
    'no-conformidades',
    'control-cambios',
    'estabilidad',
    'capacitaciones',
    'devoluciones',
    'fabuloso-captura',
    'informe-gerencial',
    'dashboard-sao001',
    'fabuloso-kpi',
    'supervision-envases',
    'panel-supervision-tapas',
    'estandares',
];

/** Que archivo sirve cada recurso, para que el servidor pueda protegerlos. */
export const ARCHIVO_POR_RECURSO = {
    'portal': 'index.html',
    'control-en-proceso': 'control-en-proceso.html',
    'control-calidad-envases': 'control-calidad-envases.html',
    'no-conformidades': 'no_conformidades.html',
    'control-cambios': 'control_cambios.html',
    'estabilidad': 'estabilidad.html',
    'capacitaciones': 'capacitaciones_vessena.html',
    'devoluciones': 'devoluciones_app_gsheets.html',
    'fabuloso-captura': 'fabuloso.html',
    'informe-gerencial': 'informe-gerencial.html',
    'dashboard-sao001': 'dashboard_sao001.html',
    'fabuloso-kpi': 'fabuloso_kpi_dashboard.html',
    'supervision-envases': 'supervision-envases.html',
    'panel-supervision-tapas': 'panel-supervision-tapas.html',
};

/** true si el rol habilita esa accion sobre el recurso. */
export function puede(rol, accion) {
    return (PERMISOS_POR_ROL[rol] || []).includes(accion);
}
