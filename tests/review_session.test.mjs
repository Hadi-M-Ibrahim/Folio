import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openReviewSession, sessionHeaders } from '../src/review/reviewSession.ts';

test('cancelling drops the lease immediately and retries a transient failure to revoke it', async t => {
  const controller = new AbortController();
  const token = 'sample-session';
  const retry = Promise.withResolvers();
  let stops = 0;
  t.mock.method(globalThis, 'fetch', async (_url, request) => {
    if (request.body === '{}') return Response.json({ token }, { status: 201 });
    assert.equal(request.keepalive, true);
    assert.deepEqual(JSON.parse(request.body), { token });
    if (++stops === 1) return new Response(null, { status: 503 });
    retry.resolve();
    return Response.json({ cancelled: true });
  });
  const release = await openReviewSession(controller.signal);
  assert.equal(sessionHeaders(controller.signal)['X-Folio-Review-Token'], token);
  controller.abort();
  assert.deepEqual(sessionHeaders(controller.signal), {});
  await retry.promise;
  release();
  assert.equal(stops, 2);
});
