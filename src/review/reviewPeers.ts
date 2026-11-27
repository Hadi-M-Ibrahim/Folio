// Messages announce which local record changed. Documents stay in IndexedDB.
export type LibraryChange = { key?: string; findings?: boolean };
const channelName = 'folio.review-library';
const lockPrefix = channelName + '.owner.';

export class ReviewPeers {
  readonly id: string = crypto.randomUUID();
  private channel?: BroadcastChannel;
  private lockReady: Promise<void> = Promise.resolve();

  connect(refresh: (change: LibraryChange) => void) {
    if (typeof BroadcastChannel !== 'undefined') {
      this.channel = new BroadcastChannel(channelName);
      this.channel.onmessage = event => refresh(event.data);
    } else {
      window.addEventListener('storage', event => {
        if (event.key === channelName) refresh({});
      });
    }
    const markPresent = () => {
      this.lockReady = this.holdLock();
    };
    markPresent();
    window.addEventListener('pageshow', event => { if (event.persisted) { markPresent(); refresh({}); } });
    window.addEventListener('focus', () => refresh({}));
  }

  private async holdLock() {
    if (!navigator.locks) return;
    await new Promise<void>(resolve => {
      void navigator.locks.request(lockPrefix + this.id, async () => {
        resolve();
        await new Promise<void>(release => window.addEventListener('pagehide', () => release(), { once: true }));
        this.send({});
      }).catch(() => resolve());
    });
  }

  async activeOwners() {
    await this.lockReady;
    const locks = await navigator.locks?.query().catch(() => undefined);
    const owners = new Set([this.id]);
    for (const lock of locks?.held ?? []) {
      if (lock.name?.startsWith(lockPrefix)) owners.add(lock.name.slice(lockPrefix.length));
    }
    return owners;
  }

  send(change: LibraryChange) {
    if (this.channel) this.channel.postMessage(change);
    else {
      try { localStorage.setItem(channelName, crypto.randomUUID()); } catch { /* Focus also refreshes the list. */ }
    }
  }
}
