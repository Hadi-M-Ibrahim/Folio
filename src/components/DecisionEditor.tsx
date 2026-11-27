import { Check, Flag, X } from 'lucide-react';
import { useRef, useState } from 'react';
import { policyActionLabels, responseLabels, type Decision, type Evidence, type Finding, type Mode } from '../review/model';
import { ResponseComposer } from './ResponseComposer';

type EditorProps = {
  decision?: Decision;
  onChange: (changes: Partial<Omit<Decision, 'at'>>) => void;
};

function PolicyActionChoices({ decision, onChange }: EditorProps) {
  return (
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
      {decision?.action && <button type="button" className="text-link clear-action" onClick={() => onChange({ action: undefined })}>Clear action</button>}
    </fieldset>
  );
}

type CitationControls = {
  onOpen: (evidence: Evidence) => void;
  onRemoveCitation: (evidence: Evidence) => void;
};

function SelectedCitations({ mode, citations, onOpen, onRemoveCitation }: CitationControls & {
  mode: Mode; citations: Evidence[];
}) {
  if (!citations.length) return null;
  return (
    <div className="response-citations">
      <h3>{mode === 'guide' ? 'Action citations' : 'Response citations'}</h3>
      <ol>
        {citations.map((citation, i) => (
          <li key={i}>
            <button type="button" className="text-link" onClick={() => onOpen(citation)} title={citation.quote}>
              {citation.title} · p. {citation.page}
            </button>
            <button type="button" className="remove-citation"
              aria-label={`Remove ${mode === 'guide' ? 'action' : 'response'} citation ${i + 1}`}
              onClick={() => onRemoveCitation(citation)}>
              <X size={14} />
            </button>
          </li>
        ))}
      </ol>
    </div>
  );
}

const editorLabels = {
  guide: { saved: 'Policy action saved', edit: 'Edit action', confirm: 'Save action', clear: 'Return to draft' },
  questionnaire: { saved: 'Response confirmed', edit: 'Edit response', confirm: 'Confirm response', clear: 'Clear confirmation' },
};

type Disposition = NonNullable<Decision['value']>;

function DecisionButtons({ mode, decision, onDisposition }: {
  mode: Mode; decision?: Decision; onDisposition: (value: Disposition) => void;
}) {
  const { answer = '', citations = [], action, value } = decision ?? {};
  const hasAnswer = Boolean(answer.trim());
  const needsCitation = mode === 'questionnaire' && hasAnswer && citations.length === 0;
  const canConfirm = mode === 'guide' ? Boolean(action) || hasAnswer : hasAnswer && citations.length > 0;
  return (
    <>
      {needsCitation && <small id="response-citation-hint" className="muted-note">
        Select “Cite in response” on a policy passage, then confirm your response. To revisit the question later, choose “Flag for follow-up”.
      </small>}
      <div className="decision-row">
        <button type="button" className="secondary" aria-pressed={value === 'confirmed'}
          aria-describedby={needsCitation ? 'response-citation-hint' : undefined}
          disabled={!canConfirm} onClick={() => onDisposition('confirmed')}>
          <Check size={15} />
          {value === 'confirmed' ? editorLabels[mode].clear : editorLabels[mode].confirm}
        </button>
        <button type="button" className="secondary" aria-pressed={value === 'flagged'} onClick={() => onDisposition('flagged')}>
          <Flag size={14} />
          {value === 'flagged' ? 'Remove flag' : 'Flag for follow-up'}
        </button>
      </div>
    </>
  );
}

export function DecisionEditor({ mode, finding, decision, onChange, onOpen, onRemoveCitation }: EditorProps & CitationControls & {
  mode: Mode;
  finding: Finding;
}) {
  const { citations = [], value: disposition } = decision ?? {};
  const isGuide = mode === 'guide';
  const labels = editorLabels[mode];
  const confirmed = disposition === 'confirmed';
  const [editing, setEditing] = useState(false);
  const toggle = useRef<HTMLButtonElement>(null);
  const collapsed = Boolean(disposition) && !editing;

  function toggleDisposition(value: Disposition) {
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
          {confirmed ? labels.saved : responseLabels.flagged}
        </span>
        <button type="button" className="text-link" ref={toggle} aria-describedby="response-status"
          aria-expanded={!collapsed} aria-controls="submission-response-editor" onClick={() => setEditing(!editing)}>
          {collapsed ? labels.edit : 'Close editor'}
        </button>
      </div>}
      <div id="submission-response-editor" className="response-fields" hidden={collapsed}>
        {isGuide && <PolicyActionChoices decision={decision} onChange={onChange} />}
        <ResponseComposer mode={mode} finding={finding} decision={decision} onChange={onChange} />
        {isGuide && <label className="decision-field action-note">
          Action note
          <textarea rows={2} placeholder="Add an optional note about this decision."
            value={decision?.note ?? ''} onChange={(event) => onChange({ note: event.target.value })} />
        </label>}
        <SelectedCitations mode={mode} citations={citations} onOpen={onOpen} onRemoveCitation={onRemoveCitation} />
        <DecisionButtons mode={mode} decision={decision} onDisposition={toggleDisposition} />
      </div>
    </>
  );
}
