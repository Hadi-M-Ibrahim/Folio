import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { ArrowLeft, ArrowRight, Check, LoaderCircle } from 'lucide-react';
import { checkInput, isLoopback, requestReview } from '../review/client';
import { documentErrorMessage, readDocument } from '../review/files';
import {
  MAX_GUIDE_CHARACTERS, MAX_POLICY_DOCUMENTS, MAX_QUESTION_CHARACTERS,
  MAX_QUESTIONS, MAX_REQUEST_BYTES, modeLabels, readScope, type Mode, type Policy, type Review, type ReviewInput, type Scope,
} from '../review/model';
import { emptyPolicyDraft, pastedPolicy, PolicyFields } from './PolicyFields';
import { SourceFields, type IntakeSource } from './SourceFields';
import { preparedGuide, preparedSelection } from './SourceRange';
import { questionsFromPdf } from './intakeQuestions';
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
    sourceTitle: 'Review a policy guide',
    sourceIntro: 'Upload the regulatory guide or paste the section you want to review.',
    policyIntro: 'Policies are optional. Add them to check coverage, or continue to the guide’s obligations.',
    submit: 'Review obligations',
    submitting: 'Reviewing obligations…',
  },
  questionnaire: {
    sourceLabel: 'State questions',
    sourceTitle: 'Answer a questionnaire',
    sourceIntro: 'Upload the state questionnaire or paste the questions you need to answer.',
    policyIntro: 'Add the policies you want to search for evidence for each question.',
    submit: 'Find evidence',
    submitting: 'Finding evidence…',
  },
};

async function readPreparedReview(file: File) {
  if (!isLoopback) throw Error('Open prepared reviews in the local app.');
  if (file.size > MAX_REQUEST_BYTES) throw Error('Use a prepared review smaller than 4 MB.');
  const input: ReviewInput & {
    corpusScope?: unknown;
    sourceDocument?: unknown;
    selection?: { guidePages?: unknown; questionNumbers?: unknown };
  } = JSON.parse(await file.text());
  checkInput(input);

  let source: IntakeSource;
  if (input.mode === 'guide') {
    const text = input.guide!;
    const pages = input.selection?.guidePages;
    const document = preparedGuide(input.sourceDocument, text, pages);
    source = {
      text,
      name: document && input.sourceDocument ? document.title : '',
      document,
      selection: preparedSelection(pages, 'page'),
    };
  } else {
    const questions = input.questions!;
    source = {
      text: questions.map((question) => question.replace(/\s+/g, ' ')).join('\n'),
      name: '',
      questions,
      selection: preparedSelection(input.selection?.questionNumbers, 'question'),
    };
  }
  return { mode: input.mode, documents: input.documents, scope: readScope(input.corpusScope), source };
}

function sourceError(mode: Mode, text: string, questions: string[]): string {
  if (mode === 'guide') {
    const guide = text.trim();
    if (!guide) return 'Upload or paste your regulatory guide.';
    if (guide.length > MAX_GUIDE_CHARACTERS) return 'Choose a guide section of up to 50,000 characters.';
  } else {
    if (!questions.length) return 'Upload or enter at least one state question.';
    if (questions.length > MAX_QUESTIONS || questions.some((question) => question.length > MAX_QUESTION_CHARACTERS)) {
      return 'Use up to 30 questions, with one question per line and up to 2,000 characters each.';
    }
  }
  return '';
}

export function Setup({ initialMode, policyStep, onClose, onDone }: SetupProps) {
  const [mode, setMode] = useState(initialMode);
  const [source, setSource] = useState<IntakeSource>({ text: '', name: '' });
  const [documents, setDocuments] = useState<Policy[]>([]);
  const [scope, setScope] = useState<Scope>();
  const [draft, setDraft] = useState(emptyPolicyDraft);
  const [allowModel, setAllowModel] = useState(false);
  const [lastError, setLastError] = useState({ step: 1, message: '' });
  const [busy, setBusy] = useState('');
  const heading = useRef<HTMLHeadingElement>(null);
  const alert = useRef<HTMLParagraphElement>(null);
  const request = useRef<AbortController | null>(null);
  const isGuide = mode === 'guide';
  const copy = intakeCopy[mode];
  const questions = useMemo(() => source.questions ?? (isGuide ? [] : source.text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)), [source, isGuide]);
  const sourcePath = '#/new/' + initialMode;
  const validationError = sourceError(mode, source.text, questions);
  const step = policyStep && !validationError ? 2 : 1;
  const error = lastError.step === step ? lastError.message : '';

  function setError(message: string) {
    setLastError({ step, message });
  }

  useEffect(() => () => request.current?.abort(), []);
  useEffect(() => {
    if (policyStep && step === 1) window.location.replace(sourcePath);
  }, [policyStep, step, sourcePath]);
  useEffect(() => {
    if (step === 1) request.current?.abort();
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
      ...(isGuide ? { guide: source.text.trim() } : { questions }),
      allowModel,
      ...(!isLoopback && allowModel ? { modelSharingConsent: true } : {}),
    };
  }

  function acceptAddedPolicies(next: Policy[]) {
    checkInput(inputWith(next));
    setDocuments(next);
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
        setDocuments(prepared.documents);
        setScope(prepared.scope);
        setAllowModel(false);
        setDraft(emptyPolicyDraft);
      } else if (kind === 'source') {
        const file = files[0];
        const doc = await readDocument(file);
        const text = doc.pages.map((page) => page.text).join('\n\n');
        setSource({
          text: !isGuide && /\.pdf$/i.test(file.name) ? questionsFromPdf(text) : text,
          name: file.name,
          document: doc,
          range: isGuide && doc.pages.length > 1 ? { unit: 'page', items: doc.pages, original: doc } : undefined,
        });
      } else {
        if (files.length + documents.length > MAX_POLICY_DOCUMENTS) throw Error('Choose up to 18 policy documents.');
        const next = [...documents];
        for (const file of files) next.push(await readDocument(file, next));
        acceptAddedPolicies(next);
      }
    } catch (cause) {
      setError(documentErrorMessage(cause));
    } finally {
      setBusy('');
    }
  }

  function removePolicy(id: string) {
    const next = documents.filter((doc) => doc.id !== id);
    setDocuments(next);
    if (scope) {
      setScope({
        ...scope,
        selectedDocuments: next.length,
        selectedPages: next.reduce((count, doc) => count + doc.pages.length, 0),
      });
    }
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

      const includeDraft = Boolean(draft.text.trim() || draft.title.trim());
      const policies = includeDraft ? [...documents, pastedPolicy(draft, documents.length + 1)] : documents;
      if (!policies.length && !isGuide) throw Error('Upload a policy file or paste a policy to continue.');
      const input = inputWith(policies);
      const controller = new AbortController();
      request.current = controller;
      setBusy(copy.submitting);
      const result = await requestReview(input, controller.signal);
      if (!controller.signal.aborted) {
        onDone({
          key: crypto.randomUUID(),
          title: source.name.replace(/\.[^.]+$/, '').replace(/_/g, ' ').trim() || modeLabels[mode] + ' review',
          input,
          result,
          sourceDocument: source.document,
          sourceSelection: source.selection,
          scope: includeDraft ? undefined : scope,
        });
      }
    } catch (cause) {
      if (!(cause instanceof Error && cause.name === 'AbortError')) setError(documentErrorMessage(cause));
    } finally {
      request.current = null;
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
      <ol className="intake-steps" aria-label="Review steps">
        {[copy.sourceLabel, 'Existing policies'].map((label, index) => (
          <li key={label} aria-current={step === index + 1 ? 'step' : undefined} data-complete={index + 1 < step}>
            <span className="intake-step-number" aria-hidden="true">
              {index + 1 < step ? <Check size={12} /> : index + 1}
            </span>
            {label}
          </li>
        ))}
      </ol>
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
              draft={draft}
              allowModel={allowModel}
              onDraft={setDraft}
              onAllowModelChange={setAllowModel}
              onFiles={(files) => void importFiles(files, 'policies')}
              onAdd={(policy) => acceptAddedPolicies([...documents, policy])}
              onRemove={removePolicy}
              onError={setError}
            />
          )}
          {source.selection && <output className="intake-help">{source.selection}</output>}
          {scope && (
            <output className="intake-help">This review searches {scope.selectedPages.toLocaleString()} selected {scope.selectedPages === 1 ? 'page' : 'pages'} from {scope.sourcePages.toLocaleString()} source pages.</output>
          )}
        </fieldset>
        {error && <p ref={alert} className="intake-error" role="alert" tabIndex={-1}>{error}</p>}
        <div className="intake-actions">
          <button type="submit" className="intake-primary" disabled={Boolean(busy)}>
            <span>{busy || (step === 1 ? 'Continue' : copy.submit)}</span>
            {busy ? <LoaderCircle size={16} className="intake-spinner" aria-hidden="true" /> : <ArrowRight size={16} aria-hidden="true" />}
          </button>
        </div>
        <output className="intake-sr-only">{busy}</output>
      </form>
    </section>
  );
}
