import { deleteDraft, readDraft, writeDraftParts } from '../review/localReviews';
import type { IntakePolicy, Mode, Policy, Scope } from '../review/model';
import { emptyPolicyDraft } from './PolicyFields';
import type { IntakeSource } from './SourceFields';

export type PolicyRanges = Record<string, Policy['pages']>;
export type IntakeDraft = {
  policies: IntakePolicy[];
  source: IntakeSource;
  selection: { mode: Mode; policyRanges: PolicyRanges; scope?: Scope };
  supplemental: typeof emptyPolicyDraft;
};

const parts = ['policies', 'source', 'selection', 'supplemental'] as const;
export const draftWarning = 'Folio couldn’t save or restore this draft on this device. You can keep working in this tab.';

export class IntakeDraftSession {
  private readonly key: string;
  private readonly restoring: boolean;
  private previous?: IntakeDraft;
  private unsaved = new Set<keyof IntakeDraft>();
  private submittedKey?: string;
  private submission?: symbol;

  constructor(readonly workflow: Mode) {
    const entry = window.history.state;
    const prefix = 'intake:' + workflow + ':';
    this.restoring = typeof entry?.folioDraft === 'string' && entry.folioDraft.startsWith(prefix);
    this.key = this.restoring ? entry.folioDraft : prefix + crypto.randomUUID();
    this.submittedKey = this.restoring ? entry.folioSubmitted : undefined;
  }

  get submitted() { return this.submittedKey; }

  beginSubmission() {
    this.submission = Symbol();
    return this.submission;
  }

  isCurrent(submission: symbol) { return this.submission === submission; }

  markSubmitted(key: string) {
    this.submittedKey = key;
    if (window.history.state?.folioDraft === this.key) this.rememberEntry();
  }

  reopen() {
    this.submission = undefined;
    this.submittedKey = undefined;
    this.rememberEntry();
  }

  // The two steps share an ID. A new link from home gets its own history entry and draft.
  rememberEntry() {
    const entry = window.history.state;
    if (entry?.folioDraft !== this.key || entry.folioSubmitted !== this.submitted) {
      window.history.replaceState({ ...entry, folioDraft: this.key, folioSubmitted: this.submitted }, '');
    }
  }

  empty(): IntakeDraft {
    this.previous = {
      policies: [], source: { text: '', name: '' }, selection: { mode: this.workflow, policyRanges: {} }, supplemental: emptyPolicyDraft,
    };
    return this.previous;
  }

  private slot(part: keyof IntakeDraft) { return this.key + ':' + part; }

  async load(): Promise<IntakeDraft> {
    const draft = this.empty();
    if (this.restoring) {
      const [policies, source, selection, supplemental] = await Promise.all([
        readDraft<IntakeDraft['policies']>(this.slot('policies')),
        readDraft<IntakeDraft['source']>(this.slot('source')),
        readDraft<IntakeDraft['selection']>(this.slot('selection')),
        readDraft<IntakeDraft['supplemental']>(this.slot('supplemental')),
      ]);
      draft.policies = policies ?? draft.policies;
      draft.source = source ?? draft.source;
      draft.selection = selection ?? draft.selection;
      draft.supplemental = supplemental ?? draft.supplemental;
    }
    this.previous = draft;
    return draft;
  }

  async save(next: IntakeDraft) {
    const changes = parts.filter(part => this.unsaved.has(part) || this.previous?.[part] !== next[part]);
    if (!changes.length) return false;
    const entries: Record<string, unknown> = {};
    for (const part of changes) entries[this.slot(part)] = next[part];
    this.previous = next;
    try {
      // IndexedDB orders these transactions, including a subsequent discard.
      await writeDraftParts(entries);
      for (const part of changes) this.unsaved.delete(part);
      return this.unsaved.size === 0;
    } catch (error) {
      for (const part of changes) this.unsaved.add(part);
      throw error;
    }
  }

  discard() {
    this.previous = undefined;
    return deleteDraft(...parts.map(part => this.slot(part)));
  }

  async leave() {
    // A pending registration will discard its draft after the review commits.
    if (!this.submission) await this.discard();
  }
}
