import { useRef, useState } from 'react';
import {
  ArrowLeft, ArrowRight, BookOpen, ChevronRight, Download, FileText,
} from 'lucide-react';
import { exportReview } from '../review/exportReview';
import { guideCitation, guideLocation, submittedSource, type SourceLocation } from '../review/guideSource';
import {
  modeLabels, policyActionLabels, responseLabels, type FindingState,
  type Evidence, type Review, type ReviewRow, type SavedResponse,
} from '../review/model';
import { FindingQueue, ResolutionButton, type QueueOptions } from './FindingQueue';
import { Inspector } from './Inspector';
import { SourceDialog } from './SourceDialog';

type Props = {
  review: Review;
  findingStates: ReadonlyMap<string, FindingState>;
  onUpdateFinding: (key: string, changes: FindingState) => void;
};

export function ReviewWorkspace({ review, findingStates, onUpdateFinding }: Props) {
  const [nav, setNav] = useState<'findings' | 'documents' | 'decisions'>('findings');
  const [source, setSource] = useState<SourceLocation | null>(null);
  const [selected, setSelected] = useState(0);
  const [queue, setQueue] = useState<QueueOptions>({ search: '', status: 'all', showStatuses: false, expanded: false });
  const detailRef = useRef<HTMLDivElement>(null);
  const { mode, documents } = review.input;
  const findings = review.result.findings;
  const isGuide = mode === 'guide';
  const resolveQuestion = isGuide ? undefined : changeResolution;
  const hasPolicies = documents.length > 0;
  const groupLabel = isGuide ? 'Obligations' : 'Questions';
  const outputLabel = isGuide ? 'Action list' : 'Responses';
  const notice = review.result.notice;
  const scopeNote = review.scope ? `Search covers ${review.scope.selectedPages} selected pages of ${review.scope.sourcePages.toLocaleString()}.` : '';
  const rows = findings.map((finding, index) => {
    const key = review.key + '/' + finding.id;
    const state = findingStates.get(key);
    return { finding, index, key, decision: state?.decision, resolved: !!state?.resolved };
  });
  const query = queue.search.trim().toLowerCase();
  const visible = rows.filter(({ finding }) =>
    (queue.status === 'all' || queue.status === finding.status) &&
    (finding.question + ' ' + finding.id).toLowerCase().includes(query),
  );
  const position = Math.max(0, visible.findIndex(({ index }) => index === selected));
  const current = visible[position];
  const previous = visible[position - 1];
  const next = visible[position + 1];
  const entries = rows.flatMap(({ finding, index, decision }) => decision ? [{ finding, index, decision }] : []);
  const reviewed = rows.filter(row => isGuide ? row.decision?.action : row.resolved).length;
  const downloadReview = () => exportReview(review, rows);

  function changeResolution(index: number, resolved: boolean) {
    onUpdateFinding(rows[index].key, { resolved });
  }

  function updateQueue(changes: Partial<QueueOptions>) {
    setQueue((options) => ({ ...options, ...changes }));
  }

  function selectFinding(index: number, focus = false) {
    setNav('findings');
    setSelected(index);
    updateQueue({ expanded: false });
    if (focus || window.matchMedia('(max-width: 760px)').matches) {
      requestAnimationFrame(() => {
        detailRef.current?.querySelector<HTMLElement>('#finding-detail')?.focus({ preventScroll: true });
        detailRef.current?.scrollIntoView({ block: 'start' });
      });
    }
  }

  function openEvidence(evidence: Evidence, term = false) {
    const doc = documents.find((document) => document.id === evidence.documentId);
    if (doc) setSource({ doc, page: evidence.page, quote: evidence.quote, term });
  }

  function openOutput() {
    setNav('decisions');
    requestAnimationFrame(() => document.getElementById('review-output')?.focus());
  }

  return (
    <section className="workspace" data-single-item={findings.length <= 1}>
      <ReviewHeading review={review} reviewed={reviewed} showingOutput={nav === 'decisions'} onDownload={downloadReview} />
      <div className="review-toolbar">
        <nav className="mode-tabs" aria-label="This review">
          <button aria-pressed={nav === 'findings'} onClick={() => setNav('findings')}>Review {groupLabel.toLowerCase()}</button>
          <button aria-pressed={nav === 'decisions'} onClick={() => setNav('decisions')}>{outputLabel}</button>
          <button aria-pressed={nav === 'documents'} onClick={() => setNav('documents')}>Source documents</button>
        </nav>
      </div>
      {nav === 'findings' && (
        <>
          {(notice || scopeNote) && <output className="run-notice">{[notice, scopeNote].filter(Boolean).join(' ')}</output>}
          <div className="work-grid">
            {findings.length > 1 && <FindingQueue rows={visible} currentIndex={current?.index} label={groupLabel}
              total={findings.length} hasPolicies={hasPolicies}
              options={queue} onChange={updateQueue} onSelect={selectFinding}
              onResolve={resolveQuestion} />}
            <div ref={detailRef} className="detail-wrap">
              {current ? (
                <>
                  <Inspector
                    key={current.key}
                    row={current}
                    total={findings.length}
                    mode={mode}
                    documents={documents}
                    onOpen={openEvidence}
                    onGuide={() => setSource(guideLocation(review, current.finding))}
                    guideCitation={isGuide && review.sourceDocument ? guideCitation(review, current.finding) : undefined}
                    onDecisionChange={(decision) => onUpdateFinding(current.key, { decision })}
                  />
                  <FindingNavigation guide={isGuide} previous={previous} next={next}
                    onSelect={index => selectFinding(index, true)} onOutput={openOutput}>
                    {findings.length === 1 && resolveQuestion && <ResolutionButton row={current} onResolve={resolveQuestion} showLabel />}
                  </FindingNavigation>
                </>
              ) : (
                <div className="empty-list">
                  <BookOpen />
                  <p>
                    {findings.length
                      ? 'Select a different filter to see findings.'
                      : 'No requirements extracted from this input.'}
                  </p>
                </div>
              )}
            </div>
          </div>
        </>
      )}
      {nav === 'documents' && <SourceDocuments review={review} onOpen={setSource} />}
      {nav === 'decisions' && (
        <ReviewDecisions entries={entries} review={review} onMarkdown={downloadReview} onReturn={() => selectFinding(selected, true)} onSelect={(index) => {
          updateQueue({ search: '', status: 'all' });
          selectFinding(index, true);
        }} />
      )}
      {source && <SourceDialog location={source} onClose={() => setSource(null)} />}
    </section>
  );
}

function FindingNavigation({ guide, previous, next, onSelect, onOutput, children }: {
  guide: boolean; previous?: ReviewRow; next?: ReviewRow; onSelect: (index: number) => void;
  onOutput: () => void; children: React.ReactNode;
}) {
  const item = guide ? 'obligation' : 'question';
  return (
    <nav className="finding-navigation" aria-label={guide ? 'Obligations' : 'Questions'}>
      {children}
      {previous && <button onClick={() => onSelect(previous.index)}><ArrowLeft size={15} />Previous {item}</button>}
      <button onClick={() => next ? onSelect(next.index) : onOutput()}>
        {next ? 'Next ' + item : guide ? 'View action list' : 'View responses'}<ArrowRight size={15} />
      </button>
    </nav>
  );
}

function ReviewHeading({ review, reviewed, showingOutput, onDownload }: {
  review: Review; reviewed: number; showingOutput: boolean; onDownload: () => void;
}) {
  const isGuide = review.input.mode === 'guide';
  const summary = [
    review.sourceDocument?.title,
    review.sourceSelection,
    isGuide && !review.input.documents.length ? 'Guide only' : undefined,
    reviewed + ' of ' + review.result.findings.length + (isGuide ? ' reviewed' : ' resolved'),
  ];
  return (
    <header className="page-heading">
      <a className="back-link" href="#review-options"><ArrowLeft size={15} /> All reviews</a>
      <div className="workspace-heading">
        <div>
          <h1 tabIndex={-1}>{isGuide ? 'Policy guide review' : 'Questionnaire review'}</h1>
          <p>{summary.filter(Boolean).join(' · ')}</p>
        </div>
        {(isGuide || !showingOutput) && <button className="report-link" onClick={onDownload}>
          <Download size={16} /> {isGuide ? 'Download action list' : 'Download responses'}
        </button>}
      </div>
    </header>
  );
}

function SourceDocuments({ review, onOpen }: { review: Review; onOpen: (source: SourceLocation) => void }) {
  const documents = [submittedSource(review), ...review.input.documents];
  return (
    <section className="library" aria-label="Source documents">
      {documents.map((doc, index) => {
        const source = index === 0;
        const unpaginated = source && !review.sourceDocument;
        const pages = unpaginated ? 'Submitted text' : doc.pages.length + (doc.pages.length === 1 ? ' page' : ' pages');
        return (
          <button
            className="library-row" key={(source ? 'source-' : 'policy-') + doc.id}
            onClick={() => onOpen({ doc, page: doc.pages[0].number, quote: '', unpaginated })}
          >
            <FileText size={21} />
            <span>
              <strong>{doc.title}</strong>
              <small>{source ? modeLabels[review.input.mode] : 'Policy'} · {pages}</small>
            </span>
            <ChevronRight size={16} />
          </button>
        );
      })}
    </section>
  );
}

function ResponseDownloads({ title, entries, onMarkdown }: {
  title: string; entries: SavedResponse[]; onMarkdown: () => void;
}) {
  const [state, setState] = useState<'idle' | 'preparing' | 'error'>('idle');
  async function download() {
    setState('preparing');
    try {
      const { exportResponsePdf } = await import('../review/exportResponsePdf');
      await exportResponsePdf(title, entries);
      setState('idle');
    } catch {
      setState('error');
    }
  }
  return (
    <>
      <div className="response-downloads">
        <button className="report-link" type="button" disabled={!entries.length || state === 'preparing'} onClick={download}>
          <Download size={15} aria-hidden="true" />{state === 'preparing' ? 'Preparing PDF…' : 'Download PDF'}
        </button>
        <button type="button" className="text-link" onClick={onMarkdown}>Full review (.md)</button>
      </div>
      {state === 'error' && <p role="alert" className="response-error">The PDF could not be downloaded. Please try again.</p>}
    </>
  );
}

function ReviewDecisions({ entries, review, onSelect, onReturn, onMarkdown }: {
  entries: SavedResponse[];
  review: Review;
  onSelect: (index: number) => void;
  onReturn: () => void;
  onMarkdown: () => void;
}) {
  const isGuide = review.input.mode === 'guide';
  return (
    <section className="library" id="review-output" tabIndex={-1} aria-label={isGuide ? 'Action list' : 'Responses'}>
      {!isGuide && <ResponseDownloads title={review.title} entries={entries} onMarkdown={onMarkdown} />}
      {entries.map(({ finding, decision, index }) => {
        const label = decision.action ? policyActionLabels[decision.action] : decision.value ? responseLabels[decision.value] : 'Draft';
        const text = decision.note || decision.answer;
        return (
          <button key={finding.id} className="library-row decision-entry" onClick={() => onSelect(index)}>
            <span>
              <small>{label}</small>
              <strong>{finding.question}</strong>
              {text && <span className="entry-text">{text}</span>}
            </span>
            <ChevronRight size={16} />
          </button>
        );
      })}
      {!entries.length && <div className="empty-decisions">
        <p>{isGuide ? 'Choose an action for an obligation to start your list.' : 'Draft or flag a response to add it here.'}</p>
        <button className="text-link" onClick={onReturn}>{isGuide ? 'Review obligations' : 'Review questions'} <ArrowRight size={14} /></button>
      </div>}
    </section>
  );
}
