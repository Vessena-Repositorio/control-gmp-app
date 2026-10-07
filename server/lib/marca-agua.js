/**
 * Marca "COPIA NO CONTROLADA" sobre los PDF que se descargan.
 *
 * Lo que sale del sistema deja de estar controlado: puede quedar impreso en un
 * cajon cuando la version ya cambio. La marca dice que es una copia, de que
 * version, quien la bajo y cuando, y que hay que verificar la vigencia en el
 * sistema antes de usarla (ISO 9001 7.5.3; SOP-DOC-001).
 *
 * El archivo guardado no se toca: la marca se agrega en cada descarga.
 */
import { PDFDocument, StandardFonts, rgb, degrees } from 'pdf-lib';

// Las fuentes estandar del PDF codifican WinAnsi: tildes y ñ entran, otros
// caracteres no. Lo que no entre se escribe sin el acento antes que fallar.
function apto(fuente, txt) {
    try {
        fuente.encodeText(txt);
        return txt;
    } catch {
        return txt.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\x20-\x7E]/g, '?');
    }
}

/**
 * Devuelve el PDF marcado. `datos` = { codigo, version, quien, cuando }.
 * Si el PDF no se puede abrir lanza error: entregar una copia sin marca seria
 * peor que no entregarla.
 */
export async function marcarCopiaNoControlada(buffer, { codigo, version, quien, cuando }) {
    const pdf = await PDFDocument.load(buffer, { ignoreEncryption: true, updateMetadata: false });
    const normal = await pdf.embedFont(StandardFonts.Helvetica);
    const negrita = await pdf.embedFont(StandardFonts.HelveticaBold);

    const marca = 'COPIA NO CONTROLADA';
    const pie = apto(normal,
        `COPIA NO CONTROLADA · ${codigo} v${version} · descargada por ${quien} el ${cuando}. ` +
        'Válida solo a esa fecha: verificar la vigencia en el sistema antes de usar.');

    for (const pagina of pdf.getPages()) {
        const { width, height } = pagina.getSize();

        // Diagonal, tenue, de esquina a esquina.
        const angulo = Math.atan2(height, width);
        const tam = Math.min(width, height) / 9;
        const ancho = negrita.widthOfTextAtSize(marca, tam);
        pagina.drawText(marca, {
            x: width / 2 - (Math.cos(angulo) * ancho) / 2 + (Math.sin(angulo) * tam) / 2,
            y: height / 2 - (Math.sin(angulo) * ancho) / 2 - (Math.cos(angulo) * tam) / 2,
            size: tam, font: negrita, color: rgb(0.75, 0.1, 0.1), opacity: 0.13,
            rotate: degrees((angulo * 180) / Math.PI),
        });

        // Pie de pagina, achicado si no entra.
        let t = 7;
        while (t > 4 && normal.widthOfTextAtSize(pie, t) > width - 24) t -= 0.5;
        pagina.drawRectangle({ x: 0, y: 0, width, height: t + 8, color: rgb(1, 1, 1), opacity: 0.85 });
        pagina.drawText(pie, { x: 12, y: 5, size: t, font: normal, color: rgb(0.6, 0.1, 0.1) });
    }
    return Buffer.from(await pdf.save());
}
