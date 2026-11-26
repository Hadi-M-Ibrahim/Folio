import sample from '../api/sample.json';
import {searchRanges} from './searchText';

export type Mode = 'questionnaire' | 'guide';
export type Status = 'supported' | 'mixed' | 'contradicted' | 'insufficient' | 'needs_review';
export const statusLabels: Record<Status, string> = {
  supported: 'Supported', mixed: 'Mixed evidence', contradicted: 'Contradicted',
  insufficient: 'Insufficient', needs_review: 'Needs review'
};
export const statusOrder = Object.keys(statusLabels) as Status[];
export const modeLabels: Record<Mode, string> = { questionnaire: 'State questionnaire', guide: 'Regulatory guide' };
export type Policy = { id: string; title: string; pages: { number: number; text: string }[] };
export type Evidence = { documentId: string; title: string; page: number; quote: string };
export type Finding = {
  id: string; question: string; criterionSource?: string; status: Status; answer: string;
  analysisEngine?:'local'|'anthropic'; totalSearchTerms?:number; totalCandidatePassages?:number; plannedTerms?:string[];
  supporting: Evidence[]; counter: Evidence[]; candidates: Evidence[]; searchTerms: string[];
  searchProof: { term: string; origin?:string; totalHits?:number; totalPages?:number; matches: { documentId: string; page: number; count: number }[] }[];
};
export type ReviewInput = { mode: Mode; questions?: string[]; guide?: string; documents: Policy[]; allowModel?: boolean };
export type Result = { mode: Mode; engine: 'anthropic' | 'local' | 'example'; notice: string; findings: Finding[] };
export type Scope = { sourceDocuments:number; sourcePages:number; searchablePages:number; selectedDocuments:number; selectedPages:number };
export type Review = { scope?:Scope; key: string; title: string; input: ReviewInput; result: Result; sample: boolean };
export type Decision = { value: 'confirmed' | 'flagged'; at: string };
export const isLoopback = ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(window.location.hostname);
export const sampleInput = (mode: Mode): ReviewInput => ({
  mode, documents: sample.documents, ...(mode === 'questionnaire' ? { questions: sample.questions } : { guide: sample.guide })
});

const summaries = [
  'Grievance acknowledgment', 'Language preference at intake', 'Written closure notice',
  'Urgent grievance escalation', 'Large-print notices'
];
const guideClauses = sample.guide.split('\n\n').slice(1).map(s => s.replace(/^\d+\.\s*/, ''));
const authored: { status: Status; answer: string; support?: [number,number]; counter?: [number,number]; terms: string[] }[] = [
  { status: 'mixed', answer: 'The grievance policy requires a written acknowledgment within five business days. The service playbook creates an exception for grievances resolved on the first call, so the documents give staff conflicting instructions.', support: [0,0], counter: [1,1], terms: ['written acknowledgment', 'five business days', 'verbal acknowledgment'] },
  { status: 'supported', answer: 'The intake procedure directs staff to ask each member for their preferred language and record it in the member profile.', support: [1,0], terms: ['preferred language', 'member profile', 'intake'] },
  { status: 'supported', answer: 'The grievance policy directs staff to send the member a written notice when a grievance closes. The notice includes the outcome and reason for the decision.', support: [0,1], terms: ['written notice', 'grievance is closed', 'outcome'] },
  { status: 'contradicted', answer: 'The escalation standard directs staff to refer urgent cases on the next business day. That instruction conflicts with the same-day requirement.', counter: [2,0], terms: ['urgent grievances', 'next business day', 'same day'] },
  { status: 'insufficient', answer: 'The policies address written notices, but none of the supplied pages specifies whether members can request large-print grievance notices.', terms: ['large print', 'large-print', 'written notice'] }
];
function pageEvidence([documentIndex, pageIndex]: [number, number]): Evidence {
  const doc = sample.documents[documentIndex], page = doc.pages[pageIndex];
  const quote = page.text.split('\n\n').at(-1)!.split(/(?<=\.)\s/)[0];
  return { documentId: doc.id, title: doc.title, page: page.number, quote };
}
export function exampleReview(mode: Mode): Review {
  const findings: Finding[] = authored.map((a, i) => {
    const supporting = a.support ? [pageEvidence(a.support)] : [];
    const counter = a.counter ? [pageEvidence(a.counter)] : [];
    const question = mode === 'questionnaire' ? sample.questions[i] : guideClauses[i];
    const searchProof = a.terms.map(term => ({term, matches: sample.documents.flatMap(doc => doc.pages.flatMap(page => {
      const count = searchRanges(page.text,term).length;
      return count ? [{documentId: doc.id, page: page.number, count}] : [];
    }))}));
    return { id: `${mode === 'questionnaire' ? 'Q' : 'R'}-${String(i+1).padStart(2, '0')}`, question, criterionSource: question, status: a.status, answer: a.answer, supporting, counter, searchTerms: a.terms, searchProof, candidates: a.status === 'insufficient' ? [pageEvidence([0,1])] : [...supporting, ...counter] };
  });
  return { key: 'example-' + mode, title: 'Member communications', input: sampleInput(mode), sample: true,
    result: { mode, engine: 'example', notice: 'Prepared example using fictional policies and requirements.', findings } };
}
export function findingTitle(f: Finding) {
  const index = sample.questions.indexOf(f.question);
  const guideIndex = guideClauses.indexOf(f.question);
  return summaries[index >= 0 ? index : guideIndex] || f.question;
}
export function checkInput(input: ReviewInput) {
  if (!['questionnaire','guide'].includes(input.mode)) throw Error('Choose a valid review mode.');
  if (!Array.isArray(input.documents) || !input.documents.length || input.documents.length > 18) throw Error('Include between 1 and 18 policy documents.');
  let totalPages = 0, totalChars = 0;
  const ids = new Set<string>();
  for (const doc of input.documents) {
    if (typeof doc.id !== 'string' || !doc.id.trim() || doc.id!==doc.id.trim() || doc.id.length > 100 || ids.has(doc.id) || typeof doc.title !== 'string' || !doc.title.trim() || doc.title.length > 240 || !Array.isArray(doc.pages) || !doc.pages.length) throw Error('Each policy needs a unique ID, a title, and at least one page.');
    ids.add(doc.id);
    const pageNumbers = new Set<number>();
    for (const page of doc.pages) {
      if (!Number.isInteger(page.number) || page.number < 1 || pageNumbers.has(page.number) || typeof page.text !== 'string' || page.text.length > 35000) throw Error('Each policy page needs a unique positive page number and up to 35,000 characters of text.');
      totalPages++; totalChars += page.text.length; pageNumbers.add(page.number);
    }
    if (!doc.pages.some(p=>p.text.trim())) throw Error('Each policy needs at least one searchable page.');
  }
  if (totalPages > 1200 || totalChars > 2400000) throw Error('This review exceeds the limit of 1,200 pages or 2.4 million policy characters.');
  if (input.mode === 'guide' && (typeof input.guide !== 'string' || !input.guide.trim() || input.guide.length > 50000)) throw Error('Enter a guide containing up to 50,000 characters.');
  if (input.mode === 'questionnaire' && (!Array.isArray(input.questions) || !input.questions.length || input.questions.length > 30 || input.questions.some(q => typeof q !== 'string' || !q.trim() || q.length > 2000))) throw Error('Include 1–30 questions, each up to 2,000 characters.');
  if (new TextEncoder().encode(JSON.stringify(input)).length > 4000000) throw Error('This review exceeds the 4 MB request limit.');
}
export async function requestReview(input: ReviewInput, signal: AbortSignal): Promise<Result> {
  checkInput(input);
  const response = await fetch('/api/review', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(input), signal});
  const body = await response.json().catch(() => null);
  if (!response.ok || !body) throw Error(body?.error || `The review service could not complete this request (HTTP ${response.status}). Try again.`);
  if (!Array.isArray(body.findings) || !['anthropic', 'local'].includes(body.engine)) throw Error('The review service returned an unexpected response. Try again.');
  return body as Result;
}
