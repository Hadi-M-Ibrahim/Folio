import type { PdfQuestion } from '../components/intakeQuestions';
import type { Policy } from './model';

export type Transcript = { pages: Policy['pages']; questions?: PdfQuestion[] };
export type Span = { start: number; end: number };
export type PageSpan = Span & { number: number };

export function pageSpans(pages: Policy['pages'], separatorLength: number, offset = 0): PageSpan[] {
  let start = -offset;
  return pages.map(({ number, text }) => {
    const span = { number, start, end: start + text.length };
    start = span.end + separatorLength;
    return span;
  });
}

export function pagesIn(spans: PageSpan[], { start, end }: Span): number[] {
  return spans.filter(page => page.end > start && page.start < end).map(page => page.number);
}

export function guideBreak(text: string, start: number, target: number): number {
  const window = text.slice(start, target);
  const half = Math.floor(window.length / 2);
  // Prefer complete paragraphs and sentences before resorting to a wrapped line or word.
  for (const boundary of [/[.!?]["”')\]]*\s*\n\s*\n/gu, /[.!?]["”')\]]*\s+/gu,
    /\n\s*\n(?=[A-Z0-9•])/gu, /\n/g, /\s+/gu]) {
    let last = 0;
    for (const match of window.matchAll(boundary)) last = match.index + match[0].length;
    if (last > half) return start + last;
  }
  if (/[\uD800-\uDBFF]/u.test(text.charAt(target - 1)) && /[\uDC00-\uDFFF]/u.test(text.charAt(target))) {
    return target - 1 > start ? target - 1 : target + 1;
  }
  return target;
}

export function* sourceSpans(length: number, limit: number, guide?: string): Generator<Span> {
  let start = 0;
  while (start < length) {
    const target = Math.min(start + limit, length);
    const end = guide && target < length ? guideBreak(guide, start, target) : target;
    yield { start, end };
    start = end;
  }
}

export function* questionSpans(questions: string[], countLimit: number, textTarget: number): Generator<Span> {
  let start = 0;
  let size = 0;
  for (const [i, question] of questions.entries()) {
    if (i > start && (i - start >= countLimit || size + question.length > textTarget)) {
      yield { start, end: i };
      start = i;
      size = 0;
    }
    size += question.length;
  }
  if (start < questions.length) yield { start, end: questions.length };
}

const sentenceBoundary = /[.!?]["”’')\]]*\s+(?=\S)/gu;
const paragraphOrListBoundary = /\n\s*\n(?=[\p{Lu}\d•(])|\n[^\S\n]*(?=(?:[-*•]|\(\w+\)|(?:\d+|[A-Za-z])[.)])\s)/gu;
const abbreviatedReference = /\b(?:secs?|subsecs?|arts?|chs?|paras?|pars?|pts?|nos?|regs?|figs?|vols?|pp?|dept|e\.g|i\.e|cf|vs|(?:[a-z]\.)+[a-z])\.$/iu;
const listNumber = /(?:^|\n)\s*(?:\d+|[a-z])\.$/iu;
// A short intact unit can be cited in full by the guide planner.
const maxWholeGuideUnit = 2000;

function guideDivision(guide: string, span: Span, midpoint: number): number {
  const text = guide.slice(span.start, span.end).trimEnd();
  const first = text.search(/\S/u);
  // A PDF page break can fall in a sentence. Prefer a complete sentence on either side of the midpoint.
  for (const boundary of [sentenceBoundary, paragraphOrListBoundary]) {
    let closest: number | undefined;
    for (const match of text.matchAll(boundary)) {
      if (match.index! <= first) continue;
      if (match[0].startsWith('.')) {
        const prefix = text.slice(Math.max(0, match.index! - 32), match.index! + 1);
        if (abbreviatedReference.test(prefix) || listNumber.test(prefix)) continue;
      }
      const cut = span.start + match.index! + match[0].length;
      if (closest === undefined || Math.abs(cut - midpoint) < Math.abs(closest - midpoint)) closest = cut;
    }
    if (closest !== undefined) return closest;
  }
  return text.length > maxWholeGuideUnit ? guideBreak(guide, span.start, midpoint) : span.end;
}

export function divide(span: Span, guide?: string): Span[] {
  const midpoint = span.start + Math.ceil((span.end - span.start) / 2);
  const end = guide ? guideDivision(guide, span, midpoint) : midpoint;
  return end > span.start && end < span.end
    ? [{ start: span.start, end }, { start: end, end: span.end }]
    : [];
}

function normalized(text: string) {
  return text.trim().replace(/\s+/gu, ' ');
}

// OCR prompts are verified by the service against these same normalized transcripts.
// Locate them sequentially so repeated prompts remain tied to their own physical page.
export function locateQuestions(pages: Policy['pages'], questions: readonly string[]) {
  const normalizedPages = pages.map(page => ({ ...page, text: normalized(page.text) })).filter(page => page.text);
  const spans = pageSpans(normalizedPages, 1);
  const text = normalizedPages.map(page => page.text).join(' ');
  let cursor = 0;
  return questions.map(question => {
    const quote = normalized(question);
    const start = text.indexOf(quote, cursor);
    if (!quote || start < 0) throw Error('A questionnaire prompt could not be located on its original PDF pages.');
    cursor = start + quote.length;
    return { text: question, pageNumbers: pagesIn(spans, { start, end: cursor }) };
  });
}

type PositionedQuestion = Span & { question: PdfQuestion };

function positions(questions: PdfQuestion[], pages: Map<number, string>, offsets: Map<number, number>): PositionedQuestion[] {
  let previous = -1;
  return questions.map(question => {
    const first = question.pageNumbers[0];
    const page = pages.get(first)!;
    const base = offsets.get(first)!;
    const quote = normalized(question.text);
    // The beginning of the prompt is on this page. Its remaining wording may continue past a
    // printed footer or onto another page. Repeated wordings advance from the previous occurrence.
    let prefix = quote.slice(0, 160);
    const from = Math.max(0, previous + 1 - base);
    let index = page.indexOf(prefix, from);
    while (index < 0 && prefix.includes(' ')) {
      prefix = prefix.slice(0, prefix.lastIndexOf(' '));
      index = page.indexOf(prefix, from);
    }
    const start = base + Math.max(from, index);
    previous = start;
    return { question, start, end: start + quote.length };
  });
}

export function combineScanQuestions(groups: Transcript[], parsed: PdfQuestion[]) {
  const pages = new Map<number, string>();
  const offsets = new Map<number, number>();
  const sections = new Map<number, number>();
  let offset = 0;
  for (const [i, group] of groups.entries()) {
    for (const page of group.pages) {
      const text = normalized(page.text);
      pages.set(page.number, text);
      sections.set(page.number, i);
      offsets.set(page.number, offset);
      offset += text.length + 1;
    }
  }
  const native = positions(groups.flatMap(group => group.questions ?? []), pages, offsets);
  const local = positions(parsed, pages, offsets);
  const merged = [...native];
  let cursor = 0;
  for (const candidate of local) {
    while (cursor < native.length && native[cursor].end <= candidate.start) cursor++;
    const anchor = native[cursor];
    if (!anchor || anchor.start >= candidate.end) {
      merged.push(candidate);
      continue;
    }
    const numbers = candidate.question.pageNumbers;
    const crossesBoundary = sections.get(numbers[0]) !== sections.get(numbers.at(-1)!);
    if (crossesBoundary && anchor.question.pageNumbers[0] === numbers[0] &&
      normalized(candidate.question.text).startsWith(normalized(anchor.question.text))) {
      // OCR returns the part starting in its group. Restore the complete prompt from the full transcript.
      merged[cursor] = candidate;
    }
  }
  return merged.sort((a, b) => a.start - b.start).map(item => item.question);
}
