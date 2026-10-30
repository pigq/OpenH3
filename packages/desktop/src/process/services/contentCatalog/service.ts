import { supportsEntry, CONTENT_CAPABILITIES } from '../../../common/contentCatalog/policy';
import type { ContentCatalog, ContentStatus, ContentAsset } from '../../../common/contentCatalog/schema';
import type { ContentStore } from './store';
import { ContentCatalogError } from './trust';
import type { GitHubContentSource, ContentCandidate } from './source';
type Options = {
  store: ContentStore;
  source: Pick<GitHubContentSource, 'keys' | 'check' | 'asset'>;
  builtin: ContentCatalog;
  version: string;
  builtinAsset?: (hash: string) => Promise<Buffer>;
  cacheLimitBytes?: number;
};
function changes(before: ContentCatalog, after: ContentCatalog): NonNullable<ContentStatus['changes']> {
  const old = new Map([...before.models, ...before.entries].map((e) => [e.id, e]));
  const added: string[] = [],
    changed: string[] = [];
  for (const entry of [...after.models, ...after.entries]) {
    const prior = old.get(entry.id);
    if (!prior) added.push(entry.id);
    else if (JSON.stringify(prior) !== JSON.stringify(entry)) changed.push(entry.id);
    old.delete(entry.id);
  }
  return { from: before.releaseSequence, to: after.releaseSequence, added, changed, removed: [...old.keys()] };
}
export class ContentCatalogService {
  private catalog: ContentCatalog;
  private pendingCatalog?: ContentCatalog;
  private active?: ContentCandidate;
  private previous?: ContentCandidate;
  private operation?: Promise<void>;
  private collection?: Promise<void>;
  private abort?: AbortController;
  private timer?: ReturnType<typeof setTimeout>;
  private gcTimer?: ReturnType<typeof setInterval>;
  private stopped = true;
  private updatePaused = false;
  private admitted = 0;
  private failures = 0;
  private listeners = new Set<() => void>();
  private leases = new Map<number, { catalog: ContentCatalog; candidate?: ContentCandidate; expires: number }>();
  private assetRequests = new Map<string, { promise: Promise<Buffer>; abort: AbortController; consumers: number }>();
  private assetOperations = new Set<Promise<Buffer>>();
  private reservedBytes = 0;
  private status: ContentStatus;
  constructor(private readonly options: Options) {
    this.catalog = options.builtin;
    this.status = {
      phase: 'idle',
      activeSequence: this.catalog.releaseSequence,
      autoSync: true,
      sourceConfigured: Object.keys(options.source.keys).length > 0,
    };
  }
  private compatible(c: ContentCandidate): boolean {
    return supportsEntry(
      { minClientVersion: c.manifest.minClientVersion, requiredCapabilities: [] },
      { version: this.options.version, capabilities: CONTENT_CAPABILITIES }
    );
  }
  async initialize(): Promise<void> {
    await this.options.store.initialize();
    const c = await this.options.store.current();
    if (c && this.compatible(c) && c.catalog.releaseSequence >= this.catalog.releaseSequence) {
      this.active = c;
      this.catalog = c.catalog;
    }
    this.previous = (await this.options.store.previous()) ?? undefined;
    this.status = {
      ...this.status,
      activeSequence: this.catalog.releaseSequence,
      autoSync: await this.options.store.settings(),
      changes: this.active ? changes(this.previous?.catalog ?? this.options.builtin, this.catalog) : undefined,
    };
    if (this.active) await this.lease(this.catalog.releaseSequence);
  }
  getCatalog(): ContentCatalog {
    return this.catalog;
  }
  getStatus(): ContentStatus {
    return { ...this.status };
  }
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  private set(patch: Partial<ContentStatus>): void {
    this.status = { ...this.status, ...patch };
    for (const fn of this.listeners) fn();
  }
  start(): void {
    if (!this.stopped || this.updatePaused) return;
    this.stopped = false;
    this.schedule(30000);
    this.gcTimer = setInterval(() => void this.collect(), 60000);
    this.gcTimer.unref?.();
  }
  /** Synchronously fence all task entry points without cancelling admitted work. */
  tryAcquireUpdateLease(): { release: () => void } | null {
    if (
      this.stopped ||
      this.updatePaused ||
      this.operation ||
      this.collection ||
      this.admitted ||
      this.assetOperations.size ||
      this.assetRequests.size
    )
      return null;
    this.updatePaused = true;
    clearTimeout(this.timer);
    clearInterval(this.gcTimer);
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        this.updatePaused = false;
        if (!this.stopped) {
          this.stopped = true;
          this.start();
        }
      },
    };
  }
  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    clearInterval(this.gcTimer);
    this.abort?.abort();
    for (const request of this.assetRequests.values()) request.abort.abort();
    await Promise.allSettled([
      ...(this.operation ? [this.operation] : []),
      ...(this.collection ? [this.collection] : []),
      ...this.assetOperations,
    ]);
    await this.options.store.releasePins();
  }
  private schedule(delay: number): void {
    clearTimeout(this.timer);
    if (!this.stopped && this.status.autoSync) {
      this.timer = setTimeout(() => {
        void this.check()
          .then(() => {
            const delays = [60000, 300000, 900000];
            const retry =
              this.status.phase === 'failed' &&
              /^(NETWORK_ERROR|HTTP_(408|429|5\d\d))$/.test(this.status.errorCode ?? '') &&
              this.failures < 3;
            this.schedule(retry ? delays[this.failures++] : 21600000);
            if (!retry) this.failures = 0;
          })
          .catch((): void => {});
      }, delay);
      this.timer.unref?.();
    }
  }
  async setAutoSync(value: boolean): Promise<void> {
    if (this.updatePaused) throw new ContentCatalogError('APP_UPDATE_PENDING');
    this.admitted += 1;
    try {
      await this.applyAutoSync(value);
    } finally {
      this.admitted -= 1;
    }
  }
  private async applyAutoSync(value: boolean): Promise<void> {
    await this.options.store.settings(value);
    this.set({ autoSync: value });
    if (!value) {
      clearTimeout(this.timer);
      this.cancel();
    } else this.schedule(30000);
  }
  cancel(): void {
    this.abort?.abort();
  }
  check(): Promise<void> {
    if (this.updatePaused) return Promise.reject(new ContentCatalogError('APP_UPDATE_PENDING'));
    if (this.operation) return this.operation.catch(() => {});
    this.abort = new AbortController();
    const signal = this.abort.signal;
    this.operation = this.run(signal).finally(() => {
      this.operation = undefined;
      this.abort = undefined;
    });
    return this.operation;
  }
  private async run(signal: AbortSignal): Promise<void> {
    await this.collection;
    this.set({ phase: 'checking', errorCode: undefined, lastCheckedAt: new Date().toISOString() });
    try {
      const c = await this.options.source.check(
        Math.max(await this.options.store.highest(), this.options.builtin.releaseSequence),
        signal
      );
      this.set({ availableSequence: c.manifest.releaseSequence });
      if (!this.compatible(c)) {
        this.set({ phase: 'incompatible', errorCode: 'CLIENT_INCOMPATIBLE' });
        return;
      }
      this.set({ phase: 'downloading' });
      this.pendingCatalog = c.catalog;
      await this.pinLeases();
      const hashes = this.options.store.required(c);
      const assets = hashes.map((hash) => c.catalog.assets.find((a) => a.sha256 === hash)!);
      if (assets.reduce((sum, a) => sum + a.sizeBytes, 0) > 128 * 1024 * 1024)
        throw new ContentCatalogError('SIZE_LIMIT');
      let next = 0;
      const downloads = new AbortController();
      const downloadSignal = AbortSignal.any([signal, downloads.signal]);
      let failure: unknown;
      await Promise.allSettled(
        Array.from({ length: Math.min(4, assets.length) }, async () => {
          try {
            while (next < assets.length) {
              const asset = assets[next++];
              downloadSignal.throwIfAborted();
              try {
                await this.options.store.readAsset(asset.sha256);
              } catch {
                const bytes = await this.options.source.asset(c, asset, downloadSignal);
                await this.pinLeases();
                await this.options.store.putAsset(asset.sha256, bytes);
              }
            }
          } catch (error) {
            if (!downloads.signal.aborted) {
              failure = error;
              downloads.abort(error);
            }
          }
        })
      );
      if (failure) throw failure;
      signal.throwIfAborted();
      this.set({ phase: 'verifying' });
      this.set({ phase: 'activating' });
      await this.options.store.activate(c, hashes);
      const diff = changes(this.catalog, c.catalog);
      this.previous = this.active;
      this.active = c;
      this.catalog = c.catalog;
      this.set({ phase: 'ready', activeSequence: c.catalog.releaseSequence, errorCode: undefined, changes: diff });
      await this.runCollection();
    } catch (error) {
      const errno = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
      const code =
        error instanceof ContentCatalogError
          ? error.code
          : signal.aborted
            ? 'CANCELLED'
            : errno === 'ENOSPC'
              ? 'DISK_FULL'
              : errno === 'EACCES' || errno === 'EPERM'
                ? 'CACHE_UNWRITABLE'
                : 'NETWORK_ERROR';
      this.set({
        phase:
          code === 'UP_TO_DATE'
            ? 'ready'
            : code === 'SCHEMA_UNSUPPORTED'
              ? 'incompatible'
              : signal.aborted
                ? 'cancelled'
                : 'failed',
        errorCode: code === 'UP_TO_DATE' ? undefined : code,
      });
    } finally {
      this.pendingCatalog = undefined;
    }
  }
  restore(): Promise<void> {
    if (this.updatePaused) return Promise.reject(new ContentCatalogError('APP_UPDATE_PENDING'));
    if (this.operation) return Promise.reject(new ContentCatalogError('BUSY'));
    this.operation = this.runRestore().finally(() => {
      this.operation = undefined;
    });
    return this.operation;
  }
  private async runRestore(): Promise<void> {
    await this.collection;
    const previous = await this.options.store.restore((candidate) => this.compatible(candidate));
    const diff = changes(this.catalog, previous.catalog);
    this.previous = this.active;
    this.active = previous;
    this.catalog = previous.catalog;
    this.set({ phase: 'ready', activeSequence: this.catalog.releaseSequence, errorCode: undefined, changes: diff });
  }
  async lease(sequence: number): Promise<void> {
    if (this.updatePaused) throw new ContentCatalogError('APP_UPDATE_PENDING');
    this.admitted += 1;
    try {
      await this.pinSequence(sequence);
    } finally {
      this.admitted -= 1;
    }
  }
  private async pinSequence(sequence: number): Promise<void> {
    for (const [id, lease] of this.leases) if (lease.expires < Date.now()) this.leases.delete(id);
    const catalog =
      sequence === this.catalog.releaseSequence
        ? this.catalog
        : sequence === this.previous?.catalog.releaseSequence
          ? this.previous.catalog
          : sequence === this.options.builtin.releaseSequence
            ? this.options.builtin
            : this.leases.get(sequence)?.catalog;
    const candidate =
      sequence === this.active?.catalog.releaseSequence
        ? this.active
        : sequence === this.previous?.catalog.releaseSequence
          ? this.previous
          : this.leases.get(sequence)?.candidate;
    if (!catalog) throw new ContentCatalogError('SNAPSHOT_UNAVAILABLE');
    this.leases.set(sequence, { catalog, candidate, expires: Date.now() + 120000 });
    await this.pinLeases();
  }
  private async pinLeases(): Promise<void> {
    const pins = new Set<string>();
    for (const lease of this.leases.values()) for (const asset of lease.catalog.assets) pins.add(asset.sha256);
    for (const asset of this.pendingCatalog?.assets ?? []) pins.add(asset.sha256);
    await this.options.store.pin(pins);
  }
  private collect(): Promise<void> {
    if (this.updatePaused) return Promise.resolve();
    // Pending covers are not committed receipts yet. Never collect across an
    // update or restore, and let a pre-existing collection finish first.
    if (this.operation) return Promise.resolve();
    if (this.collection) return this.collection;
    this.collection = this.runCollection().finally(() => {
      this.collection = undefined;
    });
    return this.collection;
  }
  private async runCollection(): Promise<void> {
    const keep = new Set<string>();
    for (const [id, lease] of this.leases) {
      if (lease.expires < Date.now()) {
        this.leases.delete(id);
        continue;
      }
      for (const asset of lease.catalog.assets) keep.add(asset.sha256);
    }
    try {
      if (await this.options.store.collect(keep, this.options.cacheLimitBytes)) this.set({ errorCode: 'CACHE_LIMIT' });
    } catch {
      /* GC failure cannot undo a verified activation. */
    }
  }
  async asset(sequence: number, hash: string, signal: AbortSignal): Promise<{ bytes: Buffer; asset: ContentAsset }> {
    if (this.updatePaused) throw new ContentCatalogError('APP_UPDATE_PENDING');
    this.admitted += 1;
    try {
      return await this.readAsset(sequence, hash, signal);
    } finally {
      this.admitted -= 1;
    }
  }
  private async readAsset(
    sequence: number,
    hash: string,
    signal: AbortSignal
  ): Promise<{ bytes: Buffer; asset: ContentAsset }> {
    signal.throwIfAborted();
    await this.lease(sequence);
    const lease = this.leases.get(sequence)!;
    const asset = lease.catalog.assets.find((a) => a.sha256 === hash);
    if (!asset) throw new ContentCatalogError('ASSET_INVALID');
    try {
      return { bytes: await this.options.store.readAsset(hash), asset };
    } catch {
      /* Fetch only an explicitly declared official media asset. */
    }
    if (sequence === this.options.builtin.releaseSequence && this.options.builtinAsset)
      return { bytes: await this.options.builtinAsset(hash), asset };
    const c = lease.candidate;
    if (!c) throw new ContentCatalogError('SNAPSHOT_UNAVAILABLE');
    let request = this.assetRequests.get(hash);
    if (!request) {
      const used = await this.options.store.cacheBytes();
      signal.throwIfAborted();
      request = this.assetRequests.get(hash);
      if (!request) {
        if (used + this.reservedBytes + asset.sizeBytes > (this.options.cacheLimitBytes ?? 512 * 1024 * 1024)) {
          this.set({ errorCode: 'CACHE_LIMIT' });
          throw new ContentCatalogError('CACHE_LIMIT');
        }
        this.reservedBytes += asset.sizeBytes;
        const abort = new AbortController();
        const promise = this.options.source
          .asset(c, asset, abort.signal)
          .then(async (b) => {
            await this.options.store.putAsset(hash, b);
            return b;
          })
          .finally(() => {
            this.assetOperations.delete(promise);
            this.reservedBytes -= asset.sizeBytes;
            if (this.assetRequests.get(hash)?.abort === abort) this.assetRequests.delete(hash);
          });
        request = { abort, consumers: 0, promise };
        this.assetOperations.add(promise);
        this.assetRequests.set(hash, request);
      }
    }
    const shared = request;
    shared.consumers++;
    let onAbort: () => void = () => {};
    try {
      const cancelled = new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(signal.reason);
        signal.addEventListener('abort', onAbort, { once: true });
        if (signal.aborted) onAbort();
      });
      return { bytes: await Promise.race([shared.promise, cancelled]), asset };
    } finally {
      signal.removeEventListener('abort', onAbort);
      if (--shared.consumers === 0) {
        if (this.assetRequests.get(hash) === shared) this.assetRequests.delete(hash);
        shared.abort.abort();
      }
    }
  }
}
