import { completedWork, type ReviewProgressState } from '../review/reviewProgress';
import './ReviewProgress.css';

export function ReviewProgress({ progress }: { progress: ReviewProgressState }) {
  const detail = completedWork(progress);
  const value = detail ? progress.completed : undefined;
  const active = progress.completed === undefined || progress.completed < progress.total;
  return (
    <div className="review-progress">
      <output className="review-progress-label">
        <span className="review-progress-message" data-active={active}>{progress.message}</span>
        {detail && <small>{detail}</small>}
      </output>
      <progress className="review-progress-track" aria-label="Review progress"
        max={progress.total} value={value}
        aria-valuemin={0} aria-valuemax={progress.total} aria-valuenow={value}
        aria-valuetext={detail || undefined} />
    </div>
  );
}
