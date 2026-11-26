import { useState } from 'react';
import { Check, ChevronDown, FileSearch, FileText, Plus, Search, SquareArrowOutUpRight } from 'lucide-react';
import { assessmentLabel, samePassage, type Evidence, type Finding, type Policy } from '../review/model';

type EvidenceControls = {
  citations: Evidence[];
  onOpen: (evidence: Evidence, term?: boolean) => void;
  onCite?: (evidence: Evidence) => void;
};

const passageLabels = {
  support: 'Supporting evidence',
  counter: 'Counterevidence',
  source: 'Originating passage',
  followup: 'New passage from follow-up',
};

function EvidenceCard({ evidence, kind, rank, citations, onOpen, onCite }: EvidenceControls & {
  evidence: Evidence;
  kind: keyof typeof passageLabels | 'candidate';
  rank?: number;
}) {
  const cited = citations.some((citation) => samePassage(citation, evidence));
  return (
    <article className={'evidence-card ' + kind}>
      <div className="evidence-label">
        <strong>{kind === 'candidate' ? 'Ranked match ' + rank : passageLabels[kind]}</strong>
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

const termOriginLabels = new Map([
  ['model', 'Model-planned term'],
  ['related_form', 'Related word form'],
  ['criterion', 'Requirement term'],
  ['followup', 'Follow-up term'],
]);

function TermProof({ proof, documents, onOpen }: {
  proof: Finding['searchProof'][number];
  documents: Policy[];
  onOpen: EvidenceControls['onOpen'];
}) {
  const hits = proof.totalHits ?? proof.matches.reduce((sum, match) => sum + match.count, 0);
  const pages = proof.totalPages ?? proof.matches.length;
  return (
    <div className="proof-term">
      <strong>{proof.term}</strong>
      <small>
        {termOriginLabels.get(proof.origin ?? '') ?? 'Search term'} · {hits} {hits === 1 ? 'hit' : 'hits'} across {pages} {pages === 1 ? 'page' : 'pages'}
      </small>
      {pages > proof.matches.length && <small>Showing {proof.matches.length} pages with the most hits</small>}
      {proof.matches.map(({ documentId, page, count }) => {
        const title = documents.find((document) => document.id === documentId)?.title || documentId;
        return (
          <button
            key={documentId + '/' + page}
            className="proof-page"
            onClick={() => onOpen({ documentId, title, page, quote: proof.term }, true)}
          >
            <FileText size={13} />
            {title} · p. {page}
            <em>{count} {count === 1 ? 'hit' : 'hits'}</em>
          </button>
        );
      })}
      {!proof.matches.length && <small>No exact matches</small>}
    </div>
  );
}

type Followup = NonNullable<Finding['followup']>;

const followupReasons: Record<Followup['reason'], string> = {
  cross_reference: 'Followed a cross-reference in the originating passage.',
  definition: 'Searched for a definition used in the originating passage.',
  apparent_conflict: 'Checked an apparent conflict involving the originating passage.',
};

function FollowupTrail({ followup, documents, ...controls }: EvidenceControls & {
  followup: Followup;
  documents: Policy[];
}) {
  const { reason, source, proof, passages, totalNewPassages } = followup;
  return (
    <section aria-labelledby="followup-heading">
      <div className="search-heading">
        <Search size={15} />
        <h3 id="followup-heading">Follow-up search</h3>
      </div>
      <p>{followupReasons[reason]}</p>
      <EvidenceCard evidence={source} kind="source" {...controls} />
      <TermProof proof={proof} documents={documents} onOpen={controls.onOpen} />
      {totalNewPassages === 0 && <p className="muted-note">This search found no new passages.</p>}
      {totalNewPassages > passages.length && (
        <p className="muted-note">Showing {passages.length} of {totalNewPassages} new passages.</p>
      )}
      {passages.map((evidence, i) => (
        <EvidenceCard key={i} evidence={evidence} kind="followup" {...controls} />
      ))}
    </section>
  );
}

export function PolicyEvidence({ finding, documents, isGuide, ...controls }: EvidenceControls & {
  finding: Finding;
  documents: Policy[];
  isGuide: boolean;
}) {
  const [showSearch, setShowSearch] = useState(false);
  const [termFilter, setTermFilter] = useState<string | null>(null);
  const termProof = termFilter ? finding.searchProof.filter((proof) => proof.term === termFilter) : finding.searchProof;
  const evidenceCount = finding.supporting.length + finding.counter.length;
  const leadMatch = evidenceCount === 0 ? finding.candidates[0] : undefined;

  const termCount = finding.totalSearchTerms ?? finding.searchTerms.length;
  const candidateCount = finding.totalCandidatePassages ?? finding.candidates.length;

  return (
    <>
      <div className="assessment">
        <small>
          {isGuide && 'Existing policy · '}
          {assessmentLabel(finding)}
        </small>
        <p>{finding.answer}</p>
      </div>
      {finding.supporting.map((evidence, i) => (
        <EvidenceCard key={i} evidence={evidence} kind="support" {...controls} />
      ))}
      {finding.counter.map((evidence, i) => (
        <EvidenceCard key={i} evidence={evidence} kind="counter" {...controls} />
      ))}
      {leadMatch && !showSearch && <EvidenceCard evidence={leadMatch} kind="candidate" rank={1} {...controls} />}
      {!evidenceCount && !leadMatch && (
        <div className="empty-inline">
          <FileSearch />
          <strong>No policy passages retrieved</strong>
        </div>
      )}
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
            <span className="count">{termCount}</span>
          </div>
          <div className="term-chips">
            {finding.searchTerms.map((term) => (
              <button
                key={term}
                aria-pressed={termFilter === term}
                onClick={() => setTermFilter((t) => (t === term ? null : term))}
              >
                {term}
              </button>
            ))}
          </div>
          {termCount > finding.searchTerms.length && (
            <p className="muted-note">Showing the first {finding.searchTerms.length} terms.</p>
          )}
          <details className="search-proof" key={termFilter || 'all'} open={!!termFilter || undefined}>
            <summary>
              Page-level search results
              <ChevronDown size={15} />
            </summary>
            {termProof.length ? (
              termProof.map((proof) => (
                <TermProof key={proof.term} proof={proof} documents={documents} onOpen={controls.onOpen} />
              ))
            ) : (
              <p>No terms recorded.</p>
            )}
          </details>
          {finding.followup && (
            <FollowupTrail followup={finding.followup} documents={documents} {...controls} />
          )}
          <div className="search-heading">
            <FileSearch size={15} />
            <h3>Ranked passages</h3>
            <span className="count">{candidateCount}</span>
          </div>
          {candidateCount > finding.candidates.length && (
            <p className="muted-note">Showing {finding.candidates.length} shortlisted passages.</p>
          )}
          {finding.candidates.length ? (
            finding.candidates.map((evidence, i) => (
              <EvidenceCard key={i} evidence={evidence} kind="candidate" rank={i + 1} {...controls} />
            ))
          ) : (
            <p className="muted-note">No passages retrieved for this requirement.</p>
          )}
        </div>
      )}
    </>
  );
}
