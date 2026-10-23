import { it, expect } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { exportBuiltin } from '../../../scripts/content-catalog/export-builtin.mjs';
import { createContentRuntime } from '@/process/services/contentCatalog/builtin';
import { buildSpawnEnv } from '../../../packages/web-host/src/backend-launcher';
it('exports all 52 bundled templates and serves their offline digest-addressed media without changing user data', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'builtin-content-'));
  let runtime: Awaited<ReturnType<typeof createContentRuntime>> | undefined;
  try {
    const dir = path.join(root, 'builtin');
    const catalog = await exportBuiltin(dir);
    expect(catalog.entries).toHaveLength(52);
    expect(catalog.models).toHaveLength(3);
    for (const e of catalog.entries) {
      expect(Object.keys(e.title)).toHaveLength(13);
      expect(Object.keys(e.prompt)).toHaveLength(13);
    }
    const original = JSON.parse(
      await readFile('packages/desktop/src/renderer/services/i18n/locales/zh-CN/guid.json', 'utf8')
    );
    for (const e of catalog.entries)
      expect(e.prompt['zh-CN']).toBe(original.templates[e.id.slice('official:'.length)].prompt);
    runtime = await createContentRuntime(dir, path.join(root, 'data'), '2.2.2');
    expect(runtime.service.getStatus().sourceConfigured).toBe(false);
    const asset = catalog.assets[0];
    const response = await fetch(`${runtime.host.url}/api/content-catalog/assets/0/${asset.sha256}`, {
      headers: { 'x-openh3-content-token': runtime.host.token },
    });
    expect(response.status).toBe(200);
    expect(Buffer.from(await response.arrayBuffer())).toEqual(await readFile(path.join(dir, asset.path)));
  } finally {
    await runtime?.stop();
    await rm(root, { recursive: true, force: true });
  }
});
it('passes host credentials explicitly without mutating the parent environment', () => {
  const before = process.env.OPENH3_CONTENT_TOKEN;
  const token = 'a'.repeat(64);
  expect(buildSpawnEnv(undefined, { port: 12345, token })).toMatchObject({
    OPENH3_CONTENT_PORT: '12345',
    OPENH3_CONTENT_TOKEN: token,
  });
  expect(process.env.OPENH3_CONTENT_TOKEN).toBe(before);
});
