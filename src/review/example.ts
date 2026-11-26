import sample from '../../api/sample.json';
import { searchRanges } from './searchText';
import type { Evidence, Finding, Mode, Review, ReviewInput, Status } from './model';

export const sampleInput = (mode: Mode): ReviewInput => ({
  mode,
  documents: sample.documents,
  ...(mode === 'questionnaire' ? { questions: sample.questions } : { guide: sample.guide }),
});

const summaries = [
  'Grievance acknowledgment',
  'Language preference at intake',
  'Written closure notice',
  'Urgent grievance escalation',
  'Large-print notices',
];
const guideClauses = sample.guide
  .split('\n\n')
  .slice(1)
  .map((s) => s.replace(/^\d+\.\s*/, ''));
const authored: {
  status: Status;
  answer: string;
  support?: [number, number];
  counter?: [number, number];
  terms: string[];
}[] = [
  {
    status: 'mixed',
    answer:
      'The grievance policy requires a written acknowledgment within five business days. The service playbook creates an exception for grievances resolved on the first call, so the documents give staff conflicting instructions.',
    support: [0, 0],
    counter: [1, 1],
    terms: ['written acknowledgment', 'five business days', 'verbal acknowledgment'],
  },
  {
    status: 'supported',
    answer:
      'The intake procedure directs staff to ask each member for their preferred language and record it in the member profile.',
    support: [1, 0],
    terms: ['preferred language', 'member profile', 'intake'],
  },
  {
    status: 'supported',
    answer:
      'The grievance policy directs staff to send the member a written notice when a grievance closes. The notice includes the outcome and reason for the decision.',
    support: [0, 1],
    terms: ['written notice', 'grievance is closed', 'outcome'],
  },
  {
    status: 'contradicted',
    answer:
      'The escalation standard directs staff to refer urgent cases on the next business day. That instruction conflicts with the same-day requirement.',
    counter: [2, 0],
    terms: ['urgent grievances', 'next business day', 'same day'],
  },
  {
    status: 'insufficient',
    answer:
      'The policies address written notices, but none of the supplied pages specifies whether members can request large-print grievance notices.',
    terms: ['large print', 'large-print', 'written notice'],
  },
];
function pageEvidence([documentIndex, pageIndex]: [number, number]): Evidence {
  const doc = sample.documents[documentIndex],
    page = doc.pages[pageIndex];
  const quote = page.text
    .split('\n\n')
    .at(-1)!
    .split(/(?<=\.)\s/)[0];
  return { documentId: doc.id, title: doc.title, page: page.number, quote };
}
export function exampleReview(mode: Mode): Review {
  const findings: Finding[] = authored.map((a, i) => {
    const supporting = a.support ? [pageEvidence(a.support)] : [];
    const counter = a.counter ? [pageEvidence(a.counter)] : [];
    const question = mode === 'questionnaire' ? sample.questions[i] : guideClauses[i];
    const searchProof = a.terms.map((term) => ({
      term,
      matches: sample.documents.flatMap((doc) =>
        doc.pages.flatMap((page) => {
          const count = searchRanges(page.text, term).length;
          return count ? [{ documentId: doc.id, page: page.number, count }] : [];
        }),
      ),
    }));
    return {
      id: `${mode === 'questionnaire' ? 'Q' : 'R'}-${String(i + 1).padStart(2, '0')}`,
      question,
      criterionSource: question,
      status: a.status,
      answer: a.answer,
      supporting,
      counter,
      searchTerms: a.terms,
      searchProof,
      candidates: a.status === 'insufficient' ? [pageEvidence([0, 1])] : [...supporting, ...counter],
    };
  });
  return {
    key: 'example-' + mode,
    title: 'Member communications',
    input: sampleInput(mode),
    sample: true,
    result: {
      mode,
      engine: 'example',
      notice: 'Prepared example using fictional policies and requirements.',
      findings,
    },
  };
}
export function findingTitle(f: Finding) {
  const index = sample.questions.indexOf(f.question);
  const guideIndex = guideClauses.indexOf(f.question);
  return summaries[index >= 0 ? index : guideIndex] || f.question;
}
