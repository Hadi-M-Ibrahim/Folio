import { Check, ChevronRight, Search, SlidersHorizontal, Undo2, X } from 'lucide-react';
import { useRef, useState } from 'react';
import { policyActionLabels, responseLabels, statusLabels, type ReviewRow, type Status } from '../review/model';
import { QuestionListMotion } from './QuestionListMotion';

export type QueueOptions = {
  search: string;
  status: Status | 'all';
  showStatuses: boolean;
  expanded: boolean;
};

type QueueRow = ReviewRow & { resolved: boolean };
type ChangeResolution = (index: number, resolved: boolean) => void;
type ListProps = {
  rows: readonly QueueRow[];
  currentIndex?: number;
  hasPolicies: boolean;
  onSelect: (index: number) => void;
};
type Props = ListProps & {
  label: string;
  total: number;
  options: QueueOptions;
  onChange: (changes: Partial<QueueOptions>) => void;
  onResolve?: ChangeResolution;
};

export function FindingQueue({ rows, currentIndex, label, total, hasPolicies, options, onChange, onSelect, onResolve }: Props) {
  const { search, status, showStatuses, expanded } = options;
  const list = { currentIndex, hasPolicies, onSelect };
  const filtered = Boolean(search.trim()) || status !== 'all';
  return (
    <aside className="queue" aria-label="Review queue" data-expanded={expanded}>
      <button
        className="mobile-queue"
        aria-expanded={expanded}
        aria-controls="review-queue"
        onClick={() => onChange({ expanded: !expanded })}
      >
        {label} ({total})
        <span>{expanded ? 'Hide list' : 'Show list'}</span>
      </button>
      <div id="review-queue">
        <div className="queue-head">
          <div className="section-title">
            <h2>{label}</h2>
            <span>{total}</span>
          </div>
          {total > 5 && <div className="queue-controls">
            <div className="queue-search">
              <Search size={15} />
              <input
                aria-label={'Search ' + label.toLowerCase()}
                placeholder={'Search ' + label.toLowerCase()}
                value={search}
                onChange={(e) => onChange({ search: e.target.value })}
              />
              {search && (
                <button aria-label="Clear search" onClick={() => onChange({ search: '' })}>
                  <X size={13} />
                </button>
              )}
            </div>
            {hasPolicies && <button
              className={'filter-button ' + (showStatuses || status !== 'all' ? 'active' : '')}
              aria-label="Filter by finding status"
              aria-expanded={showStatuses}
              onClick={() => onChange({ showStatuses: !showStatuses })}
            >
              <SlidersHorizontal size={16} />
            </button>}
          </div>}
          {showStatuses && (
            <label className="filter-select">
              Status
              <select value={status} onChange={(e) => onChange({ status: e.target.value as QueueOptions['status'] })}>
                <option value="all">All statuses</option>
                {Object.entries(statusLabels).map(([status, label]) => (
                  <option key={status} value={status}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
        {onResolve
          ? <QuestionList key={String(filtered)} {...list} rows={rows} onResolve={onResolve} filtered={filtered} />
          : <QueueItems {...list} rows={rows} />}
        {!rows.length && (
          <div className="empty-list">
            <Search size={20} />
            <p>No matching findings</p>
            {(search || status !== 'all') && (
              <button
                className="text-link"
                onClick={() => onChange({ search: '', status: 'all' })}
              >
                Clear filters
              </button>
            )}
          </div>
        )}
      </div>
    </aside>
  );
}

export function ResolutionButton({ row, onResolve, showLabel }: {
  row: QueueRow; onResolve: ChangeResolution; showLabel?: boolean;
}) {
  const label = row.resolved ? 'Reopen question' : 'Resolve question';
  const Icon = row.resolved ? Undo2 : Check;
  return (
    <button type="button" id={'resolve-question-' + row.index} className="resolution-button"
      aria-label={label + ' ' + (row.index + 1)} title={label}
      onClick={() => onResolve(row.index, !row.resolved)}>
      <Icon size={18} aria-hidden="true" />{showLabel && label}
    </button>
  );
}

function QueueItems({ rows, currentIndex, hasPolicies, onSelect, onResolve }: ListProps & { onResolve?: ChangeResolution }) {
  return rows.map(row => {
    const { finding, index, decision } = row;
    const status = decision?.action ? policyActionLabels[decision.action] : decision?.value ? responseLabels[decision.value]
      : hasPolicies ? statusLabels[finding.status] : 'Action pending';
    return (
      <div className="queue-item" key={finding.id}>
        <button className="queue-row" aria-pressed={index === currentIndex} onClick={() => onSelect(index)}>
          <span className="row-top">
            <span className="row-name">{finding.question}</span>
            {decision?.action && <Check size={13} aria-label="Reviewed" />}
          </span>
          <span className="row-status">{status}</span>
        </button>
        {onResolve && <ResolutionButton row={row} onResolve={onResolve} />}
      </div>
    );
  });
}

function QuestionList({ rows, filtered, onResolve, ...list }: ListProps & { filtered: boolean; onResolve: ChangeResolution }) {
  const [expanded, setExpanded] = useState(filtered);
  const disclosure = useRef<HTMLButtonElement>(null);
  const open = rows.filter(row => !row.resolved);
  const resolved = rows.filter(row => row.resolved);

  function moveQuestion(index: number, resolve: boolean) {
    const group = resolve ? open : resolved;
    const position = group.findIndex(row => row.index === index);
    const neighbor = group[position + 1] ?? group[position - 1];
    onResolve(index, resolve);
    // The old control unmounts when its question moves between groups.
    requestAnimationFrame(() => {
      const target = !neighbor && resolve ? disclosure.current : document.getElementById('resolve-question-' + (neighbor?.index ?? index));
      target?.focus();
    });
  }

  return (
    <QuestionListMotion resolvedCount={resolved.length}>
      <section aria-label="Open questions"><QueueItems {...list} rows={open} onResolve={moveQuestion} /></section>
      {resolved.length > 0 && (
        <>
          <button type="button" className="resolved-disclosure" ref={disclosure} aria-expanded={expanded}
            aria-controls="resolved-questions" onClick={() => setExpanded(!expanded)}>
            <ChevronRight size={15} aria-hidden="true" /> Resolved <span>{resolved.length}</span>
          </button>
          <section id="resolved-questions" aria-label="Resolved questions" hidden={!expanded}>
            <QueueItems {...list} rows={resolved} onResolve={moveQuestion} />
          </section>
        </>
      )}
    </QuestionListMotion>
  );
}
