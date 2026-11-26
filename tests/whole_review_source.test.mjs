import assert from 'node:assert/strict';
import test from 'node:test';
import { combineScanQuestions, divide, locateQuestions, pageSpans, pagesIn, sourceSpans } from '../src/review/wholeReviewSource.ts';

test('guide sections prefer a complete sentence over a page break in a qualifying clause', () => {
  const text = 'Historical background. All employees must\n\nretain records after retirement. Further background.';
  const [first] = sourceSpans(text.length, 45, text);
  assert.equal(text.slice(first.start, first.end), 'Historical background. ');
});

test('guide subdivision retains Unicode scalars and whitespace verbatim', () => {
  const text = '🧭🧭🧭'.repeat(13) + '\n\nRepeated.   Repeated.\n';
  const spans = [...sourceSpans(text.length, 9, text)];
  const chunks = spans.flatMap(span => {
    const parts = divide(span, text);
    return (parts.length ? parts : [span]).map(part => text.slice(part.start, part.end));
  });
  assert.equal(chunks.join(''), text);
  assert.ok(chunks.every(chunk => chunk.isWellFormed()));
});

test('guide subdivision chooses the nearest complete sentence on either side of the midpoint', () => {
  const first = 'Staff must retain the full register, including its supporting notes, for seven years.';
  const last = 'Supervisors must sign.';
  for (const duties of [[first, last], [last, first]]) {
    const prefix = 'Outside the selected span. ';
    const text = prefix + duties.join('  ') + ' More text outside.';
    const span = { start: prefix.length, end: prefix.length + duties.join('  ').length };
    assert.deepEqual(divide(span, text).map(part => text.slice(part.start, part.end)), [duties[0] + '  ', duties[1]]);
  }
});

test('guide subdivision keeps a short single duty intact and can shrink long unbroken input', () => {
  for (const text of ['Staff must retain audit records.  ', '1. File the reports under Sec. 12.',
    'Staff must\n\nretain the complete record.']) {
    assert.deepEqual(divide({ start: 0, end: text.length }, text), []);
  }
  const text = '🧭'.repeat(3001);
  const chunks = divide({ start: 0, end: text.length }, text).map(part => text.slice(part.start, part.end));
  assert.equal(chunks.length, 2);
  assert.equal(chunks.join(''), text);
  assert.ok(chunks.every(chunk => chunk.isWellFormed()));
});

test('guide subdivision recognizes unpunctuated paragraphs and checklist items', () => {
  for (const [first, rest] of [['Clerks file permit records\n\n', 'Managers review the files'],
    ['Checklist\n(a) Retain the original permit\n', '(b) Keep the signed decision']]) {
    const text = first + rest;
    const parts = divide({ start: 0, end: text.length }, text);
    assert.deepEqual(parts.map(part => text.slice(part.start, part.end)), [first, rest]);
  }
});

test('guide page numbers reflect the physical source and trimmed selection', () => {
  const rows = [{ number: 7, text: '  Duty one.' }, { number: 11, text: 'Duty two.' }];
  const spans = pageSpans(rows, 2, 2);
  assert.deepEqual(pagesIn(spans, { start: 0, end: 11 }), [7]);
  assert.deepEqual(pagesIn(spans, { start: 4, end: 13 }), [7, 11]);
  assert.deepEqual(pagesIn(spans, { start: 11, end: 20 }), [11]);
});

test('repeated OCR prompts retain the right physical pages across blank sheets and line wraps', () => {
  const pages = [
    { number: 2, text: 'Who\nkeeps the' }, { number: 3, text: '' }, { number: 4, text: 'log?' },
    { number: 7, text: 'Who keeps the log?' },
  ];
  const prompts = locateQuestions(pages, ['Who keeps the log?', 'Who keeps the log?']);
  assert.deepEqual(prompts.map(q => q.pageNumbers), [[2, 4], [7]]);
});

test('a question spanning transcription groups keeps its full wording and all neighboring prompts', () => {
  const row = (number, text) => ({ number, text });
  const groups = [{
    pages: [row(2, '1. Who signs?\n2. Who keeps')],
    questions: [{ text: '1. Who signs?', pageNumbers: [2] }, { text: '2. Who keeps', pageNumbers: [2] }],
  }, { pages: [row(3, 'a register?\nFiling deadline: _____')], questions: [{ text: 'Filing deadline:', pageNumbers: [3] }] },
  { pages: [row(4, '4. Who reviews it?')] }];
  const parsed = [
    { text: '1. Who signs?', pageNumbers: [2] },
    { text: '2. Who keeps a register?', pageNumbers: [2, 3] },
    { text: '4. Who reviews it?', pageNumbers: [4] },
  ];
  assert.deepEqual(combineScanQuestions(groups, parsed), [parsed[0], parsed[1], groups[1].questions[0], parsed[2]]);
});

test('a missing OCR prompt is recovered from the transcript in source order', () => {
  const questions = ['Who signs?', 'Who certifies?', 'Who signs?'];
  const pages = [{ number: 1, text: questions.join('\n') }];
  const all = questions.map(text => ({ text, pageNumbers: [1] }));
  assert.deepEqual(combineScanQuestions([{ pages, questions: [all[0], all[2]] }], all), all);
});
