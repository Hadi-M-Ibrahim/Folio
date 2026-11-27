import { isUploadedPolicy, type IntakePolicy, type Policy } from './model';
import { readDraft, readDraftParts, readSavedPolicyUploads, writeDraftParts } from './localReviews';

export { readPreviousPolicyReview } from './localReviews';

export type RecentPolicySet = {
  revision: string;
  files: { id: string; title: string; pages: number }[];
};

const summaryKey = 'recent-policies:summary';
const changeEvent = 'folio.recent-policies.changed';
const fileKey = (id: string) => 'recent-policies:file:' + id;
const version = (revision: string | null | undefined) => ({ key: summaryKey, revision });

// null records an explicit forget, so an older review won't be suggested in its place.
export function readRecentPolicies() {
  return readDraft<RecentPolicySet | null>(summaryKey);
}

export async function loadRecentPolicies(revision: string): Promise<Policy[] | undefined> {
  const summary = await readRecentPolicies();
  if (summary?.revision !== revision) return undefined;
  return readDraftParts<Policy>(summary.files.map(file => fileKey(file.id)), version(revision));
}

function announceChange() {
  if (typeof BroadcastChannel !== 'undefined') {
    const sender = new BroadcastChannel(changeEvent);
    sender.postMessage(null);
    sender.close();
    return;
  }
  window.dispatchEvent(new Event(changeEvent));
  try { localStorage.setItem(changeEvent, crypto.randomUUID()); } catch { /* Focus also refreshes the summary. */ }
}

export function subscribeRecentPolicies(refresh: () => void) {
  const changed = (event: StorageEvent) => { if (event.key === changeEvent) refresh(); };
  const channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel(changeEvent) : undefined;
  if (channel) channel.onmessage = refresh;
  else {
    window.addEventListener('storage', changed);
    window.addEventListener(changeEvent, refresh);
  }
  window.addEventListener('focus', refresh);
  return () => {
    channel?.close();
    window.removeEventListener('storage', changed);
    window.removeEventListener(changeEvent, refresh);
    window.removeEventListener('focus', refresh);
  };
}

// Preserve the intake's order when a user removes a file while its upload is still being saved.
let writing = Promise.resolve();
function writeInOrder<T>(write: () => Promise<T>): Promise<T> {
  const result = writing.then(write);
  writing = result.then(() => {}, () => {});
  return result;
}

export function saveRecentPolicies(originals: readonly IntakePolicy[], onlyIfNoHistory = false): Promise<RecentPolicySet | undefined> {
  const policies = originals.filter(isUploadedPolicy);
  if (!policies.length) return Promise.resolve(undefined);
  const files = policies.map(({ id, title, pages }) => ({ id, title, pages: pages.length }));
  const next: RecentPolicySet = { revision: crypto.randomUUID(), files };
  const keep = new Set(files.map(file => file.id));
  return writeInOrder(async () => {
    // A different tab can replace the set while this tab prepares the PDF bytes.
    // Retry against its new summary so orphaned files are always removed atomically.
    for (;;) {
      const previous = await readRecentPolicies();
      if (onlyIfNoHistory && previous !== undefined) return undefined;
      const oldFiles = previous?.files ?? [];
      const stored = new Set(oldFiles.map(file => file.id));
      const entries: Record<string, unknown> = { [summaryKey]: next };
      for (const doc of policies) {
        if (!stored.has(doc.id)) entries[fileKey(doc.id)] = doc;
      }
      const remove = oldFiles.filter(file => !keep.has(file.id)).map(file => fileKey(file.id));
      if (await writeDraftParts(entries, version(previous === null ? null : previous?.revision), remove)) break;
    }
    announceChange();
    return next;
  });
}

export function removeRecentPolicy(id: string, previousIds: readonly string[]): Promise<void> {
  return writeInOrder(async () => {
    const previous = await readRecentPolicies();
    if (!previous || previous.files.length !== previousIds.length) return;
    if (!previous.files.every((file, index) => file.id === previousIds[index])) return;
    const files = previous.files.filter(file => file.id !== id);
    if (files.length === previous.files.length) return;
    const next = files.length ? { revision: crypto.randomUUID(), files } : null;
    if (await writeDraftParts({ [summaryKey]: next }, version(previous.revision), [fileKey(id)])) announceChange();
  });
}

export function forgetRecentPolicies(revision: string): Promise<boolean> {
  return writeInOrder(async () => {
    const previous = await readRecentPolicies();
    if (previous?.revision !== revision) return false;
    const remove = previous.files.map(file => fileKey(file.id));
    const forgotten = await writeDraftParts({ [summaryKey]: null }, version(revision), remove);
    if (forgotten) announceChange();
    return forgotten;
  });
}

export async function loadReviewPolicies(key: string): Promise<Policy[]> {
  const uploads = await readSavedPolicyUploads(key);
  const policies: Policy[] = [];
  for (const doc of uploads) {
    if (doc.pdfFile) {
      // Older reviews keep the original PDF but may only store its selected pages' text.
      const { readDocument } = await import('./files');
      policies.push({ ...await readDocument(doc.pdfFile), id: doc.id });
    } else {
      policies.push(doc);
    }
  }
  return policies;
}
