import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { ContentStore } from '@/process/services/contentCatalog/store';
import { candidate, keys } from '../../unit/contentCatalog/fixtures';
const roots: string[] = [];
async function setup() {
  const root = await mkdtemp(path.join(tmpdir(), 'content-recovery-'));
  roots.push(root);
  const store = new ContentStore(root, keys);
  await store.initialize();
  await store.activate(candidate(1));
  return store;
}
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
describe('content commit fault boundaries', () => {
  it.each(['snapshots', 'active.backup.json', 'active.json'])(
    'keeps the old snapshot and a retryable watermark after %s write failure',
    async (boundary) => {
      const s = await setup();
      const target = path.join(s.root, boundary);
      const saved = target + '.test-save';
      await rename(target, saved);
      if (boundary === 'snapshots') await writeFile(target, 'not a directory');
      else await mkdir(target);
      await expect(s.activate(candidate(2))).rejects.toThrow();
      await rm(target, { recursive: true, force: true });
      await rename(saved, target);
      const restarted = new ContentStore(s.root, keys);
      await restarted.initialize();
      expect((await restarted.current())?.manifest.releaseSequence).toBe(1);
      expect(await restarted.highest()).toBe(1);
      await restarted.activate(candidate(2));
      expect((await restarted.current())?.manifest.releaseSequence).toBe(2);
    }
  );
  it('rejects concurrent writers without deleting their live lock', async () => {
    const s = await setup();
    const other = new ContentStore(s.root, keys);
    const results = await Promise.allSettled([s.activate(candidate(2)), other.activate(candidate(3))]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((r) => r.status === 'rejected');
    expect(rejected?.status === 'rejected' && rejected.reason.code).toBe('BUSY');
    expect(JSON.parse(await readFile(path.join(s.root, 'active.json'), 'utf8')).highest).toBeGreaterThan(1);
    expect(await readdir(s.root)).not.toContain('lock.json');
  });
  it('bounds obsolete snapshot receipts while retaining committed replay evidence', async () => {
    const s = await setup();
    await s.activate(candidate(2));
    await s.activate(candidate(3));
    await s.activate(candidate(4));
    await s.collect(new Set());
    expect((await readdir(path.join(s.root, 'snapshots'))).filter((v) => /^[a-f0-9]{64}$/.test(v))).toHaveLength(3);
    // active + previous + the crash-recovery backup's previous receipt are retained.
    expect(await s.highest()).toBe(4);
    await s.restore();
    expect(await s.highest()).toBe(4);
  });
});
