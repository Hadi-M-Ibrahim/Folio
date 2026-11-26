export type Mode = 'questionnaire' | 'guide';
export type Status = 'supported' | 'mixed' | 'contradicted' | 'insufficient' | 'needs_review';
export const statusLabels: Record<Status, string> = {
  supported: 'Supported',
  mixed: 'Mixed evidence',
  contradicted: 'Contradicted',
  insufficient: 'Insufficient',
  needs_review: 'Needs review',
};
export const statusOrder = Object.keys(statusLabels) as Status[];
export const modeLabels: Record<Mode, string> = {
  questionnaire: 'State questionnaire',
  guide: 'Regulatory guide',
};
export type Policy = {
  id: string;
  title: string;
  pages: { number: number; text: string }[];
};
export type Evidence = {
  documentId: string;
  title: string;
  page: number;
  quote: string;
};
export type Finding = {
  id: string;
  question: string;
  criterionSource?: string;
  criterionStart?: number | null;
  criterionEnd?: number | null;
  status: Status;
  answer: string;
  analysisEngine?: 'local' | 'anthropic';
  totalSearchTerms?: number;
  totalCandidatePassages?: number;
  plannedTerms?: string[];
  supporting: Evidence[];
  counter: Evidence[];
  candidates: Evidence[];
  searchTerms: string[];
  searchProof: {
    term: string;
    origin?: string;
    totalHits?: number;
    totalPages?: number;
    matches: { documentId: string; page: number; count: number }[];
  }[];
};
export type ReviewInput = {
  mode: Mode;
  questions?: string[];
  guide?: string;
  documents: Policy[];
  allowModel?: boolean;
};
export type Result = {
  mode: Mode;
  engine: 'anthropic' | 'local' | 'example';
  notice: string;
  findings: Finding[];
};
export type Scope = {
  sourceDocuments: number;
  sourcePages: number;
  searchablePages: number;
  selectedDocuments: number;
  selectedPages: number;
};
export function readScope(value: unknown): Scope | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const keys = ['sourceDocuments', 'sourcePages', 'searchablePages', 'selectedDocuments', 'selectedPages'] as const;
  const scope = value as Scope;
  return keys.every(key => Number.isSafeInteger(scope[key]) && scope[key] >= 0) ? scope : undefined;
}
export type Review = {
  scope?: Scope;
  key: string;
  title: string;
  input: ReviewInput;
  result: Result;
  sample: boolean;
};
export type Decision = { value: 'confirmed' | 'flagged'; at: string };
