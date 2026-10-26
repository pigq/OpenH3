import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { catalogSchema, type ContentCatalog } from '../../../common/contentCatalog/schema';
import { verifyManifest, assertDigest, ContentCatalogError, type ContentKeyring } from './trust';
import type { ContentCandidate } from './source';
type Journal = { active?: string; previous?: string; highest: number };
const HASH = /^[a-f0-9]{64}$/;
const localLocks = new Set<string>();
export class ContentStore {
  private readonly pinOwner = randomUUID();
  private writing: Promise<unknown> = Promise.resolve();
  private pinOperation: Promise<void> = Promise.resolve();
  private pinHashes = new Set<string>();
  constructor(
    readonly root: string,
    private readonly keys: ContentKeyring
  ) {}
  async initialize(): Promise<void> {
    for (const sub of ['', 'assets', 'snapshots', 'leases']) {
      const dir = path.join(this.root, sub);
      await fs.mkdir(dir, { recursive: true });
      if ((await fs.lstat(dir)).isSymbolicLink()) throw new ContentCatalogError('PATH_INVALID');
    }
  }
  private async atomic(file: string, bytes: Uint8Array): Promise<void> {
    const temp = `${file}.${randomUUID()}.tmp`;
    try {
      const h = await fs.open(temp, 'wx', 0o600);
      try {
        await h.writeFile(bytes);
        await h.sync();
      } finally {
        await h.close();
      }
      await fs.rename(temp, file);
    } finally {
      await fs.unlink(temp).catch(() => {});
    }
  }
  private async json(file: string): Promise<unknown> {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16 * 1024 * 1024)
      throw new ContentCatalogError('CACHE_INVALID');
    return JSON.parse(await fs.readFile(file, 'utf8'));
  }
  private async journal(): Promise<Journal> {
    for (const name of ['active.json', 'active.backup.json']) {
      try {
        const j = (await this.json(path.join(this.root, name))) as Journal;
        if (
          !Number.isSafeInteger(j.highest) ||
          j.highest < 0 ||
          [j.active, j.previous].some((v) => v !== undefined && !HASH.test(v))
        )
          throw Error();
        return j;
      } catch {
        /* A torn pointer never makes an uncommitted receipt active. */
      }
    }
    return { highest: 0 };
  }
  async highest(): Promise<number> {
    let highest = (await this.journal()).highest;
    // Only committed receipts advance the high water. Orphan staging receipts remain retryable.
    try {
      const { id } = (await this.json(path.join(this.root, 'watermark.json'))) as { id: string };
      highest = Math.max(highest, (await this.readSnapshot(id, false)).manifest.releaseSequence);
    } catch {
      /* The active journal is also durable commit evidence. */
    }
    return highest;
  }
  private locked<T>(action: () => Promise<T>): Promise<T> {
    const result = this.writing.catch(() => {}).then(() => this.acquire(action));
    this.writing = result;
    return result;
  }
  private async acquire<T>(action: () => Promise<T>, file = path.join(this.root, 'lock.json')): Promise<T> {
    const token = randomUUID();
    const localKey = path.basename(file) === 'lock.json' ? path.resolve(file) : undefined;
    if (localKey && localLocks.has(localKey)) throw new ContentCatalogError('BUSY');
    if (localKey) localLocks.add(localKey);
    const staged = path.join(this.root, `lock.${token}.tmp`);
    try {
      // Publish a fully written owner atomically. A crash must not leave an
      // empty exclusive lock whose owner can never be proven dead.
      try {
        const handle = await fs.open(staged, 'wx', 0o600);
        try {
          await handle.writeFile(JSON.stringify({ pid: process.pid, token, createdAt: Date.now() }));
          await handle.sync();
        } finally {
          await handle.close();
        }
        await fs.link(staged, file);
      } finally {
        await fs.unlink(staged).catch(() => {});
      }
    } catch (e) {
      if (localKey) localLocks.delete(localKey);
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      let stale: { pid: number; token: string } | undefined;
      try {
        const owner = (await this.json(file)) as { pid: number; token: string };
        if (Number.isInteger(owner.pid) && owner.pid > 0 && /^[a-f0-9-]{36}$/.test(owner.token)) {
          try {
            process.kill(owner.pid, 0);
          } catch (err) {
            if ((err as NodeJS.ErrnoException).code === 'ESRCH') stale = owner;
          }
        }
      } catch {
        /* An unparseable lock may be a live writer. */
      }
      if (stale) {
        // Reclamation itself has a fully written, reclaimable owner. If a
        // reclaimer crashes, its unique token provides the next guard level.
        return this.acquire(
          async () => {
            let current: { token: string };
            try {
              current = (await this.json(file)) as { token: string };
            } catch (error) {
              // Another reclaimer may finish before we acquire its guard.
              if ((error as NodeJS.ErrnoException).code === 'ENOENT') return this.acquire(action, file);
              throw error;
            }
            if (current.token !== stale.token) throw new ContentCatalogError('BUSY');
            await fs.unlink(file);
            return this.acquire(action, file);
          },
          path.join(this.root, `reclaim.${stale.token}.json`)
        );
      }
      throw new ContentCatalogError('BUSY');
    }
    try {
      return await action();
    } finally {
      try {
        const owner = (await this.json(file)) as { token: string };
        if (owner.token === token) await fs.unlink(file);
      } catch {
        /* Never release a different owner's lock. */
      }
      if (localKey) localLocks.delete(localKey);
    }
  }
  async putAsset(hash: string, bytes: Uint8Array): Promise<void> {
    if (!HASH.test(hash)) throw new ContentCatalogError('ASSET_INVALID');
    assertDigest(bytes, hash);
    await this.atomic(path.join(this.root, 'assets', hash), bytes);
  }
  async readAsset(hash: string): Promise<Buffer> {
    if (!HASH.test(hash)) throw new ContentCatalogError('ASSET_INVALID');
    const file = path.join(this.root, 'assets', hash);
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 32 * 1024 * 1024)
      throw new ContentCatalogError('ASSET_INVALID');
    const b = await fs.readFile(file);
    assertDigest(b, hash);
    return b;
  }
  private validate(c: ContentCandidate): ContentCandidate {
    const manifest = verifyManifest(c.manifestBytes, c.signature, this.keys, 0, Date.now(), true);
    assertDigest(c.catalogBytes, manifest.catalogSha256);
    if (c.catalogBytes.length !== manifest.catalogSizeBytes) throw new ContentCatalogError('SIZE_MISMATCH');
    const catalog = catalogSchema.parse(JSON.parse(c.catalogBytes.toString('utf8'))) as ContentCatalog;
    if (catalog.releaseSequence !== manifest.releaseSequence) throw new ContentCatalogError('CATALOG_INVALID');
    return { ...c, catalog, manifest };
  }
  private id(c: ContentCandidate): string {
    return createHash('sha256').update(c.manifestBytes).digest('hex');
  }
  private async readSnapshot(id: string, verifyAssets = true): Promise<ContentCandidate> {
    if (!HASH.test(id)) throw new ContentCatalogError('CACHE_INVALID');
    const raw = (await this.json(path.join(this.root, 'snapshots', id))) as Record<string, string>;
    const partial = {
      manifestBytes: Buffer.from(raw.manifest, 'base64'),
      signature: Buffer.from(raw.signature, 'base64'),
      catalogBytes: Buffer.from(raw.catalog, 'base64'),
    } as ContentCandidate;
    const c = this.validate(partial);
    if (this.id(c) !== id) throw new ContentCatalogError('CACHE_INVALID');
    if (verifyAssets) for (const hash of this.required(c)) await this.readAsset(hash);
    return c;
  }
  required(c: ContentCandidate): string[] {
    return [...new Set([...c.catalog.models, ...c.catalog.entries].map((e) => e.cover))];
  }
  async current(): Promise<ContentCandidate | null> {
    const j = await this.journal();
    if (!j.active) return null;
    try {
      return await this.readSnapshot(j.active);
    } catch {
      if (j.previous) {
        try {
          return await this.readSnapshot(j.previous);
        } catch {
          /* Use trusted builtin content. */
        }
      }
      return null;
    }
  }
  async previous(): Promise<ContentCandidate | null> {
    const j = await this.journal();
    return j.previous ? this.readSnapshot(j.previous).catch((): null => null) : null;
  }
  async activate(input: ContentCandidate, required = this.required(input)): Promise<void> {
    await this.locked(async () => {
      const c = this.validate(input);
      const j = await this.journal();
      if (c.manifest.releaseSequence <= (await this.highest())) throw new ContentCatalogError('REPLAY');
      verifyManifest(c.manifestBytes, c.signature, this.keys, 0);
      for (const hash of new Set([...required, ...this.required(c)])) await this.readAsset(hash);
      const id = this.id(c);
      // Recovery can serve previous while active points to a damaged receipt.
      // Preserve the usable snapshot, not the stale journal pointer.
      const previous = await this.current();
      await this.atomic(path.join(this.root, 'active.backup.json'), Buffer.from(JSON.stringify(j)));
      await this.atomic(
        path.join(this.root, 'snapshots', id),
        Buffer.from(
          JSON.stringify({
            manifest: c.manifestBytes.toString('base64'),
            signature: c.signature.toString('base64'),
            catalog: c.catalogBytes.toString('base64'),
          })
        )
      );
      await this.atomic(
        path.join(this.root, 'active.json'),
        Buffer.from(
          JSON.stringify({
            active: id,
            previous: previous ? this.id(previous) : undefined,
            highest: c.manifest.releaseSequence,
          })
        )
      );
      try {
        await this.atomic(path.join(this.root, 'watermark.json'), Buffer.from(JSON.stringify({ id })));
      } catch {
        /* The primary journal already committed this sequence. */
      }
    });
  }
  async restore(accept: (candidate: ContentCandidate) => boolean = () => true): Promise<ContentCandidate> {
    return this.locked(async () => {
      const j = await this.journal();
      if (!j.previous) throw new ContentCatalogError('NO_PREVIOUS');
      const previous = await this.readSnapshot(j.previous);
      if (!accept(previous)) throw new ContentCatalogError('NO_PREVIOUS');
      await this.atomic(
        path.join(this.root, 'active.json'),
        Buffer.from(JSON.stringify({ ...j, active: j.previous, previous: j.active }))
      );
      return previous;
    });
  }
  async settings(value?: boolean): Promise<boolean> {
    const file = path.join(this.root, 'settings.json');
    if (value !== undefined) await this.atomic(file, Buffer.from(JSON.stringify({ autoSync: value })));
    try {
      return ((await this.json(file)) as { autoSync: boolean }).autoSync !== false;
    } catch {
      return true;
    }
  }
  async cacheBytes(): Promise<number> {
    let total = 0;
    for (const hash of await fs.readdir(path.join(this.root, 'assets'))) {
      if (!HASH.test(hash)) continue;
      const stat = await fs.lstat(path.join(this.root, 'assets', hash));
      if (stat.isFile() && !stat.isSymbolicLink()) total += stat.size;
    }
    return total;
  }
  /** Share page pins across runtimes using the same cache, with crash expiry. */
  pin(hashes: ReadonlySet<string>): Promise<void> {
    if ([...hashes].some((hash) => !HASH.test(hash))) return Promise.reject(new ContentCatalogError('ASSET_INVALID'));
    this.pinHashes = new Set(hashes);
    this.pinOperation = this.pinOperation.catch(() => {}).then(() => this.writePins());
    return this.pinOperation;
  }
  private async writePins(): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      try {
        await this.locked(() =>
          this.atomic(
            path.join(this.root, 'leases', `${this.pinOwner}.json`),
            Buffer.from(JSON.stringify({ expiresAt: Date.now() + 120000, hashes: [...this.pinHashes] }))
          )
        );
        return;
      } catch (error) {
        if (!(error instanceof ContentCatalogError) || error.code !== 'BUSY' || attempt >= 1199) throw error;
        await new Promise<void>((resolve) => setTimeout(resolve, 25));
      }
    }
  }
  async releasePins(): Promise<void> {
    await this.pinOperation.catch(() => {});
    await this.writing.catch(() => {});
    await fs.unlink(path.join(this.root, 'leases', `${this.pinOwner}.json`)).catch(() => {});
  }
  /** Collect only our digest-addressed files; active, previous and page leases win over the soft cap. */
  async collect(pinned: ReadonlySet<string>, limit = 512 * 1024 * 1024): Promise<boolean> {
    return this.locked(async () => {
      const keep = new Set(pinned);
      for (const name of await fs.readdir(path.join(this.root, 'leases'))) {
        if (!/^[a-f0-9-]{36}\.json$/.test(name)) continue;
        const file = path.join(this.root, 'leases', name);
        try {
          const lease = (await this.json(file)) as { expiresAt?: unknown; hashes?: unknown };
          if (
            typeof lease.expiresAt !== 'number' ||
            lease.expiresAt <= Date.now() ||
            lease.expiresAt > Date.now() + 120000 ||
            !Array.isArray(lease.hashes) ||
            lease.hashes.some((hash: unknown) => typeof hash !== 'string' || !HASH.test(hash))
          ) {
            await fs.unlink(file);
            continue;
          }
          for (const hash of lease.hashes) keep.add(hash);
        } catch {
          /* Invalid lease data cannot grant access to any filesystem path. */
        }
      }
      const journal = await this.journal();
      const receipts = new Set([journal.active, journal.previous]);
      try {
        const backup = (await this.json(path.join(this.root, 'active.backup.json'))) as Journal;
        receipts.add(backup.active);
        receipts.add(backup.previous);
      } catch {
        /* No backup yet. */
      }
      try {
        const watermark = (await this.json(path.join(this.root, 'watermark.json'))) as { id: string };
        receipts.add(watermark.id);
      } catch {
        /* Journal is the fallback watermark. */
      }
      for (const id of receipts) {
        if (!id) continue;
        try {
          for (const a of (await this.readSnapshot(id, false)).catalog.assets) keep.add(a.sha256);
        } catch {
          /* Recovery uses the builtin when neither snapshot is usable. */
        }
      }
      for (const name of await fs.readdir(path.join(this.root, 'snapshots'))) {
        const file = path.join(this.root, 'snapshots', name);
        const stat = await fs.lstat(file);
        if (stat.isSymbolicLink() || !stat.isFile()) continue;
        if (HASH.test(name) && !receipts.has(name)) await fs.unlink(file);
        else if (/^[a-f0-9]{64}\.[a-f0-9-]+\.tmp$/.test(name) && Date.now() - stat.mtimeMs > 86400000)
          await fs.unlink(file);
      }
      const files: { file: string; hash: string; size: number; time: number }[] = [];
      for (const hash of await fs.readdir(path.join(this.root, 'assets'))) {
        const file = path.join(this.root, 'assets', hash);
        const stat = await fs.lstat(file);
        if (stat.isSymbolicLink() || !stat.isFile()) continue;
        if (HASH.test(hash)) files.push({ file, hash, size: stat.size, time: stat.mtimeMs });
        else if (/^[a-f0-9]{64}\.[a-f0-9-]+\.tmp$/.test(hash) && Date.now() - stat.mtimeMs > 86400000)
          await fs.unlink(file);
      }
      let total = files.reduce((sum, f) => sum + f.size, 0);
      for (const f of files.sort((a, b) => a.time - b.time)) {
        if (total <= limit) break;
        if (!keep.has(f.hash)) {
          await fs.unlink(f.file);
          total -= f.size;
        }
      }
      return total > limit;
    });
  }
}
