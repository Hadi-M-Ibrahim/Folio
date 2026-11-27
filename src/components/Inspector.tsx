import { BookOpen, SquareArrowOutUpRight } from 'lucide-react';
import { samePassage, statusLabels, type Decision, type Evidence, type Mode, type Policy, type ReviewRow } from '../review/model';
import { DecisionEditor } from './DecisionEditor';
import { PolicyEvidence } from './PolicyEvidence';
import './Inspector.css';

export function Inspector({
  row: { finding, index, decision },
  total,
  mode,
  documents,
  onOpen,
  onDecisionChange,
  onGuide,
  guideCitation,
}: {
  row: ReviewRow;
  total: number;
  mode: Mode;
  documents: Policy[];
  onOpen: (e: Evidence, term?: boolean) => void;
  onDecisionChange: (next: Decision | undefined) => void;
  onGuide: () => void;
  guideCitation?: string;
}) {
  const isGuide = mode === 'guide';
  const hasPolicyReview = !isGuide || documents.length > 0;
  const citations = decision?.citations ?? [];

  function updateDecision(changes: Partial<Omit<Decision, 'at'>>) {
    const next = { ...decision, ...changes };
    if (next.value === 'confirmed' && !('value' in changes)) next.value = undefined;
    onDecisionChange(
      next.answer || next.citations?.length || next.note || next.action || next.value
        ? { ...next, at: new Date().toISOString() }
        : undefined,
    );
  }

  function toggleCitation(evidence: Evidence) {
    const others = citations.filter((citation) => !samePassage(citation, evidence));
    updateDecision({ citations: others.length === citations.length ? [...citations, evidence] : others });
  }

  return (
    <section className="inspector" id="finding-detail" aria-label="Finding details" tabIndex={-1}>
      <header>
        <div className="inspector-meta">
          <span className="item-id">
            {isGuide ? 'Obligation' : 'Question'} {index + 1} of {total}
          </span>
          {hasPolicyReview && <span className={'badge ' + finding.status}><i />{statusLabels[finding.status]}</span>}
        </div>
        <h2>{finding.question}</h2>
        {isGuide && (
          <button className="text-link guide-link" onClick={onGuide}>
            <BookOpen size={14} />
            {guideCitation ?? 'Read guide passage'}
            <SquareArrowOutUpRight size={12} />
          </button>
        )}
      </header>
      {hasPolicyReview && (
        <PolicyEvidence
          finding={finding}
          documents={documents}
          isGuide={isGuide}
          citations={citations}
          onCite={toggleCitation}
          citeLabel={isGuide ? 'Cite in action' : 'Cite in response'}
          onOpen={onOpen}
        />
      )}
      <div className="decision-footer">
        <DecisionEditor mode={mode} finding={finding} decision={decision} onChange={updateDecision}
          onOpen={onOpen} onRemoveCitation={toggleCitation} />
      </div>
    </section>
  );
}
