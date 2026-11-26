import { useState } from 'react';
import { ChevronDown, ListFilter } from 'lucide-react';
import { MAX_PDF_ATTACHMENT_PAGES, type Policy } from '../review/model';
import type { PdfQuestion } from './intakeQuestions';

export type RangeItem = { number: number; text: string; pageNumbers?: number[] };
type PageKind = 'guide' | 'questionnaire' | 'policy';

export type RangeSource = {
  unit: 'page' | 'question';
  items: RangeItem[];
  original?: Policy;
  originalSelection?: string;
};

export function questionnaireRange(questions: (string | PdfQuestion)[], original?: Policy, preparedNumbers?: unknown): RangeSource | undefined {
  if (questions.length < 2) return undefined;
  const prompts = questions.map((question) => typeof question === 'string' ? { text: question } : question);
  const numbers = Array.isArray(preparedNumbers) && preparedNumbers.length === questions.length
    ? preparedNumbers
    : prompts.map(({ text }) => Number(text.match(/^\s*(?:Q(?:uestion)?\s*)?\(?(\d+)[.):]\s+/i)?.[1]));
  const numbered = numbers.every((n, i) => Number.isSafeInteger(n) && n > 0 && (i === 0 || n > numbers[i - 1]));
  return {
    unit: 'question',
    items: prompts.map((prompt, i) => ({ ...prompt, number: numbered ? numbers[i] : i + 1 })),
    original,
    originalSelection: preparedSelection(preparedNumbers, 'question'),
  };
}

export function formatRange(numbers: number[]): string {
  const ranges: string[] = [];
  for (let index = 0; index < numbers.length; index++) {
    const start = numbers[index];
    while (numbers[index + 1] === numbers[index] + 1) index++;
    const end = numbers[index];
    ranges.push(start === end ? String(start) : start + '–' + end);
  }
  return ranges.join(', ');
}

export function pdfScopeLabel(numbers: number[], subset: boolean) {
  if (subset) return (numbers.length === 1 ? 'Selected PDF page ' : 'Selected PDF pages ') + formatRange(numbers) + '.';
  return numbers.length === 1 ? 'Entire PDF included (1 page).' : 'All ' + numbers.length + ' PDF pages included.';
}

export function preparedSelection(numbers: unknown, unit: 'page' | 'question'): string | undefined {
  if (!Array.isArray(numbers) || !numbers.length || !numbers.every((n) => Number.isSafeInteger(n) && n > 0)) return undefined;
  const ordered = [...new Set<number>(numbers)].sort((a, b) => a - b);
  return (unit === 'page' ? 'Guide pages ' : 'Questionnaire items ') + formatRange(ordered) + '.';
}

export function preparedGuide(value: unknown, guide: string, selected: unknown): Policy | undefined {
  if (value && typeof value === 'object') {
    const doc = value as Partial<Policy>;
    const pages = doc.pages;
    if (typeof doc.id === 'string' && doc.id.trim() && typeof doc.title === 'string' && doc.title.trim() &&
      Array.isArray(pages) && pages.length > 0 && pages.every((page, index) => page &&
        Number.isSafeInteger(page.number) && page.number > 0 && typeof page.text === 'string' &&
        (index === 0 || pages[index - 1].number < page.number)) &&
      pages.map((page) => page.text).join('\n\n') === guide &&
      (!Array.isArray(selected) || (pages.length === selected.length && pages.every((page, index) => page.number === selected[index])))
    ) return { id: doc.id, title: doc.title, pages };
  }
  if (Array.isArray(selected) && selected.length === 1 && Number.isSafeInteger(selected[0]) && selected[0] > 0) {
    return { id: 'submitted-guide', title: 'Submitted guide', pages: [{ number: selected[0], text: guide }] };
  }
  return undefined;
}

function rangeError(source: RangeSource, pageKind: PageKind, selected: RangeItem[]): string {
  if (!selected.length) return 'No ' + (source.unit === 'page' ? 'pages' : 'questions') + ' in this selection.';
  if (pageKind === 'policy' && selected.length > MAX_PDF_ATTACHMENT_PAGES) {
    return 'Select up to ' + MAX_PDF_ATTACHMENT_PAGES + ' policy PDF pages.';
  }
  return '';
}

export function SourceRange({ source, oversized = false, appliedValue, pageKind = 'guide', onApply, onEdit }: {
  source: RangeSource;
  oversized?: boolean;
  appliedValue?: string;
  pageKind?: PageKind;
  onApply: (items: RangeItem[], description: string | undefined, rangeValue: string) => void;
  onEdit?: () => void;
}) {
  const [expanded, setExpanded] = useState<boolean>();
  const [value, setValue] = useState(appliedValue ?? '');
  const [error, setError] = useState('');
  const open = expanded ?? (oversized || Boolean(appliedValue));
  const { items, unit } = source;
  const pages = unit === 'page';
  const first = items[0].number;
  const last = items[items.length - 1].number;
  const pageLabels = { guide: 'Guide pages', questionnaire: 'Questionnaire pages', policy: 'Policy pages' };
  const group = pages ? pageLabels[pageKind] : 'Questionnaire items';
  const controlId = 'range-' + (source.original?.id ?? 'pasted');

  function apply() {
    const ranges: { start: number; end: number }[] = [];
    for (const part of value.split(',')) {
      const match = part.match(/^\s*(\d+)\s*(?:[-–]\s*(\d+)\s*)?$/);
      const start = Number(match?.[1]);
      const end = Number(match?.[2] ?? start);
      if (!match || start < first || end < start || end > last) {
        setError('Enter numbers or ranges between ' + first + ' and ' + last + ', separated by commas.');
        return;
      }
      ranges.push({ start, end });
    }
    const selected = items.filter((item) => ranges.some(({ start, end }) => start <= item.number && item.number <= end));
    const message = rangeError(source, pageKind, selected);
    if (message) { setError(message); return; }
    setError('');
    const formatted = formatRange(selected.map((item) => item.number));
    const description = selected.length === items.length ? source.originalSelection :
      group + ' ' + formatted + ' (' + selected.length + ' of ' + items.length + (pages ? ' pages).' : ' questions).');
    setValue(formatted);
    setExpanded(true);
    onApply(selected, description, formatted);
  }

  return (
    <div className="intake-range">
      <button type="button" className="intake-text-button" aria-expanded={open} aria-controls={controlId}
        onClick={() => setExpanded(!open)}>
        <ListFilter size={17} aria-hidden="true" />
        {'Choose ' + group.toLowerCase()}
        <ChevronDown className="intake-chevron" size={14} aria-hidden="true" />
      </button>
      <div id={controlId} hidden={!open}>
        <label htmlFor={controlId + '-value'}>{group} <span>({first}–{last})</span></label>
        <div className="intake-range-input">
          <input id={controlId + '-value'} value={value} placeholder={first + '–' + Math.min(first + 2, last)}
            aria-describedby={controlId + (error ? '-error' : '-help')} aria-invalid={error ? true : undefined}
            onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); apply(); } }}
            onChange={(event) => { onEdit?.(); setValue(event.target.value); setError(''); }} />
          <button className="intake-secondary" type="button" onClick={apply}>Apply range</button>
        </div>
        {error ? <p className="intake-error" id={controlId + '-error'} role="alert">{error}</p> :
          <p className="intake-help" id={controlId + '-help'}>{pages ? 'Use physical page numbers. Separate ranges with commas.' : 'Separate item numbers or ranges with commas.'}</p>}
      </div>
    </div>
  );
}
