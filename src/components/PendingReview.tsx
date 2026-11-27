import { ArrowLeft } from 'lucide-react';
import { documentErrorMessage } from '../review/files';
import type { ReviewJob } from '../review/reviewJob';
import { ReviewProgress } from './ReviewProgress';

export function PendingReview({ job, state }: { job: ReviewJob; state: ReturnType<ReviewJob['snapshot']> }) {
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
      {state.kind === 'failed' && <p role="alert" className="intake-error">{documentErrorMessage(state.error)}</p>}
      <div className="intake-actions">
        {state.kind === 'failed' && <button className="intake-primary" onClick={() => void job.start()}>Retry review</button>}
        <button className="intake-secondary" onClick={remove}>{state.kind === 'failed' ? 'Remove review' : 'Cancel review'}</button>
      </div>
    </section>
  );
}
