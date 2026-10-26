import * as fs from 'node:fs/promises';
import path from 'node:path';
import { parseCatalog } from '../../../common/contentCatalog/schema';
import { assertDigest, type ContentKeyring, ContentCatalogError } from './trust';
import { ContentStore } from './store';
import { GitHubContentSource } from './source';
import { ContentCatalogService } from './service';
import { startContentHost } from './host';
export async function createContentRuntime(builtinDir: string, dataDir: string, version: string) {
  const builtin = parseCatalog(JSON.parse(await fs.readFile(path.join(builtinDir, 'catalog.json'), 'utf8')));
  const keys = JSON.parse(
    (await fs.readFile(path.join(builtinDir, 'trusted-keys.json'), 'utf8')).replace(/^\uFEFF/, '')
  ) as ContentKeyring;
  if (
    !keys ||
    typeof keys !== 'object' ||
    Array.isArray(keys) ||
    Object.values(keys).some((k) => typeof k !== 'string')
  )
    throw new ContentCatalogError('KEYRING_INVALID');
  const service = new ContentCatalogService({
    store: new ContentStore(path.join(dataDir, 'official-content'), keys),
    source: new GitHubContentSource(keys),
    builtin,
    version,
    builtinAsset: async (hash) => {
      if (!builtin.assets.some((a) => a.sha256 === hash)) throw new ContentCatalogError('ASSET_INVALID');
      const file = path.join(builtinDir, 'assets', hash);
      const stat = await fs.lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new ContentCatalogError('ASSET_INVALID');
      const bytes = await fs.readFile(file);
      assertDigest(bytes, hash);
      return bytes;
    },
  });
  await service.initialize();
  const host = await startContentHost(service);
  service.start();
  let stopping: Promise<void> | undefined;
  return {
    service,
    host,
    stop: () =>
      (stopping ??= (async () => {
        await service.stop();
        await host.close();
      })()),
  };
}
