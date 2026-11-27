import type { FindingState } from './model';
import { applyStagedEdit, forgetStagedEdit } from './localReviews';

export type LocalEdit =
  | { kind: 'rename'; key: string; title: string }
  | { kind: 'move'; key: string; direction: -1 | 1 }
  | { kind: 'delete'; key: string }
  | { kind: 'finding'; key: string; findingKey: string; changes: FindingState };

const prefix = 'folio.local-edit.v1.';
const writer = crypto.randomUUID();
const acknowledged = 'done';
const memoryOnly = new Map<string, LocalEdit>();
let sequence = 0;
let tail = Promise.resolve();

// Finding patches distinguish an omitted field from an explicit clear.
function findingFields(key: string, value: unknown, cleared: null | undefined): unknown {
  if (key !== 'changes' || !value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([field, change]) => [field, change ?? cleared]));
}

function pendingIds(): string[] {
  const ids = [...memoryOnly.keys()];
  try {
    ids.push(...Object.keys(localStorage).filter(key => key.startsWith(prefix)));
  } catch { /* IndexedDB can still accept edits when web storage is disabled. */ }
  return ids.sort();
}

async function apply(id: string) {
  const fallback = memoryOnly.get(id);
  if (fallback) {
    await applyStagedEdit(id, fallback);
    await forgetStagedEdit(id);
    memoryOnly.delete(id);
    return;
  }
  const saved = localStorage.getItem(id);
  if (saved === null) return;
  if (saved !== acknowledged) {
    const edit: LocalEdit = JSON.parse(saved, (key, value) => findingFields(key, value, undefined));
    // The receipt and the edit commit together. A reader that arrives after
    // receipt cleanup also checks this key inside the same IDB transaction.
    await applyStagedEdit(id, edit, () => localStorage.getItem(id) === saved);
    if (localStorage.getItem(id) === saved) localStorage.setItem(id, acknowledged);
  }
  // Closing between these two steps leaves a recoverable cleanup record.
  await forgetStagedEdit(id);
  localStorage.removeItem(id);
}

function scheduleDrain(): Promise<void> {
  const result = tail.then(async () => {
    for (const id of pendingIds()) await apply(id);
  });
  // A later edit or recovery retries any entries left by an IDB error.
  tail = result.catch(() => {});
  return result;
}

export async function recoverEdits(): Promise<boolean> {
  if (!pendingIds().length) return false;
  await scheduleDrain();
  return true;
}

export function persistEdit(edit: LocalEdit): Promise<void> {
  // Each writer owns its keys. Sorting them preserves its gesture order even
  // when the originating tab closes before the first transaction completes.
  const id = prefix + writer + '.' + String(++sequence).padStart(16, '0');
  try {
    localStorage.setItem(id, JSON.stringify(edit, (key, value) => findingFields(key, value, null)));
  } catch { memoryOnly.set(id, edit); }
  return scheduleDrain();
}
