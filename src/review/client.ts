import {
  MAX_GUIDE_CHARACTERS, MAX_POLICY_CHARACTERS, MAX_POLICY_DOCUMENTS, MAX_POLICY_PAGE_CHARACTERS,
  MAX_PDF_ATTACHMENT_PAGES, MAX_POLICY_PAGES, MAX_QUESTION_CHARACTERS, MAX_QUESTIONS, MAX_REQUEST_BYTES,
  type Policy, type Result, type ReviewInput,
} from './model';

export const isLoopback = ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(window.location.hostname);

function hasText(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.length <= maxLength && Boolean(value.trim());
}

function checkPolicyPages({ pages, pdfFile }: Policy): number {
  const numbers = new Set<number>();
  let characters = 0;
  for (const page of pages) {
    if (!Number.isSafeInteger(page.number) || page.number < 1 || numbers.has(page.number) ||
      typeof page.text !== 'string' || page.text.length > MAX_POLICY_PAGE_CHARACTERS) {
      throw Error('Each policy page needs a unique positive page number and up to 35,000 characters of text.');
    }
    numbers.add(page.number);
    characters += page.text.length;
  }
  if (!(pdfFile instanceof File) && !pages.some((page) => page.text.trim()))
    throw Error('Each policy needs a PDF or at least one searchable page.');
  return characters;
}

function checkPolicies(documents: Policy[]) {
  const ids = new Set<string>();
  let pages = 0;
  let characters = 0;
  for (const doc of documents) {
    if (!hasText(doc.id, 100) || doc.id !== doc.id.trim() || ids.has(doc.id) ||
      !hasText(doc.title, 240) || !Array.isArray(doc.pages) || !doc.pages.length) {
      throw Error('Each policy needs a unique ID, a title, and at least one page.');
    }
    ids.add(doc.id);
    characters += checkPolicyPages(doc);
    pages += doc.pages.length;
  }
  if (pages > MAX_POLICY_PAGES || characters > MAX_POLICY_CHARACTERS)
    throw Error('This review exceeds the limit of 1,200 pages or 2.4 million policy characters.');
}

export function checkInput(input: ReviewInput) {
  if (!['questionnaire', 'guide'].includes(input.mode)) throw Error('Choose a valid review mode.');
  if (!Array.isArray(input.documents) || input.documents.length > MAX_POLICY_DOCUMENTS)
    throw Error('Include up to 18 policy documents.');
  if (input.mode === 'questionnaire' && !input.documents.length)
    throw Error('Add at least one policy to search for answers.');
  checkPolicies(input.documents);

  if (!input.readSourcePdf) checkSourceText(input);
  const documents = input.documents.map(({ id, title, pages }) => ({ id, title, pages }));
  const body = JSON.stringify({ ...input, documents });
  if (new TextEncoder().encode(body).length > MAX_REQUEST_BYTES)
    throw Error('This review exceeds the 4 MB request limit. Select fewer pages or remove a policy file.');
  return body;
}

function checkSourceText(input: ReviewInput) {
  if (input.mode === 'guide') {
    if (!hasText(input.guide, MAX_GUIDE_CHARACTERS)) throw Error('Enter a guide containing up to 50,000 characters.');
  } else {
    const questions = input.questions;
    if (!Array.isArray(questions) || !questions.length || questions.length > MAX_QUESTIONS ||
      !questions.every((question) => hasText(question, MAX_QUESTION_CHARACTERS))) {
      throw Error('Include 1–30 questions, each up to 2,000 characters.');
    }
  }
}

export async function requestReview(input: ReviewInput, signal: AbortSignal): Promise<Result> {
  const attachments = input.pdfAttachments ?? [];
  if (input.readSourcePdf && !attachments.some(file => file.role === 'source'))
    throw Error('Attach the source PDF before submitting this review.');
  if (input.documents.some(doc => doc.pdfFile && !attachments.some(file => file.role === 'policy' && file.documentId === doc.id)))
    throw Error('A policy PDF could not be attached. Try submitting the review again.');
  if (attachments.reduce((total, file) => total + file.pages.length, 0) > MAX_PDF_ATTACHMENT_PAGES)
    throw Error(`Select up to ${MAX_PDF_ATTACHMENT_PAGES} PDF pages across this review.`);
  const response = await fetch('/api/review', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: checkInput(input),
    signal,
  });
  if (response.status === 429) {
    // The edge firewall can return HTML. Both layers use the same ten-minute quota.
    const retry = response.headers.get('Retry-After');
    const seconds = retry && /^\d+$/.test(retry) ? Number(retry) : NaN;
    const minutes = Number.isSafeInteger(seconds) && seconds > 0 ? Math.ceil(seconds / 60) : 10;
    throw Error(`This network has reached its limit of 30 review submissions per 10 minutes. Try again in ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}. Your inputs are still here.`);
  }
  const body = await response.json().catch(() => null);
  if (!response.ok || !body)
    throw Error(
      body?.error ||
        `The review service could not complete this request (HTTP ${response.status}). Try again.`,
    );
  if (!Array.isArray(body.findings) || !['anthropic', 'local'].includes(body.engine))
    throw Error('The review service returned an unexpected response. Try again.');
  if (input.allowModel && body.engine !== 'anthropic')
    throw Error('The AI review could not finish. Your inputs are still here. Try again.');
  return body as Result;
}
