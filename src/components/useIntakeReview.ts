import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Review } from '../review/model';
import type { ReviewProgressState } from '../review/reviewProgress';
import { openReviewSession } from '../review/reviewSession';

export type RunReview = (signal: AbortSignal, onProgress: (progress: ReviewProgressState) => void,
  mayWaitForQuota: () => boolean) => Promise<Review>;

type Run = { controller: AbortController; foreground: boolean; result?: Review };
type View = { kind: 'fresh' | 'idle' | 'ready' | 'changed' } | { kind: 'running'; progress: ReviewProgressState; foreground: boolean };

export function useIntakeReview(policyStep: boolean, onDone: (review: Review) => void, onError: (error: unknown) => void) {
  const current = useRef<Run | null>(null);
  const task = useRef<RunReview | null>(null);
  const started = useRef(false);
  const [view, setView] = useState<View>({ kind: 'fresh' });

  const cancel = useCallback(() => {
    const run = current.current;
    current.current = null;
    run?.controller.abort();
    setView({ kind: started.current ? 'idle' : 'fresh' });
  }, []);
  useLayoutEffect(() => {
    if (!policyStep && current.current?.foreground) cancel();
  }, [policyStep, cancel]);
  useEffect(() => {
    window.addEventListener('pagehide', cancel);
    return () => {
      window.removeEventListener('pagehide', cancel);
      const run = current.current;
      current.current = null;
      run?.controller.abort();
    };
  }, [cancel]);

  function edit() {
    task.current = null;
    if (current.current) cancel();
    if (started.current) setView({ kind: 'changed' });
  }

  async function execute(run: Run, work: RunReview) {
    const { signal } = run.controller;
    let release: (() => void) | undefined;
    try {
      try {
        release = await openReviewSession(signal);
      } catch (cause) {
        // If session storage is unavailable, only an explicit submission may proceed.
        if (!run.foreground || signal.aborted) throw cause;
      }
      signal.throwIfAborted();
      const result = await work(signal, progress => {
        if (current.current === run) setView({ kind: 'running', foreground: run.foreground, progress });
      }, () => run.foreground);
      if (current.current !== run) return;
      run.result = result;
      if (run.foreground) onDone(result);
      else setView({ kind: 'ready' });
    } catch (cause) {
      if (current.current !== run) return;
      current.current = null;
      setView({ kind: 'idle' });
      if (run.foreground) onError(cause);
    } finally {
      release?.();
    }
  }

  function start(create: () => RunReview, early = false) {
    if (early && started.current) return;
    const run = current.current;
    if (run) {
      if (run.foreground) return;
      run.foreground = true;
      if (run.result) onDone(run.result);
      else {
        setView(state => state.kind === 'running' ? { ...state, foreground: true } : state);
      }
      return;
    }
    try {
      task.current ??= create();
    } catch (cause) {
      if (!early) onError(cause);
      return;
    }
    started.current = true;
    const next = { controller: new AbortController(), foreground: !early };
    current.current = next;
    setView({ kind: 'running', foreground: !early, progress: { phase: 'preparing', message: 'Preparing review…' } });
    void execute(next, task.current);
  }

  return { view, start, edit, cancel, started: view.kind !== 'fresh' };
}
