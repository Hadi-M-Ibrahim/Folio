import { Check, Flag, Search, SlidersHorizontal, X } from 'lucide-react';
import { policyActionLabels, statusLabels, type ReviewRow, type Status } from '../review/model';

export type QueueOptions = {
  search: string;
  status: Status | 'all';
  showStatuses: boolean;
  expanded: boolean;
};

type Props = {
  rows: readonly ReviewRow[];
  currentIndex?: number;
  label: string;
  total: number;
  reviewed: number;
  hasPolicies: boolean;
  options: QueueOptions;
  onChange: (changes: Partial<QueueOptions>) => void;
  onSelect: (index: number) => void;
};

export function FindingQueue({ rows, currentIndex, label, total, reviewed, hasPolicies, options, onChange, onSelect }: Props) {
  const { search, status, showStatuses, expanded } = options;
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
            <span>
              {reviewed}/{total} reviewed
            </span>
          </div>
          <div className="queue-controls">
            <div className="queue-search">
              <Search size={15} />
              <input
                aria-label="Search findings"
                placeholder="Search findings…"
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
          </div>
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
        {rows.map(({ finding, index, decision }) => (
          <button
            className="queue-row"
            key={finding.id}
            aria-pressed={index === currentIndex}
            onClick={() => onSelect(index)}
          >
            <span className="row-top">
              <span className="row-name">{finding.question}</span>
              {(decision?.value || decision?.action) &&
                (decision.value === 'flagged'
                  ? <Flag size={13} aria-label="Flagged" />
                  : <Check size={13} aria-label="Reviewed" />)}
            </span>
            <span className="row-status">
              {decision?.action ? policyActionLabels[decision.action] : hasPolicies ? statusLabels[finding.status] : 'Action pending'}
            </span>
          </button>
        ))}
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
