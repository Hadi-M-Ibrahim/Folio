import { isUploadedPolicy, type FindingState, type Mode, type Policy, type Review } from './model';
import type { LocalEdit } from './editJournal';
import type { ReviewRecipe, StoredJob } from './reviewJob';
import type { ReviewCheckpoint } from './wholeReview';

export type ReviewSummary = { key: string; title: string; mode: Mode; status: StoredJob['status'] };
export type ReviewMeta = ReviewSummary & { owner: string };

type CatalogEntry = ReviewMeta & { position: number; policyFiles?: string[] };
type FindingEntry = { reviewKey: string; findingKey: string; state: FindingState };
type StoreName = 'catalog' | 'jobs' | 'progress' | 'findings' | 'drafts' | 'edits';
type Progress = { checkpoint?: ReviewCheckpoint; error?: string };
type FileInfo = { path: string[]; name: string; type: string; lastModified: number };
type PackedValue = { data: unknown; files: FileInfo[] };

// WebKit's ephemeral storage can persist bytes even when its native IndexedDB File writes fail.
async function packFiles(data: unknown): Promise<PackedValue> {
  const original = { data };
  const root = structuredClone(original);
  const files: FileInfo[] = [];
  // A selected page range and its original can refer to the same PDF.
  const buffers = new Map<File, Promise<ArrayBuffer>>();
  const pending: Promise<void>[] = [];
  const seen = new WeakSet<object>();
  function visit(container: Record<string, unknown>, source: Record<string, unknown>, path: string[]) {
    if (seen.has(container)) return;
    seen.add(container);
    // WebKit may clone the same File into separate JS objects. Use the source for identity.
    for (const [key, value] of Object.entries(source)) {
      if (value instanceof File) {
        const { name, type, lastModified } = value;
        files.push({ path: [...path, key], name, type, lastModified });
        const buffer = buffers.get(value) ?? value.arrayBuffer();
        buffers.set(value, buffer);
        pending.push(buffer.then(bytes => { container[key] = bytes; }));
      } else if (value && typeof value === 'object' && (Array.isArray(value) || Object.getPrototypeOf(value) === Object.prototype)) {
        visit(container[key] as Record<string, unknown>, value as Record<string, unknown>, [...path, key]);
      }
    }
  }
  visit(root, original, []);
  await Promise.all(pending);
  return { data: root.data, files };
}

function unpackFiles<T>(packed: PackedValue): T {
  const root: Record<string, unknown> = { data: packed.data };
  const originals = new Map<ArrayBuffer, File>();
  for (const { path, name, type, lastModified } of packed.files) {
    let container = root;
    for (const key of path.slice(0, -1)) container = container[key] as Record<string, unknown>;
    const key = path[path.length - 1];
    const bytes = container[key] as ArrayBuffer;
    const file = originals.get(bytes) ?? new File([bytes], name, { type, lastModified });
    originals.set(bytes, file);
    container[key] = file;
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

function uploadNames(content: Pick<Review, 'input' | 'scope'>) {
  // Prepared reviews contain extracted passages from a selected corpus.
  return content.scope ? [] : content.input.documents.filter(isUploadedPolicy).map(doc => doc.title);
}

const legacyUploadNames = new Map<string, string[]>();
export function readPreviousPolicyReview(): Promise<{ key: string; title: string; files: string[] } | undefined> {
  return transaction(['catalog', 'jobs'], 'readonly', async tx => {
    const rows: CatalogEntry[] = await request(tx.objectStore('catalog').index('position').getAll());
    for (const { key, title, policyFiles } of rows.reverse()) {
      let files = policyFiles ?? legacyUploadNames.get(key);
      if (!files) {
        // Older rows lack the names index. Inspect the stored input without rebuilding PDFs.
        const payload: PackedValue | undefined = await request(tx.objectStore('jobs').get(key));
        files = payload ? uploadNames(payload.data as Pick<Review, 'input' | 'scope'>) : [];
        legacyUploadNames.set(key, files);
      }
      if (files.length) return { key, title, files };
    }
  });
}

export function readSavedPolicyUploads(key: string): Promise<Policy[]> {
  return transaction(['jobs'], 'readonly', async tx => {
    const payload: PackedValue | undefined = await request(tx.objectStore('jobs').get(key));
    if (!payload) return [];
    const files = payload.files.filter(({ path }) => path[1] === 'input' && path[2] === 'documents');
    const content = unpackFiles<Pick<Review, 'input' | 'scope'>>({ data: payload.data, files });
    return content.scope ? [] : content.input.documents.filter(isUploadedPolicy);
  });
}

function findingRange(reviewKey: string) {
  // Array keys sort after every string, so this includes every finding key for this review.
  return IDBKeyRange.bound([reviewKey], [reviewKey, []]);
}

function restoreFinding(state: FindingState): FindingState {
  // In the original guide editor, choosing a disposition saved the action immediately.
  if (state.resolved === undefined && state.decision?.action && !state.decision.value) {
    return { ...state, resolved: true, decision: { ...state.decision, value: 'confirmed' } };
  }
  return state;
}

async function findingsIn(tx: IDBTransaction, key: string): Promise<Map<string, FindingState>> {
  const rows: FindingEntry[] = await request(tx.objectStore('findings').getAll(findingRange(key)));
  return new Map(rows.map(row => [row.findingKey, restoreFinding(row.state)]));
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
    const policyFiles = uploadNames(record.status === 'complete' ? record.review : record.recipe);
    catalog.add({ key, title, mode, status, owner, position, policyFiles } satisfies CatalogEntry);
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
  const state = { resolved: false, ...previous, ...changes };
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
  const state = mergeFinding(previous && restoreFinding(previous.state), changes);
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

type DraftVersion = { key: string; revision: string | null | undefined };

async function getDraft<T>(drafts: IDBObjectStore, key: string): Promise<T | undefined> {
  const value: PackedValue | undefined = await request(drafts.get(key));
  return value && unpackFiles<T>(value);
}

async function matchesVersion(drafts: IDBObjectStore, expected: DraftVersion) {
  const current = await getDraft<{ revision: string } | null>(drafts, expected.key);
  return (current === null ? null : current?.revision) === expected.revision;
}

export function readDraft<T>(key: string): Promise<T | undefined> {
  return transaction(['drafts'], 'readonly', tx => getDraft<T>(tx.objectStore('drafts'), key));
}

export function readDraftParts<T>(keys: string[], expected: DraftVersion): Promise<T[] | undefined> {
  return transaction(['drafts'], 'readonly', async tx => {
    const drafts = tx.objectStore('drafts');
    if (!await matchesVersion(drafts, expected)) return undefined;
    const values: (T | undefined)[] = await Promise.all(keys.map(key => getDraft<T>(drafts, key)));
    if (values.every((part): part is T => part !== undefined)) return values;
    throw Error('Some of the saved policy files are missing.');
  });
}

export function writeDraftParts(entries: Record<string, unknown>, expected?: DraftVersion, remove: string[] = []): Promise<boolean> {
  return transaction(['drafts'], 'readwrite', async (tx, packed) => {
    const drafts = tx.objectStore('drafts');
    if (expected && !await matchesVersion(drafts, expected)) return false;
    for (const [key, value] of packed) drafts.put(value, key);
    for (const key of remove) drafts.delete(key);
    return true;
  }, () => Promise.all(Object.entries(entries).map(async ([key, value]) => [key, await packFiles(value)] as const)));
}

export function deleteDraft(...keys: string[]): Promise<void> {
  return transaction(['drafts'], 'readwrite', tx => {
    const drafts = tx.objectStore('drafts');
    for (const key of keys) drafts.delete(key);
  });
}
