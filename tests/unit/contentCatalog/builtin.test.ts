import { it, expect } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash, createPublicKey } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { exportBuiltin } from '../../../scripts/content-catalog/export-builtin.mjs';
import { createContentRuntime } from '@/process/services/contentCatalog/builtin';
import { buildSpawnEnv } from '../../../packages/web-host/src/backend-launcher';
import { COMFY_FAMILIES } from '@/renderer/pages/guid/Creation/comfyDraft';
import { CONTENT_CAPABILITIES } from '@/common/contentCatalog/policy';
it('exports all 52 bundled templates and serves their offline digest-addressed media without changing user data', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'builtin-content-'));
  let runtime: Awaited<ReturnType<typeof createContentRuntime>> | undefined;
  try {
    const dir = path.join(root, 'builtin');
    const catalog = await exportBuiltin(dir);
    expect(catalog.entries).toHaveLength(52);
    expect(catalog.models.map((model) => model.family)).toEqual(COMFY_FAMILIES.map((model) => model.family));
    for (const model of catalog.models) {
      expect(CONTENT_CAPABILITIES).toEqual(expect.arrayContaining(model.requiredCapabilities));
    }
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
    const keyring = JSON.parse(await readFile('resources/content-catalog/trusted-keys.json', 'utf8'));
    expect(JSON.parse(await readFile(path.join(dir, 'trusted-keys.json'), 'utf8'))).toEqual(keyring);
    expect(runtime.service.getStatus().sourceConfigured).toBe(true);
    const asset = catalog.assets[0];
    const response = await fetch(`${runtime.host.url}/api/content-catalog/assets/0/${asset.sha256}`, {
      headers: { 'x-openh3-content-token': runtime.host.token },
    });
    expect(response.status).toBe(200);
    expect(Buffer.from(await response.arrayBuffer())).toEqual(await readFile(path.join(dir, asset.path)));
    await runtime.stop();
    await writeFile(path.join(dir, 'trusted-keys.json'), '{}');
    runtime = await createContentRuntime(dir, path.join(root, 'unconfigured-data'), '3.0.0');
    expect(runtime.service.getStatus().sourceConfigured).toBe(false);
    expect(runtime.service.getCatalog().entries).toHaveLength(52);
  } finally {
    await runtime?.stop();
    await rm(root, { recursive: true, force: true });
  }
});
it('ships the production Ed25519 public key without a private key', async () => {
  const keyring = JSON.parse(await readFile('resources/content-catalog/trusted-keys.json', 'utf8'));
  expect(Object.keys(keyring)).toEqual(['openh3-content-20261024']);
  const pem = keyring['openh3-content-20261024'];
  expect(pem).toMatch(/^-----BEGIN PUBLIC KEY-----/);
  expect(pem).not.toContain('PRIVATE KEY');
  const key = createPublicKey(pem);
  expect(key.asymmetricKeyType).toBe('ed25519');
  expect(
    createHash('sha256')
      .update(key.export({ type: 'spki', format: 'der' }))
      .digest('hex')
  ).toBe('1decb9f5ca9eac04dc41c3509dd78e22ea5c7e3ee51ce86064f486607f9cbf41');
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
