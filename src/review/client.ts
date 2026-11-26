import type { Result, ReviewInput } from './model';

export const isLoopback = ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(window.location.hostname);

export function checkInput(input: ReviewInput) {
  if (!['questionnaire', 'guide'].includes(input.mode)) throw Error('Choose a valid review mode.');
  if (!Array.isArray(input.documents) || input.documents.length > 18)
    throw Error('Include up to 18 policy documents.');
  if (input.mode === 'questionnaire' && !input.documents.length)
    throw Error('Add at least one policy to search for answers.');
  let totalPages = 0,
    totalChars = 0;
  const ids = new Set<string>();
  for (const doc of input.documents) {
    if (
      typeof doc.id !== 'string' ||
      !doc.id.trim() ||
      doc.id !== doc.id.trim() ||
      doc.id.length > 100 ||
      ids.has(doc.id) ||
      typeof doc.title !== 'string' ||
      !doc.title.trim() ||
      doc.title.length > 240 ||
      !Array.isArray(doc.pages) ||
      !doc.pages.length
    )
      throw Error('Each policy needs a unique ID, a title, and at least one page.');
    ids.add(doc.id);
    const pageNumbers = new Set<number>();
    for (const page of doc.pages) {
      if (
        !Number.isInteger(page.number) ||
        page.number < 1 ||
        pageNumbers.has(page.number) ||
        typeof page.text !== 'string' ||
        page.text.length > 35000
      )
        throw Error(
          'Each policy page needs a unique positive page number and up to 35,000 characters of text.',
        );
      totalPages++;
      totalChars += page.text.length;
      pageNumbers.add(page.number);
    }
    if (!doc.pages.some((p) => p.text.trim())) throw Error('Each policy needs at least one searchable page.');
  }
  if (totalPages > 1200 || totalChars > 2400000)
    throw Error('This review exceeds the limit of 1,200 pages or 2.4 million policy characters.');
  if (
    input.mode === 'guide' &&
    (typeof input.guide !== 'string' || !input.guide.trim() || input.guide.length > 50000)
  )
    throw Error('Enter a guide containing up to 50,000 characters.');
  if (
    input.mode === 'questionnaire' &&
    (!Array.isArray(input.questions) ||
      !input.questions.length ||
      input.questions.length > 30 ||
      input.questions.some((q) => typeof q !== 'string' || !q.trim() || q.length > 2000))
  )
    throw Error('Include 1–30 questions, each up to 2,000 characters.');
  if (new TextEncoder().encode(JSON.stringify(input)).length > 4000000)
    throw Error('This review exceeds the 4 MB request limit.');
}
export async function requestReview(input: ReviewInput, signal: AbortSignal): Promise<Result> {
  checkInput(input);
  const response = await fetch('/api/review', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
    signal,
  });
  const body = await response.json().catch(() => null);
  if (!response.ok || !body)
    throw Error(
      body?.error ||
        `The review service could not complete this request (HTTP ${response.status}). Try again.`,
    );
  if (!Array.isArray(body.findings) || !['anthropic', 'local'].includes(body.engine))
    throw Error('The review service returned an unexpected response. Try again.');
  return body as Result;
}
