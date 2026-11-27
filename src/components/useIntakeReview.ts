import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Review } from '../review/model';
import type { ReviewProgressState } from '../review/reviewProgress';
import { openReviewSession } from '../review/reviewSession';

export type RunReview = (signal: AbortSignal, onProgress: (progress: ReviewProgressState) => void,
  mayWaitForQuota: () => boolean) => Promise<Review>;

type Run = { controller: AbortController; foreground: boolean; progress: ReviewProgressState; result?: Review };
type View = { kind: 'idle' | 'changed' } | { kind: 'running'; progress: ReviewProgressState };

export function useIntakeReview(policyStep: boolean, onDone: (review: Review) => void, onError: (error: unknown) => void) {
  const current = useRef<Run | null>(null);
  const task = useRef<RunReview | null>(null);
  const started = useRef<'early' | 'submitted' | null>(null);
  const [view, setView] = useState<View>({ kind: 'idle' });

  const cancel = useCallback(() => {
    const run = current.current;
    current.current = null;
    run?.controller.abort();
    setView({ kind: 'idle' });
  }, []);
  useLayoutEffect(() => {
    const run = current.current;
    if (!policyStep && run?.foreground) {
      // Returning to the source keeps the review available without opening its results over the form.
      run.foreground = false;
      setView({ kind: 'idle' });
    }
  }, [policyStep]);
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
    if (started.current === 'submitted') setView({ kind: 'changed' });
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
        if (current.current !== run) return;
        run.progress = progress;
        if (run.foreground) setView({ kind: 'running', progress });
      }, () => run.foreground);
      if (current.current !== run) return;
      run.result = result;
      if (run.foreground) onDone(result);
    } catch (cause) {
      if (current.current !== run) return;
      current.current = null;
      if (run.foreground) {
        setView({ kind: 'idle' });
        onError(cause);
      }
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
      started.current = 'submitted';
      if (run.result) onDone(run.result);
      else setView({ kind: 'running', progress: run.progress });
      return;
    }
    try {
      task.current ??= create();
    } catch (cause) {
      if (!early) onError(cause);
      return;
    }
    started.current = early ? 'early' : 'submitted';
    const next: Run = {
      controller: new AbortController(),
      foreground: !early,
      progress: { phase: 'preparing', message: 'Preparing review…' },
    };
    current.current = next;
    if (next.foreground) setView({ kind: 'running', progress: next.progress });
    void execute(next, task.current);
  }

  return { view, start, edit, cancel };
}
