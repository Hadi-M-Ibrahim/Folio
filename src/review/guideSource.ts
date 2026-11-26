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

function indexGuide(review: Review) {
  const doc = submittedSource(review);
  const text = doc.pages.map((page) => page.text).join('\n\n');
  const guide = review.input.guide ?? '';
  // Python reports code-point offsets. Each astral character adds one UTF-16 unit in the browser.
  const astral: number[] = [];
  for (const match of guide.matchAll(/[\u{10000}-\u{10FFFF}]/gu)) astral.push(match.index! - astral.length);
  return { doc, text, guideStart: text.indexOf(guide), astral };
}

const guideIndexes = new WeakMap<Review, ReturnType<typeof indexGuide>>();

function utf16Offset(offset: number, astral: number[]) {
  let low = 0, high = astral.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (astral[middle] < offset) low = middle + 1;
    else high = middle;
  }
  return offset + low;
}

export function guideLocation(review: Review, finding: Finding): SourceLocation {
  let index = guideIndexes.get(review);
  if (!index) {
    index = indexGuide(review);
    guideIndexes.set(review, index);
  }
  const { doc, text, guideStart, astral } = index;
  const quote = finding.criterionSource ?? finding.question;
  const offset = finding.criterionStart;
  const start = offset != null && guideStart >= 0
    ? guideStart + utf16Offset(offset, astral)
    : text.indexOf(quote);
  const marks: NonNullable<SourceLocation['marks']> = [];
  if (quote && start >= 0 && text.startsWith(quote, start)) {
    let pageStart = 0;
    for (const page of doc.pages) {
      if (pageStart >= start + quote.length) break;
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
