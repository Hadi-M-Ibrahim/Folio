import { checkInput, encodeRequest } from '../review/client';
import { makePdfAttachment } from '../review/pdf';
import { executeWholeReview } from '../review/wholeReview';
import {
  MAX_PDF_ATTACHMENT_PAGES, MAX_REQUEST_BYTES, ReviewSizeError, modeLabels,
  type Mode, type PdfAttachment, type Policy, type ReviewInput, type Scope,
} from '../review/model';
import { emptyPolicyDraft, pastedPolicy } from './PolicyFields';
import type { IntakeSource } from './SourceFields';
import type { RunReview } from './useIntakeReview';

async function attachPolicies(input: ReviewInput, originals: Policy[], hasSourcePdf: boolean, signal: AbortSignal) {
  const pdfs = input.documents.filter(doc => doc.pdfFile);
  const availablePages = MAX_PDF_ATTACHMENT_PAGES - (hasSourcePdf ? 1 : 0);
  if (pdfs.reduce((count, doc) => count + doc.pages.length, 0) > availablePages) {
    throw Error('Select up to ' + availablePages + ' policy PDF pages' + (hasSourcePdf ? ' when reviewing a source PDF.' : ' in total.'));
  }
  const attachments = [];
  let encodedBytes = 0;
  for (const doc of pdfs) {
    signal.throwIfAborted();
    const original = originals.find(item => item.id === doc.id) ?? doc;
    const attachment = await makePdfAttachment(original, 'policy', doc.pages.map(page => page.number), signal);
    encodedBytes += attachment.data.length;
    if (encodedBytes > MAX_REQUEST_BYTES) {
      throw Error('The selected policy PDFs exceed the 4 MB request limit. Select fewer policy pages.');
    }
    attachments.push(attachment);
  }
  try {
    encodeRequest({ ...input, guide: undefined, questions: undefined, pdfAttachments: attachments });
  } catch (error) {
    if (!(error instanceof ReviewSizeError)) throw error;
    throw Error('The selected policies exceed the 4 MB request limit. Select fewer policy pages or remove a policy.');
  }
  return attachments;
}

function withReturnedPages(doc: Policy, returned?: Policy['pages']): Policy {
  if (!returned?.length) return doc;
  const textByPage = new Map(returned.map((page) => [page.number, page.text]));
  return { ...doc, pages: doc.pages.map((page) => ({ ...page, text: textByPage.get(page.number) ?? page.text })) };
}

export function reviewInput(mode: Mode, source: IntakeSource, questions: string[], policies: Policy[]): ReviewInput {
  return {
    mode, documents: policies,
    ...(source.readSourcePdf ? { readSourcePdf: true } : mode === 'guide' ? { guide: source.text.trim() } : { questions }),
  };
}

export function prepareReview({ mode, source, questions, documents, originals, draft, scope }: {
  mode: Mode; source: IntakeSource; questions: string[]; documents: Policy[]; originals: Policy[];
  draft: typeof emptyPolicyDraft; scope?: Scope;
}): RunReview {
  const includeDraft = Boolean(draft.text.trim() || draft.title.trim());
  const policies = includeDraft ? [...documents, pastedPolicy(draft, documents.length + 1)] : documents;
  if (!policies.length && mode === 'questionnaire') throw Error('Upload a policy file or paste a policy to continue.');
  const input = { ...reviewInput(mode, source, questions, policies), allowModel: true, modelSharingConsent: true };
  checkInput(input);
  let policyAttachments: PdfAttachment[] | undefined;

  return async (signal, onProgress, mayWaitForQuota) => {
    if (!policyAttachments) {
      const attachments = await attachPolicies(input, originals, Boolean(source.document?.pdfFile), signal);
      signal.throwIfAborted();
      policyAttachments = attachments;
    }
    const result = await executeWholeReview({
      input, sourceDocument: source.document, sourceOriginal: source.range?.original ?? source.document,
      questionPages: source.questionPages, renderItemSubset: source.range?.unit === 'question' && Boolean(source.selection),
      policyAttachments, signal, onProgress, mayWaitForQuota,
    });
    return {
      key: crypto.randomUUID(),
      title: source.name.replace(/\.[^.]+$/, '').replace(/_/g, ' ').trim() || modeLabels[mode] + ' review',
      input: {
        ...input, ...(result.guide !== undefined && { guide: result.guide }), ...(result.questions && { questions: result.questions }),
        documents: policies.map(doc => withReturnedPages(doc, result.policyPageText?.find(record => record.documentId === doc.id)?.pages)),
      },
      result, sourceDocument: source.document && withReturnedPages(source.document, result.sourcePages),
      sourceSelection: source.selection, scope: includeDraft ? undefined : scope,
    };
  };
}
