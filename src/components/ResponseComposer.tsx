import { PenLine, Undo2 } from 'lucide-react';
import { useLayoutEffect, useRef, useState } from 'react';
import { writePolicyAction, writeResponse, type DraftAction } from '../review/client';
import { samePassage, type Decision, type Evidence, type Finding, type Mode, type PolicyAction } from '../review/model';

const actions = {
  draft: ['Generate response', 'Generating…'],
  shorten: ['Shorten', 'Shortening…'],
  simplify: ['Simplify', 'Simplifying…'],
  expand: ['Add detail', 'Adding detail…'],
} as const;
const guideActions = { ...actions, draft: ['Generate policy action', 'Generating…'] } as const;
const refinements = ['shorten', 'simplify', 'expand'] as const;

function draftCitations(finding: Finding, selected: Evidence[]) {
  if (selected.length) return selected;
  const passages: Evidence[] = [];
  for (const evidence of [...finding.supporting, ...finding.counter]) {
    if (!passages.some(existing => samePassage(existing, evidence))) passages.push(evidence);
  }
  return passages;
}

function suggestedAction(finding: Finding): PolicyAction {
  if (finding.status === 'supported') return 'no_change';
  if (finding.status === 'mixed' || finding.status === 'contradicted' ||
    finding.supporting.length || finding.counter.length || finding.candidates.length) return 'update';
  return 'write';
}

async function composeDraft(mode: Mode, action: DraftAction, finding: Finding, decision: Decision | undefined, signal: AbortSignal) {
  const answer = decision?.answer ?? '';
  const selected = decision?.citations ?? [];
  if (mode === 'guide') {
    const disposition = decision?.action ?? suggestedAction(finding);
    const next = await writePolicyAction(action, finding, disposition, answer, selected, signal);
    return { answer: next, action: disposition };
  }
  const citations = action === 'draft' ? draftCitations(finding, selected) : selected;
  const next = await writeResponse(action, finding, answer, citations, signal);
  return action === 'draft' ? { answer: next, citations } : { answer: next };
}

export function ResponseComposer({ mode, finding, decision, onChange }: {
  mode: Mode;
  finding: Finding;
  decision?: Decision;
  onChange: (changes: Pick<Decision, 'answer' | 'citations' | 'action'>) => void;
}) {
  const answer = decision?.answer ?? '';
  const isGuide = mode === 'guide';
  const revision = decision?.at;
  const [working, setWorking] = useState<{ revision?: string; action: DraftAction }>();
  const [failure, setFailure] = useState<{ revision?: string; message: string }>();
  const [undo, setUndo] = useState<{ before: string; after: string }>();
  const active = useRef<AbortController | null>(null);
  const input = useRef<HTMLTextAreaElement>(null);

  // Refocusing the tab reloads the same decision from IndexedDB as a new object.
  useLayoutEffect(() => () => active.current?.abort(), [finding.id, revision]);
  const pending = working?.revision === revision ? working?.action : undefined;
  const error = failure?.revision === revision ? failure?.message : undefined;

  async function compose(action: DraftAction) {
    if (active.current && !active.current.signal.aborted) return;
    const controller = new AbortController();
    active.current = controller;
    setWorking({ revision, action });
    setFailure(undefined);
    try {
      const next = await composeDraft(mode, action, finding, decision, controller.signal);
      if (controller.signal.aborted) return;
      if (action !== 'draft' && next.answer !== answer) setUndo({ before: answer, after: next.answer });
      onChange(next);
      input.current?.focus({ preventScroll: true });
    } catch (cause) {
      if (!controller.signal.aborted) setFailure({ revision, message: cause instanceof Error ? cause.message : 'Please try again.' });
    } finally {
      if (active.current === controller) {
        active.current = null;
        setWorking(undefined);
      }
    }
  }

  const available = answer.trim() ? refinements : ['draft'] as const;
  const labels = isGuide ? guideActions : actions;
  return (
    <div className="decision-field response-composer">
      <label htmlFor="response-text">{isGuide ? 'Policy action draft' : 'Response for submission'}</label>
      <div className="response-box">
        <textarea id="response-text" ref={input} rows={3}
          placeholder={isGuide ? 'Describe how to address this obligation.' : 'Write your response to this question.'}
          value={answer} onChange={event => { setUndo(undefined); setFailure(undefined); onChange({ answer: event.target.value }); }} />
        <fieldset className="response-tools" aria-label={isGuide ? 'Policy action writing tools' : 'Response writing tools'} disabled={!!pending}>
          {available.map(action => (
            <button key={action} type="button" onClick={() => void compose(action)}>
              {action === 'draft' && <PenLine size={14} aria-hidden="true" />}
              {labels[action][pending === action ? 1 : 0]}
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
