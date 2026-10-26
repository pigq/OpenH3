import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ContentStore } from '@/process/services/contentCatalog/store';
import { candidate, keys, image, digest } from './fixtures';
vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs/promises')>()),
}));
const roots: string[] = [];
async function store() {
  const root = await mkdtemp(path.join(tmpdir(), 'openh3-content-'));
  roots.push(root);
  return new ContentStore(root, keys);
}
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
describe('atomic content storage', () => {
  it('retries a delayed reclaimer after another cache instance already released the old lock', async () => {
    const s = await store();
    await s.initialize();
    const other = new ContentStore(s.root, keys);
    await other.initialize();
    const token = '11111111-1111-1111-1111-111111111111';
    const pid = 2147483647;
    expect(() => process.kill(pid, 0)).toThrow();
    await writeFile(path.join(s.root, 'lock.json'), JSON.stringify({ pid, token }));
    let resume: () => void = () => {};
    let paused: () => void = () => {};
    const resumeGate = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const pauseGate = new Promise<void>((resolve) => {
      paused = resolve;
    });
    const link = fs.link;
    let intercepted = false;
    const spy = vi.spyOn(fs, 'link').mockImplementation(async (...args) => {
      if (!intercepted && String(args[1]) === path.join(s.root, `reclaim.${token}.json`)) {
        intercepted = true;
        paused();
        await resumeGate;
      }
      return link(...args);
    });
    const pin = s.pin(new Set([digest]));
    try {
      await pauseGate;
      await other.collect(new Set());
      resume();
      await expect(pin).resolves.toBeUndefined();
    } finally {
      resume();
      await Promise.allSettled([pin]);
      spy.mockRestore();
    }
  });
  it('recovers after a dead writer also left an abandoned reclamation claim', async () => {
    const s = await store();
    await s.initialize();
    const token = '11111111-1111-1111-1111-111111111111';
    const reclaimToken = '22222222-2222-2222-2222-222222222222';
    const pid = 2147483647;
    expect(() => process.kill(pid, 0)).toThrow();
    await writeFile(path.join(s.root, 'lock.json'), JSON.stringify({ pid, token }));
    await mkdir(path.join(s.root, `reclaim.${token}`));
    await writeFile(path.join(s.root, `reclaim.${token}.json`), JSON.stringify({ pid, token: reclaimToken }));
    await s.activate(candidate(1));
    expect((await s.current())?.catalog.releaseSequence).toBe(1);
  });
  it('keeps live media pins visible to another cache instance until released', async () => {
    const s = await store();
    await s.initialize();
    await s.putAsset(digest, image);
    await s.pin(new Set([digest]));
    const other = new ContentStore(s.root, keys);
    await other.initialize();
    expect(await other.collect(new Set(), 0)).toBe(true);
    expect(await s.readAsset(digest)).toEqual(image);
    await s.releasePins();
    expect(await other.collect(new Set(), 0)).toBe(false);
    await expect(s.readAsset(digest)).rejects.toThrow();
  });
  it('does not publish a partial lock when writing its owner fails', async () => {
    const s = await store();
    await s.initialize();
    const open = fs.open;
    let injected = false;
    const spy = vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const handle = await open(...args);
      if (!injected && path.basename(String(args[0])).startsWith('lock.')) {
        injected = true;
        vi.spyOn(handle, 'writeFile').mockRejectedValueOnce(new Error('simulated owner write failure'));
      }
      return handle;
    });
    try {
      await expect(s.activate(candidate(1))).rejects.toThrow('simulated owner write failure');
    } finally {
      spy.mockRestore();
    }
    const restarted = new ContentStore(s.root, keys);
    await restarted.initialize();
    await restarted.activate(candidate(1));
    expect((await restarted.current())?.catalog.releaseSequence).toBe(1);
  });
  it('retains the last actually usable snapshot after recovering a corrupt active receipt', async () => {
    const s = await store();
    await s.initialize();
    await s.activate(candidate(1));
    await s.activate(candidate(2));
    const journal = JSON.parse(await readFile(path.join(s.root, 'active.json'), 'utf8'));
    await writeFile(path.join(s.root, 'snapshots', journal.active), 'corrupt');
    expect((await s.current())?.catalog.releaseSequence).toBe(1);
    await s.activate(candidate(3));
    expect((await s.previous())?.catalog.releaseSequence).toBe(1);
  });
  it('never activates missing required assets', async () => {
    const s = await store();
    await s.initialize();
    const c = candidate();
    c.catalog.entries = [];
    await expect(s.activate(c, [digest])).rejects.toThrow();
    expect(await s.current()).toBeNull();
  });
  it('commits valid snapshots and restores previous without lowering high water', async () => {
    const s = await store();
    await s.initialize();
    await s.putAsset(digest, image);
    await s.activate(candidate(1), [digest]);
    await s.activate(candidate(2), [digest]);
    expect((await s.current())?.catalog.releaseSequence).toBe(2);
    await s.restore();
    expect((await s.current())?.catalog.releaseSequence).toBe(1);
    expect(await s.highest()).toBe(2);
  });
  it('does not accept altered cached catalog bytes', async () => {
    const s = await store();
    await s.initialize();
    await s.putAsset(digest, image);
    const c = candidate();
    c.catalogBytes = Buffer.from('{}');
    await expect(s.activate(c, [])).rejects.toThrow('DIGEST');
    expect(await s.current()).toBeNull();
  });
  it('rejects corrupt or linked assets', async () => {
    const s = await store();
    await s.initialize();
    await expect(s.putAsset(digest, Buffer.from('wrong'))).rejects.toThrow();
    await writeFile(path.join(s.root, 'assets', digest), 'wrong');
    await expect(s.readAsset(digest)).rejects.toThrow('DIGEST');
  });
  it('recovers a corrupt journal without lowering the verified high water mark', async () => {
    const s = await store();
    await s.initialize();
    await s.activate(candidate(1));
    await s.activate(candidate(2));
    await writeFile(path.join(s.root, 'active.json'), '{broken');
    const restarted = new ContentStore(s.root, keys);
    await restarted.initialize();
    expect((await restarted.current())?.catalog.releaseSequence).toBe(1);
    expect(await restarted.highest()).toBe(2);
    await expect(restarted.activate(candidate(2))).rejects.toThrow('REPLAY');
  });
  it('retains active and leased media while collecting unreferenced media', async () => {
    const s = await store();
    await s.initialize();
    await s.putAsset(digest, image);
    expect(await s.collect(new Set([digest]), 0)).toBe(true);
    expect(await s.readAsset(digest)).toEqual(image);
    expect(await s.collect(new Set(), 0)).toBe(false);
    await expect(s.readAsset(digest)).rejects.toThrow();
  });
});
