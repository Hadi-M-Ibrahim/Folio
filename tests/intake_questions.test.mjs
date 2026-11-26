import assert from 'node:assert/strict';
import test from 'node:test';
import { questionsFromPdf, questionsFromPdfPages, questionsFromText } from '../src/components/intakeQuestions.ts';

test('pasted numbered items keep wrapped text, follow-up sentences, and list choices', () => {
  assert.deepEqual(questionsFromText(
    '1. Who maintains the\r\ninspection report? Explain the process. 2. Which conditions apply:\r\n• First filing\r\n• Renewal\r\n\r\n3. Identify the reviewer.',
  ), [
    '1. Who maintains the inspection report? Explain the process.',
    '2. Which conditions apply: • First filing • Renewal',
    '3. Identify the reviewer.',
  ]);
});

test('ordinary paste accepts paragraphs, adjacent questions, and line-separated prompts', () => {
  assert.deepEqual(questionsFromText(
    'Who maintains the records and\nwhere are they stored? When are they removed?\n\nIdentify the reviewer\nList the exceptions',
  ), ['Who maintains the records and where are they stored?', 'When are they removed?', 'Identify the reviewer', 'List the exceptions']);
  assert.deepEqual(questionsFromText('Retention period\nCertification authority'), ['Retention period', 'Certification authority']);
  assert.deepEqual(questionsFromText('who signs? when is it due?'), ['who signs?', 'when is it due?']);
  assert.deepEqual(questionsFromText(' \r\n\t'), []);
});

test('pasted questions preserve long prompts and full questionnaire order', () => {
  const prompts = Array.from({ length: 95 }, (_, i) => `${i + 1}. Describe ${'record retention '.repeat(140)}for filing ${i + 1}.`);
  assert.deepEqual(questionsFromText(prompts.join('\n')), prompts);
});

test('unnumbered questions survive a list of answer options', () => {
  const text = 'Who keeps records?\nWhich office must approve:\n• Renewals\n• Appeals\nHow quickly do they decide?';
  assert.deepEqual(questionsFromPdf(text).split('\n'), [
    'Who keeps records?',
    'Which office must approve: • Renewals • Appeals',
    'How quickly do they decide?',
  ]);
});

test('wrapped questions retain their printed numbers and skip empty answer fields', () => {
  const text = 'State form\n1. Does the plan send notice\nwithin five days?\n(References: ___)\nPage 1 of 2\n2. Who can request\na notice?';
  assert.deepEqual(questionsFromPdf(text).split('\n'), [
    '1. Does the plan send notice within five days?',
    '2. Who can request a notice?',
  ]);
});

test('numbering that starts partway through a form preserves preceding questions', () => {
  assert.equal(questionsFromPdf('Who signs the notice?\n2. Who reviews it?'), 'Who signs the notice?\n2. Who reviews it?');
});

test('a numbered PDF omits its cover letter, instructions, and identifying fields', () => {
  const text = [
    'Department of oversight',
    'Annual filing for licensed providers',
    'Complete all sections and return the signed form.',
    'Organization: ____________________',
    'Page 1 of 3',
    '1. Who certifies the renewal?',
    '2. Provide the filing deadline.',
  ].join('\n');
  assert.equal(questionsFromPdf(text), '1. Who certifies the renewal?\n2. Provide the filing deadline.');
});

test('an unnumbered form keeps its prompts even with numbered answer choices', () => {
  const text = 'Who decides appeals?\nWhich response applies:\n1. Always\n2. Sometimes\nWhat date applies?';
  assert.deepEqual(questionsFromPdf(text).split('\n'), [
    'Who decides appeals?', 'Which response applies: 1. Always 2. Sometimes', 'What date applies?',
  ]);
});

test('questions retain every physical page of their prompt and choices', () => {
  const pages = [
    { number: 1, text: 'Annual questionnaire\nPage 1 of 5' },
    { number: 2, text: '1. Who signs the notice?\n2. Which office must' },
    { number: 3, text: 'approve:\n• Operations\nPage 3 of 5' },
    { number: 4, text: '• Records\n(References: ___)' },
    { number: 5, text: '3. Who sends the notice?' },
  ];
  assert.deepEqual(questionsFromPdfPages(pages), [
    { text: '1. Who signs the notice?', pageNumbers: [2] },
    { text: '2. Which office must approve: • Operations • Records', pageNumbers: [2, 3, 4] },
    { text: '3. Who sends the notice?', pageNumbers: [5] },
  ]);
});

test('identical questions and repeated continuations keep their respective physical pages', () => {
  const pages = [
    { number: 4, text: 'Who approves the' }, { number: 5, text: 'record?' },
    { number: 7, text: 'Who approves the' }, { number: 8, text: 'record?' },
  ];
  assert.deepEqual(questionsFromPdfPages(pages), [
    { text: 'Who approves the record?', pageNumbers: [4, 5] },
    { text: 'Who approves the record?', pageNumbers: [7, 8] },
  ]);
});

test('page counters and a title alone do not create a questionnaire item', () => {
  assert.deepEqual(questionsFromPdfPages([
    { number: 1, text: 'State questionnaire\nPage 1 of 2' }, { number: 2, text: '' },
  ]), []);
});
