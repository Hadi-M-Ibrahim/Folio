import { checkInput, encodeRequest, guidePolicyRequired } from '../review/client';
import { makePdfAttachment } from '../review/pdf';
import { executeWholeReview } from '../review/wholeReview';
import {
  MAX_PDF_ATTACHMENT_PAGES, MAX_REQUEST_BYTES, ReviewSizeError, modeLabels,
  type Mode, type IntakePolicy, type PdfAttachment, type Policy, type ReviewInput, type Scope,
} from '../review/model';
import type { IntakeSource } from './SourceFields';
import { ReviewJob, type ReviewRecipe, type ReviewWork } from '../review/reviewJob';

export function needsPolicyFile(mode: Mode, originals: IntakePolicy[]) {
  return mode === 'guide' && !originals.some(policy => !policy.pasted);
}

async function attachPolicies(input: ReviewInput, hasSourcePdf: boolean, signal: AbortSignal) {
  const pdfs = input.documents.filter(doc => doc.pdfFile);
  const availablePages = MAX_PDF_ATTACHMENT_PAGES - (hasSourcePdf ? 1 : 0);
  if (pdfs.reduce((count, doc) => count + doc.pages.length, 0) > availablePages) {
    throw Error('Select up to ' + availablePages + ' policy PDF pages' + (hasSourcePdf ? ' when reviewing a source PDF.' : ' in total.'));
  }
  const attachments = [];
  let encodedBytes = 0;
  for (const doc of pdfs) {
    signal.throwIfAborted();
    const attachment = await makePdfAttachment(doc, 'policy', doc.pages.map(page => page.number), signal);
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

function reviewInput(mode: Mode, source: IntakeSource, questions: string[], policies: Policy[]): ReviewInput {
  return {
    mode, documents: policies,
    ...(source.readSourcePdf ? { readSourcePdf: true } : mode === 'guide' ? { guide: source.text.trim() } : { questions }),
  };
}

export function prepareReview({ mode, source, questions, documents, originals, scope }: {
  mode: Mode; source: IntakeSource; questions: string[]; documents: Policy[]; originals: IntakePolicy[];
  scope?: Scope;
}): ReviewJob {
  if (needsPolicyFile(mode, originals)) throw Error(guidePolicyRequired);
  const input = { ...reviewInput(mode, source, questions, documents), allowModel: true, modelSharingConsent: true };
  checkInput(input);
  const title = source.name.replace(/\.[^.]+$/, '').replace(/_/g, ' ').trim() || modeLabels[mode] + ' review';
  const recipe = {
    input, sourceDocument: source.document, sourceSelection: source.selection, scope,
    questionPages: source.questionPages, renderItemSubset: source.range?.unit === 'question' && Boolean(source.selection),
  };
  return ReviewJob.prepare(title, recipe, createReviewWork(recipe));
}

export function createReviewWork(recipe: ReviewRecipe): ReviewWork {
  const { input, sourceDocument, sourceSelection, scope, questionPages, renderItemSubset } = recipe;
  let policyAttachments: PdfAttachment[] | undefined;
  return async (signal, onProgress, mayWaitForQuota, checkpoint, onCheckpoint) => {
    if (!policyAttachments) {
      const attachments = await attachPolicies(input, Boolean(sourceDocument?.pdfFile), signal);
      signal.throwIfAborted();
      policyAttachments = attachments;
    }
    const result = await executeWholeReview({
      input, sourceDocument, questionPages, renderItemSubset, policyAttachments, signal, onProgress, mayWaitForQuota,
      checkpoint, onCheckpoint,
    });
    return {
      input: {
        ...input, ...(result.guide !== undefined && { guide: result.guide }), ...(result.questions && { questions: result.questions }),
        documents: input.documents.map(doc => withReturnedPages(doc, result.policyPageText?.find(record => record.documentId === doc.id)?.pages)),
      },
      result, sourceDocument: sourceDocument && withReturnedPages(sourceDocument, result.sourcePages),
      sourceSelection, scope,
    };
  };
}
