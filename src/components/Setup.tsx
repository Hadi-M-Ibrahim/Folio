import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { ArrowLeft, ArrowRight, Check, LoaderCircle } from 'lucide-react';
import { checkInput, guidePolicyRequired, isLoopback } from '../review/client';
import { documentErrorMessage, readDocument } from '../review/files';
import {
  MAX_POLICY_DOCUMENTS, readScope,
  type Mode, type Policy, type Review, type ReviewInput, type Scope,
} from '../review/model';
import { emptyPolicyDraft, PolicyFields } from './PolicyFields';
import { questionsFromText } from './intakeQuestions';
import { SourceFields, sourceFromDocument, type IntakeSource } from './SourceFields';
import { preparedGuide, preparedSelection, questionnaireRange } from './SourceRange';
import { needsPolicyFile, prepareReview, reviewInput, type IntakePolicy } from './intakeReview';
import { ReviewProgress } from './ReviewProgress';
import { useIntakeReview } from './useIntakeReview';
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
    sourceIntro: 'Upload or paste the guide. On the next step, add an existing policy file to compare.',
    policyIntro: 'Upload an existing policy file to start comparing it with the guide.',
    submit: 'Review obligations',
  },
  questionnaire: {
    sourceLabel: 'State questions',
    sourceTitle: 'Answer a questionnaire',
    sourceIntro: 'Start with the state questionnaire or a single question you need to answer.',
    policyIntro: 'Add your first policy to start finding evidence for the state’s questions.',
    submit: 'Find evidence',
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
  checkInput(input, { allowGuideDraft: true });

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

function IntakeSteps({ step, sourceLabel, sourceDescription, busy, policiesUnlocked, onSelect }: {
  step: number; sourceLabel: string; sourceDescription: string;
  busy: boolean; policiesUnlocked: boolean; onSelect: (step: number) => void;
}) {
  return (
    <nav aria-label="Review steps">
      <ol className="intake-steps">
        {[sourceLabel, 'Existing policies'].map((label, index) => (
          <li key={label} data-complete={index + 1 < step}>
            <button type="button" className="intake-step-control" aria-current={step === index + 1 ? 'step' : undefined}
              disabled={busy || (index === 1 && !policiesUnlocked)} onClick={() => onSelect(index + 1)}>
              <span className="intake-step-number" aria-hidden="true">
                {index + 1 < step ? <Check size={12} /> : index + 1}
              </span>
              <span className="intake-step-text">
                {label}
                {index === 0 && step === 2 && <small>{sourceDescription}</small>}
                {index === 1 && <small>Required</small>}
              </span>
            </button>
          </li>
        ))}
      </ol>
    </nav>
  );
}

function IntakeActions({ step, busy, needsUpload, submitLabel, view, onCancel }: {
  step: number; busy: string; needsUpload: boolean; submitLabel: string;
  view: ReturnType<typeof useIntakeReview>['view']; onCancel: () => void;
}) {
  return (
    <div className="intake-actions">
      <div className="intake-review-status">
        {view.kind === 'running' && <ReviewProgress progress={view.progress} />}
        {view.kind === 'changed' && step === 2 && !needsUpload && <output className="intake-changed">Inputs changed. Choose {submitLabel} to review this version.</output>}
      </div>
      {view.kind === 'running'
        ? <button key="cancel" type="button" className="intake-secondary" onClick={event => {
          event.preventDefault();
          onCancel();
        }}>Cancel review</button>
        : <button key="submit" type="submit" className="intake-primary" disabled={Boolean(busy) || needsUpload}>
          <span>{busy || (step === 1 ? 'Continue to policies' : submitLabel)}</span>
          {busy ? <LoaderCircle size={16} className="intake-spinner" aria-hidden="true" /> : <ArrowRight size={16} aria-hidden="true" />}
        </button>}
    </div>
  );
}

function introText(mode: Mode, step: number, hasPolicies: boolean, needsUpload: boolean) {
  const copy = intakeCopy[mode];
  if (step === 1) return copy.sourceIntro;
  if (!hasPolicies) return copy.policyIntro;
  if (mode === 'questionnaire') return 'Choose the policies to search for evidence.';
  return needsUpload ? guidePolicyRequired : 'Add any other policies that apply to this guide.';
}

function useFileRead(policyStep: boolean) {
  const page = useMemo(() => ({ policyStep }), [policyStep]);
  const sequence = useRef({ version: 0 });
  const [reading, setReading] = useState<{ page: typeof page; message: string }>();
  useEffect(() => {
    const pending = sequence.current;
    return () => { pending.version++; };
  }, [page]);
  function begin(count: number) {
    const version = ++sequence.current.version;
    setReading({ page, message: count === 1 ? 'Reading file…' : 'Reading files…' });
    return () => sequence.current.version === version;
  }
  return { busy: reading?.page === page ? reading.message : '', begin, finish: () => setReading(undefined) };
}

export function Setup({ initialMode, policyStep, onClose, onDone }: SetupProps) {
  const [mode, setMode] = useState(initialMode);
  const [source, setSource] = useState<IntakeSource>({ text: '', name: '' });
  const [originalDocuments, setOriginalDocuments] = useState<IntakePolicy[]>([]);
  const [policyRanges, setPolicyRanges] = useState<PolicyRanges>({});
  const documents = useMemo(() => selectedPolicies(originalDocuments, policyRanges), [originalDocuments, policyRanges]);
  const [scope, setScope] = useState<Scope>();
  const [draft, setDraft] = useState(emptyPolicyDraft);
  const [lastError, setLastError] = useState({ step: 1, message: '' });
  const fileRead = useFileRead(policyStep);
  const { busy } = fileRead;
  const heading = useRef<HTMLHeadingElement>(null);
  const alert = useRef<HTMLParagraphElement>(null);
  const review = useIntakeReview(policyStep, onDone, cause => setLastError({ step: 2, message: documentErrorMessage(cause) }));
  const isGuide = mode === 'guide';
  const needsUpload = needsPolicyFile(mode, originalDocuments);
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

  useEffect(() => {
    if (policyStep && step === 1) window.location.replace(sourcePath);
  }, [policyStep, step, sourcePath]);
  useEffect(() => {
    heading.current?.focus({ preventScroll: true });
    window.scrollTo(0, 0);
  }, [step, mode]);
  useEffect(() => {
    if (error) alert.current?.focus();
  }, [error]);

  const snapshot = { mode, source, questions, documents, originals: originalDocuments, draft, scope };

  function acceptAddedPolicies(added: IntakePolicy[], fromDraft = false) {
    const next = [...originalDocuments, ...added];
    if (next.length > MAX_POLICY_DOCUMENTS) throw Error('Choose up to 18 policy documents.');
    const selected = selectedPolicies(next, policyRanges);
    try {
      checkInput(reviewInput(mode, source, questions, selected));
    } catch (cause) {
      if (!added.some((doc) => doc.pdfFile)) throw cause;
      setError(documentErrorMessage(cause) + ' Open a PDF policy preview to choose the pages to review.');
    }
    setOriginalDocuments(next);
    setScope(undefined);
    if (fromDraft) setDraft(emptyPolicyDraft);
    if ((!fromDraft || source.document?.pdfFile) && (fromDraft || !draft.text.trim() && !draft.title.trim())) {
      review.start(() => prepareReview({ ...snapshot, documents: selected, originals: next, draft: emptyPolicyDraft, scope: undefined }), true);
    }
  }

  async function importFiles(files: File[], kind: 'source' | 'policies' | 'bundle') {
    const isCurrent = fileRead.begin(files.length);
    review.edit();
    setError('');
    try {
      if (kind === 'bundle') {
        const prepared = await readPreparedReview(files[0]);
        if (!isCurrent()) return false;
        setMode(prepared.mode);
        setSource(prepared.source);
        setOriginalDocuments(prepared.documents);
        setPolicyRanges({});
        setScope(prepared.scope);
        setDraft(emptyPolicyDraft);
      } else if (kind === 'source') {
        if (files.length > 1) throw Error('Choose one source file for this review.');
        const doc = await readDocument(files[0]);
        if (!isCurrent()) return false;
        const next = sourceFromDocument(doc, isGuide);
        setSource(next);
        if (doc.pdfFile && documents.length > 0) {
          review.start(() => prepareReview({ ...snapshot, source: next, questions: next.questions ?? [] }), true);
        }
      } else {
        if (files.length + documents.length > MAX_POLICY_DOCUMENTS) throw Error('Choose up to 18 policy documents.');
        const added: Policy[] = [];
        for (const file of files) {
          // A PDF's full local index may exceed review limits. Its page scope can be narrowed after opening it.
          const existing = /\.pdf$/i.test(file.name) ? undefined : [...documents, ...added].filter((doc) => !doc.pdfFile);
          added.push(await readDocument(file, existing));
          if (!isCurrent()) return false;
        }
        acceptAddedPolicies(added);
      }
      return true;
    } catch (cause) {
      if (isCurrent()) setError(documentErrorMessage(cause));
      return false;
    } finally {
      if (isCurrent()) fileRead.finish();
    }
  }

  function removePolicy(id: string) {
    review.edit();
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
    review.edit();
    const ranges = { ...policyRanges, [id]: pages };
    setPolicyRanges(ranges);
    try {
      checkInput(reviewInput(mode, source, questions, selectedPolicies(originalDocuments, ranges)));
      setError('');
    } catch (cause) {
      setError(documentErrorMessage(cause));
    }
  }

  function selectStep(target: number) {
    if (busy || target === step) return;
    setError('');
    if (target === 2) {
      if (validationError) { setError(validationError); return; }
      window.history.pushState({ folioIntakeSource: sourcePath }, '', sourcePath + '/policies');
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    } else if (window.history.state?.folioIntakeSource === sourcePath) {
      window.history.back();
    } else {
      window.location.replace(sourcePath);
    }
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (step === 1) return selectStep(2);
    if (busy) return;
    setError('');
    review.start(() => prepareReview(snapshot));
  }

  function updateSource(next: IntakeSource) {
    if (next.text !== source.text || next.document !== source.document || next.range !== source.range ||
      next.selection !== source.selection || next.name !== source.name) review.edit();
    setSource(next);
    setError('');
  }

  return (
    <section className="intake" aria-labelledby="intake-title">
      <button
        className="intake-back"
        type="button"
        disabled={Boolean(busy)}
        onClick={() => step === 1 ? onClose() : selectStep(1)}
      >
        <ArrowLeft size={15} aria-hidden="true" /> Back
      </button>
      <div className="intake-layout">
        <IntakeSteps step={step} sourceLabel={copy.sourceLabel}
          busy={Boolean(busy)} policiesUnlocked={!validationError} onSelect={selectStep}
          sourceDescription={source.name || (isGuide ? 'Guide text' : questions.length + (questions.length === 1 ? ' question' : ' questions'))} />
        <div className="intake-sheet">
          <h1 id="intake-title" ref={heading} tabIndex={-1}>
            {step === 1 ? copy.sourceTitle : 'Add existing policies'}
          </h1>
          <p className="intake-intro" id="intake-intro">
            {introText(mode, step, documents.length > 0, needsUpload)}
          </p>
          <form onSubmit={submit}>
            <fieldset disabled={Boolean(busy)} className="intake-fields">
              <legend className="intake-sr-only">{step === 1 ? copy.sourceLabel : 'Existing policies'}</legend>
              {step === 1 ? (
                <SourceFields
                  isGuide={isGuide}
                  source={source}
                  questions={questions}
                  onFiles={importFiles}
                  onEditRange={review.edit}
                  onChange={updateSource}
                />
              ) : (
                <PolicyFields
                  allowPaste={!needsUpload}
                  documents={documents}
                  originalDocuments={originalDocuments}
                  draft={draft}
                  onDraft={next => {
                    if (next.text !== draft.text || next.title !== draft.title) review.edit();
                    setDraft(next);
                  }}
                  onEditRange={review.edit}
                  onFiles={files => importFiles(files, 'policies')}
                  onAdd={policy => { review.edit(); acceptAddedPolicies([{ ...policy, pasted: true }], true); }}
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
            <IntakeActions step={step} busy={busy} needsUpload={step === 2 && needsUpload}
              submitLabel={copy.submit} view={review.view} onCancel={review.cancel} />
            {busy && <output className="intake-sr-only">{busy}</output>}
          </form>
        </div>
      </div>
    </section>
  );
}
