import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bundleModule, root, digest, atomicWrite } from './helpers.mjs';
export async function exportBuiltin(out = path.join(root, 'out/content-catalog')) {
  const { CREATION_TEMPLATES } = await bundleModule(
    'packages/desktop/src/renderer/pages/guid/utils/creationTemplates.ts'
  );
  const { parseCatalog } = await bundleModule('packages/desktop/src/common/contentCatalog/schema.ts');
  const localesRoot = path.join(root, 'packages/desktop/src/renderer/services/i18n/locales');
  const locales = {};
  for (const dir of await fs.readdir(localesRoot)) {
    try {
      locales[dir] = JSON.parse(await fs.readFile(path.join(localesRoot, dir, 'guid.json'), 'utf8'));
    } catch {
      /* Only configured locale directories have guid data. */
    }
  }
  const assets = new Map();
  const add = async (file) => {
    const bytes = await fs.readFile(file);
    const hash = digest(bytes);
    const ext = path.extname(file);
    const mime = { '.webp': 'image/webp', '.png': 'image/png', '.jpg': 'image/jpeg', '.mp4': 'video/mp4' }[ext];
    if (!mime) throw Error('Unsupported bundled media');
    assets.set(hash, { sha256: hash, path: `assets/${hash}`, mimeType: mime, sizeBytes: bytes.length });
    await atomicWrite(path.join(out, 'assets', hash), bytes);
    return hash;
  };
  const texts = (key, field) =>
    Object.fromEntries(
      Object.entries(locales).map(([locale, data]) => [
        locale,
        data.templates?.[key]?.[field] ?? locales['en-US'].templates?.[key]?.[field] ?? key,
      ])
    );
  const entries = [];
  for (const t of CREATION_TEMPLATES) {
    entries.push({
      id: `official:${t.key}`,
      revision: 1,
      origin: 'official',
      entryType: 'template',
      kind: t.kind,
      title: texts(t.key, 'title'),
      description: texts(t.key, 'title'),
      prompt: texts(t.key, 'prompt'),
      parameters: {},
      requiresReference: Boolean(t.requiresReference),
      cover: await add(t.cover),
      ratio: t.ratio,
      minClientVersion: '0.0.0',
      requiredCapabilities: [`template.${t.kind}`],
      attribution: {
        author: 'OpenH3 template catalog',
        license: 'Bundled legacy media; publication rights require review',
        sourceUrl: 'https://github.com/pigq/OpenH3',
      },
      ...(t.kind === 'video' ? { media: await add(t.src), duration: t.duration } : {}),
    });
  }
  const models = [];
  for (const [family, name, kind, file] of [
    ['h3', 'H3', 'video', 'previews/coast.webp'],
    ['qwen-edit', 'Qwen-Edit', 'image', 'style/women-hair-grid.webp'],
    ['z-image', 'Z-Image', 'image', 'images/landscape.webp'],
  ]) {
    models.push({
      id: `official:model-${family}`,
      revision: 1,
      origin: 'official',
      family,
      name,
      kind,
      description: Object.fromEntries(
        Object.entries(locales).map(([locale, data]) => [locale, data.comfy?.families?.[family] ?? name])
      ),
      cover: await add(path.join(root, 'packages/desktop/src/renderer/assets/creation', file)),
      minClientVersion: '0.0.0',
      requiredCapabilities: [`comfy.${family}`],
    });
  }
  const catalog = parseCatalog({
    schemaVersion: 1,
    releaseSequence: 0,
    defaultLocale: 'en-US',
    publishedAt: '2026-10-23T00:00:00Z',
    models,
    entries,
    assets: [...assets.values()],
  });
  await atomicWrite(path.join(out, 'catalog.json'), JSON.stringify(catalog));
  await atomicWrite(
    path.join(out, 'trusted-keys.json'),
    await fs.readFile(path.join(root, 'resources/content-catalog/trusted-keys.json'))
  );
  return catalog;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  console.log(`Exported ${(await exportBuiltin(process.argv[2])).entries.length} official builtin templates`);
