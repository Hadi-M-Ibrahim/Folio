import { Check, Flag, X } from 'lucide-react';
import { policyActionLabels, responseLabels, type Decision, type Evidence, type PolicyAction } from '../review/model';

type EditorProps = {
  decision?: Decision;
  onChange: (changes: Partial<Omit<Decision, 'at'>>) => void;
};

export function PolicyActionEditor({ decision, onChange }: EditorProps) {
  return (
    <>
      <label className="decision-field">
        Policy action
        <select
          value={decision?.action || ''}
          onChange={(event) => {
            const action = event.target.value as PolicyAction | '';
            onChange({ action: action || undefined });
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
          onChange={(event) => onChange({ note: event.target.value })}
        />
      </label>
    </>
  );
}

export function ResponseEditor({ decision, onChange, onOpen, onRemoveCitation }: EditorProps & {
  onOpen: (evidence: Evidence) => void;
  onRemoveCitation: (evidence: Evidence) => void;
}) {
  const citations = decision?.citations ?? [];
  const confirmed = decision?.value === 'confirmed';
  const flagged = decision?.value === 'flagged';
  const hasAnswer = !!decision?.answer?.trim();

  function toggleDisposition(value: NonNullable<Decision['value']>) {
    onChange({ value: decision?.value === value ? undefined : value });
  }

  return (
    <>
      <label className="decision-field">
        Response for submission
        <textarea
          rows={3}
          placeholder="Write your response to this question."
          value={decision?.answer || ''}
          onChange={(event) => onChange({ answer: event.target.value })}
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
