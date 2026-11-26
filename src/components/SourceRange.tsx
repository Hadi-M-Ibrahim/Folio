import { useState } from 'react';
import { MAX_GUIDE_CHARACTERS, MAX_QUESTIONS, type Policy } from '../review/model';

export type RangeSource = {
  unit: 'page' | 'question';
  items: Policy['pages'];
  original?: Policy;
};

export function questionnaireRange(questions: string[], original?: Policy): RangeSource | undefined {
  if (questions.length <= MAX_QUESTIONS) return undefined;
  const numbers = questions.map((q) => Number(q.match(/^\s*(?:Q(?:uestion)?\s*)?\(?(\d+)[.):]\s+/i)?.[1]));
  const numbered = numbers.every((n, i) => Number.isSafeInteger(n) && n > 0 && (i === 0 || n > numbers[i - 1]));
  return {
    unit: 'question',
    items: questions.map((text, i) => ({ number: numbered ? numbers[i] : i + 1, text })),
    original,
  };
}

function formatRange(numbers: number[]): string {
  const ranges: string[] = [];
  for (let index = 0; index < numbers.length; index++) {
    const start = numbers[index];
    while (numbers[index + 1] === numbers[index] + 1) index++;
    const end = numbers[index];
    ranges.push(start === end ? String(start) : start + '–' + end);
  }
  return ranges.join(', ');
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

export function SourceRange({ source, oversized, onApply }: {
  source: RangeSource;
  oversized: boolean;
  onApply: (items: Policy['pages'], description?: string) => void;
}) {
  const [open, setOpen] = useState(oversized);
  const [value, setValue] = useState('');
  const [error, setError] = useState('');
  const { items, unit } = source;
  const pages = unit === 'page';
  const first = items[0].number;
  const last = items[items.length - 1].number;
  const group = pages ? 'Guide pages' : 'Questionnaire items';

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
    if (!selected.length) {
      setError('No readable ' + (pages ? 'pages' : 'questions') + ' in this selection.');
      return;
    }
    if (pages ? selected.map((p) => p.text).join('\n\n').length > MAX_GUIDE_CHARACTERS : selected.length > MAX_QUESTIONS) {
      setError(pages ? 'Select a smaller section of up to 50,000 characters.' : 'Select up to 30 questions per review.');
      return;
    }
    setError('');
    onApply(selected, selected.length === items.length ? undefined :
      group + ' ' + formatRange(selected.map((item) => item.number)) + ' (' + selected.length + ' of ' + items.length + (pages ? ' readable pages).' : ' questions).'));
  }

  return (
    <div className="intake-range">
      <button type="button" className="intake-text-button" aria-expanded={open} aria-controls="intake-range-controls"
        onClick={() => setOpen(!open)}>
        {open ? 'Hide range selection' : 'Choose ' + (pages ? 'guide pages' : 'questionnaire items')}
      </button>
      <div id="intake-range-controls" hidden={!open}>
        <label htmlFor="intake-range-value">{group} <span>({first}–{last})</span></label>
        <div className="intake-range-input">
          <input id="intake-range-value" value={value} placeholder={first + '–' + Math.min(first + 2, last)}
            aria-describedby={error ? 'intake-range-error' : 'intake-range-help'} aria-invalid={error ? true : undefined}
            onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); apply(); } }}
            onChange={(event) => { setValue(event.target.value); setError(''); }} />
          <button className="intake-secondary" type="button" onClick={apply}>Apply range</button>
        </div>
        {error ? <p className="intake-error" id="intake-range-error" role="alert">{error}</p> :
          <p className="intake-help" id="intake-range-help">{pages ? 'Use physical page numbers. Separate ranges with commas.' : 'Select up to 30 items. Separate ranges with commas.'}</p>}
      </div>
    </div>
  );
}
