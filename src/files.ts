import type { Policy } from './review';

export async function readDocument(file: File): Promise<Policy> {
  if (file.size > 32 * 1024 * 1024) throw Error('Use files smaller than 32 MB.');
  const name = file.name;
  let pages: Policy['pages'];
  if (/\.pdf$/i.test(name)) {
    const pdfjs = await import('pdfjs-dist');
    const {default: workerUrl} = await import('pdfjs-dist/build/pdf.worker.min.mjs?url');
    pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
    const loadingTask = pdfjs.getDocument({data: await file.arrayBuffer()});
    const pdf = await loadingTask.promise;
    try {
      if (pdf.numPages > 1200) throw Error('A review supports up to 1,200 pages.');
      pages = [];
      for (let number=1; number<=pdf.numPages; number++) {
        const page = await pdf.getPage(number);
        const content = await page.getTextContent();
        const text = content.items.map(item => 'str' in item ? item.str + (item.hasEOL ? '\n' : ' ') : '').join('').trim();
        if (text) pages.push({number, text});
        page.cleanup();
      }
    } finally { await loadingTask.destroy(); }
  } else if (/\.(txt|md)$/i.test(name)) {
    // A form feed explicitly separates pages in a plain-text export.
    pages = (await file.text()).split('\f').map((text, i) => ({number:i+1, text:text.trim()})).filter(p => p.text);
  } else throw Error('Choose a PDF, TXT, or Markdown file.');
  if (!pages.length) throw Error(`No readable text in “${name}”. For a scanned PDF, run OCR and upload the text export.`);
  return {id: crypto.randomUUID(), title: name, pages};
}
