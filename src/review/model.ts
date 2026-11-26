export type Mode = 'questionnaire' | 'guide';
export type Status = 'supported' | 'mixed' | 'contradicted' | 'insufficient' | 'needs_review';
export const statusLabels: Record<Status, string> = {
  supported: 'Supported',
  mixed: 'Mixed evidence',
  contradicted: 'Contradicted',
  insufficient: 'Insufficient',
  needs_review: 'Needs review',
};
export const modeLabels: Record<Mode, string> = {
  questionnaire: 'State questionnaire',
  guide: 'Regulatory guide',
};
export type Policy = {
  id: string;
  title: string;
  pages: { number: number; text: string }[];
  pdfFile?: File;
};
export type PdfAttachment = {
  role: 'source' | 'policy';
  documentId: string;
  title: string;
  pages: number[];
  data: string;
};
export const MAX_POLICY_PAGES = 1200;
export const MAX_POLICY_CHARACTERS = 2400000;
export const MAX_POLICY_PAGE_CHARACTERS = 35000;
export const MAX_POLICY_DOCUMENTS = 18;
export const MAX_GUIDE_CHARACTERS = 50_000;
export const MAX_QUESTIONS = 30;
export const MAX_QUESTION_CHARACTERS = 2_000;
export const MAX_REQUEST_BYTES = 4_000_000;
export const MAX_PDF_ATTACHMENT_PAGES = 600;
export type Evidence = {
  documentId: string;
  title: string;
  page: number;
  quote: string;
};
type SearchProof = {
  term: string;
  origin?: string;
  totalHits?: number;
  totalPages?: number;
  matches: { documentId: string; page: number; count: number }[];
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
  searchProof: SearchProof[];
  followup?: {
    reason: 'cross_reference' | 'definition' | 'apparent_conflict';
    source: Evidence;
    proof: SearchProof;
    passages: Evidence[];
    totalNewPassages: number;
  };
};
export type ReviewInput = {
  mode: Mode;
  questions?: string[];
  guide?: string;
  documents: Policy[];
  allowModel?: boolean;
  modelSharingConsent?: boolean;
  pdfAttachments?: PdfAttachment[];
  readSourcePdf?: boolean;
};
export type Result = {
  mode: Mode;
  engine: 'anthropic' | 'local';
  planningEngine?: 'anthropic' | 'local';
  criterionLimitReached?: boolean;
  notice: string;
  findings: Finding[];
  sourcePages?: Policy['pages'];
  guide?: string;
  questions?: string[];
  policyPageText?: { documentId: string; pages: Policy['pages'] }[];
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
  sourceDocument?: Policy;
  sourceSelection?: string;
  key: string;
  title: string;
  input: ReviewInput;
  result: Result;
};
export type PolicyAction = 'write' | 'update' | 'no_change';
export const policyActionLabels: Record<PolicyAction, string> = {
  write: 'Write new policy',
  update: 'Update existing policy',
  no_change: 'No change',
};
export type Decision = {
  value?: 'confirmed' | 'flagged';
  answer?: string;
  citations?: Evidence[];
  action?: PolicyAction;
  note?: string;
  at: string;
};

export const responseLabels: Record<NonNullable<Decision['value']>, string> = {
  confirmed: 'Confirmed',
  flagged: 'Flagged for follow-up',
};

export type ReviewRow = {
  finding: Finding;
  index: number;
  decision: Decision | undefined;
};

export function samePassage(left: Evidence, right: Evidence): boolean {
  return left.documentId === right.documentId && left.page === right.page && left.quote === right.quote;
}

export function assessmentLabel(finding: Finding): string {
  return finding.analysisEngine === 'anthropic' ? 'Model assessment' : 'Keyword search';
}

export function guideSourceLabel(finding: Finding): string {
  const { criterionStart, criterionEnd } = finding;
  return criterionStart != null && criterionEnd != null && criterionEnd > criterionStart
    ? `Source guide · characters ${criterionStart + 1}–${criterionEnd}`
    : 'Source guide';
}
