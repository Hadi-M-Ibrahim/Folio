import { useSyncExternalStore } from 'react';
import type { Mode, Policy, Review, ReviewInput, Scope } from './model';
import type { ReviewProgressState } from './reviewProgress';
import { openReviewSession } from './reviewSession';
import type { ReviewCheckpoint } from './wholeReview';

export type ReviewWork = (signal: AbortSignal, onProgress: (progress: ReviewProgressState) => void,
  mayWaitForQuota: () => boolean, checkpoint: ReviewCheckpoint | undefined,
  onCheckpoint: (checkpoint: ReviewCheckpoint) => void) => Promise<Omit<Review, 'key' | 'title'>>;

// Selected documents retain their original PDF Files and the physical page numbers to review.
export type ReviewRecipe = {
  input: ReviewInput;
  sourceDocument?: Policy;
  sourceSelection?: string;
  scope?: Scope;
  questionPages?: number[][];
  renderItemSubset: boolean;
};

type Unfinished = { recipe: ReviewRecipe; checkpoint?: ReviewCheckpoint };
export type StoredJob = { key: string; title: string; mode: Mode } & (
  | ({ status: 'running' | 'paused' } & Unfinished)
  | ({ status: 'failed'; error: string } & Unfinished)
  | { status: 'complete'; review: Review }
);

type JobState = { kind: 'idle' | 'paused' | 'elsewhere' } | { kind: 'running'; progress: ReviewProgressState } |
  { kind: 'failed'; error: unknown } | { kind: 'complete'; review: Review };
const idle = { kind: 'idle' } as const;
const getIdle = () => idle;
const unsubscribe = () => {};
const subscribeToNothing = () => unsubscribe;

export class ReviewJob {
  private controller?: AbortController;
  private listeners = new Set<() => void>();
  private removeFromTab?: () => void;

  private constructor(private saved: StoredJob, private state: JobState, private work?: ReviewWork) {}

  static prepare(title: string, recipe: ReviewRecipe, work: ReviewWork) {
    const key = crypto.randomUUID();
    return new ReviewJob({ key, title, mode: recipe.input.mode, status: 'paused', recipe }, idle, work);
  }

  static restore(record: StoredJob, activeElsewhere = false) {
    if (record.status === 'complete') {
      const review = { ...record.review, key: record.key, title: record.title };
      return new ReviewJob({ ...record, review }, { kind: 'complete', review });
    }
    if (record.status === 'failed') return new ReviewJob(record, { kind: 'failed', error: Error(record.error) });
    if (record.status === 'running' && activeElsewhere) return new ReviewJob(record, { kind: 'elsewhere' });
    return new ReviewJob({ ...record, status: 'paused' }, { kind: 'paused' });
  }

  get key() { return this.saved.key; }
  get mode() { return this.saved.mode; }
  get title() { return this.saved.title; }
  get submitted() { return Boolean(this.removeFromTab); }
  track(remove: () => void) { this.removeFromTab = remove; }
  record() { return this.saved; }
  snapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  private publish(state: JobState) {
    this.state = state;
    for (const listener of this.listeners) listener();
  }

  rename(title: string) {
    if (title === this.title) return;
    if (this.saved.status === 'complete') {
      const review = { ...this.saved.review, title };
      this.saved = { ...this.saved, title, review };
      this.publish({ kind: 'complete', review });
    } else {
      this.saved = { ...this.saved, title };
      this.publish({ ...this.state });
    }
  }

  pause = () => {
    if (!this.controller || this.saved.status !== 'running') return;
    this.controller.abort();
    this.controller = undefined;
    this.saved = { ...this.saved, status: 'paused' };
    this.publish({ kind: 'paused' });
  };

  cancel = () => {
    this.controller?.abort();
    this.controller = undefined;
    this.removeFromTab?.();
    this.removeFromTab = undefined;
    if (this.saved.status === 'running') this.saved = { ...this.saved, status: 'paused' };
    this.publish(idle);
  };

  async start() {
    if (this.controller || this.saved.status === 'complete' || this.state.kind === 'elsewhere') return;
    const { recipe, checkpoint } = this.saved;
    const controller = new AbortController();
    this.controller = controller;
    const { signal } = controller;
    this.saved = { key: this.key, title: this.title, mode: this.mode, recipe, checkpoint, status: 'running' };
    this.publish({ kind: 'running', progress: { phase: 'preparing', message: 'Preparing review…' } });
    const onPageHide = () => this.submitted ? this.pause() : this.cancel();
    // WebKit can reject in-flight fetches during reload before dispatching pagehide.
    window.addEventListener('beforeunload', onPageHide, { signal });
    window.addEventListener('pagehide', onPageHide, { signal });
    let release: (() => void) | undefined;
    try {
      try {
        release = await openReviewSession(signal);
      } catch (cause) {
        if (!this.submitted || signal.aborted) throw cause;
      }
      signal.throwIfAborted();
      if (!this.work) {
        const { createReviewWork } = await import('../components/intakeReview');
        signal.throwIfAborted();
        this.work = createReviewWork(recipe);
      }
      const result = await this.work(signal, progress => {
        if (!signal.aborted) this.publish({ kind: 'running', progress });
      }, () => this.submitted, checkpoint, next => {
        if (signal.aborted || this.saved.status !== 'running') return;
        this.saved = { ...this.saved, checkpoint: next };
        this.publish(this.state);
      });
      signal.throwIfAborted();
      this.work = undefined;
      const review = { ...result, key: this.key, title: this.title };
      this.saved = { key: this.key, title: this.title, mode: this.mode, status: 'complete', review };
      this.publish({ kind: 'complete', review });
    } catch (error) {
      if (!signal.aborted && this.saved.status === 'running') {
        const message = error instanceof Error ? error.message : 'Could not finish the review. Try again.';
        this.saved = { ...this.saved, status: 'failed', error: message };
        this.publish({ kind: 'failed', error });
      }
    } finally {
      if (this.controller === controller) this.controller = undefined;
      release?.();
      window.removeEventListener('beforeunload', onPageHide);
      window.removeEventListener('pagehide', onPageHide);
    }
  }
}

export function useReviewState(job?: ReviewJob) {
  return useSyncExternalStore(job?.subscribe ?? subscribeToNothing, job?.snapshot ?? getIdle, getIdle);
}
