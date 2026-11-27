import { Check, Flag, X } from 'lucide-react';
import { useRef, useState } from 'react';
import { policyActionLabels, responseLabels, type Decision, type Evidence, type Finding } from '../review/model';
import { ResponseComposer } from './ResponseComposer';

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
  const { answer = '', citations = [], value: disposition } = decision ?? {};
  const confirmed = disposition === 'confirmed';
  const flagged = disposition === 'flagged';
  const hasAnswer = Boolean(answer.trim());
  const needsCitation = hasAnswer && citations.length === 0;

  const [editing, setEditing] = useState(false);
  const toggle = useRef<HTMLButtonElement>(null);
  const collapsed = Boolean(disposition) && !editing;

  function toggleDisposition(value: NonNullable<Decision['value']>) {
    const next = disposition === value ? undefined : value;
    onChange({ value: next });
    setEditing(false);
    if (next) requestAnimationFrame(() => toggle.current?.focus({ preventScroll: true }));
  }

  return (
    <>
      {disposition && <div className="response-disposition">
        <span id="response-status">
          {confirmed ? <Check size={15} aria-hidden="true" /> : <Flag size={14} aria-hidden="true" />}
          {confirmed ? 'Response confirmed' : responseLabels.flagged}
        </span>
        <button type="button" className="text-link" ref={toggle} aria-describedby="response-status"
          aria-expanded={!collapsed} aria-controls="submission-response-editor" onClick={() => setEditing(!editing)}>
          {collapsed ? 'Edit response' : 'Close editor'}
        </button>
      </div>}
      <div id="submission-response-editor" className="response-fields" hidden={collapsed}>
        <ResponseComposer finding={finding} decision={decision} onChange={onChange} />
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
        {needsCitation && (
          <small id="response-citation-hint" className="muted-note">
            Select “Cite in response” on a policy passage, then confirm your response. To revisit the question later, choose “Flag for follow-up”.
          </small>
        )}
        <div className="decision-row">
          <button
            className="secondary"
            aria-pressed={confirmed}
            aria-describedby={needsCitation ? 'response-citation-hint' : undefined}
            disabled={!hasAnswer || citations.length === 0}
            onClick={() => toggleDisposition('confirmed')}
          >
            <Check size={15} />
            {confirmed ? 'Clear confirmation' : 'Confirm response'}
          </button>
          <button
            className="secondary"
            aria-pressed={flagged}
            onClick={() => toggleDisposition('flagged')}
          >
            <Flag size={14} />
            {flagged ? 'Remove flag' : 'Flag for follow-up'}
          </button>
        </div>
      </div>
    </>
  );
}
