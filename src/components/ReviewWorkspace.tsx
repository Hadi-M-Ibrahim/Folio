import { useRef, useState } from 'react';
import {
  ArrowLeft, ArrowRight, BookOpen, Check, ChevronRight, Download, FileText,
  Flag, Search, SlidersHorizontal, X,
} from 'lucide-react';
import { exportReview } from '../review/exportReview';
import { guideCitation, guideLocation, submittedSource, type SourceLocation } from '../review/guideSource';
import {
  modeLabels, policyActionLabels, statusLabels, statusOrder, type Decision,
  type Evidence, type Review, type Status,
} from '../review/model';
import { Inspector } from './Inspector';
import { SourceDialog } from './SourceDialog';

type Props = {
  review: Review;
  decisions: ReadonlyMap<string, { decision: Decision }>;
  onDecisionChange: (key: string, decision?: Decision) => void;
};

export function ReviewWorkspace({ review, decisions, onDecisionChange }: Props) {
  const [nav, setNav] = useState<'findings' | 'documents' | 'decisions'>('findings');
  const [source, setSource] = useState<SourceLocation | null>(null);
  const [selected, setSelected] = useState(0);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<Status | 'all'>('all');
  const [filters, setFilters] = useState(false);
  const [showQueue, setShowQueue] = useState(false);
  const detailRef = useRef<HTMLDivElement>(null);
  const { mode, documents } = review.input;
  const findings = review.result.findings;
  const isGuide = mode === 'guide';
  const hasPolicies = documents.length > 0;
  const itemLabel = isGuide ? 'obligation' : 'question';
  const groupLabel = isGuide ? 'Obligations' : 'Questions';
  const notice = review.input.allowModel || review.result.criterionLimitReached ? review.result.notice : '';
  const scopeNote = review.scope ? `Search covers ${review.scope.selectedPages} selected pages of ${review.scope.sourcePages.toLocaleString()}.` : '';
  const visible = findings
    .map((f, i) => ({ f, i }))
    .filter(({ f }) =>
      (filter === 'all' || filter === f.status) &&
      (f.question + ' ' + f.id).toLowerCase().includes(search.trim().toLowerCase()),
    );
  const currentRow = visible.find(({ i }) => i === selected) ?? visible[0];
  const current = currentRow?.f;
  const entries = findings.flatMap((finding, index) => {
    const decision = decisions.get(review.key + '/' + finding.id)?.decision;
    return decision ? [{ finding, index, decision }] : [];
  });
  const reviewed = entries.filter(({ decision }) => isGuide ? decision.action : decision.value).length;
  const next = currentRow && visible.find(({ i }) => i > currentRow.i);

  function selectFinding(index: number, focus = false) {
    setNav('findings');
    setSelected(index);
    setShowQueue(false);
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
      <header className="page-heading">
        <a className="back-link" href="#/"><ArrowLeft size={15} /> All reviews</a>
        <h1 tabIndex={-1}>{review.title}</h1>
        <p>{[
          modeLabels[mode], review.sourceSelection,
          isGuide && review.result.planningEngine === 'local' ? 'Rule-based extraction' : undefined,
          documents.length ? documents.length + (documents.length === 1 ? ' policy document' : ' policy documents') : 'Guide only',
        ].filter(Boolean).join(' · ')}</p>
      </header>
      <div className="review-toolbar">
        <nav className="mode-tabs" aria-label="This review">
          <button aria-pressed={nav === 'findings'} onClick={() => setNav('findings')}>{groupLabel}</button>
          <button aria-pressed={nav === 'documents'} onClick={() => setNav('documents')}>Source documents</button>
          <button aria-pressed={nav === 'decisions'} onClick={() => setNav('decisions')}>Decisions</button>
        </nav>
        <button className="report-link" onClick={() => exportReview(review, decisions)}>
          <Download size={15} /> {isGuide ? 'Download action list' : 'Download responses'}
        </button>
      </div>
      {nav === 'findings' && (
        <>
          {(notice || scopeNote) && <output className="run-notice">{[notice, scopeNote].filter(Boolean).join(' ')}</output>}
          <div className="work-grid">
            <aside className="queue" aria-label="Review queue" data-expanded={showQueue}>
              <button
                className="mobile-queue"
                aria-expanded={showQueue}
                aria-controls="review-queue"
                onClick={() => setShowQueue(!showQueue)}
              >
                {groupLabel} ({findings.length})
                <span>{showQueue ? 'Hide list' : 'Show list'}</span>
              </button>
              <div id="review-queue">
                <div className="queue-head">
                  <div className="section-title">
                    <h2>{groupLabel}</h2>
                    <span>
                      {reviewed}/{findings.length} reviewed
                    </span>
                  </div>
                  <div className="queue-controls">
                    <div className="queue-search">
                      <Search size={15} />
                      <input
                        aria-label="Search findings"
                        placeholder="Search findings…"
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                      />
                      {search && (
                        <button aria-label="Clear search" onClick={() => setSearch('')}>
                          <X size={13} />
                        </button>
                      )}
                    </div>
                    {hasPolicies && <button
                      className={'filter-button ' + (filters || filter !== 'all' ? 'active' : '')}
                      aria-label="Filter by finding status"
                      aria-expanded={filters}
                      onClick={() => setFilters(!filters)}
                    >
                      <SlidersHorizontal size={16} />
                    </button>}
                  </div>
                  {filters && (
                    <label className="filter-select">
                      Status
                      <select value={filter} onChange={(e) => setFilter(e.target.value as Status | 'all')}>
                        <option value="all">All statuses</option>
                        {statusOrder.map((s) => (
                          <option key={s} value={s}>
                            {statusLabels[s]}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                </div>
                <div className="queue-items">
                  {visible.map(({ f, i }) => {
                    const decision = decisions.get(review.key + '/' + f.id)?.decision;
                    return (
                      <button
                        className={'queue-row ' + (i === currentRow?.i ? 'selected' : '')}
                        key={f.id}
                        aria-pressed={i === currentRow?.i}
                        onClick={() => selectFinding(i)}
                      >
                        <span className="row-top">
                          <span className="row-name">{f.question}</span>
                          {(decision?.value || decision?.action) &&
                            (decision.value !== 'flagged' ? (
                              <Check size={13} aria-label="Reviewed" />
                            ) : (
                              <Flag size={13} aria-label="Flagged" />
                            ))}
                        </span>
                        <span className="row-status">
                          {decision?.action ? policyActionLabels[decision.action] : hasPolicies ? statusLabels[f.status] : 'Action pending'}
                        </span>
                      </button>
                    );
                  })}
                  {!visible.length && (
                    <div className="empty-list">
                      <Search size={20} />
                      <p>No matching findings</p>
                      {(search || filter !== 'all') && (
                        <button
                          className="text-link"
                          onClick={() => {
                            setSearch('');
                            setFilter('all');
                          }}
                        >
                          Clear filters
                        </button>
                      )}
                    </div>
                  )}
                </div>
              </div>
            </aside>
            <div ref={detailRef} className="detail-wrap">
              {current ? (
                <>
                  <Inspector
                    key={review.key + '/' + current.id}
                    finding={current}
                    mode={mode}
                    documents={review.input.documents}
                    onOpen={openEvidence}
                    onGuide={() => setSource(guideLocation(review, current))}
                    guideCitation={isGuide ? guideCitation(review, current) : undefined}
                    index={currentRow.i}
                    decision={decisions.get(review.key + '/' + current.id)?.decision}
                    onDecisionChange={(decision) => onDecisionChange(review.key + '/' + current.id, decision)}
                  />
                  {next && (
                    <button className="next-finding" onClick={() => selectFinding(next.i, true)}>
                      Next {itemLabel}<ArrowRight size={16} />
                    </button>
                  )}
                </>
              ) : (
                <div className="panel empty-list">
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
      {nav === 'documents' && (
        <section className="library" aria-label="Source documents">
          {[submittedSource(review), ...documents].map((doc, i) => (
            <button
              className="library-row" key={(i === 0 ? 'source-' : 'policy-') + doc.id}
              onClick={() => setSource({ doc, page: doc.pages[0].number, quote: '', unpaginated: i === 0 && !review.sourceDocument })}
            >
              <FileText size={21} />
              <span>
                <strong>{doc.title}</strong>
                <small>{i === 0 ? modeLabels[mode] : 'Policy'} · {i === 0 && !review.sourceDocument ? 'Submitted text' : doc.pages.length + (doc.pages.length === 1 ? ' page' : ' pages')}</small>
              </span>
              <ChevronRight size={16} />
            </button>
          ))}
        </section>
      )}
      {nav === 'decisions' && (
        <section className="library" aria-label="Review decisions">
          {entries.length ? entries.map(({ finding, decision, index }) => (
            <button key={finding.id} className="library-row decision-entry" onClick={() => {
              setSearch('');
              setFilter('all');
              selectFinding(index, true);
            }}>
              <span>
                <small>{decision.action ? policyActionLabels[decision.action] :
                  decision.value === 'confirmed' ? 'Confirmed' : decision.value === 'flagged' ? 'Flagged for follow-up' : 'Draft'}</small>
                <strong>{finding.question}</strong>
                {(decision.note || decision.answer) && <span className="entry-text">{decision.note || decision.answer}</span>}
              </span>
              <ChevronRight size={16} />
            </button>
          )) : <p className="empty-decisions">{isGuide ? 'Policy actions you record will appear here.' : 'Your responses and decisions will appear here.'}</p>}
        </section>
      )}
      {source && <SourceDialog location={source} onClose={() => setSource(null)} />}
    </section>
  );
}
