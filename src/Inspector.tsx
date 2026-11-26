import { useState } from 'react';
import {
  BookOpen,
  Check,
  ChevronDown,
  FileSearch,
  FileText,
  Flag,
  Search,
  SquareArrowOutUpRight,
} from 'lucide-react';
import {
  statusLabels,
  type Decision,
  type Evidence,
  type Finding,
  type Mode,
  type Policy,
  type Status,
} from './review';

export function Badge({ status }: { status: Status }) {
  return (
    <span className={'badge ' + status}>
      <i />
      {statusLabels[status]}
    </span>
  );
}
export function EvidenceCard({
  evidence,
  kind,
  onOpen,
  rank,
}: {
  evidence: Evidence;
  kind: 'support' | 'counter' | 'candidate';
  onOpen: (e: Evidence, term?: boolean) => void;
  rank?: number;
}) {
  return (
    <article className={'evidence-card ' + kind}>
      <div className="evidence-label">
        <strong>
          {kind === 'support'
            ? 'Supporting evidence'
            : kind === 'counter'
              ? 'Counterevidence'
              : 'Ranked match ' + rank}
        </strong>
      </div>
      <blockquote>“{evidence.quote}”</blockquote>
      <button className="citation" onClick={() => onOpen(evidence)} title="View source page">
        <FileText size={14} />
        <span>{evidence.title}</span>
        <i />
        p. {evidence.page}
        <SquareArrowOutUpRight size={12} />
      </button>
    </article>
  );
}
export function Inspector({
  finding: f,
  mode,
  documents,
  onOpen,
  decision,
  decide,
  index,
  onGuide,
}: {
  finding: Finding;
  mode: Mode;
  documents: Policy[];
  onOpen: (e: Evidence, term?: boolean) => void;
  decision?: Decision;
  decide: (decision?: Decision['value']) => void;
  index: number;
  onGuide: () => void;
}) {
  const [showSearch, setShowSearch] = useState(false);
  const isGuide = mode === 'guide';
  const evidenceCount = f.supporting.length + f.counter.length;
  const [termFilter, setTermFilter] = useState<string | null>(null);
  const termProof = termFilter ? f.searchProof.filter((p) => p.term === termFilter) : f.searchProof;
  const nameFor = (id: string) => documents.find((d) => d.id === id)?.title || id;
  return (
    <section className="inspector panel" id="finding-detail" aria-label="Finding details" tabIndex={-1}>
      <header className="inspector-head">
        <div className="inspector-meta">
          <span className="item-id">
            {isGuide ? 'Obligation' : 'Question'} {index + 1}
          </span>
          <Badge status={f.status} />
        </div>
        <h2>{f.question}</h2>
        {isGuide && f.criterionSource && (
          <details className="guide-origin">
            <summary>
              <BookOpen size={14} />
              Source obligation
              <ChevronDown size={14} />
            </summary>
            <blockquote>{f.criterionSource}</blockquote>
            <button className="text-link guide-link" onClick={onGuide}>
              <BookOpen size={13} />
              Read full guide
            </button>
          </details>
        )}
      </header>
      <div className="assessment">
        {f.analysisEngine === 'local' && <small>Keyword retrieval</small>}
        <p>{f.answer}</p>
      </div>
      <div className="detail-body">
        {f.supporting.map((e, i) => (
          <EvidenceCard key={'s' + i} evidence={e} kind="support" onOpen={onOpen} />
        ))}
        {f.counter.map((e, i) => (
          <EvidenceCard key={'c' + i} evidence={e} kind="counter" onOpen={onOpen} />
        ))}
        {!evidenceCount && (
          <div className="empty-inline">
            <FileSearch />
            <div>
              <strong>No classified evidence</strong>
              <p>
                {f.candidates.length
                  ? 'Open the search trail to inspect the retrieved passages.'
                  : 'The supplied pages yielded no classified passages for this requirement.'}
              </p>
              {!!f.candidates.length && (
                <button className="text-link" onClick={() => setShowSearch(true)}>
                  Inspect ranked matches
                </button>
              )}
            </div>
          </div>
        )}
      </div>
      <button
        aria-expanded={showSearch}
        aria-controls="search-results"
        className="search-toggle"
        onClick={() => setShowSearch(!showSearch)}
      >
        Search trail <ChevronDown size={16} />
      </button>
      {showSearch && (
        <div id="search-results">
          <div className="search-heading">
            <Search size={15} />
            <h3>Search terms</h3>
            <span className="count">{f.totalSearchTerms ?? f.searchTerms.length}</span>
          </div>
          <div className="term-chips">
            {f.searchTerms.map((term) => (
              <button
                className={termFilter === term ? 'active' : ''}
                key={term}
                aria-pressed={termFilter === term}
                onClick={() => setTermFilter((t) => (t === term ? null : term))}
              >
                {term}
              </button>
            ))}
          </div>
          {(f.totalSearchTerms ?? 0) > f.searchTerms.length && (
            <p className="muted-note">Showing the first {f.searchTerms.length} terms.</p>
          )}
          <details className="search-proof" key={termFilter || 'all'} open={!!termFilter || undefined}>
            <summary>
              Page-level search results
              <ChevronDown size={15} />
            </summary>
            {termProof.length ? (
              termProof.map((p) => (
                <div className="proof-term" key={p.term}>
                  <strong>{p.term}</strong>
                  <small>
                    {p.origin === 'model'
                      ? 'Model-planned term'
                      : p.origin === 'related_form'
                        ? 'Related word form'
                        : p.origin === 'criterion'
                          ? 'Requirement term'
                          : 'Prepared search term'}{' '}
                    · {p.totalHits ?? p.matches.reduce((n, m) => n + m.count, 0)} hits across{' '}
                    {p.totalPages ?? p.matches.length} pages
                  </small>
                  {(p.totalPages ?? 0) > p.matches.length && (
                    <small>Showing {p.matches.length} pages with the most hits</small>
                  )}
                  {p.matches.length ? (
                    p.matches.map((m, i) => (
                      <button
                        key={i}
                        className="proof-page"
                        onClick={() =>
                          onOpen(
                            {
                              documentId: m.documentId,
                              title: nameFor(m.documentId),
                              page: m.page,
                              quote: p.term,
                            },
                            true,
                          )
                        }
                      >
                        <FileText size={13} />
                        {nameFor(m.documentId)} · p. {m.page}
                        <em>
                          {m.count} {m.count === 1 ? 'hit' : 'hits'}
                        </em>
                      </button>
                    ))
                  ) : (
                    <small>No exact matches</small>
                  )}
                </div>
              ))
            ) : (
              <p>No terms recorded.</p>
            )}
          </details>
          <div className="search-heading">
            <FileSearch size={15} />
            <h3>Ranked passages</h3>
            <span className="count">{f.totalCandidatePassages ?? f.candidates.length}</span>
          </div>
          {(f.totalCandidatePassages ?? 0) > f.candidates.length && (
            <p className="muted-note">Showing {f.candidates.length} shortlisted passages.</p>
          )}
          {f.candidates.length ? (
            f.candidates.map((e, i) => (
              <EvidenceCard key={i} evidence={e} kind="candidate" rank={i + 1} onOpen={onOpen} />
            ))
          ) : (
            <p className="muted-note">No passages retrieved for this requirement.</p>
          )}
        </div>
      )}
      <div className="decision-footer">
        <div className="decision-row">
          <button
            className={'secondary small ' + (decision?.value === 'confirmed' ? 'chosen' : '')}
            aria-pressed={decision?.value === 'confirmed'}
            onClick={() => decide(decision?.value === 'confirmed' ? undefined : 'confirmed')}
          >
            <Check size={15} />
            {decision?.value === 'confirmed' ? 'Confirmed' : 'Confirm finding'}
          </button>
          <button
            className={'secondary small ' + (decision?.value === 'flagged' ? 'flagged' : '')}
            aria-pressed={decision?.value === 'flagged'}
            onClick={() => decide(decision?.value === 'flagged' ? undefined : 'flagged')}
          >
            <Flag size={14} />
            {decision?.value === 'flagged' ? 'Flagged for follow-up' : 'Flag for follow-up'}
          </button>
        </div>
      </div>
    </section>
  );
}
