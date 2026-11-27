import { questionsFromPdfPages, type PdfQuestion } from '../components/intakeQuestions';
import { requestReview } from './client';
import { MAX_PDF_ATTACHMENT_PAGES, ReviewSizeError, type Policy, type PdfAttachment, type Result, type ReviewInput } from './model';
import { makePdfAttachment } from './pdf';
import type { ReviewPhase, ReviewProgressState } from './reviewProgress';
import { combineScanQuestions, divide, locateQuestions, pageSpans, pagesIn, questionSpans, sourceSpans, type Span, type Transcript } from './wholeReviewSource';

type Options = {
  input: ReviewInput;
  sourceDocument?: Policy;
  sourceOriginal?: Policy;
  questionPages?: readonly (readonly number[])[];
  renderItemSubset?: boolean;
  policyAttachments: PdfAttachment[];
  signal: AbortSignal;
  onProgress?: (progress: ReviewProgressState) => void;
  mayWaitForQuota?: () => boolean;
};

const questionsPerPart = 10;
const guideCharactersPerPart = 10_000;
const scanPagesPerPart = 3;
type Completed = { span: Span; result: Result };
type Cache = {
  options: Options;
  completed: Map<string, Result>;
  subdivided: Set<string>;
  policyText: Map<string, Map<number, string>>;
  lastPdf?: { key: string; attachment: PdfAttachment };
};
const retries = new WeakMap<ReviewInput, Cache>();

function checkpoint(options: Options): Cache {
  const cache = retries.get(options.input);
  // Intake retains this immutable input and the attached policies for an unchanged retry.
  if (cache && cache.options.sourceDocument === options.sourceDocument &&
    cache.options.sourceOriginal === options.sourceOriginal && cache.options.renderItemSubset === options.renderItemSubset &&
    cache.options.policyAttachments === options.policyAttachments &&
    JSON.stringify(cache.options.questionPages) === JSON.stringify(options.questionPages)) return cache;
  const fresh = { options, completed: new Map<string, Result>(), subdivided: new Set<string>(), policyText: new Map() };
  retries.set(options.input, fresh);
  return fresh;
}

function savePolicyText(cache: Cache, records: Result['policyPageText']) {
  for (const { documentId, pages } of records ?? []) {
    const text = cache.policyText.get(documentId) ?? new Map<number, string>();
    for (const page of pages) text.set(page.number, page.text);
    cache.policyText.set(documentId, text);
  }
}

function indexedPolicies(input: ReviewInput, cache: Cache) {
  return input.documents.map(doc => {
    const text = cache.policyText.get(doc.id);
    if (!text) return doc;
    return { ...doc, pages: doc.pages.map(page => ({ ...page, text: text.get(page.number) ?? page.text })) };
  });
}

type Section = {
  key: string;
  numbers: number[];
  partial: boolean;
  input: ReviewInput;
  label: string;
  work: Span & { phase: ReviewPhase; total: number };
};

async function send(options: Options, cache: Cache, section: Section, forceRender = false): Promise<Result> {
  options.signal.throwIfAborted();
  const prior = cache.completed.get(section.key);
  if (prior) return prior;
  const { input, partial, numbers, label, work } = section;
  const report = (completed: number, message = label) => {
    options.signal.throwIfAborted();
    options.onProgress?.({ phase: work.phase, message, completed, total: work.total });
  };
  report(work.start);
  const attachments = input.transcribeSourceOnly ? [] : [...options.policyAttachments];
  const doc = options.sourceOriginal ?? options.sourceDocument;
  if (doc?.pdfFile) {
    if (attachments.reduce((sum, file) => sum + file.pages.length, numbers.length) > MAX_PDF_ATTACHMENT_PAGES)
      throw new ReviewSizeError('The source and policy PDFs exceed the per-request PDF page limit.');
    const renderSelectedPages = Boolean(forceRender || partial || options.renderItemSubset);
    const key = (renderSelectedPages ? 'render/' : 'original/') + numbers.join(',');
    if (cache.lastPdf?.key !== key) {
      const attachment = await makePdfAttachment(doc, 'source', numbers, options.signal, { renderSelectedPages });
      options.signal.throwIfAborted();
      cache.lastPdf = { key, attachment };
    }
    attachments.unshift(cache.lastPdf.attachment);
  }
  const wire = {
    ...input, ...(input.allowModel && { requireComplete: true }),
    ...(partial && { documentPart: true }), ...(attachments.length && { pdfAttachments: attachments }),
  };
  const onRateLimit = (seconds: number) => report(work.start, 'Review paused at the submission limit. Resuming in ' +
    Math.max(1, Math.ceil(seconds / 60)) + ' min…');
  options.signal.throwIfAborted();
  const result = await requestReview(wire, options.signal, partial ? {
    onRateLimit, onResume: () => report(work.start), mayWaitForQuota: options.mayWaitForQuota,
  } : undefined);
  options.signal.throwIfAborted();
  validatePart(input, numbers, result);
  cache.completed.set(section.key, result);
  savePolicyText(cache, result.policyPageText);
  report(work.end);
  return result;
}

function validatePart(input: ReviewInput, numbers: number[], result: Result) {
  if (input.readSourcePdf) {
    const rows = result.sourcePages;
    if (!rows || rows.length !== numbers.length ||
      rows.some((row, i) => row.number !== numbers[i] || typeof row.text !== 'string'))
      throw Error('The review service returned an incomplete PDF transcription. Try again.');
  }
  const questions = input.questions ?? result.questions;
  if (!input.transcribeSourceOnly && input.mode === 'questionnaire' &&
    (!questions || result.findings.length !== questions.length ||
      result.findings.some((finding, i) => finding.question !== questions[i].trim()))) {
    throw Error('The review service returned an incomplete questionnaire. Try again.');
  }
}

type Series = {
  name: string;
  phase: ReviewPhase;
  phaseOffset?: number;
  phaseTotal?: number;
  length: number;
  spans: Iterable<Span>;
  guide?: string;
  alwaysPart?: boolean;
  section: (span: Span, partial: boolean) => Pick<Section, 'input' | 'numbers' | 'label'>;
};

async function runSeries(options: Options, cache: Cache, series: Series): Promise<Completed[]> {
  const completed: Completed[] = [];
  async function processSpan(span: Span, partial: boolean): Promise<void> {
    options.signal.throwIfAborted();
    if (series.guide && !series.guide.slice(span.start, span.end).trim()) return;
    const key = series.name + '/' + span.start + '/' + span.end;
    let parts: Span[] | undefined;
    if (!cache.subdivided.has(key)) {
      const offset = series.phaseOffset ?? 0;
      const work = { phase: series.phase, start: offset + span.start, end: offset + span.end, total: series.phaseTotal ?? series.length };
      const section = { ...series.section(span, partial), key, partial, work };
      try {
        const result = await send(options, cache, section);
        completed.push({ span, result });
        return;
      } catch (error) {
        options.signal.throwIfAborted();
        if (!(error instanceof ReviewSizeError)) throw error;
        parts = divide(span, series.guide);
        if (!parts.length) {
          // A single-page original can carry large invisible resources. Re-encode its visible page.
          if (partial || !section.numbers.length) throw error;
          completed.push({ span, result: await send(options, cache, section, true) });
          return;
        }
      }
      cache.subdivided.add(key);
    }
    for (const part of parts ?? divide(span, series.guide)) await processSpan(part, true);
  }
  try {
    for (const span of series.spans) {
      await processSpan(span, Boolean(series.alwaysPart || span.end - span.start < series.length));
    }
  } catch (cause) {
    options.signal.throwIfAborted();
    const done = completed.at(-1)?.span.end;
    if (series.phase === 'questions' && done && cause instanceof Error) {
      throw new Error(cause.message + ' ' + done + ' of ' + series.length +
        ' questions completed. Retry to resume in this tab.', { cause });
    }
    throw cause;
  }
  return completed;
}

function merge(input: ReviewInput, parts: Completed[], cache: Cache): Result {
  const findings: Result['findings'] = [];
  const notices = new Set<string>();
  let utf16 = 0;
  let codepoints = 0;
  let usedModel = false;
  let localPlan = false;
  for (const { span, result } of parts) {
    if (input.guide) {
      codepoints += Array.from(input.guide.slice(utf16, span.start)).length;
      utf16 = span.start;
    }
    for (const finding of result.findings) {
      findings.push({ ...finding, id: 'q' + (findings.length + 1),
        ...(finding.criterionStart != null && { criterionStart: finding.criterionStart + codepoints }),
        ...(finding.criterionEnd != null && { criterionEnd: finding.criterionEnd + codepoints }) });
    }
    if (result.notice) notices.add(result.notice);
    usedModel ||= result.engine === 'anthropic';
    localPlan ||= result.planningEngine === 'local';
  }
  const policyPageText = Array.from(cache.policyText, ([documentId, pages]) =>
    ({ documentId, pages: Array.from(pages, ([number, text]) => ({ number, text })) }));
  if (!findings.length && input.mode === 'guide') notices.add('No reviewable obligations were identified in this guide.');
  return {
    mode: input.mode, engine: usedModel ? 'anthropic' : 'local', planningEngine: localPlan ? 'local' : 'anthropic',
    notice: [...notices].join(' '), findings,
    criterionLimitReached: parts.some(part => part.result.criterionLimitReached),
    ...(input.guide !== undefined && { guide: input.guide }), ...(input.questions && { questions: input.questions }),
    ...(policyPageText.length && { policyPageText }),
  };
}

function guideSeries(input: ReviewInput, source: Policy | undefined, cache: Cache): Series {
  const guide = input.guide!;
  const pages = source?.pdfFile ? source.pages : [];
  const offset = pages.length ? pages.map(page => page.text).join('\n\n').indexOf(guide) : 0;
  if (offset < 0) throw Error('The submitted guide could not be matched to its original PDF pages.');
  const spans = pageSpans(pages, 2, offset);
  return { name: 'guide', phase: 'guide', length: guide.length, spans: sourceSpans(guide.length, guideCharactersPerPart, guide), guide,
    section: (span, partial) => ({
      input: { ...input, guide: guide.slice(span.start, span.end), documents: indexedPolicies(input, cache) },
      numbers: partial ? pagesIn(spans, span) : pages.map(page => page.number),
      label: 'Reviewing guide obligations…',
    }) };
}

function questionSeries(input: ReviewInput, source: Policy | undefined, cache: Cache,
  questionPages?: Options['questionPages']): Series {
  const questions = input.questions!;
  const pages = source?.pdfFile ? source.pages : [];
  function relevantPages(span: Span, partial: boolean) {
    if (!partial || !pages.length) return pages.map(page => page.number);
    questionPages ??= locateQuestions(pages, questions).map(question => question.pageNumbers);
    const selected = questionPages.slice(span.start, span.end);
    if (selected.length !== span.end - span.start || selected.some(numbers => !numbers.length))
      throw Error('A questionnaire prompt could not be located on its original PDF pages.');
    return [...new Set(selected.flat())].sort((a, b) => a - b);
  }
  return { name: 'questions', phase: 'questions', length: questions.length, spans: questionSpans(questions, questionsPerPart, 16_000),
    section: (span, partial) => ({
      input: { ...input, questions: questions.slice(span.start, span.end), documents: indexedPolicies(input, cache) },
      numbers: relevantPages(span, partial),
      label: 'Finding policy evidence…',
    }) };
}

async function reviewText(options: Options, cache: Cache, input: ReviewInput, source?: Policy,
  questionPages?: Options['questionPages'], alwaysPart = false) {
  const series = input.mode === 'guide' ? guideSeries(input, source, cache) : questionSeries(input, source, cache, questionPages);
  const parts = await runSeries(options, cache, { ...series, alwaysPart });
  options.signal.throwIfAborted();
  if (series.guide && parts.at(-1)?.span.end !== series.length) {
    // A final all-whitespace span is resolved locally without sending a request.
    options.onProgress?.({ phase: 'guide', message: 'Reviewing guide obligations…', completed: series.length, total: series.length });
  }
  return merge(input, parts, cache);
}

async function readSource(options: Options, cache: Cache, source: Policy): Promise<Transcript[]> {
  const groups: Transcript[] = [];
  const missingText = source.pages.some(page => !page.text.trim());
  // An entirely indexed questionnaire explicitly requesting PDF reading has no usable prompt index.
  const needsReading = (page: Policy['pages'][number]) => !missingText || !page.text.trim();
  const phaseTotal = source.pages.filter(needsReading).length;
  let phaseOffset = 0;
  for (let start = 0; start < source.pages.length;) {
    const read = needsReading(source.pages[start]);
    let end = start + 1;
    while (end < source.pages.length && needsReading(source.pages[end]) === read) end++;
    const pages = source.pages.slice(start, end);
    if (read) {
      const completed = await runSeries(options, cache, {
        name: 'transcribe-' + start, phase: 'transcribing', phaseOffset, phaseTotal,
        length: pages.length, spans: sourceSpans(pages.length, scanPagesPerPart), alwaysPart: true,
        section: span => ({
          input: { ...options.input, readSourcePdf: true, transcribeSourceOnly: true, documents: [] },
          numbers: pages.slice(span.start, span.end).map(p => p.number),
          label: 'Transcribing scanned pages…',
        }),
      });
      phaseOffset += pages.length;
      for (const { result } of completed) {
        const rows = result.sourcePages!;
        groups.push({ pages: rows, questions: locateQuestions(rows, result.questions ?? []) });
      }
    } else {
      groups.push({ pages });
    }
    start = end;
  }
  return groups;
}

async function reviewScan(options: Options, cache: Cache, source: Policy): Promise<Result> {
  const { input } = options;
  const count = source.pages.length;
  const numbers = source.pages.map(page => page.number);
  // A short scan can be read, planned and assessed in one call using its original bytes.
  if (count <= scanPagesPerPart && !cache.subdivided.has('scan')) {
    try {
      const result = await send(options, cache, { key: 'scan', numbers,
        input, partial: false, label: 'Reading and reviewing PDF…',
        work: { phase: 'scan', start: 0, end: count, total: count } });
      return result;
    } catch (error) {
      options.signal.throwIfAborted();
      if (!(error instanceof ReviewSizeError)) throw error;
    }
    cache.subdivided.add('scan');
  }
  const groups = await readSource(options, cache, source);
  const pages = groups.flatMap(group => group.pages);
  const textInput = { ...input, readSourcePdf: false };
  let questions: PdfQuestion[] | undefined;
  if (input.mode === 'guide') {
    textInput.guide = pages.map(page => page.text).join('\n\n');
    if (!textInput.guide.trim()) throw Error('No readable source text was found in the PDF.');
  } else {
    questions = combineScanQuestions(groups, questionsFromPdfPages(pages));
    if (!questions.length) throw Error('No questionnaire prompts were found in the PDF.');
    textInput.questions = questions.map(question => question.text);
  }
  const result = await reviewText(options, cache, textInput, { ...source, pages }, questions?.map(q => q.pageNumbers), true);
  const transcriptionNotice = 'Check machine-transcribed text and quotations against the original PDF pages.';
  const notice = result.notice.includes(transcriptionNotice) ? result.notice : [result.notice, transcriptionNotice].filter(Boolean).join(' ');
  return { ...result, sourcePages: pages, notice };
}

export async function executeWholeReview(options: Options): Promise<Result> {
  const { input, sourceDocument } = options;
  options.signal.throwIfAborted();
  const cache = checkpoint(options);
  let result: Result;
  if (input.readSourcePdf) {
    if (!sourceDocument?.pdfFile) throw Error('Attach the original PDF to read its pages.');
    result = await reviewScan(options, cache, sourceDocument);
  } else {
    result = await reviewText(options, cache, input, sourceDocument, options.questionPages);
  }
  options.signal.throwIfAborted();
  if (retries.get(input) === cache) retries.delete(input);
  return result;
}
