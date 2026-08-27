// Traduce la bolsa dinamica de `mediciones` que llega del origen a filas
// normalizadas. La convencion de claves del origen es:
//
//   arr_peso_cav1                -> fase=arr,  parametro=peso,             cavidad=1
//   proc_espesor_cav3            -> fase=proc, parametro=espesor,          cavidad=3
//   proc_Base sin deformacion    -> fase=proc, parametro=Base sin deform., cavidad=null
//   arr_estetica_cav1_Def.Base   -> fase=arr,  parametro=estetica_Def.Base,cavidad=1
//   semanal_altura_h_cav2        -> fase=semanal, parametro=altura_h,      cavidad=2
//   _maquinaParada               -> fase=meta, parametro=maquinaParada
//   num_cavidad / peso_preforma  -> fase=null, parametro=la clave entera

const FASES = ['arr', 'proc', 'semanal', 'quincenal', 'validacion', 'mensual', 'diario'];

export function parseClave(clave) {
    // Las claves con guion bajo inicial son metadatos del control, no medidas.
    if (clave.startsWith('_')) {
        return { fase: 'meta', parametro: clave.slice(1), cavidad: null };
    }

    let fase = null;
    let resto = clave;
    for (const f of FASES) {
        if (resto.startsWith(f + '_')) {
            fase = f;
            resto = resto.slice(f.length + 1);
            break;
        }
    }

    // La cavidad puede venir al final (peso_cav1) o en el medio
    // (estetica_cav1_Def.Base), por eso se busca y se recorta en su posicion.
    let cavidad = null;
    const m = resto.match(/_?cav(\d+)_?/i);
    if (m) {
        cavidad = parseInt(m[1], 10);
        resto = (resto.slice(0, m.index) + '_' + resto.slice(m.index + m[0].length))
            .replace(/_+/g, '_')
            .replace(/^_|_$/g, '');
    }

    return { fase, parametro: resto || clave, cavidad };
}

/**
 * Separa el valor en texto y numero.
 *
 * Solo se acepta punto como separador decimal a proposito: `num_cavidad` guarda
 * listas de cavidades como "1,2" y "1,2,3,4". Si se admitiera la coma, "1,2"
 * se guardaria como 1.2 y contaminaria los promedios. Los valores realmente
 * numericos ya llegan como numeros JSON desde el origen.
 */
export function normalizarValor(valor) {
    if (valor === null || valor === undefined) return { texto: null, num: null };

    if (typeof valor === 'number') {
        return { texto: String(valor), num: Number.isFinite(valor) ? valor : null };
    }
    if (typeof valor === 'boolean') {
        return { texto: valor ? 'true' : 'false', num: valor ? 1 : 0 };
    }

    const texto = String(valor).trim();
    if (texto === '') return { texto: '', num: null };

    const num = /^-?\d+(\.\d+)?$/.test(texto) ? Number(texto) : null;
    return { texto, num: Number.isFinite(num) ? num : null };
}

/**
 * Expande el objeto `mediciones` de un control a filas listas para insertar.
 * Los arrays (muestras multiples de LCC) generan una fila por muestra.
 */
export function expandirMediciones(mediciones) {
    if (!mediciones || typeof mediciones !== 'object') return [];

    const filas = [];
    for (const [clave, valor] of Object.entries(mediciones)) {
        const { fase, parametro, cavidad } = parseClave(clave);

        const valores = Array.isArray(valor) ? valor : [valor];
        valores.forEach((v, i) => {
            // Se descartan huecos, pero el objeto original queda intacto en
            // controles.raw, asi que no se pierde nada.
            if (v === null || v === undefined || v === '') return;
            const { texto, num } = normalizarValor(v);
            filas.push({
                clave,
                fase,
                parametro,
                cavidad,
                muestra: i + 1,
                valor_texto: texto,
                valor_num: num,
            });
        });
    }
    return filas;
}
