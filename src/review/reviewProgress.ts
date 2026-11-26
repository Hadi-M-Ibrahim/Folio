export type ReviewPhase = 'preparing' | 'transcribing' | 'scan' | 'questions' | 'guide';

export type ReviewProgressState = {
  phase: ReviewPhase;
  message: string;
} & (
  | { completed: number; total: number }
  | { completed?: undefined; total?: undefined }
);

export function completedWork(progress: ReviewProgressState): string {
  const { phase, completed, total } = progress;
  if (completed === undefined || !total) return '';
  if (phase === 'guide') return Math.floor(100 * completed / total) + '% of guide text reviewed';
  const unit = phase === 'questions' ? 'question' : 'page';
  return completed.toLocaleString() + ' of ' + total.toLocaleString() + ' ' + unit +
    (total === 1 ? '' : 's') + (phase === 'transcribing' ? ' transcribed' : ' reviewed');
}
