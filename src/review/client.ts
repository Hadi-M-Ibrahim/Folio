import { guideStreamType, readGuideStream } from './guideProgress';
import type { ReviewProgressState } from './reviewProgress';
import { sessionHeaders } from './reviewSession';
import {
  MAX_POLICY_CHARACTERS, MAX_POLICY_DOCUMENTS, MAX_POLICY_PAGE_CHARACTERS,
  MAX_PDF_ATTACHMENT_PAGES, MAX_POLICY_PAGES, MAX_REQUEST_BYTES, ReviewSizeError,
  type Evidence, type Finding, type Policy, type PolicyAction, type Result, type ReviewInput,
} from './model';

export const isLoopback = ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(window.location.hostname);
export const guidePolicyRequired = 'Upload at least one existing policy file to review this guide.';

function hasText(value: unknown, maxLength = Infinity): value is string {
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

export function checkPolicies(documents: Policy[]) {
  if (!Array.isArray(documents) || documents.length > MAX_POLICY_DOCUMENTS)
    throw Error('Include up to 18 policy documents.');
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

export function checkInput(input: ReviewInput, { allowGuideDraft = false } = {}) {
  if (!['questionnaire', 'guide'].includes(input.mode)) throw Error('Choose a valid review mode.');
  checkPolicies(input.documents);
  if (!input.documents.length && !input.transcribeSourceOnly) {
    if (input.mode === 'questionnaire') throw Error('Add at least one policy to search for answers.');
    if (!allowGuideDraft) throw Error(guidePolicyRequired);
  }
  if (!input.readSourcePdf) checkSourceText(input);
}

export function encodeRequest(input: ReviewInput) {
  const documents = input.documents.map(({ id, title, pages }) => ({ id, title, pages }));
  const body = JSON.stringify({ ...input, documents });
  if (new TextEncoder().encode(body).length > MAX_REQUEST_BYTES)
    throw new ReviewSizeError('The source and policies exceed the 4 MB transfer limit for this part.');
  return body;
}

function checkSourceText(input: ReviewInput) {
  if (input.mode === 'guide') {
    if (!hasText(input.guide)) throw Error('Upload or paste your regulatory guide.');
  } else {
    const questions = input.questions;
    if (!Array.isArray(questions) || !questions.length || !questions.every((question) => hasText(question))) {
      throw Error('Include at least one question. Each question needs text.');
    }
  }
}

function waitForQuota(seconds: number, signal: AbortSignal) {
  signal.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    const cancel = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', cancel);
      resolve();
    }, seconds * 1000);
    signal.addEventListener('abort', cancel, { once: true });
  });
}

type RequestOptions = { onGuideProgress?: (progress: ReviewProgressState) => void; onRateLimit?: (seconds: number) => void; onResume?: () => void; mayWaitForQuota?: () => boolean };

async function postReview(url: string, body: string, signal: AbortSignal, options?: RequestOptions) {
  for (;;) {
    signal.throwIfAborted();
    const response = await fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...(options?.onGuideProgress && { Accept: guideStreamType }), ...sessionHeaders(signal) }, body, signal,
    });
    if (response.status !== 429) return response;
    // The edge firewall and API can both throttle the shared network.
    const retry = response.headers.get('Retry-After');
    const seconds = retry && /^\d+$/.test(retry) ? Number(retry) : NaN;
    const wait = Number.isSafeInteger(seconds) && seconds > 0 ? seconds : 600;
    await response.body?.cancel();
    signal.throwIfAborted();
    if (!options?.onRateLimit || options.mayWaitForQuota?.() === false) {
      const minutes = Math.ceil(wait / 60);
      throw Error(`This network has reached its limit of 30 review submissions per 10 minutes. Try again in ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}. Your inputs are still here.`);
    }
    options.onRateLimit(wait);
    await waitForQuota(wait, signal);
    signal.throwIfAborted();
    options.onResume?.();
  }
}

function checkAttachments(input: ReviewInput) {
  const attachments = input.pdfAttachments ?? [];
  if (input.readSourcePdf && !attachments.some(file => file.role === 'source'))
    throw Error('Attach the source PDF before submitting this review.');
  if (input.documents.some(doc => doc.pdfFile && !attachments.some(file => file.role === 'policy' && file.documentId === doc.id)))
    throw Error('A policy PDF could not be attached. Try submitting the review again.');
  if (attachments.reduce((total, file) => total + file.pages.length, 0) > MAX_PDF_ATTACHMENT_PAGES)
    throw new ReviewSizeError(`One transfer can include up to ${MAX_PDF_ATTACHMENT_PAGES} PDF pages.`);
}

export async function requestReview(input: ReviewInput, signal: AbortSignal, options?: RequestOptions): Promise<Result> {
  checkInput(input);
  checkAttachments(input);
  const response = await postReview('/api/review', encodeRequest(input), signal, options);
  const { status, body } = options?.onGuideProgress && response.headers.get('Content-Type')?.split(';')[0] === guideStreamType
    ? await readGuideStream(response, options.onGuideProgress)
    : { status: response.status, body: await response.json().catch(() => null) };
  if (status === 413 || (status === 422 && body?.code === 'review_part_too_large')) {
    throw new ReviewSizeError(body?.error || 'This part exceeds the review service transfer limit.');
  }
  if (status !== 200 || !body)
    throw Error(
      body?.error ||
        `The review service could not complete this request (HTTP ${status}). Try again.`,
    );
  if (!Array.isArray(body.findings) || !['anthropic', 'local'].includes(body.engine))
    throw Error('The review service returned an unexpected response. Try again.');
  if (input.allowModel && body.engine !== 'anthropic')
    throw Error('The AI review could not finish. Your inputs are still here. Try again.');
  return body as Result;
}

export type DraftAction = 'draft' | 'shorten' | 'simplify' | 'expand';

async function requestDraft(payload: object, field: 'answer' | 'actionText', signal: AbortSignal) {
  const response = await postReview('/api/review?operation=draft', JSON.stringify(payload), signal);
  const result = await response.json().catch(() => null);
  const text = result?.[field];
  if (!response.ok || typeof text !== 'string' || !text.trim()) {
    const subject = field === 'actionText' ? 'policy action' : 'response';
    throw Error(result?.error || 'The ' + subject + ' could not be drafted. Try again.');
  }
  return text.trim();
}

export function writeResponse(action: DraftAction, finding: Finding, answer: string, citations: Evidence[], signal: AbortSignal) {
  return requestDraft({ action, question: finding.question, status: finding.status, assessment: finding.answer, answer, citations }, 'answer', signal);
}

export function writePolicyAction(
  action: DraftAction, finding: Finding, disposition: PolicyAction, actionText: string, citations: Evidence[], signal: AbortSignal,
) {
  return requestDraft({
    mode: 'guide', action, disposition, obligation: finding.question, guidePassage: finding.criterionSource ?? '',
    status: finding.status, assessment: finding.answer, actionText, citations, supporting: finding.supporting, counter: finding.counter,
    candidates: [...finding.candidates, ...(finding.followup?.passages ?? [])],
  }, 'actionText', signal);
}
