import { ArrowLeft } from 'lucide-react';
import { documentErrorMessage } from '../review/files';
import type { ReviewJob } from '../review/reviewJob';
import { ReviewProgress } from './ReviewProgress';

export function PendingReview({ job, state, onStart }: {
  job: ReviewJob; state: ReturnType<ReviewJob['snapshot']>; onStart: () => void;
}) {
  function remove() {
    window.location.hash = 'review-options';
    job.cancel();
  }
  return (
    <section className="pending-review" aria-labelledby="pending-title">
      <header className="page-heading">
        <a className="back-link" href="#review-options"><ArrowLeft size={15} /> All reviews</a>
        <h1 id="pending-title" tabIndex={-1}>{job.title}</h1>
      </header>
      {state.kind === 'running' && <ReviewProgress progress={state.progress} />}
      {state.kind === 'paused' && <p><output>This review was interrupted. Resume to continue with your saved documents and selections.</output></p>}
      {state.kind === 'elsewhere' && <p><output>This review is running in another tab.</output></p>}
      {state.kind === 'failed' && <p role="alert" className="intake-error">{documentErrorMessage(state.error)}</p>}
      {state.kind !== 'elsewhere' && <div className="intake-actions">
        {state.kind === 'paused' && <button className="intake-primary" onClick={onStart}>Resume review</button>}
        {state.kind === 'failed' && <button className="intake-primary" onClick={onStart}>Retry review</button>}
        <button className="intake-secondary" onClick={remove}>{state.kind === 'running' ? 'Cancel review' : 'Remove review'}</button>
      </div>}
    </section>
  );
}
