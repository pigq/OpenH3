import { it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash, generateKeyPairSync, verify } from 'node:crypto';
import { buildCatalog } from '../../../scripts/content-catalog/build.mjs';
import { signCatalog } from '../../../scripts/content-catalog/sign.mjs';
import { publishCatalog } from '../../../scripts/content-catalog/publish.mjs';
import { candidate, keys, pair, withCatalog, image, digest } from '../../unit/contentCatalog/fixtures';
import type { ContentCatalog } from '@/common/contentCatalog/schema';
const template = {
  id: 'official:test',
  revision: 1,
  origin: 'official' as const,
  entryType: 'template' as const,
  kind: 'image' as const,
  title: { 'en-US': 'Title' },
  description: { 'en-US': 'Description' },
  prompt: { 'en-US': 'Prompt' },
  cover: digest,
  ratio: '1:1' as const,
  attribution: { author: 'Author', license: 'CC0', sourceUrl: 'https://github.com/pigq/OpenH3' },
  parameters: {},
  requiresReference: false,
  minClientVersion: '0.0.0',
  requiredCapabilities: [],
};
async function simulatedPublisher(
  options: { fail?: string; current?: ContentCatalog; next?: ContentCatalog; rollbackReason?: string } = {}
) {
  const root = await mkdtemp(path.join(tmpdir(), 'content-publish-api-'));
  const calls: { route: string; method: string; body: Record<string, unknown> }[] = [];
  const prior = withCatalog(candidate(1), options.current ?? { ...candidate(1).catalog, assets: [] });
  const next = options.next ?? { ...prior.catalog, releaseSequence: 2 };
  await writeFile(path.join(root, 'catalog.json'), JSON.stringify(next));
  await writeFile(path.join(root, 'changes.json'), '{}');
  await mkdir(path.join(root, 'assets'));
  for (const asset of next.assets) await writeFile(path.join(root, asset.path), image);
  const fetcher = async (url: string, init: RequestInit) => {
    if (url.startsWith('https://raw.githubusercontent.com/')) return new Response(prior.catalogBytes);
    const route = url.replace('https://api.github.com/repos/pigq/OpenH3', '');
    const body = JSON.parse(String(init.body ?? '{}'));
    calls.push({ route, method: init.method!, body });
    if (route === options.fail) return new Response('{}', { status: 422 });
    let data: unknown = { sha: 'c'.repeat(40) };
    if (route === '/git/ref/heads/content-stable') data = { object: { sha: 'b'.repeat(40) } };
    else if (route === '/git/ref/heads/content-snapshots') data = { object: { sha: 'd'.repeat(40) } };
    else if (route.startsWith('/contents/manifest.json')) data = { content: prior.manifestBytes.toString('base64') };
    else if (route.startsWith('/contents/manifest.sig')) data = { content: prior.signature.toString('base64') };
    else if (route.startsWith('/contents/catalog.json')) data = { content: prior.catalogBytes.toString('base64') };
    return new Response(JSON.stringify(data), { status: 200 });
  };
  try {
    return {
      result: await publishCatalog({
        directory: root,
        keyId: 'test',
        keyring: keys,
        privateKey: pair.privateKey,
        minClientVersion: '2.0.0',
        token: 'test-only',
        fetcher,
        rollbackReason: options.rollbackReason,
      }),
      calls,
      changes: JSON.parse(await readFile(path.join(root, 'changes.json'), 'utf8')),
      manifestBytes: await readFile(path.join(root, 'manifest.json')),
      signature: await readFile(path.join(root, 'manifest.sig')),
    };
  } catch (error) {
    return { error, calls };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
it('publishes a complete signed snapshot before changing the channel, with accurate audited changes', async () => {
  const { result, error, calls, manifestBytes, signature, changes } = await simulatedPublisher();
  expect(error).toBeUndefined();
  expect(result).toMatchObject({ sequence: 2 });
  expect(verify(null, manifestBytes!, pair.publicKey, signature!)).toBe(true);
  expect(JSON.parse(manifestBytes!.toString()).snapshotCommit).toBe(result!.snapshotCommit);
  const snapshotMove = calls.findIndex((c) => c.route === '/git/refs/heads/content-snapshots');
  expect(snapshotMove).toBeGreaterThan(0);
  expect(calls.at(-1)).toMatchObject({
    route: '/git/refs/heads/content-stable',
    method: 'PATCH',
    body: { force: false },
  });
  expect(snapshotMove).toBeLessThan(calls.length - 1);
  expect(changes).toEqual({ from: 1, to: 2, added: [], changed: [], removed: [] });
});
it('allows an explicitly audited old revision only under a newer signed release sequence', async () => {
  const c = candidate(1).catalog;
  const assets = c.assets.map((a) => ({ ...a, path: `assets/${a.sha256}` }));
  const current = { ...c, assets, entries: [{ ...template, revision: 2, prompt: { 'en-US': 'New prompt' } }] };
  const next = { ...current, releaseSequence: 2, entries: [template] };
  const rejected = await simulatedPublisher({ current, next });
  expect(rejected.error).toMatchObject({ message: 'REVISION_MUST_INCREASE' });
  const published = await simulatedPublisher({ current, next, rollbackReason: 'Restore reviewed previous prompt' });
  expect(published.error).toBeUndefined();
  expect(published.result?.sequence).toBe(2);
  expect(published.changes).toMatchObject({
    from: 1,
    to: 2,
    changed: [template.id],
    rollbackReason: 'Restore reviewed previous prompt',
  });
  const replay = await simulatedPublisher({
    current,
    next: { ...next, releaseSequence: 1 },
    rollbackReason: 'Restore reviewed previous prompt',
  });
  expect(replay.error).toMatchObject({ message: 'SEQUENCE_MUST_INCREASE' });
});
it('refuses an unauditable rollback before publishing any blobs', async () => {
  const { error, calls } = await simulatedPublisher({ rollbackReason: 'short' });
  expect(error).toMatchObject({ message: 'ROLLBACK_REASON_REQUIRED' });
  expect(calls.some((c) => c.method === 'POST' || c.method === 'PATCH')).toBe(false);
});
it('does not move the signed channel when snapshot publication fails', async () => {
  const { error, calls } = await simulatedPublisher({ fail: '/git/refs/heads/content-snapshots' });
  expect(error).toBeInstanceOf(Error);
  expect(calls.some((c) => c.route === '/git/refs/heads/content-stable')).toBe(false);
});
it('moves the signed channel last and never force-overwrites a concurrent publisher', async () => {
  const { error, calls } = await simulatedPublisher({ fail: '/git/refs/heads/content-stable' });
  expect(error).toBeInstanceOf(Error);
  expect(calls.at(-1)).toMatchObject({
    route: '/git/refs/heads/content-stable',
    method: 'PATCH',
    body: { force: false },
  });
});
it('checks entry revision changes against the verified current payload, not optional local files', async () => {
  const c = candidate(1).catalog;
  const current = { ...c, entries: [template], assets: [{ ...c.assets[0], sha256: template.cover }] };
  const next = { ...current, releaseSequence: 2, entries: [{ ...template, prompt: { 'en-US': 'changed' } }] };
  const { error, calls } = await simulatedPublisher({ current, next });
  expect(error).toMatchObject({ message: 'REVISION_MUST_INCREASE' });
  expect(calls.some((c) => c.method === 'POST')).toBe(false);
});
it('builds only approved, attributed, digest-verified data and signs the final original bytes', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'content-publish-'));
  try {
    const keys = generateKeyPairSync('ed25519');
    const keyring = { test: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString() };
    const bytes = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aHZsAAAAASUVORK5CYII=',
      'base64'
    );
    const hash = createHash('sha256').update(bytes).digest('hex');
    await mkdir(path.join(root, 'assets'));
    await writeFile(path.join(root, 'assets', hash), bytes);
    const entry = {
      id: 'official:test',
      revision: 1,
      origin: 'official',
      entryType: 'template',
      kind: 'image',
      title: { 'en-US': 'Title' },
      description: { 'en-US': 'Description' },
      prompt: { 'en-US': 'Prompt' },
      cover: hash,
      ratio: '1:1',
      attribution: { author: 'Author', license: 'CC0-1.0', sourceUrl: 'https://github.com/pigq/OpenH3' },
    };
    const catalog = {
      schemaVersion: 1,
      releaseSequence: 1,
      defaultLocale: 'en-US',
      publishedAt: new Date().toISOString(),
      models: [],
      entries: [entry],
      assets: [{ sha256: hash, path: `assets/${hash}`, mimeType: 'image/png', sizeBytes: bytes.length }],
    };
    const source = {
      catalog,
      approvals: [
        { id: entry.id, revision: 1, status: 'published', approvedBy: 'maintainer', approvedAt: catalog.publishedAt },
      ],
    };
    const input = path.join(root, 'source.json');
    const out = path.join(root, 'dist');
    await writeFile(input, JSON.stringify(source));
    await expect(buildCatalog({ input, assetsDir: root, out, keyring: {} })).rejects.toThrow('TRUST_UNCONFIGURED');
    const built = await buildCatalog({ input, assetsDir: root, out, keyring });
    expect(built.entries).toHaveLength(1);
    const manifest = await signCatalog({
      directory: out,
      snapshotCommit: 'a'.repeat(40),
      keyId: 'test',
      keyring,
      privateKey: keys.privateKey,
      minClientVersion: '2.2.2',
    });
    expect(manifest.releaseSequence).toBe(1);
    expect(
      verify(
        null,
        await readFile(path.join(out, 'manifest.json')),
        keys.publicKey,
        await readFile(path.join(out, 'manifest.sig'))
      )
    ).toBe(true);
    source.approvals[0].status = 'draft';
    await writeFile(input, JSON.stringify(source));
    await expect(buildCatalog({ input, assetsDir: root, out, keyring })).rejects.toThrow('APPROVAL_REQUIRED');
    source.approvals[0].status = 'published';
    source.catalog.entries[0].attribution.license = 'publication rights require review';
    await writeFile(input, JSON.stringify(source));
    await expect(buildCatalog({ input, assetsDir: root, out, keyring })).rejects.toThrow('ATTRIBUTION_REVIEW_REQUIRED');
    source.catalog.entries[0].attribution.license = 'CC0-1.0';
    const invalidSources = [
      { ...source, catalog: { ...source.catalog, entries: [entry, entry] } },
      { ...source, catalog: { ...source.catalog, entries: [{ ...entry, cover: '0'.repeat(64) }] } },
      {
        ...source,
        catalog: { ...source.catalog, entries: [{ ...entry, title: { 'zh-CN': 'Only translated title' } }] },
      },
      {
        ...source,
        catalog: { ...source.catalog, entries: [{ ...entry, requiredCapabilities: ['unreviewed.executor'] }] },
      },
      {
        ...source,
        catalog: { ...source.catalog, assets: [{ ...source.catalog.assets[0], sizeBytes: 4 * 1024 * 1024 + 1 }] },
      },
      {
        ...source,
        catalog: {
          ...source.catalog,
          models: [
            {
              id: entry.id,
              revision: 1,
              origin: 'official',
              family: 'unknown',
              name: 'Unknown',
              kind: 'image',
              description: entry.description,
              cover: hash,
            },
          ],
          entries: [],
        },
      },
    ];
    for (const invalid of invalidSources) {
      await writeFile(input, JSON.stringify(invalid));
      await expect(
        buildCatalog({ input, assetsDir: root, out: path.join(root, 'invalid-output'), keyring })
      ).rejects.toThrow();
    }
    const pointer = Buffer.from(
      'version https://git-lfs.github.com/spec/v1\noid sha256:' + '1'.repeat(64) + '\nsize 1\n'
    );
    const pointerHash = createHash('sha256').update(pointer).digest('hex');
    await writeFile(path.join(root, 'assets', pointerHash), pointer);
    await writeFile(
      input,
      JSON.stringify({
        ...source,
        catalog: {
          ...source.catalog,
          entries: [{ ...entry, cover: pointerHash }],
          assets: [
            { sha256: pointerHash, path: `assets/${pointerHash}`, mimeType: 'image/png', sizeBytes: pointer.length },
          ],
        },
      })
    );
    await expect(buildCatalog({ input, assetsDir: root, out: path.join(root, 'lfs-output'), keyring })).rejects.toThrow(
      'LFS_POINTER'
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
