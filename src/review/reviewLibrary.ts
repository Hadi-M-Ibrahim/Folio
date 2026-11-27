import { useEffect, useState, useSyncExternalStore } from 'react';
import { ReviewJob } from './reviewJob';
import type { FindingState } from './model';
import {
  claimSavedReview, createSavedReview, mergeFinding, readCatalog, readFindings, readSavedReview, saveJobState, type ReviewMeta,
} from './localReviews';
import { persistEdit, recoverEdits } from './editJournal';
import { ReviewPeers, type LibraryChange } from './reviewPeers';

const storageNotice = 'This browser couldn’t save or load your latest changes. Keep this page open.';
const emptyFindings = new Map<string, FindingState>();

class ReviewLibrary {
  items: ReviewMeta[] = [];
  ready = false;
  warning = '';
  private peers = new ReviewPeers();
  private connected = false;
  private selected?: string;
  private storedStatus = new Map<string, ReviewMeta['status']>();
  private unsaved = new Set<string>();
  private jobs = new Map<string, ReviewJob>();
  private subscriptions = new Map<string, () => void>();
  private states = new Map<string, Map<string, FindingState>>();
  private listeners = new Set<() => void>();
  private revision = 0;
  private catalogRead = 0;
  private selectionRead = 0;
  private findingRead = 0;
  private claiming = new Set<string>();

  version = () => this.revision;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  private changed() {
    this.revision++;
    for (const notify of this.listeners) notify();
  }
  private storageError = () => {
    this.warning = storageNotice;
    this.ready = true;
    this.changed();
  };
  private async persist(write: Promise<unknown>, change: LibraryChange, retainInMemory = false) {
    try {
      await write;
      this.peers.send(change);
      if (!this.ready || this.warning) void this.refresh({});
      return true;
    } catch {
      if (retainInMemory && change.key && this.jobs.has(change.key)) this.unsaved.add(change.key);
      this.storageError();
      return false;
    }
  }

  connect() {
    if (this.connected) return;
    this.connected = true;
    this.peers.connect(change => { void this.refresh(change); });
    void this.refresh({});
  }

  job(key?: string) { return key ? this.jobs.get(key) : undefined; }
  findings(key?: string) { return key && this.states.get(key) || emptyFindings; }

  select(key?: string) {
    if (this.selected === key) return;
    this.selected = key;
    this.selectionRead++;
    if (key && this.ready && !this.jobs.has(key)) void this.loadSelected();
  }

  private async refresh(change: LibraryChange) {
    const alreadyLoaded = this.ready;
    let editsSaved = true;
    try {
      if (await recoverEdits()) {
        this.peers.send({});
        change = {};
      }
    } catch {
      editsSaved = false;
      this.storageError();
      if (alreadyLoaded) return;
    }
    try {
      if (change.findings) {
        if (change.key && this.jobs.has(change.key)) await this.refreshFindings(change.key);
        return;
      }
      const sequence = ++this.catalogRead;
      const [rows, owners] = await Promise.all([readCatalog(), this.peers.activeOwners()]);
      if (sequence !== this.catalogRead) return;
      const previous = new Map(this.items.map(row => [row.key, row]));
      this.storedStatus = new Map(rows.map(row => [row.key, row.status]));
      const saved = rows.filter(row => !this.unsaved.has(row.key)).map(row =>
        row.status === 'running' && !owners.has(row.owner) ? { ...row, status: 'paused' as const } : row);
      this.items = [...this.items.filter(row => this.unsaved.has(row.key)), ...saved];
      for (const [key, job] of this.jobs) {
        const row = this.items.find(item => item.key === key);
        if (!row || previous.get(key)?.owner !== row.owner || !this.matches(job, row)) this.forget(key);
        else job.rename(row.title);
      }
      this.ready = true;
      if (editsSaved && !this.unsaved.size) this.warning = '';
      this.changed();
      if (this.selected && !this.jobs.has(this.selected)) await this.loadSelected();
      else if (!change.key && this.selected) await this.refreshFindings(this.selected);
    } catch { this.storageError(); }
  }

  private matches(job: ReviewJob, row: ReviewMeta) {
    const kind = job.snapshot().kind;
    if (kind === 'elsewhere') return row.status === 'running' && row.owner !== this.peers.id;
    if (row.status === 'running' && row.owner !== this.peers.id) return false;
    return job.record().status === row.status;
  }

  private async loadSelected() {
    const row = this.items.find(item => item.key === this.selected);
    if (!row) return;
    const request = ++this.selectionRead;
    try {
      const saved = await readSavedReview(row.key);
      if (request !== this.selectionRead || !saved || this.jobs.has(row.key)) return;
      const elsewhere = row.status === 'running' && row.owner !== this.peers.id;
      const job = ReviewJob.restore(saved.record, elsewhere);
      job.track(() => this.remove(job.key));
      this.jobs.set(row.key, job);
      this.states.set(row.key, saved.findings);
      this.changed();
    } catch { this.storageError(); }
  }

  private async refreshFindings(key: string) {
    const read = ++this.findingRead;
    const findings = await readFindings(key);
    if (read !== this.findingRead || !this.jobs.has(key) || this.unsaved.has(key)) return;
    this.states.set(key, findings);
    this.changed();
  }

  private forget(key: string) {
    this.subscriptions.get(key)?.();
    this.subscriptions.delete(key);
    const job = this.jobs.get(key);
    this.jobs.delete(key);
    this.states.delete(key);
    job?.pause();
  }

  private observe(job: ReviewJob) {
    const key = job.key;
    this.subscriptions.get(key)?.();
    let previous = job.record();
    this.subscriptions.set(key, job.subscribe(() => {
      const record = job.record();
      if (record === previous) return;
      const before = previous;
      previous = record;
      if (record.title !== before.title) return; // Renaming only updates the catalog.
      const statusChanged = before.status !== record.status;
      if (statusChanged) {
        this.catalogRead++;
        this.storedStatus.set(key, record.status);
        this.items = this.items.map(item => item.key === key ? { ...item, status: record.status, owner: this.peers.id } : item);
        this.changed();
      }
      void saveJobState(record, this.peers.id).then(saved => {
        if (!saved) void this.refresh({ key });
        else {
          if (this.unsaved.delete(key)) void this.refresh({});
          if (statusChanged) this.peers.send({ key });
        }
      }, () => {
        if (this.jobs.get(key) === job) { this.unsaved.add(key); this.storageError(); }
      });
    }));
  }

  submit = async (job: ReviewJob) => {
    const key = job.key;
    if (job.submitted) {
      if (this.jobs.get(key) !== job) return false;
      if (job.record().status !== 'complete') await this.resume(job);
      return !this.unsaved.has(key);
    }
    this.catalogRead++;
    job.track(() => this.remove(key));
    this.jobs.set(key, job);
    const record = job.record();
    this.items = [{ key, mode: job.mode, title: job.title, status: record.status, owner: this.peers.id }, ...this.items];
    this.storedStatus.set(key, record.status);
    const saved = this.persist(createSavedReview(record, this.peers.id), { key }, true);
    this.observe(job);
    this.changed();
    void job.start();
    return saved;
  };

  resume = async (job: ReviewJob) => {
    const row = this.items.find(item => item.key === job.key);
    if (!row || this.claiming.has(job.key) || job.snapshot().kind === 'running') return;
    const status = this.storedStatus.get(job.key) ?? row.status;
    this.claiming.add(job.key);
    try {
      const owners = await this.peers.activeOwners();
      if (row.status === 'running' && owners.has(row.owner) && row.owner !== this.peers.id) return;
      if (!this.unsaved.has(job.key) && !await claimSavedReview(job.key, row.owner, this.peers.id, status)) {
        await this.refresh({ key: job.key });
        return;
      }
      if (this.jobs.get(job.key) !== job) return;
      this.items = this.items.map(item => item.key === row.key ? { ...item, owner: this.peers.id } : item);
      this.observe(job);
      void job.start();
    } catch { this.storageError(); }
    finally { this.claiming.delete(job.key); }
  };

  rename = (key: string, value: string) => {
    const title = value.trim();
    if (!title) return;
    this.catalogRead++;
    this.items = this.items.map(item => item.key === key ? { ...item, title } : item);
    this.jobs.get(key)?.rename(title);
    this.changed();
    void this.persist(persistEdit({ kind: 'rename', key, title }), { key });
  };

  move = (key: string, direction: -1 | 1) => {
    const index = this.items.findIndex(item => item.key === key);
    const target = index + direction;
    if (index < 0 || !this.items[target]) return;
    this.catalogRead++;
    const items = [...this.items];
    [items[index], items[target]] = [items[target], items[index]];
    this.items = items;
    this.changed();
    void persistEdit({ kind: 'move', key, direction }).then(() => {
      this.peers.send({ key });
      void this.refresh({ key });
    }, this.storageError);
  };

  remove = (key: string) => {
    if (!this.items.some(item => item.key === key)) return;
    this.catalogRead++;
    this.selectionRead++;
    this.forget(key);
    this.unsaved.delete(key);
    this.storedStatus.delete(key);
    this.items = this.items.filter(item => item.key !== key);
    this.changed();
    void this.persist(persistEdit({ kind: 'delete', key }), { key });
  };

  updateFinding = (findingKey: string, changes: FindingState) => {
    const key = this.selected;
    if (!key || !this.jobs.has(key)) return;
    this.findingRead++;
    const findings = new Map(this.states.get(key));
    const state = mergeFinding(findings.get(findingKey), changes);
    if (state.decision || state.resolved) findings.set(findingKey, state);
    else findings.delete(findingKey);
    this.states.set(key, findings);
    this.changed();
    void this.persist(persistEdit({ kind: 'finding', key, findingKey, changes }), { key, findings: true });
  };
}

const serverVersion = () => 0;
export function useReviewLibrary(key?: string) {
  const [library] = useState(() => new ReviewLibrary());
  useSyncExternalStore(library.subscribe, library.version, serverVersion);
  useEffect(() => { library.connect(); }, [library]);
  useEffect(() => { library.select(key); }, [library, key]);
  return library;
}
