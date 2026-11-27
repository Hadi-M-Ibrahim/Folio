import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
import { version as pdfVersion } from 'pdfjs-dist/package.json';
import { MAX_REQUEST_BYTES, ReviewSizeError, type PdfAttachment, type Policy } from './model';

const maxAttachmentBytes = Math.floor(MAX_REQUEST_BYTES / 4) * 3;
const pdfPageCounts = new WeakMap<File, number>();

export async function openPdf(file: File, signal?: AbortSignal) {
  const [pdfjs, data] = await Promise.all([import('pdfjs-dist'), file.arrayBuffer()]);
  signal?.throwIfAborted();
  const directory = import.meta.env.DEV ? 'node_modules/pdfjs-dist/' : 'assets/pdfjs-' + pdfVersion + '/';
  const assets = new URL(import.meta.env.BASE_URL + directory, window.location.origin);
  pdfjs.GlobalWorkerOptions.workerSrc = assets + 'build/pdf.worker.min.mjs';
  const task = pdfjs.getDocument({
    data, cMapUrl: assets + 'cmaps/', cMapPacked: true, standardFontDataUrl: assets + 'standard_fonts/',
    wasmUrl: assets + 'wasm/', useWasm: false, useWorkerFetch: true, stopAtErrors: true,
  });
  void task.promise.then((pdf) => pdfPageCounts.set(file, pdf.numPages), () => {});
  return task;
}

function checkAttachmentSize(bytes: number) {
  if (bytes >= maxAttachmentBytes) {
    throw new ReviewSizeError('These PDF pages exceed the 4 MB transfer limit after encoding.');
  }
}

function base64Pdf(blob: Blob): Promise<string> {
  checkAttachmentSize(blob.size);
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve((reader.result as string).split(',')[1]);
    reader.onerror = () => reject(Error('Could not read the PDF attachment. Choose the file again.'));
    reader.readAsDataURL(blob);
  });
}

async function renderPageImage(page: PDFPageProxy, signal: AbortSignal) {
  signal.throwIfAborted();
  const { width, height } = page.getViewport({ scale: 1 });
  // 180 dpi for standard paper; bound memory for oversized pages.
  const scale = Math.min(2.5, 3200 / Math.max(width, height), Math.sqrt(5_000_000 / (width * height)));
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.ceil(viewport.width));
  canvas.height = Math.max(1, Math.ceil(viewport.height));
  const render = page.render({ canvas, viewport });
  const cancel = () => render.cancel();
  signal.addEventListener('abort', cancel, { once: true });
  try {
    await render.promise;
    const image = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((blob) => blob?.type === 'image/jpeg' ? resolve(blob) :
        reject(Error('Could not prepare this PDF page. Try exporting the selected pages as a separate PDF.')), 'image/jpeg', 0.85);
    });
    return { image, width, height, pixelsWide: canvas.width, pixelsHigh: canvas.height };
  } finally {
    signal.removeEventListener('abort', cancel);
    canvas.width = canvas.height = 0;
    page.cleanup();
  }
}

// Build a new, image-only PDF. Copying source PDF objects can bring along
// other pages' shared image resources, form values and embedded attachments.
async function selectedPagesPdf(pdf: PDFDocumentProxy, numbers: number[], signal: AbortSignal) {
  const chunks: BlobPart[] = [];
  const offsets = [0];
  let length = 0;
  function append(chunk: string | Blob) {
    chunks.push(chunk);
    length += typeof chunk === 'string' ? chunk.length : chunk.size; // All PDF syntax we emit is ASCII.
    checkAttachmentSize(length);
  }
  function object(...parts: (string | Blob)[]) {
    offsets.push(length);
    append(offsets.length - 1 + ' 0 obj\n');
    for (const part of parts) append(part);
    append('\nendobj\n');
  }

  append('%PDF-1.4\n');
  object('<< /Type /Catalog /Pages 2 0 R >>');
  const kids = numbers.map((_, i) => (3 + i * 3) + ' 0 R').join(' ');
  object(`<< /Type /Pages /Count ${numbers.length} /Kids [${kids}] >>`);
  for (const number of numbers) {
    signal.throwIfAborted();
    const { width, height, image, pixelsWide, pixelsHigh } = await renderPageImage(await pdf.getPage(number), signal);
    const w = width.toFixed(4);
    const h = height.toFixed(4);
    const pageId = offsets.length;
    object(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] /Resources << /XObject << /Im ${pageId + 2} 0 R >> >> /Contents ${pageId + 1} 0 R >>`);
    const draw = `q ${w} 0 0 ${h} 0 0 cm /Im Do Q\n`;
    object(`<< /Length ${draw.length} >>\nstream\n${draw}endstream`);
    object(`<< /Type /XObject /Subtype /Image /Width ${pixelsWide} /Height ${pixelsHigh} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${image.size} >>\nstream\n`, image, '\nendstream');
  }
  const xref = length;
  append(`xref\n0 ${offsets.length}\n0000000000 65535 f \n`);
  for (const offset of offsets.slice(1)) append(String(offset).padStart(10, '0') + ' 00000 n \n');
  append(`trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return new Blob(chunks, { type: 'application/pdf' });
}

// Each review attempt owns its reader. A retry can begin while the cancelled attempt's worker shuts down.
export function createPdfAttachmentReader(doc: Policy, role: PdfAttachment['role'], signal: AbortSignal) {
  let loading: ReturnType<typeof openPdf> | undefined;
  let closing: Promise<void> | undefined;

  function close() {
    signal.removeEventListener('abort', onAbort);
    if (!closing) closing = loading ? loading.then(task => task.destroy(), () => {}) : Promise.resolve();
    return closing;
  }

  function onAbort() {
    // The caller also awaits close() in its finally block.
    void close().catch(() => {});
  }

  async function attachment(pageNumbers: readonly number[], renderSelectedPages = false): Promise<PdfAttachment> {
    signal.throwIfAborted();
    if (closing) throw Error('This PDF reader is closed.');
    const file = doc.pdfFile;
    if (!file) throw Error('Choose the original PDF again to attach its pages.');
    const pages = [...new Set(pageNumbers)].sort((a, b) => a - b);
    if (!pages.length || pages.some(n => !Number.isSafeInteger(n) || n < 1)) {
      throw Error('Choose at least one valid PDF page.');
    }
    const lastPage = pages[pages.length - 1];
    // Large policy originals can include bulky embedded resources. Try a visual copy before requiring a narrower policy scope.
    const keepOriginal = !renderSelectedPages && (role !== 'policy' || file.size < maxAttachmentBytes);
    const useOriginal = (count?: number) => keepOriginal && pages.length === count && lastPage === count;
    let blob: Blob = file;
    if (!useOriginal(pdfPageCounts.get(file))) {
      if (!loading) {
        loading = openPdf(file, signal);
        signal.addEventListener('abort', onAbort, { once: true });
      }
      const pdf = await (await loading).promise;
      signal.throwIfAborted();
      if (lastPage > pdf.numPages) throw Error('Choose pages within the original PDF.');
      if (!useOriginal(pdf.numPages)) blob = await selectedPagesPdf(pdf, pages, signal);
    }
    signal.throwIfAborted();
    const data = await base64Pdf(blob);
    signal.throwIfAborted();
    return { role, documentId: doc.id, title: doc.title, pages, data };
  }
  return { attachment, close };
}

export async function makePolicyPdfAttachment(doc: Policy, signal: AbortSignal): Promise<PdfAttachment> {
  const reader = createPdfAttachmentReader(doc, 'policy', signal);
  try {
    return await reader.attachment(doc.pages.map(page => page.number));
  } catch (error) {
    signal.throwIfAborted();
    throw error;
  } finally {
    await reader.close();
  }
}
