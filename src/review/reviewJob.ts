import { useSyncExternalStore } from 'react';
import type { Mode, Review } from './model';
import type { ReviewProgressState } from './reviewProgress';
import { openReviewSession } from './reviewSession';

type Work = (signal: AbortSignal, onProgress: (progress: ReviewProgressState) => void,
  mayWaitForQuota: () => boolean) => Promise<Omit<Review, 'key' | 'title'>>;

type JobState = { kind: 'idle' } | { kind: 'running'; progress: ReviewProgressState } |
  { kind: 'failed'; error: unknown } | { kind: 'complete'; review: Review };
const idle = { kind: 'idle' } as const;
const getIdle = () => idle;
const unsubscribe = () => {};
const subscribeToNothing = () => unsubscribe;

export class ReviewJob {
  readonly key = crypto.randomUUID();
  private state: JobState = idle;
  private controller?: AbortController;
  private listeners = new Set<() => void>();
  private removeFromTab?: () => void;
  private work?: Work;

  constructor(readonly mode: Mode, readonly title: string, work: Work) {
    this.work = work;
  }

  get submitted() { return Boolean(this.removeFromTab); }
  track(remove: () => void) { this.removeFromTab = remove; }
  snapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  private publish(state: JobState) {
    this.state = state;
    for (const listener of this.listeners) listener();
  }

  cancel = () => {
    this.controller?.abort();
    this.controller = undefined;
    this.removeFromTab?.();
    this.removeFromTab = undefined;
    this.publish(idle);
  };

  async start() {
    if (this.controller || !this.work) return;
    const controller = new AbortController();
    this.controller = controller;
    const { signal } = controller;
    this.publish({ kind: 'running', progress: { phase: 'preparing', message: 'Preparing review…' } });
    const onPageHide = () => this.cancel();
    window.addEventListener('pagehide', onPageHide, { signal });
    let release: (() => void) | undefined;
    try {
      try {
        release = await openReviewSession(signal);
      } catch (cause) {
        if (!this.submitted || signal.aborted) throw cause;
      }
      signal.throwIfAborted();
      const result = await this.work(signal, progress => {
        if (!signal.aborted) this.publish({ kind: 'running', progress });
      }, () => this.submitted);
      signal.throwIfAborted();
      this.work = undefined;
      this.publish({ kind: 'complete', review: { ...result, key: this.key, title: this.title } });
    } catch (error) {
      if (!signal.aborted) this.publish({ kind: 'failed', error });
    } finally {
      if (this.controller === controller) this.controller = undefined;
      release?.();
      window.removeEventListener('pagehide', onPageHide);
    }
  }
}

export function useReviewState(job?: ReviewJob) {
  return useSyncExternalStore(job?.subscribe ?? subscribeToNothing, job?.snapshot ?? getIdle, getIdle);
}
