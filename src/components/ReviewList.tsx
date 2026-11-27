import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { ArrowDown, ArrowRight, ArrowUp, Ellipsis, Pencil, Trash2 } from 'lucide-react';
import type { ReviewSummary } from '../review/localReviews';
import { modeLabels } from '../review/model';

export type ReviewActions = {
  rename: (key: string, title: string) => void;
  move: (key: string, direction: -1 | 1) => void;
  remove: (key: string) => void;
};

const statusLabels = { running: 'In progress', paused: 'Paused', failed: 'Needs attention', complete: 'Ready' };
type Panel = 'menu' | 'rename' | 'delete' | null;

function navigateMenu(event: KeyboardEvent<HTMLDivElement>, close: () => void) {
  if (event.key === 'Tab') {
    close();
    return;
  }
  const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:enabled')];
  const index = items.indexOf(document.activeElement as HTMLButtonElement);
  const destinations: Record<string, number> = {
    ArrowDown: (index + 1) % items.length,
    ArrowUp: (index - 1 + items.length) % items.length,
    Home: 0,
    End: items.length - 1,
  };
  const destination = destinations[event.key];
  if (destination === undefined) return;
  event.preventDefault();
  items[destination].focus();
}

function ReviewRow({ review, actions, first, last }: {
  review: ReviewSummary; actions?: ReviewActions; first: boolean; last: boolean;
}) {
  const title = review.title.trim() || modeLabels[review.mode] + ' review';
  const [panel, setPanel] = useState<Panel>(null);
  const [name, setName] = useState('');
  const row = useRef<HTMLLIElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const cancelDelete = useRef<HTMLButtonElement>(null);
  const menuId = 'review-actions-' + review.key;

  useLayoutEffect(() => {
    if (panel === 'menu' && menu.current && toggle.current) {
      const bounds = menu.current.getBoundingClientRect();
      if (bounds.bottom > window.innerHeight && toggle.current.getBoundingClientRect().top > bounds.height) {
        menu.current.dataset.above = 'true';
      }
      menu.current.querySelector('button')?.focus();
    }
    if (panel === 'rename') {
      input.current?.focus();
      input.current?.select();
    }
    if (panel === 'delete') cancelDelete.current?.focus();
  }, [panel]);

  useEffect(() => {
    if (!panel) return;
    const currentRow = row.current;
    function escape(event: globalThis.KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault();
        closePanel();
      }
    }
    function dismiss(event: PointerEvent) {
      if (event.target instanceof Node && !currentRow?.contains(event.target)) setPanel(null);
    }
    currentRow?.addEventListener('keydown', escape);
    if (panel === 'menu') document.addEventListener('pointerdown', dismiss);
    return () => {
      currentRow?.removeEventListener('keydown', escape);
      document.removeEventListener('pointerdown', dismiss);
    };
  }, [panel]);

  function closePanel() {
    setPanel(null);
    toggle.current?.focus();
  }

  function move(direction: -1 | 1) {
    actions?.move(review.key, direction);
    setPanel(null);
    requestAnimationFrame(() => toggle.current?.focus());
  }

  function remove() {
    const neighbor = row.current?.nextElementSibling ?? row.current?.previousElementSibling;
    const nextFocus = neighbor?.querySelector<HTMLElement>('.session-review') ?? document.getElementById('review-options');
    nextFocus?.focus();
    actions?.remove(review.key);
    setPanel(null);
  }

  return (
    <li className="review-list-row" ref={row}>
      <div className="review-row-main">
        <a className="session-review" href={'#/review/' + review.key}>
          <span>{title}</span>
          <small>{modeLabels[review.mode]} · <span aria-live="polite">{statusLabels[review.status]}</span></small>
          <ArrowRight aria-hidden="true" size={17} />
        </a>
        {actions && <div className="review-controls" onBlur={event => {
          if (panel === 'menu' && !event.currentTarget.contains(event.relatedTarget)) setPanel(null);
        }}>
          <button className="review-actions-toggle" ref={toggle} aria-label={'Actions for ' + title}
            aria-haspopup="menu" aria-expanded={panel === 'menu'} aria-controls={panel === 'menu' ? menuId : undefined}
            onClick={() => setPanel(panel === 'menu' ? null : 'menu')}
            onKeyDown={event => {
              if (event.key === 'ArrowDown') { event.preventDefault(); setPanel('menu'); }
            }}>
            <Ellipsis size={19} aria-hidden="true" />
          </button>
          {panel === 'menu' && (
            <div className="review-actions-menu" role="menu" tabIndex={-1} aria-label={'Actions for ' + title} id={menuId} ref={menu}
              onKeyDown={event => navigateMenu(event, closePanel)}>
              <button role="menuitem" tabIndex={-1} onClick={() => { setName(title); setPanel('rename'); }}>
                <Pencil size={15} aria-hidden="true" />Rename
              </button>
              <button role="menuitem" tabIndex={-1} disabled={first} onClick={() => move(-1)}>
                <ArrowUp size={15} aria-hidden="true" />Move up
              </button>
              <button role="menuitem" tabIndex={-1} disabled={last} onClick={() => move(1)}>
                <ArrowDown size={15} aria-hidden="true" />Move down
              </button>
              <button className="review-delete-action" role="menuitem" tabIndex={-1} onClick={() => setPanel('delete')}>
                <Trash2 size={15} aria-hidden="true" />Delete
              </button>
            </div>
          )}
        </div>}
      </div>
      {panel === 'rename' && <form className="review-row-editor" onSubmit={event => {
        event.preventDefault();
        const trimmed = name.trim();
        if (!trimmed) return;
        actions?.rename(review.key, trimmed);
        closePanel();
      }}>
        <label className="review-name-field">
          Review name
          <input ref={input} value={name} onChange={event => setName(event.target.value)} />
        </label>
        <div className="review-editor-buttons">
          <button type="button" onClick={closePanel}>Cancel</button>
          <button className="review-save-button" type="submit" disabled={!name.trim()}>Save</button>
        </div>
      </form>}
      {panel === 'delete' && <fieldset className="review-row-editor review-delete-confirm" aria-label="Confirm deletion">
        <p>Delete “{title}” from this browser?</p>
        <div className="review-editor-buttons">
          <button type="button" ref={cancelDelete} onClick={closePanel}>Cancel</button>
          <button className="review-delete-button" type="button" onClick={remove}>Delete review</button>
        </div>
      </fieldset>}
    </li>
  );
}

export function ReviewList({ reviews, actions }: { reviews: ReviewSummary[]; actions?: ReviewActions }) {
  return (
    <section className="session-reviews" aria-labelledby="session-title">
      <h2 id="session-title">Reviews</h2>
      <ul>
        {reviews.map((review, index) => (
          <ReviewRow key={review.key} review={review} actions={actions} first={index === 0} last={index === reviews.length - 1} />
        ))}
      </ul>
    </section>
  );
}
