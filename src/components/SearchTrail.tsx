import { useState } from 'react';
import { ChevronDown } from 'lucide-react';
import type { Finding, Policy } from '../review/model';
import { EvidenceCard, PassageContent, type EvidenceControls } from './EvidenceCard';
import './SearchTrail.css';

type Proof = Finding['searchProof'][number];
type Followup = NonNullable<Finding['followup']>;
type Section = 'Ranked passages' | 'Search terms' | 'Follow-up search';
const origins: Record<string, string> = {
  model: 'Model-planned term', related_form: 'Related word form', criterion: 'Requirement term', followup: 'Follow-up term',
};
const reasons: Record<Followup['reason'], string> = {
  cross_reference: 'Followed a cross-reference in the originating passage.',
  definition: 'Searched for a definition used in the originating passage.',
  apparent_conflict: 'Checked an apparent conflict involving the originating passage.',
};

function countLabel(count: number, unit: string) {
  return count.toLocaleString() + ' ' + unit + (count === 1 ? '' : 's');
}

function TermProof({ proof, documents, onOpen, expanded }: {
  proof: Proof; documents: Policy[]; onOpen: EvidenceControls['onOpen']; expanded: boolean;
}) {
  const hits = proof.totalHits ?? proof.matches.reduce((sum, match) => sum + match.count, 0);
  const pages = proof.totalPages ?? proof.matches.length;
  const label = (
    <span className="trail-term-label">
      <strong>{proof.term}</strong>
      <small>{origins[proof.origin ?? ''] ?? 'Search term'} · {hits
        ? countLabel(hits, 'hit') + ' across ' + countLabel(pages, 'page')
        : 'No exact matches'}</small>
    </span>
  );
  if (!pages && !proof.matches.length) return <div className="trail-term-empty">{label}</div>;
  return (
    <details className="trail-term" open={expanded || undefined}>
      <summary>{label}<ChevronDown size={15} aria-hidden="true" /></summary>
      {pages > proof.matches.length && <p className="muted-note">Showing {proof.matches.length} pages with the most hits.</p>}
      {proof.matches.map(({ documentId, page, count }) => {
        const title = documents.find(doc => doc.id === documentId)?.title || documentId;
        return <button type="button" key={documentId + '/' + page} className="trail-page"
          onClick={() => onOpen({ documentId, title, page, quote: proof.term }, true)}>
          <span>{title} · p. {page}</span><span>{countLabel(count, 'hit')}</span>
        </button>;
      })}
    </details>
  );
}

function SearchTerms({ finding, documents, selected, onSelect, onOpen }: {
  finding: Finding; documents: Policy[]; selected: string; onSelect: (term: string) => void; onOpen: EvidenceControls['onOpen'];
}) {
  const terms = [...new Set([...finding.searchTerms, ...finding.searchProof.map(proof => proof.term)])];
  const proofs = selected ? finding.searchProof.filter(proof => proof.term === selected) : finding.searchProof;
  const total = finding.totalSearchTerms ?? terms.length;
  return (
    <section aria-label="Search terms">
      {terms.length > 0 && <div className="trail-filter">
        <label htmlFor="trail-term-filter">Search term</label>
        <select id="trail-term-filter" value={selected} onChange={event => onSelect(event.target.value)}>
          <option value="">All terms</option>
          {terms.map(term => <option key={term}>{term}</option>)}
        </select>
      </div>}
      {total > terms.length && <p className="muted-note">Showing the first {terms.length} terms.</p>}
      {proofs.map(proof => <TermProof key={selected + '/' + proof.term} proof={proof} documents={documents}
        expanded={Boolean(selected)} onOpen={onOpen} />)}
      {!proofs.length && <p className="muted-note">{terms.length ? 'No page results recorded.' : 'No terms recorded.'}</p>}
    </section>
  );
}

function RankedPassages({ finding, ...controls }: EvidenceControls & { finding: Finding }) {
  const passages = finding.candidates;
  return (
    <section aria-label="Ranked passages">
      {(finding.totalCandidatePassages ?? 0) > passages.length &&
        <p className="muted-note">Showing {passages.length} shortlisted passages.</p>}
      {passages.map((passage, index) => (
        <article className="trail-match" key={index}>
          <details open={index === 0 || undefined}>
            <summary aria-label={`Ranked match ${index + 1}, ${passage.title}, p. ${passage.page}`}>
              <span className="trail-rank">{index + 1}</span>
              <strong>{passage.title}</strong><span className="trail-page-number">p. {passage.page}</span>
              <ChevronDown size={15} aria-hidden="true" />
            </summary>
            <PassageContent evidence={passage} compact {...controls} />
          </details>
        </article>
      ))}
      {!passages.length && <p className="muted-note">No passages retrieved for this requirement.</p>}
    </section>
  );
}

function FollowupSearch({ followup, documents, ...controls }: EvidenceControls & { followup: Followup; documents: Policy[] }) {
  const { reason, source, proof, passages, totalNewPassages } = followup;
  return (
    <section className="trail-followup" aria-label="Follow-up search">
      <p className="trail-reason">{reasons[reason]}</p>
      <EvidenceCard evidence={source} kind="source" {...controls} />
      <TermProof proof={proof} documents={documents} onOpen={controls.onOpen} expanded />
      {totalNewPassages === 0 && <p className="muted-note">This search found no new passages.</p>}
      {totalNewPassages > passages.length && <p className="muted-note">Showing {passages.length} of {totalNewPassages} new passages.</p>}
      {passages.map((passage, i) => <EvidenceCard key={i} evidence={passage} kind="followup" {...controls} />)}
    </section>
  );
}

export function SearchTrail({ finding, documents, open, onToggle, ...controls }: EvidenceControls & {
  finding: Finding; documents: Policy[]; open: boolean; onToggle: () => void;
}) {
  const [section, setSection] = useState<Section>(finding.candidates.length ? 'Ranked passages' : 'Search terms');
  const [term, setTerm] = useState('');
  const sections: { label: Section; count?: number }[] = [
    { label: 'Ranked passages', count: finding.totalCandidatePassages ?? finding.candidates.length },
    { label: 'Search terms', count: finding.totalSearchTerms ?? finding.searchTerms.length },
  ];
  if (finding.followup) sections.push({ label: 'Follow-up search' });
  return (
    <>
      <button type="button" aria-expanded={open} aria-controls="search-results" className="search-toggle" onClick={onToggle}>
        Search trail <ChevronDown size={16} aria-hidden="true" />
      </button>
      <div id="search-results" hidden={!open}>
        {open && <>
          <fieldset className="trail-sections" aria-label="Search trail sections">
            {sections.map(({ label, count }, index) => <button key={label} type="button" aria-label={label}
              aria-describedby={count === undefined ? undefined : 'trail-count-' + index}
              aria-pressed={section === label} onClick={() => setSection(label)}>
              {label}{count !== undefined && <small id={'trail-count-' + index}>{count.toLocaleString()}</small>}
            </button>)}
          </fieldset>
          {section === 'Ranked passages' && <RankedPassages finding={finding} {...controls} />}
          {section === 'Search terms' && <SearchTerms finding={finding} documents={documents} selected={term} onSelect={setTerm} onOpen={controls.onOpen} />}
          {section === 'Follow-up search' && finding.followup && <FollowupSearch followup={finding.followup} documents={documents} {...controls} />}
        </>}
      </div>
    </>
  );
}
