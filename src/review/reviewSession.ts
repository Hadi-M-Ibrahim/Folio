// Tokens identify cancellable work. Files and review contents stay out of the control requests.
const sessions = new WeakMap<AbortSignal, string>();

export function sessionHeaders(signal: AbortSignal): Record<string, string> {
  const token = sessions.get(signal);
  return token ? { 'X-Folio-Review-Token': token } : {};
}

export async function openReviewSession(signal: AbortSignal): Promise<() => void> {
  signal.throwIfAborted();
  const response = await fetch('/api/review-session', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', signal,
  });
  if (!response.ok) throw Error('The background review could not start.');
  const { token } = await response.json();
  if (typeof token !== 'string' || !token) throw Error('The background review could not start.');
  function stop() {
    sessions.delete(signal);
    void fetch('/api/review-session', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }), keepalive: true,
    }).catch(() => {});
  }
  if (signal.aborted) {
    stop();
    signal.throwIfAborted();
  }
  sessions.set(signal, token);
  signal.addEventListener('abort', stop, { once: true });
  return () => {
    sessions.delete(signal);
    signal.removeEventListener('abort', stop);
  };
}
