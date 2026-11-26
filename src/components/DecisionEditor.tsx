import { Check, Flag, X } from 'lucide-react';
import { useRef } from 'react';
import { policyActionLabels, responseLabels, samePassage, type Decision, type Evidence, type Finding } from '../review/model';

type EditorProps = {
  decision?: Decision;
  onChange: (changes: Partial<Omit<Decision, 'at'>>) => void;
};

export function PolicyActionEditor({ decision, onChange }: EditorProps) {
  return (
    <>
      <fieldset className="action-choices">
        <legend>Policy action</legend>
        <div>
          {(['write', 'update', 'no_change'] as const).map(action => (
            <label key={action}>
              <input type="radio" name="policy-action" checked={decision?.action === action} onChange={() => onChange({ action })} />
              {policyActionLabels[action]}
            </label>
          ))}
        </div>
        {decision?.action && <button className="text-link clear-action" onClick={() => onChange({ action: undefined })}>Clear action</button>}
      </fieldset>
      <label className="decision-field">
        Action note
        <textarea
          rows={2}
          placeholder="Describe the change or explain your decision."
          value={decision?.note || ''}
          onChange={(event) => onChange({ note: event.target.value })}
        />
      </label>
    </>
  );
}

export function ResponseEditor({ finding, decision, onChange, onOpen, onRemoveCitation }: EditorProps & {
  finding: Finding;
  onOpen: (evidence: Evidence) => void;
  onRemoveCitation: (evidence: Evidence) => void;
}) {
  const citations = decision?.citations ?? [];
  const confirmed = decision?.value === 'confirmed';
  const flagged = decision?.value === 'flagged';
  const hasAnswer = !!decision?.answer?.trim();
  const input = useRef<HTMLTextAreaElement>(null);
  const verified = [...finding.supporting, ...finding.counter];
  const canUseAnswer = !hasAnswer && finding.analysisEngine === 'anthropic' && verified.length > 0 &&
    ['supported', 'mixed', 'contradicted'].includes(finding.status);

  function useSuggestion() {
    const additional = verified.filter(passage => !citations.some(citation => samePassage(citation, passage)));
    onChange({ answer: finding.answer, citations: [...citations, ...additional] });
    input.current?.focus();
  }

  function toggleDisposition(value: NonNullable<Decision['value']>) {
    onChange({ value: decision?.value === value ? undefined : value });
  }

  return (
    <>
      <div className="decision-field">
        <div className="response-label">
          <label htmlFor="response-text">Response for submission</label>
          {canUseAnswer && <button className="text-link" onClick={useSuggestion}>Use suggested answer</button>}
        </div>
        <textarea
          id="response-text"
          ref={input}
          rows={3}
          placeholder="Write your response to this question."
          value={decision?.answer || ''}
          onChange={(event) => onChange({ answer: event.target.value })}
        />
      </div>
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
                  onClick={() => onRemoveCitation(citation)}
                >
                  <X size={14} />
                </button>
              </li>
            ))}
          </ol>
        </div>
      )}
      {hasAnswer && !citations.length && (
        <small className="muted-note">Attach a citation to confirm this response, or flag it for follow-up.</small>
      )}
      <div className="decision-row">
        <button
          className="secondary"
          aria-pressed={confirmed}
          disabled={!hasAnswer || citations.length === 0}
          onClick={() => toggleDisposition('confirmed')}
        >
          <Check size={15} />
          {confirmed ? 'Response confirmed' : 'Confirm response'}
        </button>
        <button
          className="secondary"
          aria-pressed={flagged}
          onClick={() => toggleDisposition('flagged')}
        >
          <Flag size={14} />
          {flagged ? responseLabels.flagged : 'Flag for follow-up'}
        </button>
      </div>
    </>
  );
}
