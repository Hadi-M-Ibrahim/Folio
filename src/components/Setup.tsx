import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { ArrowLeft, ArrowRight, Check, FileText, LoaderCircle, Plus, Upload, X } from 'lucide-react';
import { checkInput, isLoopback, requestReview } from '../review/client';
import { readDocument } from '../review/files';
import { MAX_POLICY_PAGE_CHARACTERS, MAX_POLICY_PAGES, modeLabels, readScope, type Mode, type Policy, type Review, type ReviewInput, type Scope } from '../review/model';
import { IntakeFile } from './IntakeFile';
import { preparedGuide, preparedSelection, questionnaireRange, SourceRange, type RangeSource } from './SourceRange';
import { questionsFromPdf } from './intakeQuestions';
import './intake.css';

type SetupProps = {
  initialMode: Mode;
  policyStep: boolean;
  onClose: () => void;
  onDone: (review: Review) => void;
};

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : 'Could not read the document. Try again.';
}

export function Setup({ initialMode, policyStep, onClose, onDone }: SetupProps) {
  const [mode, setMode] = useState(initialMode);
  const [source, setSource] = useState('');
  const [sourceName, setSourceName] = useState('');
  const [sourceDocument, setSourceDocument] = useState<Policy>();
  const [rangeSource, setRangeSource] = useState<RangeSource>();
  const [sourceSelection, setSourceSelection] = useState<string>();
  const [preparedQuestions, setPreparedQuestions] = useState<string[]>();
  const [documents, setDocuments] = useState<Policy[]>([]);
  const [scope, setScope] = useState<Scope>();
  const [policyTitle, setPolicyTitle] = useState('');
  const [policyText, setPolicyText] = useState('');
  const [pasteOpen, setPasteOpen] = useState(false);
  const [allowModel, setAllowModel] = useState(false);
  const [lastError, setLastError] = useState({ step: 1, message: '' });
  const [busy, setBusy] = useState('');
  const heading = useRef<HTMLHeadingElement>(null);
  const alert = useRef<HTMLParagraphElement>(null);
  const pasteButton = useRef<HTMLButtonElement>(null);
  const request = useRef<AbortController | null>(null);
  const isGuide = mode === 'guide';
  const sourceLabel = isGuide ? 'Regulatory guide' : 'State questions';
  const questions = useMemo(() => preparedQuestions ?? (isGuide ? [] : source.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)), [preparedQuestions, isGuide, source]);
  const availableRange = useMemo(() => rangeSource ?? questionnaireRange(questions), [rangeSource, questions]);
  const sourcePath = '#/new/' + initialMode;
  const validSource = Boolean(source.trim()) && (isGuide
    ? source.trim().length <= 50000
    : questions.length <= 30 && questions.every((q) => q.length <= 2000));
  const step = policyStep && validSource ? 2 : 1;
  const error = lastError.step === step ? lastError.message : '';

  function setError(message: string) {
    setLastError({ step, message });
  }

  useEffect(() => () => request.current?.abort(), []);
  useEffect(() => {
    if (policyStep && !validSource) window.location.replace(sourcePath);
  }, [policyStep, validSource, sourcePath]);
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
      ...(isGuide ? { guide: source.trim() } : { questions }),
      allowModel,
      ...(!isLoopback && allowModel ? { publicInputConsent: true } : {}),
    };
  }

  async function importFiles(files: File[], kind: 'source' | 'policies' | 'bundle') {
    setError('');
    setBusy('Reading ' + (files.length > 1 ? 'files…' : 'file…'));
    try {
      if (kind === 'bundle') {
        if (!isLoopback) throw Error('Open prepared reviews in the local app.');
        const file = files[0];
        if (file.size > 4000000) throw Error('Use a prepared review smaller than 4 MB.');
        const input: ReviewInput & {
          corpusScope?: Scope;
          sourceDocument?: unknown;
          selection?: { guidePages?: unknown; questionNumbers?: unknown };
        } = JSON.parse(await file.text());
        checkInput(input);
        setMode(input.mode);
        setPreparedQuestions(input.mode === 'questionnaire' ? input.questions : undefined);
        setSource(input.mode === 'guide' ? input.guide! : input.questions!.map((q) => q.replace(/\s+/g, ' ')).join('\n'));
        const doc = input.mode === 'guide' ? preparedGuide(input.sourceDocument, input.guide!, input.selection?.guidePages) : undefined;
        setSourceName(doc && input.sourceDocument ? doc.title : '');
        setSourceDocument(doc);
        setRangeSource(undefined);
        setSourceSelection(input.mode === 'guide'
          ? preparedSelection(input.selection?.guidePages, 'page')
          : preparedSelection(input.selection?.questionNumbers, 'question'));
        setDocuments(input.documents);
        setScope(readScope(input.corpusScope));
        setAllowModel(false);
        setPolicyText('');
        setPolicyTitle('');
        setPasteOpen(false);
      } else if (kind === 'source') {
        const file = files[0];
        const doc = await readDocument(file);
        const text = doc.pages.map((page) => page.text).join('\n\n');
        const value = !isGuide && /\.pdf$/i.test(file.name) ? questionsFromPdf(text) : text;
        setPreparedQuestions(undefined);
        setSource(value);
        setSourceName(file.name);
        setSourceDocument(doc);
        setSourceSelection(undefined);
        if (isGuide) setRangeSource(doc.pages.length > 1 ? { unit: 'page', items: doc.pages, original: doc } : undefined);
        else setRangeSource(questionnaireRange(value.split(/\r?\n/).map((q) => q.trim()).filter(Boolean), doc));
      } else {
        if (files.length + documents.length > 18) throw Error('Choose up to 18 policy documents.');
        const next = [...documents];
        for (const file of files) next.push(await readDocument(file, next));
        checkInput(inputWith(next));
        setDocuments(next);
        setScope(undefined);
      }
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy('');
    }
  }

  function pastedPolicy(): Policy {
    if (!policyText.trim()) throw Error('Enter the policy text.');
    const sections = policyText.split('\f', MAX_POLICY_PAGES + 1);
    if (sections.length > MAX_POLICY_PAGES) throw Error('A review supports up to 1,200 pages.');
    const pages = sections
      .map((text, index) => ({ number: index + 1, text: text.trim() }))
      .filter((page) => page.text);
    if (pages.some((page) => page.text.length > MAX_POLICY_PAGE_CHARACTERS)) {
      throw Error('Each policy page can contain up to 35,000 characters. Upload a paginated file or paste a shorter section.');
    }
    return { id: crypto.randomUUID(), title: policyTitle.trim() || 'Policy ' + (documents.length + 1), pages };
  }

  function addPolicy() {
    setError('');
    try {
      const next = [...documents, pastedPolicy()];
      checkInput(inputWith(next));
      setDocuments(next);
      setScope(undefined);
      setPolicyTitle('');
      setPolicyText('');
      setPasteOpen(false);
      pasteButton.current?.focus();
    } catch (cause) {
      setError(errorMessage(cause));
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
    setError('');
    pasteButton.current?.focus();
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setError('');
    try {
      if (step === 1) {
        if (!source.trim()) throw Error(isGuide ? 'Upload or paste your regulatory guide.' : 'Upload or enter at least one state question.');
        if (isGuide && source.trim().length > 50000) throw Error('Choose a guide section of up to 50,000 characters.');
        if (!isGuide && (questions.length > 30 || questions.some((q) => q.length > 2000))) {
          throw Error('Use up to 30 questions, with one question per line and up to 2,000 characters each.');
        }
        window.history.pushState({ folioIntakeSource: sourcePath }, '', sourcePath + '/policies');
        window.dispatchEvent(new HashChangeEvent('hashchange'));
        return;
      }

      const includeDraft = Boolean(policyText.trim() || policyTitle.trim());
      const policies = includeDraft ? [...documents, pastedPolicy()] : documents;
      if (!policies.length && !isGuide) throw Error('Upload a policy file or paste a policy to continue.');
      const input = inputWith(policies);
      const controller = new AbortController();
      request.current = controller;
      setBusy(isGuide ? 'Reviewing obligations…' : 'Finding evidence…');
      const result = await requestReview(input, controller.signal);
      if (!controller.signal.aborted) {
        onDone({
          key: crypto.randomUUID(),
          title: sourceName.replace(/\.[^.]+$/, '').replace(/_/g, ' ').trim() || modeLabels[mode] + ' review',
          input,
          result,
          sourceDocument,
          sourceSelection,
          scope: includeDraft ? undefined : scope,
        });
      }
    } catch (cause) {
      if (!(cause instanceof Error && cause.name === 'AbortError')) setError(errorMessage(cause));
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
        {[sourceLabel, 'Existing policies'].map((label, index) => (
          <li key={label} aria-current={step === index + 1 ? 'step' : undefined} data-complete={index + 1 < step}>
            <span className="intake-step-number" aria-hidden="true">
              {index + 1 < step ? <Check size={12} /> : index + 1}
            </span>
            {label}
          </li>
        ))}
      </ol>
      <h1 id="intake-title" ref={heading} tabIndex={-1}>
        {step === 2 ? 'Add existing policies' : isGuide ? 'Review a policy guide' : 'Answer a questionnaire'}
      </h1>
      <p className="intake-intro">
        {step === 1
          ? isGuide ? 'Upload the regulatory guide or paste the section you want to review.' : 'Upload the state questionnaire or paste the questions you need to answer.'
          : isGuide ? 'Policies are optional. Add them to check coverage, or continue to the guide’s obligations.' : 'Add the policies you want to search for evidence for each question.'}
      </p>
      <form onSubmit={(event) => void submit(event)}>
        <fieldset disabled={Boolean(busy)} className="intake-fields">
          <legend className="intake-sr-only">{step === 1 ? sourceLabel : 'Existing policies'}</legend>
          {step === 1 ? (
            <>
              <IntakeFile
                label={isGuide ? 'Upload regulatory guide' : 'Upload questionnaire'}
                fileName={sourceName}
                onFiles={(files) => void importFiles(files, 'source')}
              />
              {availableRange && (
                <SourceRange
                  key={availableRange.original?.id ?? 'pasted'}
                  source={availableRange}
                  oversized={isGuide ? source.length > 50000 || availableRange.items.length > 10 : questions.length > 30}
                  onApply={(items, description) => {
                    setRangeSource(availableRange);
                    setSourceSelection(description);
                    setSourceDocument(isGuide && availableRange.original ? { ...availableRange.original, pages: items } : availableRange.original);
                    setPreparedQuestions(isGuide ? undefined : items.map((item) => item.text));
                    setSource(items.map((item) => item.text).join(isGuide ? '\n\n' : '\n'));
                    setError('');
                  }}
                />
              )}
              <div className="intake-source">
                <div className="intake-field-heading">
                  <label htmlFor="intake-source">{isGuide ? 'Guide text' : 'Questions'}</label>
                  {!isGuide && questions.length > 0 && (
                    <span>{questions.length} {questions.length === 1 ? 'question' : 'questions'}</span>
                  )}
                </div>
                <textarea
                  id="intake-source"
                  rows={6}
                  value={source}
                  placeholder={isGuide ? 'Paste guide text here…' : 'Paste questions here…'}
                  aria-describedby={!isGuide ? 'question-format' : undefined}
                  onChange={(event) => {
                    setSource(event.target.value);
                    setSourceDocument(undefined);
                    setPreparedQuestions(undefined);
                    setSourceSelection(undefined);
                    setRangeSource(undefined);
                    setError('');
                  }}
                />
                {!isGuide && <p className="intake-help" id="question-format">One question per line.</p>}
              </div>
              {isLoopback && (
                <label className="intake-bundle">
                  <Upload size={14} aria-hidden="true" /> Import a prepared review (.json)
                  <input
                    type="file"
                    accept=".json"
                    onChange={(event) => {
                      const file = event.currentTarget.files?.[0];
                      event.currentTarget.value = '';
                      if (file) void importFiles([file], 'bundle');
                    }}
                  />
                </label>
              )}
            </>
          ) : (
            <>
              <IntakeFile label="Upload policy files" multiple onFiles={(files) => void importFiles(files, 'policies')} />
              {documents.length > 0 && (
                <ul className="intake-documents" aria-label="Added policies">
                  {documents.map((doc) => (
                    <li key={doc.id}>
                      <FileText size={16} aria-hidden="true" />
                      <span>{doc.title}</span>
                      <small>{doc.pages.length} {doc.pages.length === 1 ? 'page' : 'pages'}</small>
                      <button type="button" aria-label={'Remove ' + doc.title} onClick={() => removePolicy(doc.id)}><X size={16} /></button>
                    </li>
                  ))}
                </ul>
              )}
              <div className="intake-paste">
                <button
                  ref={pasteButton}
                  type="button"
                  className="intake-text-button"
                  aria-expanded={pasteOpen}
                  aria-controls="intake-paste-fields"
                  onClick={() => setPasteOpen(!pasteOpen)}
                >
                  {pasteOpen ? <X size={15} aria-hidden="true" /> : <Plus size={15} aria-hidden="true" />}
                  {pasteOpen ? 'Hide text entry' : 'Paste a policy'}
                </button>
                <div className="intake-paste-fields" id="intake-paste-fields" hidden={!pasteOpen}>
                  <label htmlFor="intake-policy-name">Policy title <span>(optional)</span></label>
                  <input id="intake-policy-name" maxLength={240} value={policyTitle} onChange={(e) => setPolicyTitle(e.target.value)} />
                  <label htmlFor="intake-policy-text">Policy text</label>
                  <textarea id="intake-policy-text" rows={4} value={policyText} onChange={(e) => { setPolicyText(e.target.value); setError(''); }} />
                  <button type="button" className="intake-secondary" onClick={addPolicy}>Add policy</button>
                </div>
              </div>
              <label className="intake-consent">
                <input type="checkbox" checked={allowModel} onChange={(e) => setAllowModel(e.target.checked)}
                  aria-labelledby="intake-model-label" aria-describedby="intake-model-description" />
                <span>
                  <strong id="intake-model-label">Use Anthropic for this review</strong>
                  <small id="intake-model-description">
                    {isLoopback ? 'Allow the local server to send selected text to Anthropic if the operator has enabled it.' : 'I confirm these documents are public and agree to send selected text to Anthropic.'}
                  </small>
                </span>
              </label>
            </>
          )}
          {sourceSelection && <output className="intake-help">{sourceSelection}</output>}
          {scope && (
            <output className="intake-help">This review searches {scope.selectedPages.toLocaleString()} selected {scope.selectedPages === 1 ? 'page' : 'pages'} from {scope.sourcePages.toLocaleString()} source pages.</output>
          )}
        </fieldset>
        {error && <p ref={alert} className="intake-error" role="alert" tabIndex={-1}>{error}</p>}
        <div className="intake-actions">
          {!isLoopback && <p className="intake-privacy">Use public documents. Running a review sends their text to Folio.</p>}
          <button type="submit" className="intake-primary" disabled={Boolean(busy)}>
            <span>{busy || (step === 1 ? 'Continue' : isGuide ? 'Review obligations' : 'Find evidence')}</span>
            {busy ? <LoaderCircle size={16} className="intake-spinner" aria-hidden="true" /> : <ArrowRight size={16} aria-hidden="true" />}
          </button>
        </div>
        <output className="intake-sr-only">{busy}</output>
      </form>
    </section>
  );
}
