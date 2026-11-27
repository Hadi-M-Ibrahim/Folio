import { useEffect, useRef, useState } from 'react';
import { ReviewJob, useReviewState } from '../review/reviewJob';
import type { ReviewProgressState } from '../review/reviewProgress';

type View = { kind: 'idle' | 'changed' } | { kind: 'running'; progress: ReviewProgressState };

export function useIntakeReview(sourceStep: boolean, onSubmit: (job: ReviewJob) => void, onError: (cause: unknown) => void) {
  const current = useRef<ReviewJob>(undefined);
  const started = useRef<'early' | 'submitted' | undefined>(undefined);
  const [job, setJob] = useState<ReviewJob>();
  const [submittedFrom, setSubmittedFrom] = useState('');
  const [changed, setChanged] = useState(false);
  const state = useReviewState(job);

  if (!sourceStep && submittedFrom) setSubmittedFrom('');
  useEffect(() => () => {
    // Submitted jobs belong to the tab. Only speculative work belongs to the form.
    if (!current.current?.submitted) current.current?.cancel();
  }, []);
  useEffect(() => {
    if (state.kind === 'complete' && sourceStep && submittedFrom && window.location.hash === submittedFrom) {
      window.location.hash = '/review/' + state.review.key;
    }
  }, [state, submittedFrom, sourceStep]);

  function cancel() {
    current.current?.cancel();
    setSubmittedFrom('');
  }

  function edit() {
    if (current.current?.snapshot().kind !== 'complete') current.current?.cancel();
    current.current = undefined;
    setJob(undefined);
    setSubmittedFrom('');
    setChanged(started.current === 'submitted');
  }

  function start(create: () => ReviewJob, early = false) {
    if (early && started.current) return;
    try {
      const next = current.current ?? create();
      current.current = next;
      setJob(next);
      started.current = early ? 'early' : 'submitted';
      setChanged(false);
      setSubmittedFrom(early ? '' : window.location.hash);
      if (!early) onSubmit(next);
      void next.start();
    } catch (cause) {
      if (!early) onError(cause);
    }
  }

  const view: View = submittedFrom && sourceStep && state.kind === 'running' ? state : { kind: sourceStep && changed ? 'changed' : 'idle' };
  const failure = submittedFrom && state.kind === 'failed' ? state : undefined;
  return { view, failure, start, edit, cancel };
}
