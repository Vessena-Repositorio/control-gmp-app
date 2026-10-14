/**
 * Codigo de un documento nuevo (migracion 061). La regla esta explicada en la
 * migracion; aca solo se aplica:
 *
 *   general  TIPO-AREA-NNN, una numeracion comun a SOP, INS, PL, MAN, RI...
 *   esp      ESP-AREA-NNN, numeracion propia
 *   pmv      PMV-NNN
 *   derivado PREFIJO-<codigo del padre>-<letra>, letras por prefijo y padre
 *
 * Siempre el siguiente al mayor que existe: un hueco no se reutiliza.
 *
 * `c` es un cliente de Postgres (o algo con .query). Para asignar de verdad
 * hay que llamarla dentro de una transaccion con `bloquear: true`: el lock
 * hace que dos altas simultaneas no reciban el mismo numero.
 */
function fallo(status, mensaje) {
    const e = new Error(mensaje);
    e.status = status;
    return e;
}

const tres = (n) => String(n).padStart(3, '0');

/** A=1 ... Z=26, AA=27: la serie de letras de los derivados. */
function letraANumero(s) {
    return [...s].reduce((n, ch) => n * 26 + (ch.charCodeAt(0) - 64), 0);
}
function numeroALetra(n) {
    let s = '';
    while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); }
    return s;
}

export async function siguienteCodigo(c, { tipo, area, padreId, bloquear = false }) {
    const t = String(tipo || '').toUpperCase();
    const { rows: [tp] } = await c.query('SELECT * FROM dc_tipos WHERE codigo = $1 AND activo', [t]);
    if (!tp) throw fallo(400, `tipo de documento desconocido: ${tipo}`);
    if (bloquear) await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['dc_codigos']);

    if (tp.deriva_de) {
        if (!padreId) throw fallo(400, `un ${tp.nombre.toLowerCase()} se crea a partir de su documento (${tp.deriva_de})`);
        const { rows: [p] } = await c.query('SELECT id, codigo, tipo, area FROM dc_documentos WHERE id = $1', [padreId]);
        if (!p) throw fallo(404, 'documento padre inexistente');
        if (p.tipo !== tp.deriva_de) throw fallo(400, `el documento padre tiene que ser un ${tp.deriva_de} (${p.codigo} es ${p.tipo})`);
        const base = `${t.split('-')[0]}-${p.codigo.toUpperCase()}`;
        const { rows } = await c.query(
            `SELECT upper(codigo) AS codigo FROM dc_documentos WHERE upper(codigo) LIKE $1`, [`${base}-%`]);
        // Solo la letra: REG-SOP-LCC-046-A.1 cuenta como A.
        const usadas = rows.map((r) => r.codigo.slice(base.length + 1).match(/^([A-Z]+)/)?.[1]).filter(Boolean);
        const sig = numeroALetra(Math.max(0, ...usadas.map(letraANumero)) + 1);
        return { codigo: `${base}-${sig}`, area: p.area, padre: p.codigo };
    }

    if (!tp.secuencia) throw fallo(400, `${tp.nombre}: lleva el código de su origen, escribilo a mano`);

    let a = null;
    if (tp.con_area) {
        a = String(area || '').toUpperCase();
        const { rows: [ar] } = await c.query('SELECT codigo FROM dc_areas WHERE codigo = $1 AND activa', [a]);
        if (!ar) throw fallo(400, a ? `área desconocida: ${a}` : 'elegí el área');
    }

    // Los tipos que comparten la numeracion, y la forma de su codigo.
    const { rows: grupo } = await c.query('SELECT codigo FROM dc_tipos WHERE secuencia = $1', [tp.secuencia]);
    const tipos = grupo.map((g) => g.codigo);
    const { rows } = await c.query('SELECT upper(codigo) AS codigo, tipo FROM dc_documentos WHERE tipo = ANY($1)', [tipos]);
    const forma = tp.con_area ? /^[A-Z]+-[A-Z0-9]+-(\d+)$/ : /^[A-Z]+-(\d+)$/;
    const max = Math.max(0, ...rows.map((r) => Number(r.codigo.match(forma)?.[1] || 0)));
    const codigo = tp.con_area ? `${t}-${a}-${tres(max + 1)}` : `${t}-${tres(max + 1)}`;
    return { codigo, area: a, ultimo: max };
}
