import { useState } from 'react';
import {
  BookOpen,
  Check,
  ChevronDown,
  FileSearch,
  FileText,
  Flag,
  Plus,
  Search,
  SquareArrowOutUpRight,
  X,
} from 'lucide-react';
import {
  guideSourceLabel,
  policyActionLabels,
  statusLabels,
  type Decision,
  type Evidence,
  type Finding,
  type Mode,
  type Policy,
  type PolicyAction,
  type Status,
} from '../review/model';
import './Inspector.css';

function Badge({ status }: { status: Status }) {
  return (
    <span className={'badge ' + status}>
      <i />
      {statusLabels[status]}
    </span>
  );
}
function EvidenceCard({
  evidence,
  kind,
  onOpen,
  rank,
  cited,
  onCite,
}: {
  evidence: Evidence;
  kind: 'support' | 'counter' | 'candidate';
  onOpen: (e: Evidence, term?: boolean) => void;
  rank?: number;
  cited?: boolean;
  onCite?: (evidence: Evidence) => void;
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
      <div className="evidence-tools">
        <button className="citation" onClick={() => onOpen(evidence)} title="View source page">
          <FileText size={14} />
          <span>{evidence.title}</span>
          <i />
          p. {evidence.page}
          <SquareArrowOutUpRight size={12} />
        </button>
        {onCite && (
          <button className="text-link cite-response" onClick={() => onCite(evidence)}>
            {cited ? <Check size={13} /> : <Plus size={13} />}
            {cited ? 'Remove citation' : 'Cite in response'}
          </button>
        )}
      </div>
    </article>
  );
}

function samePassage(left: Evidence, right: Evidence): boolean {
  return left.documentId === right.documentId && left.page === right.page && left.quote === right.quote;
}

export function Inspector({
  finding: f,
  mode,
  documents,
  onOpen,
  decision,
  onDecisionChange,
  index,
  onGuide,
  guideCitation,
}: {
  finding: Finding;
  mode: Mode;
  documents: Policy[];
  onOpen: (e: Evidence, term?: boolean) => void;
  decision?: Decision;
  onDecisionChange: (next: Decision | undefined) => void;
  index: number;
  onGuide: () => void;
  guideCitation?: string;
}) {
  const [showSearch, setShowSearch] = useState(false);
  const isGuide = mode === 'guide';
  const hasPolicyReview = !isGuide || documents.length > 0;
  const evidenceCount = f.supporting.length + f.counter.length;
  const [termFilter, setTermFilter] = useState<string | null>(null);
  const termProof = termFilter ? f.searchProof.filter((p) => p.term === termFilter) : f.searchProof;
  const nameFor = (id: string) => documents.find((d) => d.id === id)?.title || id;
  const leadMatch = evidenceCount === 0 ? f.candidates[0] : undefined;
  const citations = decision?.citations ?? [];
  const draftValue = decision?.value === 'confirmed' ? undefined : decision?.value;
  function updateDecision(changes: Partial<Omit<Decision, 'at'>>) {
    const next = { ...decision, ...changes };
    onDecisionChange(
      next.answer || next.citations?.length || next.note || next.action || next.value
        ? { ...next, at: new Date().toISOString() }
        : undefined,
    );
  }
  function toggleDisposition(value: Decision['value']) {
    updateDecision({ value: decision?.value === value ? undefined : value });
  }
  function isCited(evidence: Evidence): boolean {
    return citations.some((citation) => samePassage(citation, evidence));
  }
  function toggleCitation(evidence: Evidence) {
    const updated = isCited(evidence)
      ? citations.filter((citation) => !samePassage(citation, evidence))
      : [...citations, evidence];
    updateDecision({ citations: updated, value: draftValue });
  }
  function evidenceCard(evidence: Evidence, kind: 'support' | 'counter' | 'candidate', index: number) {
    return (
      <EvidenceCard
        key={kind + index}
        evidence={evidence}
        kind={kind}
        rank={index + 1}
        onOpen={onOpen}
        cited={isCited(evidence)}
        onCite={isGuide ? undefined : toggleCitation}
      />
    );
  }
  return (
    <section className="inspector panel" id="finding-detail" aria-label="Finding details" tabIndex={-1}>
      <header className="inspector-head">
        <div className="inspector-meta">
          <span className="item-id">
            {isGuide ? 'Obligation' : 'Question'} {index + 1}
          </span>
          {hasPolicyReview && <Badge status={f.status} />}
        </div>
        <h2>{f.question}</h2>
        {isGuide && f.criterionSource && f.criterionSource !== f.question && (
          <details className="guide-origin">
            <summary>Guide passage <ChevronDown size={14} /></summary>
            <blockquote>{f.criterionSource}</blockquote>
          </details>
        )}
        {isGuide && (
          <button className="text-link guide-link" onClick={onGuide}>
            <BookOpen size={14} />
            {guideCitation || guideSourceLabel(f)}
            <SquareArrowOutUpRight size={12} />
          </button>
        )}
      </header>
      {hasPolicyReview && (
        <>
          <div className="assessment">
            <small>
              {isGuide && 'Existing policy · '}
              {f.analysisEngine === 'anthropic' ? 'Model assessment' : 'Keyword search'}
            </small>
            <p>{f.answer}</p>
          </div>
          <div className="detail-body">
            {f.supporting.map((e, i) => evidenceCard(e, 'support', i))}
            {f.counter.map((e, i) => evidenceCard(e, 'counter', i))}
            {leadMatch && !showSearch && evidenceCard(leadMatch, 'candidate', 0)}
            {!evidenceCount && !leadMatch && (
              <div className="empty-inline">
                <FileSearch />
                <div>
                  <strong>No policy passages retrieved</strong>
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
                              : 'Search term'}{' '}
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
                f.candidates.map((e, i) => evidenceCard(e, 'candidate', i))
              ) : (
                <p className="muted-note">No passages retrieved for this requirement.</p>
              )}
            </div>
          )}
        </>
      )}
      <div className="decision-footer">
        {isGuide ? (
          <>
            <label className="decision-field">
              Policy action
              <select
                value={decision?.action || ''}
                onChange={(event) => {
                  const action = event.target.value as PolicyAction | '';
                  updateDecision({ action: action || undefined });
                }}
              >
                <option value="">Choose an action</option>
                {Object.entries(policyActionLabels).map(([action, label]) => (
                  <option key={action} value={action}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <label className="decision-field">
              Action note
              <textarea
                rows={2}
                placeholder="Describe the change or explain your decision."
                value={decision?.note || ''}
                onChange={(event) => updateDecision({ note: event.target.value })}
              />
            </label>
          </>
        ) : (
          <>
            <label className="decision-field">
              Response for submission
              <textarea
                rows={3}
                placeholder="Write your response to this question."
                value={decision?.answer || ''}
                onChange={(event) =>
                  updateDecision({
                    answer: event.target.value,
                    value: draftValue,
                  })
                }
              />
            </label>
            {citations.length > 0 && (
              <div className="response-citations">
                <h3>Response citations</h3>
                <ol>
                  {citations.map((citation, i) => (
                    <li key={i}>
                      <button className="text-link" onClick={() => onOpen(citation)} title={citation.quote}>
                        {citation.title} · p. {citation.page}
                      </button>
                      <button
                        className="remove-citation"
                        aria-label={`Remove response citation ${i + 1}`}
                        onClick={() => toggleCitation(citation)}
                      >
                        <X size={14} />
                      </button>
                    </li>
                  ))}
                </ol>
              </div>
            )}
            {decision?.answer?.trim() && !citations.length && (
              <small className="muted-note">Attach a citation to confirm this response, or flag it for follow-up.</small>
            )}
            <div className="decision-row">
              <button
                className={'secondary small ' + (decision?.value === 'confirmed' ? 'chosen' : '')}
                aria-pressed={decision?.value === 'confirmed'}
                disabled={!decision?.answer?.trim() || citations.length === 0}
                onClick={() => toggleDisposition('confirmed')}
              >
                <Check size={15} />
                {decision?.value === 'confirmed' ? 'Response confirmed' : 'Confirm response'}
              </button>
              <button
                className={'secondary small ' + (decision?.value === 'flagged' ? 'flagged' : '')}
                aria-pressed={decision?.value === 'flagged'}
                onClick={() => toggleDisposition('flagged')}
              >
                <Flag size={14} />
                {decision?.value === 'flagged' ? 'Flagged for follow-up' : 'Flag for follow-up'}
              </button>
            </div>
          </>
        )}
      </div>
    </section>
  );
}
