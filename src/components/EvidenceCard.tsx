import { Check, FileText, Plus, SquareArrowOutUpRight } from 'lucide-react';
import { samePassage, type Evidence } from '../review/model';

export type EvidenceControls = {
  citations: Evidence[];
  citeLabel: string;
  onOpen: (evidence: Evidence, term?: boolean) => void;
  onCite?: (evidence: Evidence) => void;
};

const passageLabels = {
  support: 'Supporting evidence',
  counter: 'Counterevidence',
  source: 'Originating passage',
  followup: 'New passage from follow-up',
};

export function PassageContent({ evidence, compact = false, citations, citeLabel, onOpen, onCite }: EvidenceControls & {
  evidence: Evidence; compact?: boolean;
}) {
  const cited = citations.some((citation) => samePassage(citation, evidence));
  return (
    <>
      <blockquote>“{evidence.quote}”</blockquote>
      <div className="evidence-tools">
        <button type="button" className="citation" onClick={() => onOpen(evidence)} title="View source page"
          aria-label={compact ? `Open ${evidence.title} · p. ${evidence.page}` : undefined}>
          {compact ? 'Open page' : <><FileText size={14} /><span>{evidence.title}</span><i />p. {evidence.page}</>}
          <SquareArrowOutUpRight size={12} />
        </button>
        {onCite && (
          <button type="button" className="text-link cite-response" onClick={() => onCite(evidence)}>
            {cited ? <Check size={13} /> : <Plus size={13} />}
            {cited ? 'Remove citation' : citeLabel}
          </button>
        )}
      </div>
    </>
  );
}

export function EvidenceCard({ evidence, kind, rank, ...controls }: EvidenceControls & {
  evidence: Evidence;
  kind: keyof typeof passageLabels | 'candidate';
  rank?: number;
}) {
  return (
    <article className={'evidence-card ' + kind}>
      <div className="evidence-label"><strong>{kind === 'candidate' ? 'Ranked match ' + rank : passageLabels[kind]}</strong></div>
      <PassageContent evidence={evidence} {...controls} />
    </article>
  );
}
