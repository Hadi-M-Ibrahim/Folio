import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { ArrowLeft, ArrowRight, Check, FolderOpen, LoaderCircle } from 'lucide-react';
import { checkInput, checkPolicies, isLoopback } from '../review/client';
import { documentErrorMessage, readDocument } from '../review/files';
import {
  MAX_POLICY_DOCUMENTS, readScope,
  type Mode, type Policy, type ReviewInput, type Scope,
} from '../review/model';
import { emptyPolicyDraft, pastedPolicy, PolicyFields } from './PolicyFields';
import { questionsFromText } from './intakeQuestions';
import { SourceFields, sourceFromDocument, type IntakeSource } from './SourceFields';
import { preparedGuide, preparedSelection, questionnaireRange } from './SourceRange';
import { needsPolicyFile, prepareReview, type IntakePolicy } from './intakeReview';
import type { ReviewJob } from '../review/reviewJob';
import { ReviewProgress } from './ReviewProgress';
import { useIntakeReview } from './useIntakeReview';
import './intake.css';

type SetupProps = {
  initialMode: Mode;
  sourceStep: boolean;
  onClose: () => void;
  onSubmit: (job: ReviewJob) => void;
};

const intakeCopy = {
  guide: {
    sourceLabel: 'Regulatory guide',
    sourceTitle: 'Review a new policy guide',
    sourceIntro: 'Upload or paste the guide to compare it with your policies.',
    policyIntro: 'Upload the existing policy files you want to compare with the new guide.',
    next: 'Continue to guide',
    submit: 'Review obligations',
  },
  questionnaire: {
    sourceLabel: 'State questions',
    sourceTitle: 'Answer a questionnaire',
    sourceIntro: 'Upload the state questionnaire or enter the questions you need to answer.',
    policyIntro: 'Add the existing policies you want to search for answers.',
    next: 'Continue to questions',
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

function sourceQuestions(source: IntakeSource, mode: Mode): string[] {
  return source.questions ?? (mode === 'guide' || source.readSourcePdf ? [] : questionsFromText(source.text));
}

type PolicyRanges = Record<string, Policy['pages']>;
function selectedPolicies(originals: Policy[], ranges: PolicyRanges): Policy[] {
  return originals.map((doc) => Object.hasOwn(ranges, doc.id) ? { ...doc, pages: ranges[doc.id] } : doc);
}

function IntakeSteps({ step, sourceLabel, busy, sourceUnlocked, onSelect }: {
  step: number; sourceLabel: string;
  busy: boolean; sourceUnlocked: boolean; onSelect: (step: number) => void;
}) {
  return (
    <nav aria-label="Review steps">
      <ol className="intake-steps">
        {['Existing policies', sourceLabel].map((label, index) => (
          <li key={label} data-complete={index + 1 < step}>
            <button type="button" className="intake-step-control" aria-current={step === index + 1 ? 'step' : undefined}
              disabled={busy || (index === 1 && !sourceUnlocked)} onClick={() => onSelect(index + 1)}>
              <span className="intake-step-number" aria-hidden="true">
                {index + 1 < step ? <Check size={12} /> : index + 1}
              </span>
              <span className="intake-step-text">{label}</span>
            </button>
          </li>
        ))}
      </ol>
    </nav>
  );
}

function IntakeActions({ busy, ready, submitLabel, view, onCancel }: {
  busy: string; ready: boolean; submitLabel: string;
  view: ReturnType<typeof useIntakeReview>['view']; onCancel: () => void;
}) {
  return (
    <div className="intake-actions">
      <div className="intake-review-status">
        {view.kind === 'running' && <ReviewProgress progress={view.progress} />}
        {view.kind === 'changed' && ready && <output className="intake-changed">Inputs changed. Choose {submitLabel} to review this version.</output>}
      </div>
      {view.kind === 'running' && <a className="intake-all-reviews" href="#review-options">All reviews</a>}
      {view.kind === 'running'
        ? <button key="cancel" type="button" className="intake-secondary" onClick={event => {
          event.preventDefault();
          onCancel();
        }}>Cancel review</button>
        : <button key="submit" type="submit" className="intake-primary" disabled={Boolean(busy) || !ready}>
          <span>{busy || submitLabel}</span>
          {busy ? <LoaderCircle size={16} className="intake-spinner" aria-hidden="true" /> : <ArrowRight size={16} aria-hidden="true" />}
        </button>}
    </div>
  );
}

function useFileRead(sourceStep: boolean) {
  const page = useMemo(() => ({ sourceStep }), [sourceStep]);
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

export function Setup({ initialMode, sourceStep, onClose, onSubmit }: SetupProps) {
  const [mode, setMode] = useState(initialMode);
  const [source, setSource] = useState<IntakeSource>({ text: '', name: '' });
  const [originalDocuments, setOriginalDocuments] = useState<IntakePolicy[]>([]);
  const [policyRanges, setPolicyRanges] = useState<PolicyRanges>({});
  const documents = useMemo(() => selectedPolicies(originalDocuments, policyRanges), [originalDocuments, policyRanges]);
  const [scope, setScope] = useState<Scope>();
  const [draft, setDraft] = useState(emptyPolicyDraft);
  const [lastError, setLastError] = useState({ step: 1, message: '' });
  const fileRead = useFileRead(sourceStep);
  const { busy } = fileRead;
  const heading = useRef<HTMLHeadingElement>(null);
  const alert = useRef<HTMLParagraphElement>(null);
  const review = useIntakeReview(sourceStep, onSubmit, cause => setLastError({ step: 2, message: documentErrorMessage(cause) }));
  const isGuide = mode === 'guide';
  const needsUpload = needsPolicyFile(mode, originalDocuments);
  const copy = intakeCopy[mode];
  const questions = useMemo(() => sourceQuestions(source, mode), [source, mode]);
  const hasPolicyDraft = Boolean(draft.title.trim() || draft.text.trim());
  const canContinue = !needsUpload && (documents.length > 0 || Boolean(draft.text.trim()));
  const sourceReady = Boolean(source.readSourcePdf || (isGuide ? source.text.trim() : questions.length));
  const policyPath = '#/new/' + initialMode;
  const step = sourceStep && canContinue && !hasPolicyDraft ? 2 : 1;
  const page = step === 1
    ? { label: 'Existing policies', title: 'Add existing policies', intro: copy.policyIntro, action: copy.next, ready: canContinue }
    : { label: copy.sourceLabel, title: copy.sourceTitle, intro: copy.sourceIntro, action: copy.submit, ready: sourceReady };
  const error = step === 2 && review.failure ? documentErrorMessage(review.failure.error) : lastError.step === step ? lastError.message : '';

  function setError(message: string) {
    setLastError({ step, message });
  }

  useEffect(() => {
    if (sourceStep && step === 1) window.location.replace(policyPath);
  }, [sourceStep, step, policyPath]);
  useEffect(() => {
    heading.current?.focus({ preventScroll: true });
    window.scrollTo(0, 0);
  }, [step, mode]);
  useEffect(() => {
    if (error) alert.current?.focus();
  }, [error]);

  const snapshot = { mode, source, questions, documents, originals: originalDocuments, scope };

  function acceptAddedPolicies(added: IntakePolicy[], fromDraft = false) {
    const next = [...originalDocuments, ...added];
    if (next.length > MAX_POLICY_DOCUMENTS) throw Error('Choose up to 18 policy documents.');
    const selected = selectedPolicies(next, policyRanges);
    try {
      checkPolicies(selected);
    } catch (cause) {
      if (!added.some((doc) => doc.pdfFile)) throw cause;
      setError(documentErrorMessage(cause) + ' Open a PDF policy preview to choose the pages to review.');
    }
    setOriginalDocuments(next);
    setScope(undefined);
    if (fromDraft) setDraft(emptyPolicyDraft);
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
        review.start(() => prepareReview({ ...snapshot, source: next, questions: sourceQuestions(next, mode) }), true);
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
      checkPolicies(selectedPolicies(originalDocuments, ranges));
      setError('');
    } catch (cause) {
      setError(documentErrorMessage(cause));
    }
  }

  function selectStep(target: number) {
    if (busy || target === step) return;
    setError('');
    if (target === 2) {
      if (!canContinue) return;
      try {
        if (hasPolicyDraft) {
          acceptAddedPolicies([{ ...pastedPolicy(draft, documents.length + 1), pasted: true }], true);
        } else {
          checkPolicies(documents);
        }
      } catch (cause) {
        setError(documentErrorMessage(cause));
        return;
      }
      window.history.pushState({ folioPolicies: policyPath }, '', policyPath + '/source');
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    } else if (window.history.state?.folioPolicies === policyPath) {
      window.history.back();
    } else {
      window.location.replace(policyPath);
    }
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (step === 1) return selectStep(2);
    if (busy || !sourceReady) return;
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
        <IntakeSteps step={step} sourceLabel={copy.sourceLabel} busy={Boolean(busy)} sourceUnlocked={canContinue} onSelect={selectStep} />
        <div className="intake-sheet">
          <h1 id="intake-title" ref={heading} tabIndex={-1}>
            {page.title}
          </h1>
          <p className="intake-intro" id="intake-intro">
            {page.intro}
          </p>
          <form onSubmit={submit}>
            <fieldset disabled={Boolean(busy)} className="intake-fields">
              <legend className="intake-sr-only">{page.label}</legend>
              {step === 1 ? <>
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
                {scope && <output className="intake-help">This review searches {scope.selectedPages.toLocaleString()} selected {scope.selectedPages === 1 ? 'page' : 'pages'} from {scope.sourcePages.toLocaleString()} source pages.</output>}
                {isLoopback && (
                  <label className="intake-bundle">
                    <FolderOpen size={15} aria-hidden="true" /> Import a prepared review (.json)
                    <input type="file" accept=".json" aria-describedby="intake-intro" onChange={event => {
                      const file = event.currentTarget.files?.[0];
                      event.currentTarget.value = '';
                      if (file) void importFiles([file], 'bundle');
                    }} />
                  </label>
                )}
              </> : <>
                <SourceFields
                  isGuide={isGuide}
                  source={source}
                  questions={questions}
                  onFiles={files => importFiles(files, 'source')}
                  onFinishText={() => { if (sourceReady) review.start(() => prepareReview(snapshot), true); }}
                  onEditRange={review.edit}
                  onChange={updateSource}
                />
                {source.selection && <output className="intake-selection">{source.selection}</output>}
              </>}
            </fieldset>
            {error && <p ref={alert} className="intake-error" role="alert" tabIndex={-1}>{error}</p>}
            <IntakeActions busy={busy} ready={page.ready}
              submitLabel={page.action} view={review.view} onCancel={review.cancel} />
            {busy && <output className="intake-sr-only">{busy}</output>}
          </form>
        </div>
      </div>
    </section>
  );
}
