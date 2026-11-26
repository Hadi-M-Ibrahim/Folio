import { useEffect, useRef, useState } from 'react';
import {
  BookOpenText,
  ClipboardList,
  FileText,
  FlaskConical,
  LoaderCircle,
  LockKeyhole,
  Plus,
  Upload,
  X,
} from 'lucide-react';
import { Modal } from './Modal';
import { readDocument } from './files';
import {
  checkInput,
  isLoopback,
  modeLabels,
  readScope,
  requestReview,
  sampleInput,
  type Mode,
  type Policy,
  type Review,
  type ReviewInput,
  type Scope,
} from './review';

export function Setup({
  initialMode,
  onClose,
  onDone,
}: {
  initialMode: Mode;
  onClose: () => void;
  onDone: (review: Review) => void;
}) {
  const [mode, setMode] = useState(initialMode),
    [source, setSource] = useState<'sample' | 'custom'>('sample');
  const [questions, setQuestions] = useState(''),
    [guide, setGuide] = useState(''),
    [title, setTitle] = useState('');
  const [documents, setDocuments] = useState<Policy[]>([]),
    [policyTitle, setPolicyTitle] = useState(''),
    [policyText, setPolicyText] = useState('');
  const [entry, setEntry] = useState(false),
    [model, setModel] = useState(true),
    [error, setError] = useState('');
  const [busy, setBusy] = useState(''),
    controller = useRef<AbortController | null>(null);
  const [importedQuestions, setImportedQuestions] = useState<string[]>();
  const [scope, setScope] = useState<Scope>();
  const sample = sampleInput(mode);
  useEffect(() => () => controller.current?.abort(), []);
  function addText() {
    if (!policyText.trim())
      throw Error('Enter policy text before adding this document.');
    const doc = {
      id: crypto.randomUUID(),
      title: policyTitle.trim() || 'Untitled policy',
      pages: [{ number: 1, text: policyText.trim() }],
    };
    if (doc.pages[0].text.length > 35000)
      throw Error(
        'Split policy text longer than 35,000 characters into multiple pages in a text file.'
      );
    return doc;
  }
  async function upload(
    files: FileList | null,
    kind: 'policies' | 'criteria' | 'bundle'
  ) {
    if (!files?.length) return;
    setError('');
    setBusy('Reading file…');
    try {
      if (kind === 'bundle') {
        if (!isLoopback)
          throw Error('Prepared bundles can be opened in the local app.');
        if (files[0].size > 4000000)
          throw Error('Review bundles must be under 4 MB.');
        const input: ReviewInput & { corpusScope?: Scope } = JSON.parse(
          await files[0].text()
        );
        checkInput(input);
        setImportedQuestions(input.questions);
        setScope(readScope(input.corpusScope));
        setMode(input.mode);
        setQuestions(input.questions?.join('\n') || '');
        setGuide(input.guide || '');
        setDocuments(input.documents);
        setModel(false);
        setEntry(false);
        setPolicyText('');
        setPolicyTitle('');
      } else if (kind === 'criteria') {
        const d = await readDocument(files[0]);
        const text = d.pages.map((p) => p.text).join('\n\n');
        setScope(undefined);
        setImportedQuestions(undefined);
        if (mode === 'guide') setGuide(text);
        else setQuestions(text);
      } else {
        if (files.length + documents.length > 18)
          throw Error('Choose up to 18 policy documents.');
        const docs: Policy[] = [];
        for (const file of Array.from(files))
          docs.push(await readDocument(file));
        setScope(undefined);
        setDocuments((current) => [...current, ...docs]);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not read this file.');
    } finally {
      setBusy('');
    }
  }
  async function run() {
    setError('');
    try {
      const docs =
        source === 'custom' && entry && policyText.trim()
          ? [...documents, addText()]
          : documents;
      const input: ReviewInput =
        source === 'sample'
          ? { ...sample, allowModel: model }
          : {
              mode,
              documents: docs,
              ...(mode === 'questionnaire'
                ? {
                    questions:
                      importedQuestions ||
                      questions
                        .split('\n')
                        .map((q) => q.trim())
                        .filter(Boolean),
                  }
                : { guide: guide.trim() }),
              allowModel: isLoopback && model,
            };
      checkInput(input);
      controller.current = new AbortController();
      setBusy('Running review…');
      const result = await requestReview(input, controller.current.signal);
      onDone({
        scope:
          source === 'custom' && !(entry && policyText.trim())
            ? scope
            : undefined,
        key: crypto.randomUUID(),
        title:
          source === 'sample'
            ? 'Member communications'
            : title.trim() || 'Custom policy review',
        input,
        result,
        sample: source === 'sample',
      });
    } catch (e) {
      if (e instanceof Error && e.name !== 'AbortError') setError(e.message);
    } finally {
      setBusy('');
    }
  }
  function switchSource(value: 'sample' | 'custom') {
    setSource(value);
    setModel(value === 'sample');
    setError('');
  }
  return (
    <Modal
      title="New review"
      onClose={onClose}
    >
      <div className="modal-body setup">
        <fieldset disabled={!!busy}>
          <legend className="field-label">Review mode</legend>
          <div className="segmented mode-picker">
            {(['questionnaire', 'guide'] as const).map((m) => (
              <button
                type="button"
                key={m}
                className={m === mode ? 'active' : ''}
                aria-pressed={m === mode}
                onClick={() => {
                  if (m !== mode) setScope(undefined);
                  setMode(m);
                  setError('');
                }}
              >
                {m === 'guide' ? <BookOpenText /> : <ClipboardList />}
                {modeLabels[m]}
              </button>
            ))}
          </div>
          <label className="field-label" htmlFor="data-source">
            Review materials
          </label>
          <select
            id="data-source"
            value={source}
            onChange={(e) =>
              switchSource(e.target.value as 'sample' | 'custom')
            }
          >
            <option value="sample">Use the synthetic sample</option>
            <option value="custom">Add my own materials</option>
          </select>
          {source === 'sample' ? (
            <div className="sample-preview">
              <FlaskConical size={20} />
              <div>
                <strong>Member communications</strong>
                <p>
                  Three fictional policies and{' '}
                  {mode === 'guide'
                    ? 'a five-clause regulatory guide'
                    : 'five state questionnaire items'}
                  .
                </p>
              </div>
            </div>
          ) : (
            <>
              <p className="privacy-note">
                <LockKeyhole size={16} />
                {isLoopback
                  ? 'Your review is sent to the local server when you run it.'
                  : 'Use public or synthetic materials. Running a review sends the supplied text to this server. Open the app locally to review private documents.'}
              </p>
              {isLoopback && (
                <label className="file-button bundle">
                  <Upload size={15} />
                  Import a prepared review (.json)
                  <input
                    type="file"
                    accept=".json"
                    onChange={(e) => {
                      void upload(e.target.files, 'bundle');
                      e.target.value = '';
                    }}
                  />
                </label>
              )}
              {scope && (
                <p className="helper">
                  {scope.selectedPages} selected pages from{' '}
                  {scope.sourcePages.toLocaleString()} source pages. Search
                  covers the selected pages.
                </p>
              )}
              <label className="field-label" htmlFor="review-title">
                Review name <span>Optional</span>
              </label>
              <input
                id="review-title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Custom policy review"
                maxLength={120}
              />
              <div className="field-heading">
                <label className="field-label" htmlFor="requirements">
                  {mode === 'guide' ? 'Regulatory guide' : 'Questions'}
                </label>
                <label className="text-link file-button">
                  <Upload size={14} />
                  Import file
                  <input
                    type="file"
                    accept=".pdf,.txt,.md"
                    onChange={(e) => {
                      void upload(e.target.files, 'criteria');
                      e.target.value = '';
                    }}
                  />
                </label>
              </div>
              <textarea
                id="requirements"
                rows={4}
                value={mode === 'guide' ? guide : questions}
                onChange={(e) => {
                  setScope(undefined);
                  setImportedQuestions(undefined);
                  if (mode === 'guide') setGuide(e.target.value);
                  else setQuestions(e.target.value);
                }}
                placeholder={
                  mode === 'guide'
                    ? 'Paste the guide and its obligations here.'
                    : 'Enter one question per line.'
                }
              />
              <div className="field-heading">
                <span className="field-label">Policy documents</span>
                <button className="text-link" onClick={() => setEntry(!entry)}>
                  {entry ? 'Close text entry' : 'Paste text'}
                </button>
              </div>
              <label className="drop-zone file-button">
                <Upload size={20} />
                <strong>Choose policy files</strong>
                <small>Text-based PDF, TXT, or Markdown</small>
                <input
                  type="file"
                  multiple
                  accept=".pdf,.txt,.md"
                  onChange={(e) => {
                    void upload(e.target.files, 'policies');
                    e.target.value = '';
                  }}
                />
              </label>
              {documents.map((d) => (
                <div className="file-row" key={d.id}>
                  <FileText size={16} />
                  <span>{d.title}</span>
                  <small>{d.pages.length} pp.</small>
                  <button
                    className="icon-button"
                    aria-label={'Remove ' + d.title}
                    onClick={() => {
                      setScope(undefined);
                      setDocuments((ds) => ds.filter((doc) => doc.id !== d.id));
                    }}
                  >
                    <X size={14} />
                  </button>
                </div>
              ))}
              {entry && (
                <div className="paste-box">
                  <label htmlFor="policy-name">Policy title</label>
                  <input
                    id="policy-name"
                    value={policyTitle}
                    onChange={(e) => setPolicyTitle(e.target.value)}
                    placeholder="Policy title"
                  />
                  <label htmlFor="policy-text">Policy text</label>
                  <textarea
                    id="policy-text"
                    value={policyText}
                    rows={4}
                    onChange={(e) => setPolicyText(e.target.value)}
                    placeholder="Paste policy language here."
                  />
                  <button
                    className="secondary small"
                    onClick={() => {
                      try {
                        const d = addText();
                        setScope(undefined);
                        setDocuments((ds) => [...ds, d]);
                        setPolicyTitle('');
                        setPolicyText('');
                        setEntry(false);
                        setError('');
                      } catch (e) {
                        setError((e as Error).message);
                      }
                    }}
                  >
                    <Plus size={14} />
                    Add document
                  </button>
                </div>
              )}
            </>
          )}
          {(source === 'sample' || isLoopback) && (
            <label className="check-option">
              <input
                type="checkbox"
                checked={model}
                onChange={(e) => setModel(e.target.checked)}
              />
              <span>
                <strong>Request a model assessment</strong>
                <small>
                  {source === 'sample'
                    ? 'Allow this synthetic sample to be sent to Anthropic if configured. Clear this option to use keyword retrieval.'
                    : 'Allow this local server to send selected text to Anthropic if the operator enabled private model review.'}
                </small>
              </span>
            </label>
          )}
        </fieldset>
        {error && (
          <div className="form-error" role="alert">
            {error}
          </div>
        )}
      </div>
      <div className="modal-footer">
        <button className="secondary" onClick={onClose}>
          Cancel
        </button>
        <button
          className="primary"
          disabled={!!busy}
          onClick={() => void run()}
        >
          {busy ? (
            <LoaderCircle size={16} className="spin" />
          ) : (
            <ClipboardList size={16} />
          )}
          <span aria-live="polite">{busy || 'Run review'}</span>
        </button>
      </div>
    </Modal>
  );
}
