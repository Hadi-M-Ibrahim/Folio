import assert from 'node:assert/strict';
import test from 'node:test';
import { questionsFromPdf } from '../src/components/intakeQuestions.ts';

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
