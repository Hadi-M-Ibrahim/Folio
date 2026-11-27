import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createServer } from 'vite';

let executeWholeReview;
let server;
before(async () => {
  // Load the browser TypeScript modules with the same resolver as the app.
  // Page rendering is orthogonal to these checkpoints. Keep the real physical page selection.
  server = await createServer({
    configFile: false, appType: 'custom', server: { middlewareMode: true, hmr: false, watch: null },
    optimizeDeps: { noDiscovery: true, include: [] },
    plugins: [{
      name: 'test-pdf-attachment',
      load(id) {
        if (id.endsWith('/src/review/pdf.ts')) return `export function createPdfAttachmentReader(doc, role) {
          return { attachment: async pages => ({ role, documentId: doc.id, title: doc.title, pages, data: 'AA==' }), close() {} };
        }`;
      },
    }],
  });
  globalThis.window = { location: { hostname: 'localhost' } };
  try {
    ({ executeWholeReview } = await server.ssrLoadModule('/src/review/wholeReview.ts'));
  } finally {
    delete globalThis.window;
  }
});
after(async () => { await server?.close(); });

function questionnaire(count) {
  return {
    input: { mode: 'questionnaire', questions: Array.from({ length: count }, (_, i) => 'Who signs form ' + (i + 1) + '?'),
      documents: [{ id: 'policy', title: 'Policy', pages: [{ number: 1, text: 'The clerk signs.' }] }] },
    policyAttachments: [], signal: new AbortController().signal,
  };
}

function reviewed(questions) {
  return Response.json({ mode: 'questionnaire', engine: 'anthropic', findings: questions.map(question => ({ question })) });
}

test('subdivision and retry measure validated questions against the same total', async t => {
  const options = questionnaire(6);
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (_url, { body }) => {
    const { questions } = JSON.parse(body);
    calls.push(questions);
    if (calls.length === 1) return Response.json({ code: 'review_part_too_large' }, { status: 422 });
    if (calls.length === 3) return reviewed([]); // Incomplete results must not advance the bar or the checkpoint.
    return reviewed(questions);
  });
  const states = [];
  options.onProgress = state => states.push(state);
  await assert.rejects(executeWholeReview(options), /incomplete questionnaire.*3 of 6 questions completed/);
  assert.deepEqual(states.map(s => s.completed), [0, 0, 3, 3]);
  assert.ok(states.every(s => s.total === 6 && s.phase === 'questions'));
  states.length = 0;
  const result = await executeWholeReview(options);
  assert.deepEqual(states.map(s => s.completed), [3, 6]);
  assert.deepEqual(calls[3], calls[2]);
  assert.deepEqual(result.findings.map(f => f.question), options.input.questions);
});

test('a response delivered after cancellation cannot advance progress or satisfy a retry', async t => {
  const options = questionnaire(25);
  const controller = new AbortController();
  const arrived = Promise.withResolvers();
  const late = Promise.withResolvers();
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (_url, { body }) => {
    const { questions } = JSON.parse(body);
    calls.push(questions);
    if (calls.length === 2) {
      arrived.resolve();
      await late.promise; // Deliberately ignore the aborted fetch signal.
    }
    return reviewed(questions);
  });
  const counts = [];
  const running = executeWholeReview({ ...options, signal: controller.signal, onProgress: s => counts.push(s.completed) });
  await arrived.promise;
  controller.abort();
  late.resolve();
  await assert.rejects(running, { name: 'AbortError' });
  assert.deepEqual(counts, [0, 10, 10]);
  assert.equal(calls.length, 2);
  counts.length = 0;
  await executeWholeReview({ ...options, onProgress: s => counts.push(s.completed) });
  assert.deepEqual(counts, [10, 20, 20, 25]);
  assert.deepEqual(calls[2], calls[1]);
});

test('mixed native and scanned pages keep a single transcription total before assessment', async t => {
  const options = questionnaire(1);
  delete options.input.questions;
  options.input.readSourcePdf = true;
  const pages = Array.from({ length: 6 }, (_, i) => ({ number: i + 8, text: i === 2 ? 'Who signs form 10?' : '' }));
  options.sourceDocument = { id: 'source', title: 'Source', pages, pdfFile: new File(['PDF'], 'source.pdf') };
  const transcribed = [];
  t.mock.method(globalThis, 'fetch', async (_url, { body }) => {
    const request = JSON.parse(body);
    if (!request.transcribeSourceOnly) return reviewed(request.questions);
    const numbers = request.pdfAttachments[0].pages;
    transcribed.push(...numbers);
    const sourcePages = numbers.map(number => ({ number, text: 'Who signs form ' + number + '?' }));
    return Response.json({ mode: 'questionnaire', engine: 'anthropic', findings: [], sourcePages,
      questions: sourcePages.map(p => p.text) });
  });
  const states = [];
  await executeWholeReview({ ...options, onProgress: s => states.push([s.phase, s.completed, s.total]) });
  assert.deepEqual(transcribed, [8, 9, 11, 12, 13]);
  assert.deepEqual(states, [
    ['transcribing', 0, 5], ['transcribing', 2, 5], ['transcribing', 2, 5], ['transcribing', 5, 5],
    ['questions', 0, 6], ['questions', 6, 6],
  ]);
});

test('a short scanned guide reports page units and switches phases only when it must split', async t => {
  const pages = [{ number: 4, text: 'Retain records.' }, { number: 6, text: 'Sign notices.' }];
  const sourceDocument = { id: 'source', title: 'Guide', pages: pages.map(p => ({ ...p, text: '' })),
    pdfFile: new File(['PDF'], 'guide.pdf') };
  let split = false;
  t.mock.method(globalThis, 'fetch', async (_url, { body }) => {
    const request = JSON.parse(body);
    if (split && request.readSourcePdf && !request.transcribeSourceOnly) {
      return Response.json({ code: 'review_part_too_large' }, { status: 422 });
    }
    return Response.json({ mode: 'guide', engine: 'anthropic', notice: '', findings: [], sourcePages: pages });
  });
  const states = [];
  const documents = [{ id: 'records', title: 'Records policy', pages: [{ number: 1, text: 'The clerk retains records.' }] }];
  const options = { input: { mode: 'guide', documents, readSourcePdf: true }, sourceDocument, policyAttachments: [],
    signal: new AbortController().signal, onProgress: s => states.push([s.phase, s.completed, s.total]) };
  await executeWholeReview(options);
  assert.deepEqual(states, [['scan', 0, 2], ['scan', 2, 2]]);
  states.length = 0;
  split = true;
  await executeWholeReview(options);
  const chars = pages.map(p => p.text).join('\n\n').length;
  assert.deepEqual(states, [
    ['scan', 0, 2], ['transcribing', 0, 2], ['transcribing', 2, 2], ['guide', 0, chars], ['guide', chars, chars],
  ]);
});

test('multipart quota waits use the current submission state and preserve completed units', async t => {
  const options = questionnaire(11);
  let joined = false;
  options.mayWaitForQuota = () => joined;
  const quota = () => new Response(null, { status: 429, headers: { 'Retry-After': '1' } });
  const states = [];
  options.onProgress = state => states.push(state);
  let calls = 0;
  const arrived = Promise.withResolvers();
  const reply = Promise.withResolvers();
  t.mock.method(globalThis, 'fetch', async (_url, { body }) => {
    calls++;
    if (calls === 2) return quota();
    if (calls === 3) {
      arrived.resolve();
      await reply.promise;
      return quota();
    }
    return reviewed(JSON.parse(body).questions);
  });
  await assert.rejects(executeWholeReview(options), /network has reached its limit/);
  assert.equal(calls, 2);
  states.length = 0;
  const retry = executeWholeReview(options);
  await arrived.promise;
  joined = true;
  reply.resolve();
  await retry;
  assert.deepEqual(states.map(s => s.completed), [10, 10, 10, 11]);
  assert.match(states[1].message, /Review paused at the submission limit/);
  assert.equal(states[2].message, states[0].message);
});

test('guide progress arrives before the result, including across network chunks', async t => {
  const options = questionnaire(1);
  options.input = { mode: 'guide', guide: 'Staff must sign.', documents: options.input.documents };
  const encoder = new TextEncoder();
  let stream;
  const started = Promise.withResolvers();
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    assert.equal(init.headers.Accept, 'application/x-ndjson');
    return new Response(new ReadableStream({ start(controller) { stream = controller; } }),
      { headers: { 'Content-Type': 'application/x-ndjson' } });
  });
  const states = [];
  const result = executeWholeReview({ ...options, onProgress(state) {
    states.push(state);
    if (state.phase === 'obligations') started.resolve();
  } });
  await new Promise(resolve => setImmediate(resolve));
  stream.enqueue(encoder.encode('{"stage":"plan'));
  stream.enqueue(encoder.encode('ning","completed":0,"total":0}\n{"stage":"assessing","completed":2,"total":4}\n'));
  await started.promise;
  assert.equal(states.at(-2).message, 'Identifying guide obligations…');
  assert.deepEqual(states.at(-1), { phase: 'obligations', message: 'Checking policy evidence…', completed: 2, total: 4 });
  stream.close();
  await assert.rejects(result, /connection ended/);
  assert.equal(states.at(-1).completed, 2);
});

test('a terminal guide error still subdivides and validates the smaller sections', async t => {
  const options = questionnaire(1);
  options.input = { mode: 'guide', guide: 'Staff must sign. Clerks must file.', documents: options.input.documents };
  options.onProgress = () => {};
  const pieces = [];
  t.mock.method(globalThis, 'fetch', async (_url, { body }) => {
    const { guide } = JSON.parse(body);
    pieces.push(guide);
    const event = pieces.length === 1
      ? { status: 422, body: { code: 'review_part_too_large' } }
      : { status: 200, body: { mode: 'guide', engine: 'anthropic', findings: [{ question: guide.trim() }] } };
    return new Response(JSON.stringify(event) + '\n', { headers: { 'Content-Type': 'application/x-ndjson' } });
  });
  const result = await executeWholeReview(options);
  assert.equal(pieces.length, 3);
  assert.equal(pieces.slice(1).join(''), options.input.guide);
  assert.deepEqual(result.findings.map(f => f.question), ['Staff must sign.', 'Clerks must file.']);
});
