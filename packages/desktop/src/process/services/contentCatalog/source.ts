import {
  catalogSchema,
  type ContentAsset,
  type ContentCatalog,
  type ContentManifest,
} from '../../../common/contentCatalog/schema';
import { assertDigest, ContentCatalogError, verifyManifest, type ContentKeyring } from './trust';
import { ContentRequestPool } from './assets';
export type ContentCandidate = {
  catalogBytes: Buffer;
  manifestBytes: Buffer;
  signature: Buffer;
  manifest: ContentManifest;
  catalog: ContentCatalog;
};
export class GitHubContentSource {
  private pool = new ContentRequestPool();
  constructor(
    readonly keys: ContentKeyring,
    private readonly fetcher: typeof fetch = fetch,
    private readonly now: () => number = Date.now
  ) {}
  private async bytes(url: string, limit: number, signal: AbortSignal): Promise<Buffer> {
    return this.pool.run(signal, () => this.fetchBytes(url, limit, signal));
  }
  private async fetchBytes(url: string, limit: number, signal: AbortSignal): Promise<Buffer> {
    let current = new URL(url);
    for (let hop = 0; hop < 5; hop++) {
      if (
        current.protocol !== 'https:' ||
        current.port !== '' ||
        !['api.github.com', 'raw.githubusercontent.com'].includes(current.hostname) ||
        current.username ||
        current.password
      )
        throw new ContentCatalogError('HOST_NOT_ALLOWED');
      const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(30000)]);
      const response = await this.fetcher(current.toString(), {
        signal: requestSignal,
        redirect: 'manual',
        headers: { 'User-Agent': 'OpenH3-Content', Accept: 'application/vnd.github+json' },
      });
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel();
        const next = response.headers.get('location');
        if (!next) throw new ContentCatalogError('REDIRECT_INVALID');
        current = new URL(next, current);
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new ContentCatalogError(`HTTP_${response.status}`);
      }
      if (Number(response.headers.get('content-length')) > limit) {
        await response.body?.cancel();
        throw new ContentCatalogError('SIZE_LIMIT');
      }
      const reader = response.body?.getReader();
      if (!reader) throw new ContentCatalogError('BODY_MISSING');
      const chunks: Uint8Array[] = [];
      let total = 0;
      const abortReader = () => {
        void reader.cancel().catch(() => {});
      };
      requestSignal.addEventListener('abort', abortReader, { once: true });
      try {
        while (true) {
          requestSignal.throwIfAborted();
          const { done, value } = await reader.read();
          requestSignal.throwIfAborted();
          if (done) break;
          total += value.byteLength;
          if (total > limit) throw new ContentCatalogError('SIZE_LIMIT');
          chunks.push(value);
        }
      } finally {
        requestSignal.removeEventListener('abort', abortReader);
        await reader.cancel().catch(() => {});
      }
      return Buffer.concat(chunks);
    }
    throw new ContentCatalogError('REDIRECT_LIMIT');
  }
  private url(commit: string, file: string): string {
    return `https://raw.githubusercontent.com/pigq/OpenH3/${commit}/${file}`;
  }
  async check(highest: number, signal: AbortSignal): Promise<ContentCandidate> {
    if (!Object.keys(this.keys).length) throw new ContentCatalogError('TRUST_UNCONFIGURED');
    const pointer = JSON.parse(
      (
        await this.bytes('https://api.github.com/repos/pigq/OpenH3/commits/content-stable', 256 * 1024, signal)
      ).toString('utf8')
    ) as { sha?: string };
    if (!pointer.sha || !/^[a-f0-9]{40}$/.test(pointer.sha)) throw new ContentCatalogError('COMMIT_INVALID');
    const metadata = new AbortController();
    const metadataSignal = AbortSignal.any([signal, metadata.signal]);
    const requests = [
      this.bytes(this.url(pointer.sha, 'manifest.json'), 256 * 1024, metadataSignal),
      this.bytes(this.url(pointer.sha, 'manifest.sig'), 64, metadataSignal),
    ];
    let manifestBytes: Buffer, signature: Buffer;
    try {
      [manifestBytes, signature] = await Promise.all(requests);
    } catch (error) {
      metadata.abort(error);
      await Promise.allSettled(requests);
      throw error;
    }
    const manifest = verifyManifest(manifestBytes, signature, this.keys, 0, this.now());
    if (manifest.releaseSequence === highest) throw new ContentCatalogError('UP_TO_DATE');
    if (manifest.releaseSequence < highest) throw new ContentCatalogError('REPLAY');
    const bytes = await this.bytes(
      this.url(manifest.snapshotCommit, manifest.catalogPath),
      manifest.catalogSizeBytes,
      signal
    );
    assertDigest(bytes, manifest.catalogSha256);
    if (bytes.length !== manifest.catalogSizeBytes) throw new ContentCatalogError('SIZE_MISMATCH');
    const raw = JSON.parse(bytes.toString('utf8')) as { schemaVersion?: unknown };
    if (raw.schemaVersion !== 1) throw new ContentCatalogError('SCHEMA_UNSUPPORTED');
    const parsed = catalogSchema.safeParse(raw);
    if (!parsed.success || parsed.data.releaseSequence !== manifest.releaseSequence)
      throw new ContentCatalogError('CATALOG_INVALID');
    return { catalogBytes: bytes, manifestBytes, signature, manifest, catalog: parsed.data as ContentCatalog };
  }
  async asset(candidate: ContentCandidate, asset: ContentAsset, signal: AbortSignal): Promise<Buffer> {
    const b = await this.bytes(this.url(candidate.manifest.snapshotCommit, asset.path), asset.sizeBytes, signal);
    assertDigest(b, asset.sha256);
    if (b.length !== asset.sizeBytes) throw new ContentCatalogError('SIZE_MISMATCH');
    return b;
  }
}
