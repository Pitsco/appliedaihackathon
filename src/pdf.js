// PDF helpers. Text comes out page by page so every fact can point at the page it was found on.
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { PDFDocument, PDFName, PDFRawStream, PDFArray } from 'pdf-lib';

/** Text of every page, in order. A page with no text layer (a bare scan) comes back as ''. */
export async function pdfPageTexts(buffer) {
  const task = getDocument({
    data: new Uint8Array(buffer),
    verbosity: 0,
    isEvalSupported: false,
    disableFontFace: true,
    useSystemFonts: false,
  });
  const doc = await task.promise;
  const pages = [];
  try {
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const content = await page.getTextContent();
      let text = '';
      let lastY = null;
      for (const item of content.items) {
        if (typeof item.str !== 'string') continue;
        const y = item.transform ? Math.round(item.transform[5]) : null;
        if (lastY !== null && y !== null && Math.abs(y - lastY) > 2 && !text.endsWith('\n')) text += '\n';
        text += item.str;
        if (item.hasEOL) text += '\n';
        lastY = y;
      }
      pages.push(
        text
          .replace(/[ \t]+\n/g, '\n')
          .replace(/\n{3,}/g, '\n\n')
          .replace(/[ \t]{2,}/g, ' ')
          .trim(),
      );
      page.cleanup();
    }
  } finally {
    await task.destroy();
  }
  return pages;
}

/** A new PDF holding only the given 1-based pages, in the given order. Used to send bare scans to the vision model. */
export async function subsetPdf(buffer, pageNumbers) {
  const source = await PDFDocument.load(buffer, { ignoreEncryption: true });
  const out = await PDFDocument.create();
  const copied = await out.copyPages(
    source,
    pageNumbers.map((n) => n - 1),
  );
  for (const page of copied) out.addPage(page);
  return Buffer.from(await out.save());
}

/** The largest JPEG embedded in a PDF, or null. A scanned photo ID is a one-page PDF wrapped around exactly such an image. */
export async function largestJpeg(buffer) {
  const doc = await PDFDocument.load(buffer, { ignoreEncryption: true });
  let best = null;
  for (const [, object] of doc.context.enumerateIndirectObjects()) {
    if (!(object instanceof PDFRawStream)) continue;
    const dict = object.dict;
    if (dict.get(PDFName.of('Subtype')) !== PDFName.of('Image')) continue;
    const filter = dict.get(PDFName.of('Filter'));
    const names = filter instanceof PDFArray ? filter.asArray() : [filter];
    if (names.length !== 1 || names[0] !== PDFName.of('DCTDecode')) continue;
    const width = Number(dict.get(PDFName.of('Width'))?.toString() ?? 0);
    const height = Number(dict.get(PDFName.of('Height'))?.toString() ?? 0);
    const area = width * height;
    if (!best || area > best.area) best = { area, width, height, bytes: Buffer.from(object.contents) };
  }
  return best;
}
