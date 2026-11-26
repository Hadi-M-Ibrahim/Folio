import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { ArrowLeft, ArrowRight, Check, LoaderCircle } from 'lucide-react';
import { checkInput, encodeRequest, isLoopback } from '../review/client';
import { documentErrorMessage, readDocument } from '../review/files';
import { makePdfAttachment } from '../review/pdf';
import { executeWholeReview } from '../review/wholeReview';
import {
  MAX_PDF_ATTACHMENT_PAGES, MAX_POLICY_DOCUMENTS, MAX_REQUEST_BYTES, ReviewSizeError, modeLabels, readScope,
  type Mode, type PdfAttachment, type Policy, type Review, type ReviewInput, type Scope,
} from '../review/model';
import { emptyPolicyDraft, pastedPolicy, PolicyFields } from './PolicyFields';
import { questionsFromText } from './intakeQuestions';
import { SourceFields, sourceFromDocument, type IntakeSource } from './SourceFields';
import { preparedGuide, preparedSelection, questionnaireRange } from './SourceRange';
import './intake.css';

type SetupProps = {
  initialMode: Mode;
  policyStep: boolean;
  onClose: () => void;
  onDone: (review: Review) => void;
};

const intakeCopy = {
  guide: {
    sourceLabel: 'Regulatory guide',
    sourceTitle: 'Review a new policy guide',
    sourceIntro: 'Start with the regulatory guide or the section you want to review.',
    policyIntro: 'Add policies to compare with the guide, or review its obligations on their own.',
    submit: 'Review obligations',
    submitting: 'Reviewing obligations…',
  },
  questionnaire: {
    sourceLabel: 'State questions',
    sourceTitle: 'Answer a questionnaire',
    sourceIntro: 'Start with the state questionnaire or a single question you need to answer.',
    policyIntro: 'Add at least one policy. Folio will search it for passages you can cite in your answers.',
    submit: 'Find evidence',
    submitting: 'Finding evidence…',
  },
};

async function readPreparedReview(file: File) {
  if (!isLoopback) throw Error('Open prepared reviews in the local app.');
  if (file.size > 32 * 1024 * 1024) throw Error('Use a prepared review of up to 32 MB.');
  const input: ReviewInput & {
    corpusScope?: unknown;
    sourceDocument?: unknown;
    selection?: { guidePages?: unknown; questionNumbers?: unknown };
  } = JSON.parse(await file.text());
  if (input.readSourcePdf || input.pdfAttachments || (Array.isArray(input.documents) && input.documents.some((doc) => doc?.pdfFile))) {
    throw Error('Upload original PDFs directly. Prepared reviews must contain text.');
  }
  checkInput(input);

  let source: IntakeSource;
  if (input.mode === 'guide') {
    const text = input.guide!;
    const pages = input.selection?.guidePages;
    const document = preparedGuide(input.sourceDocument, text, pages);
    const selection = preparedSelection(pages, 'page');
    source = {
      text,
      name: document && input.sourceDocument ? document.title : '',
      document,
      selection,
      range: document && document.pages.length > 1 ? { unit: 'page', items: document.pages, original: document, originalSelection: selection } : undefined,
    };
  } else {
    const questions = input.questions!;
    source = {
      text: questions.map((question) => question.replace(/\s+/g, ' ')).join('\n'),
      name: '',
      questions,
      range: questionnaireRange(questions, undefined, input.selection?.questionNumbers),
      selection: preparedSelection(input.selection?.questionNumbers, 'question'),
    };
  }
  return { mode: input.mode, documents: input.documents, scope: readScope(input.corpusScope), source };
}

function sourceError(mode: Mode, source: IntakeSource, questions: string[]): string {
  if (source.readSourcePdf && source.document?.pdfFile) return '';
  if (mode === 'guide' && !source.text.trim()) return 'Upload or paste your regulatory guide.';
  if (mode === 'questionnaire' && !questions.length) return 'Upload or enter at least one state question.';
  return '';
}

type PolicyRanges = Record<string, Policy['pages']>;
function selectedPolicies(originals: Policy[], ranges: PolicyRanges): Policy[] {
  return originals.map((doc) => Object.hasOwn(ranges, doc.id) ? { ...doc, pages: ranges[doc.id] } : doc);
}

function sharingDisclosure(mode: Mode, source: IntakeSource, documents: Policy[]) {
  const subject = mode === 'guide' ? 'guide' : 'questions';
  if (source.document?.pdfFile || documents.some((doc) => doc.pdfFile)) {
    const focus = source.document?.pdfFile && source.range?.unit === 'question' && source.selection
      ? ' Folio reviews only the selected questions.' : '';
    return 'Submitting sends the original PDFs or selected PDF pages to Anthropic, along with available text from your ' +
      subject + ' and relevant policy passages.' + focus;
  }
  return 'Submitting sends your ' + subject + ' and relevant policy text to Anthropic.';
}

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

export function Setup({ initialMode, policyStep, onClose, onDone }: SetupProps) {
  const [mode, setMode] = useState(initialMode);
  const [source, setSource] = useState<IntakeSource>({ text: '', name: '' });
  const [originalDocuments, setOriginalDocuments] = useState<Policy[]>([]);
  const [policyRanges, setPolicyRanges] = useState<PolicyRanges>({});
  const documents = useMemo(() => selectedPolicies(originalDocuments, policyRanges), [originalDocuments, policyRanges]);
  const [scope, setScope] = useState<Scope>();
  const [draft, setDraft] = useState(emptyPolicyDraft);
  const [lastError, setLastError] = useState({ step: 1, message: '' });
  const [busy, setBusy] = useState('');
  const heading = useRef<HTMLHeadingElement>(null);
  const alert = useRef<HTMLParagraphElement>(null);
  const [request, setRequest] = useState<AbortController | null>(null);
  const retry = useRef<{ input: ReviewInput; scope?: Scope; policyAttachments?: PdfAttachment[] } | null>(null);
  const isGuide = mode === 'guide';
  const copy = intakeCopy[mode];
  const questions = useMemo(() => source.questions ?? (isGuide || source.readSourcePdf ? [] : questionsFromText(source.text)),
    [source.questions, source.readSourcePdf, source.text, isGuide]);
  const sourcePath = '#/new/' + initialMode;
  const validationError = sourceError(mode, source, questions);
  const step = policyStep && !validationError ? 2 : 1;
  const error = lastError.step === step ? lastError.message : '';

  function setError(message: string) {
    setLastError({ step, message });
  }

  useEffect(() => () => request?.abort(), [request]);
  useEffect(() => {
    retry.current = null;
  }, [source.text, source.document, source.range, source.questionPages, source.readSourcePdf, source.selection,
    questions, documents, mode, scope, draft.text, draft.title]);
  useEffect(() => {
    if (policyStep && step === 1) window.location.replace(sourcePath);
  }, [policyStep, step, sourcePath]);
  useEffect(() => {
    if (step === 1) request?.abort();
  }, [step, request]);
  useEffect(() => {
    heading.current?.focus({ preventScroll: true });
    window.scrollTo(0, 0);
  }, [step, mode]);
  useEffect(() => {
    if (error) alert.current?.focus();
  }, [error]);

  function inputWith(policies: Policy[]): ReviewInput {
    return {
      mode,
      documents: policies,
      ...(source.readSourcePdf ? { readSourcePdf: true } : isGuide ? { guide: source.text.trim() } : { questions }),
    };
  }

  function acceptAddedPolicies(added: Policy[]) {
    const next = [...originalDocuments, ...added];
    if (next.length > MAX_POLICY_DOCUMENTS) throw Error('Choose up to 18 policy documents.');
    const selected = selectedPolicies(next, policyRanges);
    try {
      checkInput(inputWith(selected));
    } catch (cause) {
      if (!added.some((doc) => doc.pdfFile)) throw cause;
      setError(documentErrorMessage(cause) + ' Open a PDF policy preview to choose the pages to review.');
    }
    setOriginalDocuments(next);
    setScope(undefined);
  }

  async function importFiles(files: File[], kind: 'source' | 'policies' | 'bundle') {
    setError('');
    setBusy('Reading ' + (files.length > 1 ? 'files…' : 'file…'));
    try {
      if (kind === 'bundle') {
        const prepared = await readPreparedReview(files[0]);
        setMode(prepared.mode);
        setSource(prepared.source);
        setOriginalDocuments(prepared.documents);
        setPolicyRanges({});
        setScope(prepared.scope);
        setDraft(emptyPolicyDraft);
      } else if (kind === 'source') {
        if (files.length > 1) throw Error('Choose one source file for this review.');
        setSource(sourceFromDocument(await readDocument(files[0]), isGuide));
      } else {
        if (files.length + documents.length > MAX_POLICY_DOCUMENTS) throw Error('Choose up to 18 policy documents.');
        const added: Policy[] = [];
        for (const file of files) {
          // A PDF's full local index may exceed review limits. Its page scope can be narrowed after opening it.
          const existing = /\.pdf$/i.test(file.name) ? undefined : [...documents, ...added].filter((doc) => !doc.pdfFile);
          added.push(await readDocument(file, existing));
        }
        acceptAddedPolicies(added);
      }
    } catch (cause) {
      setError(documentErrorMessage(cause));
    } finally {
      setBusy('');
    }
  }

  function removePolicy(id: string) {
    const next = documents.filter((doc) => doc.id !== id);
    setOriginalDocuments(originalDocuments.filter((doc) => doc.id !== id));
    setPolicyRanges((current) => {
      const nextRanges = { ...current };
      delete nextRanges[id];
      return nextRanges;
    });
    if (scope) {
      setScope({
        ...scope,
        selectedDocuments: next.length,
        selectedPages: next.reduce((count, doc) => count + doc.pages.length, 0),
      });
    }
  }

  function selectPolicyPages(id: string, pages: Policy['pages']) {
    const ranges = { ...policyRanges, [id]: pages };
    setPolicyRanges(ranges);
    try {
      checkInput(inputWith(selectedPolicies(originalDocuments, ranges)));
      setError('');
    } catch (cause) {
      setError(documentErrorMessage(cause));
    }
  }

  function submission() {
    if (!retry.current) {
      const includeDraft = Boolean(draft.text.trim() || draft.title.trim());
      const policies = includeDraft ? [...documents, pastedPolicy(draft, documents.length + 1)] : documents;
      if (!policies.length && !isGuide) throw Error('Upload a policy file or paste a policy to continue.');
      const input = { ...inputWith(policies), allowModel: true, modelSharingConsent: true };
      checkInput(input);
      retry.current = { input, scope: includeDraft ? undefined : scope };
    }
    return retry.current;
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setError('');
    try {
      if (step === 1) {
        if (validationError) throw Error(validationError);
        window.history.pushState({ folioIntakeSource: sourcePath }, '', sourcePath + '/policies');
        window.dispatchEvent(new HashChangeEvent('hashchange'));
        return;
      }

      const attempt = submission();
      const { input } = attempt;
      const controller = new AbortController();
      setRequest(controller);
      setBusy(copy.submitting);
      attempt.policyAttachments ??= await attachPolicies(input, originalDocuments, Boolean(source.document?.pdfFile), controller.signal);
      controller.signal.throwIfAborted();
      const result = await executeWholeReview({
        input,
        sourceDocument: source.document,
        sourceOriginal: source.range?.original ?? source.document,
        questionPages: source.questionPages,
        renderItemSubset: source.range?.unit === 'question' && Boolean(source.selection),
        policyAttachments: attempt.policyAttachments,
        signal: controller.signal,
        onProgress: setBusy,
      });
      if (!controller.signal.aborted) {
        onDone({
          key: crypto.randomUUID(),
          title: source.name.replace(/\.[^.]+$/, '').replace(/_/g, ' ').trim() || modeLabels[mode] + ' review',
          input: {
            ...input,
            ...(result.guide !== undefined && { guide: result.guide }),
            ...(result.questions && { questions: result.questions }),
            documents: input.documents.map((doc) => withReturnedPages(doc, result.policyPageText?.find((record) => record.documentId === doc.id)?.pages)),
          },
          result,
          sourceDocument: source.document && withReturnedPages(source.document, result.sourcePages),
          sourceSelection: source.selection,
          scope: attempt.scope,
        });
      }
    } catch (cause) {
      if (!(cause instanceof Error && cause.name === 'AbortError')) setError(documentErrorMessage(cause));
    } finally {
      setRequest(null);
      setBusy('');
    }
  }

  return (
    <section className="intake" aria-labelledby="intake-title">
      <button
        className="intake-back"
        type="button"
        disabled={Boolean(busy)}
        onClick={() => {
          setError('');
          if (step === 1) onClose();
          else if (window.history.state?.folioIntakeSource === sourcePath) window.history.back();
          else window.location.replace(sourcePath);
        }}
      >
        <ArrowLeft size={15} aria-hidden="true" /> Back
      </button>
      <div className="intake-layout">
        <ol className="intake-steps" aria-label="Review steps">
          {[copy.sourceLabel, 'Existing policies'].map((label, index) => (
            <li key={label} aria-current={step === index + 1 ? 'step' : undefined} data-complete={index + 1 < step}>
              <span className="intake-step-number" aria-hidden="true">
                {index + 1 < step ? <Check size={12} /> : index + 1}
              </span>
              <span className="intake-step-text">
                {label}
                {index === 0 && step === 2 && <small>{source.name || (isGuide ? 'Guide text' : questions.length + (questions.length === 1 ? ' question' : ' questions'))}</small>}
                {index === 1 && <small>{isGuide ? 'Optional' : 'Required'}</small>}
              </span>
            </li>
          ))}
        </ol>
        <div className="intake-sheet">
          <h1 id="intake-title" ref={heading} tabIndex={-1}>
            {step === 1 ? copy.sourceTitle : 'Add existing policies'}
          </h1>
          <p className="intake-intro">
            {step === 1 ? copy.sourceIntro : copy.policyIntro}
          </p>
          <form onSubmit={(event) => void submit(event)}>
            <fieldset disabled={Boolean(busy)} className="intake-fields">
              <legend className="intake-sr-only">{step === 1 ? copy.sourceLabel : 'Existing policies'}</legend>
              {step === 1 ? (
                <SourceFields
                  isGuide={isGuide}
                  source={source}
                  questions={questions}
                  onFiles={importFiles}
                  onChange={(value) => { setSource(value); setError(''); }}
                />
              ) : (
                <PolicyFields
                  documents={documents}
                  originalDocuments={originalDocuments}
                  draft={draft}
                  onDraft={setDraft}
                  onFiles={(files) => void importFiles(files, 'policies')}
                  onAdd={(policy) => acceptAddedPolicies([policy])}
                  onRange={selectPolicyPages}
                  onRemove={removePolicy}
                  onError={setError}
                />
              )}
              {source.selection && <output className="intake-selection">{source.selection}</output>}
              {scope && step === 2 && (
                <output className="intake-help">This review searches {scope.selectedPages.toLocaleString()} selected {scope.selectedPages === 1 ? 'page' : 'pages'} from {scope.sourcePages.toLocaleString()} source pages.</output>
              )}
            </fieldset>
            {error && <p ref={alert} className="intake-error" role="alert" tabIndex={-1}>{error}</p>}
            <div className="intake-actions">
              {request ? <>
                <output className="intake-progress"><LoaderCircle size={16} className="intake-spinner" aria-hidden="true" />{busy}</output>
                <button key="cancel" type="button" className="intake-secondary" onClick={event => {
                  event.preventDefault();
                  request.abort();
                }}>Cancel review</button>
              </> : <>
                {step === 2 && <p className="intake-disclosure" id="intake-sharing">
                  {sharingDisclosure(mode, source, documents)}
                </p>}
                <button type="submit" className="intake-primary" disabled={Boolean(busy)} aria-describedby={step === 2 ? 'intake-sharing' : undefined}>
                  <span>{busy || (step === 1 ? 'Continue to policies' : copy.submit)}</span>
                  {busy ? <LoaderCircle size={16} className="intake-spinner" aria-hidden="true" /> : <ArrowRight size={16} aria-hidden="true" />}
                </button>
              </>}
            </div>
            {!request && <output className="intake-sr-only">{busy}</output>}
          </form>
        </div>
      </div>
    </section>
  );
}
