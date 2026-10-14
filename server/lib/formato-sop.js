/**
 * Formato de los SOP escritos en la app: AX-SOP-DOC-001-B "Formato de SOPs"
 * V2.0 (migracion 062). Arma la definicion del documento para pdfmake.
 *
 * Este modulo no toca la base ni el disco: recibe todo armado y devuelve la
 * definicion. Asi la misma funcion sirve para la vista previa del borrador y
 * para el PDF oficial al aprobar, y se puede probar suelta.
 *
 * Lo que se escribe en cada seccion usa un formato de texto simple:
 *   linea en blanco      parrafo nuevo
 *   - texto              viñeta
 *   1. texto             paso numerado
 *   ## Titulo            subseccion (5.1, 5.2... dentro del procedimiento)
 *   **negrita** *cursiva*
 *   | a | b | c |        fila de tabla (la primera es el encabezado)
 *   Termino: definicion  en Definiciones, arma la tabla Termino / Definicion
 */

/** Las secciones del formato, en orden. El historico lo arma el sistema. */
export const SECCIONES = [
    { clave: 'objetivo', titulo: 'OBJETIVO', ayuda: 'Qué se busca lograr con este procedimiento.' },
    { clave: 'alcance', titulo: 'ALCANCE', ayuda: 'Áreas o procesos a los que aplica, y las exclusiones si las hay.' },
    { clave: 'definiciones', titulo: 'DEFINICIONES/ABREVIACIONES', ayuda: 'Una por línea: "Término: definición". Se arma la tabla sola.' },
    { clave: 'responsabilidades', titulo: 'RESPONSABILIDADES', ayuda: 'Roles y responsabilidades en forma macro. Ej.: "- Supervisor de producción: ..."' },
    { clave: 'procedimiento', titulo: 'PROCEDIMIENTO', ayuda: 'Usá "## Título" para cada subsección (5.1, 5.2...), "1." para pasos y "|" para tablas ¿Quién? ¿Qué? ¿Cuándo?' },
    { clave: 'referencias', titulo: 'REFERENCIAS', ayuda: 'Documentos globales y locales que sirven de base.' },
    { clave: 'relacionados', titulo: 'DOCUMENTOS RELACIONADOS', ayuda: 'Anexos y otros documentos que complementan el procedimiento.' },
    { clave: 'registros', titulo: 'REGISTROS', ayuda: 'Registros que genera el procedimiento (código y nombre).' },
    { clave: 'indicadores', titulo: 'INDICADORES', ayuda: 'KPIs relevantes del proceso.' },
];

/** Secciones que no pueden quedar vacias para enviar a revision. */
export const OBLIGATORIAS = ['objetivo', 'alcance', 'procedimiento'];

const DURAZNO = '#F8CBAD';
const GRIS = '#7F7F7F';
const LINEAS = { hLineWidth: () => 0.6, vLineWidth: () => 0.6, hLineColor: () => '#555', vLineColor: () => '#555',
    paddingTop: () => 3, paddingBottom: () => 3, paddingLeft: () => 4, paddingRight: () => 4 };

/** **negrita** y *cursiva* a fragmentos de pdfmake. */
export function enLinea(texto) {
    const partes = String(texto).split(/(\*\*[^*]+\*\*|\*[^*\s][^*]*\*)/g).filter((p) => p !== '');
    return partes.map((p) => {
        if (/^\*\*[^*]+\*\*$/.test(p)) return { text: p.slice(2, -2), bold: true };
        if (/^\*[^*]+\*$/.test(p)) return { text: p.slice(1, -1), italics: true };
        return p;
    });
}

function tabla(filas) {
    const ancho = Math.max(...filas.map((f) => f.length));
    const body = filas.map((f, i) => {
        const celdas = [...f, ...Array(ancho - f.length).fill('')];
        return celdas.map((c) => (i === 0
            ? { text: enLinea(c), bold: true, fillColor: DURAZNO }
            : { text: enLinea(c) }));
    });
    return { table: { headerRows: 1, widths: Array(ancho).fill('*'), body }, layout: LINEAS, margin: [0, 2, 0, 8] };
}

/**
 * Texto de una seccion a bloques de pdfmake. `numero` es el de la seccion
 * (para numerar las subsecciones 5.1, 5.2...).
 */
export function aBloques(texto, { numero, definiciones = false } = {}) {
    const lineas = String(texto || '').replace(/\r/g, '').split('\n');
    const bloques = [];
    let parrafo = [], lista = null, filas = null, defs = null, sub = 0;

    const cerrar = () => {
        if (parrafo.length) { bloques.push({ text: enLinea(parrafo.join(' ')), margin: [0, 0, 0, 6] }); parrafo = []; }
        if (lista) { bloques.push({ [lista.tipo]: lista.items.map((t) => ({ text: enLinea(t) })), margin: [0, 0, 0, 6] }); lista = null; }
        if (filas) { bloques.push(tabla(filas)); filas = null; }
        if (defs) { bloques.push(tabla([['Término', 'Definición'], ...defs])); defs = null; }
    };

    for (const cruda of lineas) {
        const l = cruda.trim();
        if (!l) { cerrar(); continue; }
        let m;
        if ((m = l.match(/^##\s+(.+)/))) {
            cerrar();
            sub++;
            bloques.push({ text: `${numero}.${sub}    ${m[1].toUpperCase()}`, style: 'h2', tocItem: true, tocStyle: 'toc2', tocMargin: [0, 0, 0, 0] });
            continue;
        }
        if (l.startsWith('|')) {
            const celdas = l.replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
            if (celdas.every((c) => /^:?-{2,}:?$/.test(c))) continue; // separador de markdown
            if (!filas) { cerrar(); filas = []; }
            filas.push(celdas);
            continue;
        }
        if ((m = l.match(/^[-•*]\s+(.+)/))) {
            if (!lista || lista.tipo !== 'ul') { cerrar(); lista = { tipo: 'ul', items: [] }; }
            lista.items.push(m[1]);
            continue;
        }
        if ((m = l.match(/^\d+[.)]\s+(.+)/))) {
            if (!lista || lista.tipo !== 'ol') { cerrar(); lista = { tipo: 'ol', items: [] }; }
            lista.items.push(m[1]);
            continue;
        }
        if (definiciones && (m = l.match(/^([^:]{1,60}):\s*(.+)$/))) {
            if (!defs) { cerrar(); defs = []; }
            defs.push([m[1].trim(), m[2].trim()]);
            continue;
        }
        if (lista || filas || defs) cerrar();
        parrafo.push(l);
    }
    cerrar();
    return bloques;
}

const MESES = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Setiembre', 'Octubre', 'Noviembre', 'Diciembre'];
const dma = (iso) => (iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : '');
const mesAnio = (iso) => (iso ? `${MESES[Number(iso.slice(5, 7)) - 1]} ${iso.slice(0, 4)}` : '—');

function firmasTabla(titulo, segunda, filas) {
    const body = [
        [{ text: 'Nombre / Firma', bold: true, alignment: 'center' }, { text: segunda, bold: true, alignment: 'center' }, { text: 'Fecha', bold: true, alignment: 'center' }],
        ...(filas.length ? filas : [{ nombre: '', cargo: '', fecha: '' }]).map((f) => [
            { text: f.nombre || ' ' }, { text: f.cargo || '' }, { text: f.fecha ? dma(f.fecha) : '', alignment: 'center' }]),
    ];
    return [
        { text: titulo, bold: true, margin: [4, 14, 0, 6] },
        { table: { widths: ['*', 150, 90], body }, layout: { ...LINEAS, paddingTop: () => 5, paddingBottom: () => 5 } },
    ];
}

/**
 * Definicion completa para pdfmake.
 * d = {
 *   tipo, codigo, titulo, version, fechaAprobacion, fechaVigencia, fechaEntrenamiento (ISO o null),
 *   secciones: { objetivo: '...', ... },
 *   preparado: [{ nombre, cargo, fecha }], revisado: [...], aprobado: [...],
 *   historico: [{ version, fecha, cambios }],
 *   borrador: true/false, logo: dataURL, fuente: 'Helvetica' | 'Roboto'
 * }
 */
export function definicionSop(d) {
    const ancho = 481; // A4 menos margenes de 57
    const cuerpo = [];

    // --- Primera pagina: fechas y firmas
    cuerpo.push(
        { text: [{ text: 'Fecha de Entrenamiento: ', bold: true }, d.fechaEntrenamiento ? dma(d.fechaEntrenamiento) : '______________________________'], margin: [0, 30, 0, 0] },
        { text: [{ text: 'Fecha de entrada en vigencia: ', bold: true }, d.fechaVigencia ? dma(d.fechaVigencia) : '__________________________'], margin: [0, 26, 0, 6] },
        ...firmasTabla('Preparado por', 'Función - Área', d.preparado || []),
        ...firmasTabla('Revisado por', 'Área', d.revisado || []),
        ...firmasTabla('Aprobado por', 'Área', d.aprobado || []),
        { text: '', pageBreak: 'after' },
        { toc: { title: { text: 'CONTENIDO', bold: true, margin: [4, 0, 0, 14] }, numberStyle: { bold: true } } },
        { text: '', pageBreak: 'after' },
    );

    // --- Secciones
    SECCIONES.forEach((s, i) => {
        const n = i + 1;
        cuerpo.push({ text: `${n}    ${s.titulo}`, style: 'h1', tocItem: true, tocStyle: 'toc1' });
        const bloques = aBloques(d.secciones?.[s.clave], { numero: n, definiciones: s.clave === 'definiciones' });
        cuerpo.push({ stack: bloques.length ? bloques : [{ text: 'No aplica.', italics: true, color: GRIS }], margin: [28, 0, 0, 10] });
    });

    // --- Historico de cambios (lo arma el sistema con las versiones)
    const n = SECCIONES.length + 1;
    cuerpo.push(
        { text: `${n}    HISTÓRICO DE CAMBIOS`, style: 'h1', tocItem: true, tocStyle: 'toc1' },
        {
            margin: [28, 0, 0, 0],
            table: {
                headerRows: 1, widths: [50, 70, '*'],
                body: [
                    [{ text: 'Versión', bold: true, fillColor: DURAZNO }, { text: 'Fecha', bold: true, fillColor: DURAZNO }, { text: 'Modificaciones', bold: true, fillColor: DURAZNO }],
                    ...(d.historico || []).map((h) => [h.version, h.fecha ? dma(h.fecha) : '—', { text: enLinea(h.cambios || '—') }]),
                ],
            },
            layout: LINEAS,
        },
    );

    return {
        pageSize: 'A4',
        // Arriba: el encabezado (tabla + titulo del documento) ocupa ~135 pt.
        pageMargins: [57, 150, 57, 62],
        defaultStyle: { font: d.fuente || 'Helvetica', fontSize: 10, lineHeight: 1.15, alignment: 'justify' },
        info: { title: `${d.codigo} v${d.version} ${d.titulo}`, author: 'Vessena S.A.', subject: 'Procedimiento' },
        watermark: d.borrador ? { text: 'BORRADOR', color: '#B23636', opacity: 0.12, bold: true } : undefined,
        header: (pagina, total) => ({
            margin: [57, 34, 57, 0],
            stack: [
                {
                    table: {
                        widths: ['*', 165],
                        body: [
                            [{ text: d.tipo || 'SOP', fontSize: 34, bold: true, italics: true, color: GRIS, margin: [2, 0, 0, 0], border: [true, true, true, false] },
                             d.logo ? { image: d.logo, width: 100, alignment: 'center', margin: [0, 12, 0, 0], border: [true, true, true, false] }
                                    : { text: 'VESSENA', color: '#B01010', bold: true, alignment: 'center', margin: [0, 14, 0, 0] }],
                            [{ text: [{ text: 'Ref. documento: ' }, { text: d.codigo, bold: true }], fontSize: 7 },
                             { text: [{ text: 'Aprobado: ' }, { text: mesAnio(d.fechaAprobacion), bold: true }], fontSize: 7 }],
                            [{ text: [{ text: 'Número de versión: ' }, { text: d.version, bold: true }], fontSize: 7 },
                             { text: `Página ${pagina} de ${total}`, bold: true, fontSize: 7 }],
                        ],
                    },
                    layout: { ...LINEAS, paddingTop: () => 1, paddingBottom: () => 1 },
                },
                { text: d.titulo, bold: true, fontSize: 11, margin: [4, 8, 0, 0], alignment: 'left' },
            ],
        }),
        footer: () => ({
            margin: [57, 18, 57, 0],
            table: { widths: ['*'], body: [[{
                text: 'Las versiones impresas de este documento se consideran NO controladas a menos que estén selladas como Copia Controlada y rubricadas por el responsable del sistema de documentación',
                fontSize: 6.5, alignment: 'center' }]] },
            layout: LINEAS,
        }),
        content: cuerpo,
        styles: {
            h1: { fontSize: 11, bold: true, characterSpacing: 0.3, margin: [0, 14, 0, 8], alignment: 'left' },
            h2: { fontSize: 9.5, bold: true, margin: [0, 8, 0, 6], alignment: 'left' },
            toc1: { bold: true, fontSize: 10 },
            toc2: { bold: true, fontSize: 8.5 },
        },
    };
}
