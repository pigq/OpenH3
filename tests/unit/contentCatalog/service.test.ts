import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ContentCatalogService } from '@/process/services/contentCatalog/service';
import { ContentStore } from '@/process/services/contentCatalog/store';
import { candidate, keys, image, digest, withCatalog } from './fixtures';
import { createHash } from 'node:crypto';
import { ContentCatalogError } from '@/process/services/contentCatalog/trust';
const roots: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const p of roots.splice(0)) await rm(p, { recursive: true, force: true });
});
describe('content orchestration', () => {
  it('waits out a temporary foreign pin lock instead of failing application startup', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'catalog-service-'));
    roots.push(root);
    const store = new ContentStore(root, keys);
    await store.initialize();
    await store.activate(candidate(1));
    const lock = path.join(root, 'lock.json');
    await writeFile(lock, JSON.stringify({ pid: process.pid, token: '11111111-1111-1111-1111-111111111111' }));
    const s = new ContentCatalogService({
      store,
      source: { keys, check: vi.fn(), asset: vi.fn() },
      builtin: candidate(0).catalog,
      version: '2.0.0',
    });
    const initialized = s.initialize().catch((error: unknown) => error);
    await new Promise<void>((resolve) => setTimeout(resolve, 75));
    await unlink(lock);
    expect(await initialized).toBeUndefined();
    expect(s.getCatalog().releaseSequence).toBe(1);
    await s.stop();
  });
  it('serves the snapshot actually restored when another runtime commits first', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'catalog-service-'));
    roots.push(root);
    const store = new ContentStore(root, keys);
    await store.initialize();
    await store.activate(candidate(1));
    await store.activate(candidate(2));
    const other = new ContentStore(root, keys);
    await other.initialize();
    const s = new ContentCatalogService({
      store,
      source: { keys, check: vi.fn(), asset: vi.fn() },
      builtin: candidate(0).catalog,
      version: '2.0.0',
    });
    await s.initialize();
    const restore = store.restore.bind(store);
    vi.spyOn(store, 'restore').mockImplementationOnce(async (...args) => {
      await other.activate(candidate(3));
      return restore(...args);
    });
    await s.restore();
    expect(s.getCatalog().releaseSequence).toBe(2);
    expect((await store.current())?.catalog.releaseSequence).toBe(2);
    await s.stop();
  });
  it('allows simultaneous page assets to renew their shared disk lease', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'catalog-service-'));
    roots.push(root);
    const store = new ContentStore(root, keys);
    const c = candidate(1);
    const source = { keys, check: vi.fn(async () => c), asset: vi.fn(async () => image) };
    const s = new ContentCatalogService({ store, source, builtin: candidate(0).catalog, version: '2.0.0' });
    await s.initialize();
    await s.check();
    await store.putAsset(digest, image);
    const results = await Promise.allSettled(
      Array.from({ length: 12 }, () => s.asset(1, digest, new AbortController().signal))
    );
    expect(results.every((result) => result.status === 'fulfilled')).toBe(true);
    await s.stop();
  });
  it('protects its active page media from a second runtime using the same cache', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'catalog-service-'));
    roots.push(root);
    const first = candidate(1);
    const a = new ContentStore(root, keys);
    await a.initialize();
    await a.putAsset(digest, image);
    await a.activate(first);
    const source = {
      keys,
      check: vi.fn(),
      asset: vi.fn(async () => {
        throw Error('OFFLINE');
      }),
    };
    const s = new ContentCatalogService({ store: a, source, builtin: candidate(0).catalog, version: '2.0.0' });
    await s.initialize();
    await s.lease(1);
    const b = new ContentStore(root, keys);
    await b.initialize();
    for (const sequence of [2, 3, 4]) {
      const c = candidate(sequence);
      await b.activate(withCatalog(c, { ...c.catalog, assets: [] }));
    }
    await b.collect(new Set(), 0);
    expect((await s.asset(1, digest, new AbortController().signal)).bytes).toEqual(image);
    expect(source.asset).not.toHaveBeenCalled();
    await s.stop();
  });
  it('does not collect a new cover before its snapshot is activated', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'catalog-service-'));
    roots.push(root);
    const secondImage = Buffer.concat([image, Buffer.from('second')]);
    const secondHash = createHash('sha256').update(secondImage).digest('hex');
    const c = candidate(2);
    const signed = withCatalog(c, {
      ...c.catalog,
      assets: [
        ...c.catalog.assets,
        { ...c.catalog.assets[0], sha256: secondHash, sizeBytes: secondImage.length, path: 'second.png' },
      ],
      models: [digest, secondHash].map((cover, i) => ({
        id: `official:pending${i}`,
        attribution: { author: 'Test', license: 'CC0', sourceUrl: 'https://github.com/pigq/OpenH3' },
        revision: 1,
        origin: 'official',
        family: 'h3',
        name: 'H3',
        kind: 'video',
        description: { 'en-US': 'Model' },
        cover,
        minClientVersion: '0.0.0',
        requiredCapabilities: [],
      })),
    });
    let release: () => void = () => {};
    let secondStarted = false;
    const source = {
      keys,
      check: vi.fn(async () => signed),
      asset: vi.fn(async (_c, asset) => {
        if (asset.sha256 === secondHash) {
          secondStarted = true;
          await new Promise<void>((resolve) => {
            release = resolve;
          });
          return secondImage;
        }
        return image;
      }),
    };
    const store = new ContentStore(root, keys);
    const s = new ContentCatalogService({
      store,
      source,
      builtin: candidate(0).catalog,
      version: '2.0.0',
      cacheLimitBytes: 1,
    });
    await s.initialize();
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    s.start();
    const updating = s.check();
    await vi.waitFor(async () => {
      expect(secondStarted).toBe(true);
      expect(await store.readAsset(digest)).toEqual(image);
    });
    const collect = vi.spyOn(store, 'collect');
    await vi.advanceTimersByTimeAsync(60000);
    if (collect.mock.results[0]) await collect.mock.results[0].value;
    release();
    await updating;
    expect(s.getStatus()).toMatchObject({ phase: 'ready', activeSequence: 2 });
    expect((await store.current())?.catalog.releaseSequence).toBe(2);
    await s.stop();
  });
  it('serializes restore with update checks and other restores', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'catalog-service-'));
    roots.push(root);
    const store = new ContentStore(root, keys);
    await store.initialize();
    await store.activate(candidate(1));
    await store.activate(candidate(2));
    const source = { keys, check: vi.fn(async () => candidate(3)), asset: vi.fn(async () => image) };
    const s = new ContentCatalogService({ store, source, builtin: candidate(0).catalog, version: '2.0.0' });
    await s.initialize();
    const previous = await store.previous();
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.spyOn(store, 'previous').mockImplementationOnce(async () => {
      await gate;
      return previous;
    });
    const restoring = s.restore();
    const checking = s.check();
    const duplicate = s.restore().catch((error: unknown) => error);
    release();
    await Promise.all([restoring, checking]);
    expect(await duplicate).toMatchObject({ code: 'BUSY' });
    expect(source.check).not.toHaveBeenCalled();
    expect(s.getCatalog().releaseSequence).toBe(1);
    expect((await store.current())?.catalog.releaseSequence).toBe(1);
    await s.stop();
  });
  it('starts a fresh preview when the abandoned flight is still cleaning up', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'catalog-service-'));
    roots.push(root);
    const c = candidate();
    const store = new ContentStore(root, keys);
    let rejectAbandoned: () => void = () => {};
    const source = {
      keys,
      check: vi.fn(async () => c),
      asset: vi.fn(async (_c, _a, signal: AbortSignal) => {
        if (source.asset.mock.calls.length === 1) {
          await new Promise<void>((_resolve, reject) => {
            rejectAbandoned = () => reject(signal.reason);
          });
        }
        signal.throwIfAborted();
        return image;
      }),
    };
    const s = new ContentCatalogService({ store, source, builtin: candidate(0).catalog, version: '2.0.0' });
    await s.initialize();
    await s.check();
    const abort = new AbortController();
    const abandoned = s.asset(1, digest, abort.signal).catch((error: unknown) => error);
    await vi.waitFor(() => expect(source.asset).toHaveBeenCalledTimes(1));
    abort.abort();
    await abandoned;
    const retry = s.asset(1, digest, new AbortController().signal);
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    rejectAbandoned();
    expect((await retry).bytes).toEqual(image);
    expect(source.asset).toHaveBeenCalledTimes(2);
    await s.stop();
  });
  it('aborts sibling downloads and waits for cleanup before releasing single flight', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'catalog-service-'));
    roots.push(root);
    const second = createHash('sha256').update('second').digest('hex');
    const c = candidate();
    const catalog = {
      ...c.catalog,
      assets: [...c.catalog.assets, { ...c.catalog.assets[0], sha256: second, path: 'second.webp' }],
      models: [digest, second].map((cover, i) => ({
        id: `official:model${i}`,
        attribution: { author: 'Test', license: 'CC0', sourceUrl: 'https://github.com/pigq/OpenH3' },
        revision: 1,
        origin: 'official' as const,
        family: 'h3',
        name: 'H3',
        kind: 'image' as const,
        description: { 'en-US': 'Model' },
        cover,
        minClientVersion: '0.0.0',
        requiredCapabilities: [],
      })),
    };
    let cleaned = false;
    const source = {
      keys,
      check: vi.fn(async () => withCatalog(c, catalog)),
      asset: vi.fn(async (_c, a, signal: AbortSignal) => {
        if (a.sha256 === digest) {
          await new Promise((resolve) => setTimeout(resolve, 5));
          throw new ContentCatalogError('DIGEST_MISMATCH');
        }
        await new Promise<void>((resolve) =>
          signal.addEventListener(
            'abort',
            () =>
              setTimeout(() => {
                cleaned = true;
                resolve();
              }, 5),
            { once: true }
          )
        );
        signal.throwIfAborted();
        return image;
      }),
    };
    const s = new ContentCatalogService({
      store: new ContentStore(root, keys),
      source,
      builtin: c.catalog,
      version: '2.0.0',
    });
    await s.initialize();
    await s.check();
    expect(cleaned).toBe(true);
    expect(s.getStatus().errorCode).toBe('DIGEST_MISMATCH');
    expect(s.getCatalog().models).toHaveLength(0);
    s.stop();
  });
  it('does not let one cancelled preview abort another consumer', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'catalog-service-'));
    roots.push(root);
    const c = candidate();
    let finish: () => void = () => {};
    const source = {
      keys,
      check: vi.fn(async () => c),
      asset: vi.fn(async (_c, _a, signal: AbortSignal) => {
        await new Promise<void>((resolve, reject) => {
          finish = resolve;
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
        return image;
      }),
    };
    const s = new ContentCatalogService({
      store: new ContentStore(root, keys),
      source,
      builtin: { ...c.catalog, releaseSequence: 0 },
      version: '2.0.0',
    });
    await s.initialize();
    await s.check();
    const a = new AbortController();
    const b = new AbortController();
    const secondConsumerJoined = vi.spyOn(b.signal, 'addEventListener');
    const first = s.asset(1, digest, a.signal);
    const result = first.catch((e) => e);
    const other = s.asset(1, digest, b.signal);
    await vi.waitFor(() => {
      expect(source.asset).toHaveBeenCalledTimes(1);
      expect(secondConsumerJoined).toHaveBeenCalledWith('abort', expect.any(Function), { once: true });
    });
    a.abort();
    finish();
    expect((await other).bytes).toEqual(image);
    expect(await result).toBeInstanceOf(Error);
    expect(source.asset).toHaveBeenCalledTimes(1);
    await s.stop();
  });
  it('stops optional preview downloads before exceeding the cache budget', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'catalog-service-'));
    roots.push(root);
    const c = candidate();
    const video = { ...c.catalog.assets[0], mimeType: 'video/mp4' as const };
    const signed = withCatalog(c, { ...c.catalog, assets: [video] });
    const store = new ContentStore(root, keys);
    const source = { keys, check: vi.fn(async () => signed), asset: vi.fn(async () => image) };
    const s = new ContentCatalogService({
      store,
      source,
      builtin: { ...signed.catalog, releaseSequence: 0 },
      version: '2.0.0',
      cacheLimitBytes: image.length - 1,
    });
    await s.initialize();
    await s.check();
    await expect(s.asset(1, digest, new AbortController().signal)).rejects.toThrow('CACHE_LIMIT');
    expect(source.asset).not.toHaveBeenCalled();
    await s.stop();
  });
  it('schedules startup, bounded retries and cancels all timers on shutdown', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'catalog-service-'));
    roots.push(root);
    const c = candidate();
    const source = {
      keys,
      check: vi.fn(async () => {
        throw new ContentCatalogError('NETWORK_ERROR');
      }),
      asset: vi.fn(),
    };
    const s = new ContentCatalogService({
      store: new ContentStore(root, keys),
      source,
      builtin: c.catalog,
      version: '2.0.0',
    });
    await s.initialize();
    // Fake only scheduler time; filesystem operations still complete on the real event loop.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const check = vi.spyOn(s, 'check');
    s.start();
    await vi.advanceTimersByTimeAsync(29999);
    expect(check).not.toHaveBeenCalled();
    for (const delay of [1, 60000, 300000, 900000]) {
      await vi.advanceTimersByTimeAsync(delay);
      await vi.waitFor(() => expect(s.getStatus().phase).toBe('failed'));
      // Let the single-flight completion enqueue the next retry.
      await Promise.resolve();
    }
    expect(check).toHaveBeenCalledTimes(4);
    await s.setAutoSync(false);
    await vi.advanceTimersByTimeAsync(21600000);
    expect(check).toHaveBeenCalledTimes(4);
    s.stop();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('is single flight, preserves local models and updates a complete directory', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'catalog-service-'));
    roots.push(root);
    const c = candidate();
    const source = { keys, check: vi.fn(async () => c), asset: vi.fn(async () => image) };
    const s = new ContentCatalogService({
      store: new ContentStore(root, keys),
      source,
      builtin: { ...c.catalog, releaseSequence: 0 },
      version: '2.0.0',
    });
    await s.initialize();
    await Promise.all([s.check(), s.check()]);
    expect(source.check).toHaveBeenCalledTimes(1);
    expect(s.getCatalog().releaseSequence).toBe(1);
    expect(s.getStatus().phase).toBe('ready');
    s.stop();
  });
  it('retains builtin content on network failure without downloading models', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'catalog-service-'));
    roots.push(root);
    const c = candidate();
    const source = {
      keys,
      check: vi.fn(async () => {
        throw Error('OFFLINE');
      }),
      asset: vi.fn(),
    };
    const s = new ContentCatalogService({
      store: new ContentStore(root, keys),
      source,
      builtin: { ...c.catalog, releaseSequence: 0 },
      version: '2.0.0',
    });
    await s.initialize();
    await s.check();
    expect(s.getCatalog().releaseSequence).toBe(0);
    expect(s.getStatus().phase).toBe('failed');
    expect(source.asset).not.toHaveBeenCalled();
    s.stop();
  });
});
