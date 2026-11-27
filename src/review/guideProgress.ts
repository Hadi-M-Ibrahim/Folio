import type { ReviewProgressState } from './reviewProgress';

export const guideStreamType = 'application/x-ndjson';

type Observer = (progress: ReviewProgressState) => void;

function reportStage(event: Record<string, unknown>, report: Observer) {
  if (event.stage === 'reading' || event.stage === 'planning') {
    report({ phase: 'guide', message: event.stage === 'reading' ? 'Reading scanned pages…' : 'Identifying guide obligations…' });
    return;
  }
  const { completed, total } = event;
  if ((event.stage !== 'assessing' && event.stage !== 'references') ||
    typeof completed !== 'number' || !Number.isSafeInteger(completed) || completed < 0 ||
    typeof total !== 'number' || !Number.isSafeInteger(total) || total <= 0 || completed > total) return;
  report({ phase: 'obligations', completed, total,
    message: event.stage === 'references' ? 'Checking policy references…' : 'Checking policy evidence…' });
}

export async function readGuideStream(response: Response, report: Observer) {
  const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
  let pending = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      pending += value;
      let newline;
      while ((newline = pending.indexOf('\n')) !== -1) {
        const event = JSON.parse(pending.slice(0, newline));
        pending = pending.slice(newline + 1);
        if (Number.isInteger(event.status) && event.body) return { status: event.status as number, body: event.body };
        reportStage(event, report);
      }
    }
    throw Error('The connection ended before the guide review finished. Retry to continue.');
  } finally {
    reader.releaseLock();
  }
}
