import { guideSourceLabel, type Finding, type Policy, type Review } from './model';

export type SourceLocation = {
  doc: Policy;
  page: number;
  quote: string;
  term?: boolean;
  unpaginated?: boolean;
  marks?: { page: number; start: number; end: number }[];
};

export function submittedSource(review: Review): Policy {
  if (review.sourceDocument) return review.sourceDocument;
  const { guide, questions } = review.input;
  return {
    id: 'submitted-source',
    title: guide ? 'Submitted guide' : 'Submitted questions',
    pages: [{ number: 1, text: guide ?? questions?.join('\n\n') ?? '' }],
  };
}

export function guideLocation(review: Review, finding: Finding): SourceLocation {
  const doc = submittedSource(review);
  const quote = finding.criterionSource ?? finding.question;
  const text = doc.pages.map((page) => page.text).join('\n\n');
  const guide = review.input.guide ?? '';
  const guideStart = text.indexOf(guide);
  const offset = finding.criterionStart;
  const start = offset != null && guideStart >= 0
    ? guideStart + Array.from(guide).slice(0, offset).join('').length
    : text.indexOf(quote);
  const marks: NonNullable<SourceLocation['marks']> = [];
  if (quote && start >= 0 && text.startsWith(quote, start)) {
    let pageStart = 0;
    for (const page of doc.pages) {
      const from = Math.max(0, start - pageStart);
      const to = Math.min(page.text.length, start + quote.length - pageStart);
      if (from < to) marks.push({ page: page.number, start: from, end: to });
      pageStart += page.text.length + 2;
    }
  }
  return { doc, page: marks[0]?.page ?? doc.pages[0].number, quote, marks, unpaginated: !review.sourceDocument };
}

export function guideCitation(review: Review, finding: Finding): string {
  if (!review.sourceDocument) return guideSourceLabel(finding);
  const { doc, marks } = guideLocation(review, finding);
  if (!marks?.length) return guideSourceLabel(finding);
  const pages = marks.map((mark) => mark.page);
  return doc.title + (pages.length === 1 ? ' · p. ' : ' · pp. ') + pages.join(', ');
}
