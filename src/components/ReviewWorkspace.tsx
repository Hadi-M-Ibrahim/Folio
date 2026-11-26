import { useRef, useState } from 'react';
import {
  ArrowLeft, ArrowRight, BookOpen, ChevronRight, Download, FileText,
} from 'lucide-react';
import { exportReview } from '../review/exportReview';
import { guideCitation, guideLocation, submittedSource, type SourceLocation } from '../review/guideSource';
import {
  modeLabels, policyActionLabels, responseLabels, type Decision,
  type Evidence, type Review, type ReviewRow,
} from '../review/model';
import { FindingQueue, type QueueOptions } from './FindingQueue';
import { Inspector } from './Inspector';
import { SourceDialog } from './SourceDialog';

type Props = {
  review: Review;
  decisions: ReadonlyMap<string, Decision>;
  onDecisionChange: (key: string, decision?: Decision) => void;
};

export function ReviewWorkspace({ review, decisions, onDecisionChange }: Props) {
  const [nav, setNav] = useState<'findings' | 'documents' | 'decisions'>('findings');
  const [source, setSource] = useState<SourceLocation | null>(null);
  const [selected, setSelected] = useState(0);
  const [queue, setQueue] = useState<QueueOptions>({ search: '', status: 'all', showStatuses: false, expanded: false });
  const detailRef = useRef<HTMLDivElement>(null);
  const { mode, documents } = review.input;
  const findings = review.result.findings;
  const isGuide = mode === 'guide';
  const hasPolicies = documents.length > 0;
  const itemLabel = isGuide ? 'obligation' : 'question';
  const groupLabel = isGuide ? 'Obligations' : 'Questions';
  const notice = review.input.allowModel || review.result.criterionLimitReached ? review.result.notice : '';
  const scopeNote = review.scope ? `Search covers ${review.scope.selectedPages} selected pages of ${review.scope.sourcePages.toLocaleString()}.` : '';
  const rows = findings.map((finding, index) => {
    const key = review.key + '/' + finding.id;
    return { finding, index, key, decision: decisions.get(key) };
  });
  const query = queue.search.trim().toLowerCase();
  const visible = rows.filter(({ finding }) =>
    (queue.status === 'all' || queue.status === finding.status) &&
    (finding.question + ' ' + finding.id).toLowerCase().includes(query),
  );
  const current = visible.find(({ index }) => index === selected) ?? visible[0];
  const next = current && visible.find(({ index }) => index > current.index);
  const entries = rows.flatMap(({ finding, index, decision }) => decision ? [{ finding, index, decision }] : []);
  const reviewed = entries.filter(({ decision }) => isGuide ? decision.action : decision.value).length;

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
        detailRef.current?.scrollIntoView({ block: 'nearest' });
      });
    }
  }

  function openEvidence(evidence: Evidence, term = false) {
    const doc = documents.find((document) => document.id === evidence.documentId);
    if (doc) setSource({ doc, page: evidence.page, quote: evidence.quote, term });
  }

  return (
    <section className="workspace">
      <ReviewHeading review={review} />
      <div className="review-toolbar">
        <nav className="mode-tabs" aria-label="This review">
          <button aria-pressed={nav === 'findings'} onClick={() => setNav('findings')}>{groupLabel}</button>
          <button aria-pressed={nav === 'documents'} onClick={() => setNav('documents')}>Source documents</button>
          <button aria-pressed={nav === 'decisions'} onClick={() => setNav('decisions')}>Decisions</button>
        </nav>
        <button className="report-link" onClick={() => exportReview(review, rows)}>
          <Download size={15} /> {isGuide ? 'Download action list' : 'Download responses'}
        </button>
      </div>
      {nav === 'findings' && (
        <>
          {(notice || scopeNote) && <output className="run-notice">{[notice, scopeNote].filter(Boolean).join(' ')}</output>}
          <div className="work-grid">
            <FindingQueue rows={visible} currentIndex={current?.index} label={groupLabel}
              total={findings.length} reviewed={reviewed} hasPolicies={hasPolicies}
              options={queue} onChange={updateQueue} onSelect={selectFinding} />
            <div ref={detailRef} className="detail-wrap">
              {current ? (
                <>
                  <Inspector
                    key={current.key}
                    row={current}
                    mode={mode}
                    documents={documents}
                    onOpen={openEvidence}
                    onGuide={() => setSource(guideLocation(review, current.finding))}
                    guideCitation={isGuide ? guideCitation(review, current.finding) : undefined}
                    onDecisionChange={(decision) => onDecisionChange(current.key, decision)}
                  />
                  {next && (
                    <button className="next-finding" onClick={() => selectFinding(next.index, true)}>
                      Next {itemLabel}<ArrowRight size={16} />
                    </button>
                  )}
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
        <ReviewDecisions entries={entries} isGuide={isGuide} onSelect={(index) => {
          updateQueue({ search: '', status: 'all' });
          selectFinding(index, true);
        }} />
      )}
      {source && <SourceDialog location={source} onClose={() => setSource(null)} />}
    </section>
  );
}

function ReviewHeading({ review }: { review: Review }) {
  const { mode, documents } = review.input;
  const scope = documents.length ? documents.length + (documents.length === 1 ? ' policy document' : ' policy documents') : 'Guide only';
  const summary = [
    modeLabels[mode],
    review.sourceSelection,
    mode === 'guide' && review.result.planningEngine === 'local' ? 'Rule-based extraction' : undefined,
    scope,
  ];
  return (
    <header className="page-heading">
      <a className="back-link" href="#/"><ArrowLeft size={15} /> All reviews</a>
      <h1 tabIndex={-1}>{review.title}</h1>
      <p>{summary.filter(Boolean).join(' · ')}</p>
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

function ReviewDecisions({ entries, isGuide, onSelect }: {
  entries: (ReviewRow & { decision: Decision })[];
  isGuide: boolean;
  onSelect: (index: number) => void;
}) {
  return (
    <section className="library" aria-label="Review decisions">
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
      {!entries.length && <p className="empty-decisions">
        {isGuide ? 'Policy actions you record will appear here.' : 'Your responses and decisions will appear here.'}
      </p>}
    </section>
  );
}
