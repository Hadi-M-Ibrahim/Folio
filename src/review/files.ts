import { MAX_POLICY_CHARACTERS, MAX_POLICY_PAGE_CHARACTERS, MAX_POLICY_PAGES, type Policy } from './model';
import type { TextContent } from 'pdfjs-dist/types/src/display/api';

const maxFileBytes = 32 * 1024 * 1024;
const maxExtractedCharacters = 32_000_000;

export function documentErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : 'Could not read the document. Try again.';
}

export function* textPages(text: string) {
  // Count blank physical pages toward the limit and preserve gaps in page numbering.
  const sections = text.split('\f', MAX_POLICY_PAGES + 1);
  if (sections.length > MAX_POLICY_PAGES) throw Error('A review supports up to 1,200 pages.');
  for (const [index, section] of sections.entries()) {
    const trimmed = section.trim();
    if (trimmed) yield { number: index + 1, text: trimmed };
  }
}

export async function readDocument(file: File, existingPolicies?: readonly Policy[]): Promise<Policy> {
  if (file.size > maxFileBytes) throw Error('Use files smaller than 32 MB.');
  const name = file.name;
  const pages: Policy['pages'] = [];
  let remainingPages = MAX_POLICY_PAGES;
  let remainingCharacters = MAX_POLICY_CHARACTERS;
  for (const policy of existingPolicies ?? []) {
    remainingPages -= policy.pages.length;
    for (const page of policy.pages) remainingCharacters -= page.text.length;
  }

  function addPage(page: Policy['pages'][number]) {
    if (existingPolicies) {
      if (page.text.length > MAX_POLICY_PAGE_CHARACTERS) throw Error('Each policy page can contain up to 35,000 characters.');
      remainingPages--;
      remainingCharacters -= page.text.length;
      if (remainingPages < 0 || remainingCharacters < 0) {
        throw Error('This review exceeds the limit of 1,200 pages or 2.4 million policy characters.');
      }
    }
    pages.push(page);
  }

  if (/\.pdf$/i.test(name)) {
    const pdfjs = await import('pdfjs-dist');
    const { default: workerUrl } = await import('pdfjs-dist/build/pdf.worker.min.mjs?url');
    pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
    const loadingTask = pdfjs.getDocument({ data: await file.arrayBuffer() });
    try {
      const pdf = await loadingTask.promise;
      if (pdf.numPages > MAX_POLICY_PAGES) throw Error('A review supports up to 1,200 pages.');
      let extractedCharacters = 0;
      for (let number = 1; number <= pdf.numPages; number++) {
        const page = await pdf.getPage(number);
        const reader: ReadableStreamDefaultReader<TextContent> = page.streamTextContent().getReader();
        const parts: string[] = [];
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            // A font or ligature change can split a word across PDF text items.
            let part = '';
            for (const item of value.items) {
              if (!('str' in item)) continue;
              extractedCharacters += item.str.length + (item.hasEOL ? 1 : 0);
              if (extractedCharacters > maxExtractedCharacters) {
                throw Error('Use a PDF with up to 32 million characters of extracted text.');
              }
              part += item.str + (item.hasEOL ? '\n' : '');
            }
            if (part) parts.push(part);
          }
          const text = parts.join('').trim();
          if (text) addPage({ number, text });
        } finally {
          reader.releaseLock();
          page.cleanup();
        }
      }
    } finally {
      await loadingTask.destroy();
    }
  } else if (/\.(txt|md)$/i.test(name)) {
    for (const page of textPages(await file.text())) addPage(page);
  } else throw Error('Choose a PDF, TXT, or Markdown file.');
  if (!pages.length)
    throw Error(`No readable text in “${name}”. For a scanned PDF, run OCR and upload the text export.`);
  return { id: crypto.randomUUID(), title: name, pages };
}
