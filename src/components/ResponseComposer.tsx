import { PenLine, Undo2 } from 'lucide-react';
import { useLayoutEffect, useRef, useState } from 'react';
import { writeResponse, type DraftAction } from '../review/client';
import { samePassage, type Decision, type Evidence, type Finding } from '../review/model';

const actions = {
  draft: ['Generate response', 'Generating…'],
  shorten: ['Shorten', 'Shortening…'],
  simplify: ['Simplify', 'Simplifying…'],
  expand: ['Add detail', 'Adding detail…'],
} as const;
const refinements = ['shorten', 'simplify', 'expand'] as const;

function draftCitations(finding: Finding, selected: Evidence[]) {
  if (selected.length) return selected;
  const passages: Evidence[] = [];
  for (const evidence of [...finding.supporting, ...finding.counter]) {
    if (!passages.some(existing => samePassage(existing, evidence))) passages.push(evidence);
  }
  return passages;
}

export function ResponseComposer({ finding, decision, onChange }: {
  finding: Finding;
  decision?: Decision;
  onChange: (changes: Pick<Decision, 'answer' | 'citations'>) => void;
}) {
  const answer = decision?.answer ?? '';
  const [working, setWorking] = useState<{ decision?: Decision; action: DraftAction }>();
  const [failure, setFailure] = useState<{ decision?: Decision; message: string }>();
  const [undo, setUndo] = useState<{ before: string; after: string }>();
  const active = useRef<AbortController | null>(null);
  const input = useRef<HTMLTextAreaElement>(null);

  // A manual edit, citation change or navigation supersedes a pending rewrite.
  useLayoutEffect(() => () => active.current?.abort(), [finding, decision]);
  const pending = working?.decision === decision ? working?.action : undefined;
  const error = failure?.decision === decision ? failure?.message : undefined;

  async function compose(action: DraftAction) {
    if (active.current && !active.current.signal.aborted) return;
    const controller = new AbortController();
    active.current = controller;
    setWorking({ decision, action });
    setFailure(undefined);
    const selected = decision?.citations ?? [];
    const citations = action === 'draft' ? draftCitations(finding, selected) : selected;
    try {
      const next = await writeResponse(action, finding, answer, citations, controller.signal);
      if (controller.signal.aborted) return;
      if (action !== 'draft' && next !== answer) setUndo({ before: answer, after: next });
      onChange(action === 'draft' ? { answer: next, citations } : { answer: next });
      input.current?.focus({ preventScroll: true });
    } catch (cause) {
      if (!controller.signal.aborted) setFailure({ decision, message: cause instanceof Error ? cause.message : 'Please try again.' });
    } finally {
      if (active.current === controller) {
        active.current = null;
        setWorking(undefined);
      }
    }
  }

  const available = answer.trim() ? refinements : ['draft'] as const;
  return (
    <div className="decision-field response-composer">
      <label htmlFor="response-text">Response for submission</label>
      <div className="response-box">
        <textarea id="response-text" ref={input} rows={3} placeholder="Write your response to this question."
          value={answer} onChange={event => { setUndo(undefined); setFailure(undefined); onChange({ answer: event.target.value }); }} />
        <fieldset className="response-tools" aria-label="Response writing tools" disabled={!!pending}>
          {available.map(action => (
            <button key={action} type="button" onClick={() => void compose(action)}>
              {action === 'draft' && <PenLine size={14} aria-hidden="true" />}
              {actions[action][pending === action ? 1 : 0]}
            </button>
          ))}
          {undo && undo.after === answer && <button className="undo-response" type="button"
            onClick={() => { onChange({ answer: undo.before }); setUndo(undefined); input.current?.focus(); }}>
            <Undo2 size={13} aria-hidden="true" />Undo
          </button>}
        </fieldset>
      </div>
      {error && <p className="response-error" role="alert">{error}</p>}
    </div>
  );
}
