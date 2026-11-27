import type { FindingState, Mode, Review } from './model';
import type { LocalEdit } from './editJournal';
import type { ReviewRecipe, StoredJob } from './reviewJob';
import type { ReviewCheckpoint } from './wholeReview';

export type ReviewSummary = { key: string; title: string; mode: Mode; status: StoredJob['status'] };
export type ReviewMeta = ReviewSummary & { owner: string };

type CatalogEntry = ReviewMeta & { position: number };
type FindingEntry = { reviewKey: string; findingKey: string; state: FindingState };
type StoreName = 'catalog' | 'jobs' | 'progress' | 'findings' | 'drafts' | 'edits';
type Progress = { checkpoint?: ReviewCheckpoint; error?: string };
type FileInfo = { path: string[]; name: string; type: string; lastModified: number };
type PackedValue = { data: unknown; files: FileInfo[] };

// WebKit's ephemeral storage can persist bytes even when its native IndexedDB File writes fail.
async function packFiles(data: unknown): Promise<PackedValue> {
  const root = { data: structuredClone(data) };
  const files: FileInfo[] = [];
  const pending: Promise<void>[] = [];
  const seen = new WeakSet<object>();
  function visit(container: Record<string, unknown>, path: string[]) {
    if (seen.has(container)) return;
    seen.add(container);
    for (const [key, value] of Object.entries(container)) {
      if (value instanceof File) {
        const { name, type, lastModified } = value;
        files.push({ path: [...path, key], name, type, lastModified });
        pending.push(value.arrayBuffer().then(bytes => { container[key] = bytes; }));
      } else if (value && typeof value === 'object' && (Array.isArray(value) || Object.getPrototypeOf(value) === Object.prototype)) {
        visit(value as Record<string, unknown>, [...path, key]);
      }
    }
  }
  visit(root, []);
  await Promise.all(pending);
  return { data: root.data, files };
}

function unpackFiles<T>(packed: PackedValue): T {
  const root: Record<string, unknown> = { data: packed.data };
  for (const { path, name, type, lastModified } of packed.files) {
    let container = root;
    for (const key of path.slice(0, -1)) container = container[key] as Record<string, unknown>;
    const key = path[path.length - 1];
    container[key] = new File([container[key] as ArrayBuffer], name, { type, lastModified });
  }
  return root.data as T;
}

let connection: Promise<IDBDatabase> | undefined;

function database(): Promise<IDBDatabase> {
  if (connection) return connection;
  const pending = new Promise<IDBDatabase>((resolve, reject) => {
    const open = indexedDB.open('folio-local-reviews', 2);
    let blocked = false;
    open.onupgradeneeded = event => {
      const db = open.result;
      if (event.oldVersion === 0) {
        db.createObjectStore('catalog', { keyPath: 'key' }).createIndex('position', 'position');
        db.createObjectStore('jobs');
        db.createObjectStore('progress');
        db.createObjectStore('findings', { keyPath: ['reviewKey', 'findingKey'] });
        db.createObjectStore('drafts');
      }
      if (!db.objectStoreNames.contains('edits')) db.createObjectStore('edits');
    };
    open.onerror = () => reject(open.error);
    open.onblocked = () => {
      blocked = true;
      reject(Error('Close other Folio tabs and try opening local reviews again.'));
    };
    open.onsuccess = () => {
      const db = open.result;
      if (blocked) {
        db.close();
        return;
      }
      const forget = () => { if (connection === pending) connection = undefined; };
      db.onclose = forget;
      db.onversionchange = () => { db.close(); forget(); };
      resolve(db);
    };
  });
  connection = pending;
  void pending.catch(() => { if (connection === pending) connection = undefined; });
  return pending;
}

function request<T>(operation: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    operation.onsuccess = () => resolve(operation.result);
    operation.onerror = () => reject(operation.error);
  });
}

async function runTransaction<T>(stores: StoreName[], mode: IDBTransactionMode,
  run: (tx: IDBTransaction) => Promise<T> | T): Promise<T> {
  const db = await database();
  const tx = db.transaction(stores, mode);
  const committed = new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? Error('Local storage was interrupted.'));
  });
  try {
    const [result] = await Promise.all([Promise.resolve().then(() => run(tx)), committed]);
    return result;
  } catch (error) {
    // A synchronous put() failure (e.g. an unclonable value) must roll back earlier writes too.
    try { tx.abort(); } catch { /* Already finished or aborted. */ }
    throw error;
  }
}

// Preparing PDF bytes is asynchronous. Preserve call order so a slower upload cannot overtake
// a subsequent edit or discard, while keeping file reads outside IndexedDB transactions.
const queues = { drafts: Promise.resolve(), reviews: Promise.resolve() };
function transaction<T, P = undefined>(stores: StoreName[], mode: IDBTransactionMode,
  run: (tx: IDBTransaction, prepared: P) => Promise<T> | T, prepare?: () => Promise<P>): Promise<T> {
  const group = stores[0] === 'drafts' ? 'drafts' : 'reviews';
  const operation = queues[group].then(async () => {
    const prepared = await prepare?.() as P;
    return runTransaction(stores, mode, tx => run(tx, prepared));
  });
  queues[group] = operation.then(() => {}, () => {});
  return operation;
}

function getMeta(tx: IDBTransaction, key: string): Promise<CatalogEntry | undefined> {
  return request(tx.objectStore('catalog').get(key));
}

export function readCatalog(): Promise<ReviewMeta[]> {
  return transaction(['catalog'], 'readonly', async tx => {
    const entries: CatalogEntry[] = await request(tx.objectStore('catalog').index('position').getAll());
    return entries.reverse().map(({ key, title, mode, status, owner }) => ({ key, title, mode, status, owner }));
  });
}

function findingRange(reviewKey: string) {
  // Array keys sort after every string, so this includes every finding key for this review.
  return IDBKeyRange.bound([reviewKey], [reviewKey, []]);
}

async function findingsIn(tx: IDBTransaction, key: string): Promise<Map<string, FindingState>> {
  const rows: FindingEntry[] = await request(tx.objectStore('findings').getAll(findingRange(key)));
  return new Map(rows.map(row => [row.findingKey, row.state]));
}

export function readFindings(key: string): Promise<Map<string, FindingState>> {
  return transaction(['findings'], 'readonly', tx => findingsIn(tx, key));
}

function restoredJob(meta: ReviewMeta, payload: PackedValue, progress?: Progress): StoredJob {
  const { key, mode, status, title } = meta;
  if (status === 'complete') {
    const review = unpackFiles<Review>(payload);
    return { key, mode, title, status, review: { ...review, key, title } };
  }
  const recipe = unpackFiles<ReviewRecipe>(payload);
  const checkpoint = progress?.checkpoint;
  if (status === 'failed') return { key, mode, title, status, recipe, checkpoint, error: progress?.error ?? 'Review failed.' };
  return { key, mode, title, status, recipe, checkpoint };
}

export function readSavedReview(key: string): Promise<{ record: StoredJob; findings: Map<string, FindingState> } | undefined> {
  return transaction(['catalog', 'jobs', 'progress', 'findings'], 'readonly', async tx => {
    const [meta, payload, progress, findings] = await Promise.all([
      getMeta(tx, key), request<PackedValue | undefined>(tx.objectStore('jobs').get(key)),
      request<Progress | undefined>(tx.objectStore('progress').get(key)), findingsIn(tx, key),
    ]);
    if (!meta) return undefined;
    if (!payload) throw Error('This review’s saved data is missing.');
    return { record: restoredJob(meta, payload, progress), findings };
  });
}

function storeProgress(tx: IDBTransaction, record: Exclude<StoredJob, { status: 'complete' }>) {
  const error = record.status === 'failed' ? record.error : undefined;
  tx.objectStore('progress').put({ checkpoint: record.checkpoint, error } satisfies Progress, record.key);
}

export function createSavedReview(record: StoredJob, owner: string): Promise<void> {
  return transaction(['catalog', 'jobs', 'progress'], 'readwrite', async (tx, payload) => {
    if (await getMeta(tx, record.key)) return;
    const catalog = tx.objectStore('catalog');
    const newest = await request(catalog.index('position').openKeyCursor(null, 'prev'));
    const position = newest ? Number(newest.key) + 1 : 0;
    const { key, title, mode, status } = record;
    catalog.add({ key, title, mode, status, owner, position } satisfies CatalogEntry);
    tx.objectStore('jobs').add(payload, key);
    if (record.status !== 'complete') storeProgress(tx, record);
  }, () => packFiles(record.status === 'complete' ? record.review : record.recipe));
}

export function saveJobState(record: StoredJob, owner: string): Promise<boolean> {
  return transaction(['catalog', 'jobs', 'progress'], 'readwrite', async (tx, payload) => {
    const meta = await getMeta(tx, record.key);
    if (!meta || meta.owner !== owner) return false;
    if (meta.status === 'complete') return record.status === 'complete';
    tx.objectStore('catalog').put({ ...meta, status: record.status });
    if (record.status === 'complete') {
      tx.objectStore('jobs').put(payload, record.key);
      tx.objectStore('progress').delete(record.key);
    } else {
      storeProgress(tx, record);
    }
    return true;
  }, record.status === 'complete' ? () => packFiles(record.review) : undefined);
}

export function claimSavedReview(key: string, expectedOwner: string, newOwner: string, expectedStatus: StoredJob['status']): Promise<boolean> {
  return transaction(['catalog'], 'readwrite', async tx => {
    const meta = await getMeta(tx, key);
    if (!meta || meta.owner !== expectedOwner || meta.status !== expectedStatus || meta.status === 'complete') return false;
    tx.objectStore('catalog').put({ ...meta, status: 'running', owner: newOwner });
    return true;
  });
}

export function mergeFinding(previous: FindingState | undefined, changes: FindingState): FindingState {
  const state = { ...previous, ...changes };
  if (state.decision?.value !== previous?.decision?.value) state.resolved = !!state.decision?.value;
  return state;
}

async function moveEntry(catalog: IDBObjectStore, meta: CatalogEntry, direction: -1 | 1) {
  // The largest position appears first in the library.
  const up = direction === -1;
  const range = up ? IDBKeyRange.lowerBound(meta.position, true) : IDBKeyRange.upperBound(meta.position, true);
  const cursor = await request(catalog.index('position').openCursor(range, up ? 'next' : 'prev'));
  if (!cursor) return;
  const neighbor: CatalogEntry = cursor.value;
  catalog.put({ ...meta, position: neighbor.position });
  catalog.put({ ...neighbor, position: meta.position });
}

async function editFinding(store: IDBObjectStore, reviewKey: string, findingKey: string, changes: FindingState) {
  const key = [reviewKey, findingKey];
  const previous: FindingEntry | undefined = await request(store.get(key));
  const state = mergeFinding(previous?.state, changes);
  if (state.decision || state.resolved) store.put({ reviewKey, findingKey, state } satisfies FindingEntry);
  else store.delete(key);
}

async function applyEdit(tx: IDBTransaction, edit: LocalEdit) {
  const catalog = tx.objectStore('catalog');
  const { key } = edit;
  if (edit.kind === 'delete') {
    catalog.delete(key);
    tx.objectStore('jobs').delete(key);
    tx.objectStore('progress').delete(key);
    tx.objectStore('findings').delete(findingRange(key));
    return;
  }
  const meta = await getMeta(tx, key);
  if (!meta) return;
  switch (edit.kind) {
    case 'rename':
      catalog.put({ ...meta, title: edit.title });
      return;
    case 'move':
      return moveEntry(catalog, meta, edit.direction);
    case 'finding':
      return editFinding(tx.objectStore('findings'), key, edit.findingKey, edit.changes);
  }
}

const editStores: Record<LocalEdit['kind'], StoreName[]> = {
  rename: ['catalog'], move: ['catalog'], finding: ['catalog', 'findings'], delete: ['catalog', 'jobs', 'progress', 'findings'],
};

export function applyStagedEdit(id: string, edit: LocalEdit, isPending?: () => boolean): Promise<void> {
  return transaction([...editStores[edit.kind], 'edits'], 'readwrite', async tx => {
    const receipts = tx.objectStore('edits');
    if (await request(receipts.getKey(id)) !== undefined || isPending?.() === false) return;
    await applyEdit(tx, edit);
    receipts.add(true, id);
  });
}

export function forgetStagedEdit(id: string): Promise<void> {
  return transaction(['edits'], 'readwrite', tx => { tx.objectStore('edits').delete(id); });
}

export function readDraft<T>(key: string): Promise<T | undefined> {
  return transaction(['drafts'], 'readonly', async tx => {
    const value: PackedValue | undefined = await request(tx.objectStore('drafts').get(key));
    return value && unpackFiles<T>(value);
  });
}

export function writeDraftParts(entries: Record<string, unknown>): Promise<void> {
  return transaction(['drafts'], 'readwrite', (tx, packed) => {
    const drafts = tx.objectStore('drafts');
    for (const [key, value] of packed) drafts.put(value, key);
  }, () => Promise.all(Object.entries(entries).map(async ([key, value]) => [key, await packFiles(value)] as const)));
}

export function deleteDraft(...keys: string[]): Promise<void> {
  return transaction(['drafts'], 'readwrite', tx => {
    const drafts = tx.objectStore('drafts');
    for (const key of keys) drafts.delete(key);
  });
}
