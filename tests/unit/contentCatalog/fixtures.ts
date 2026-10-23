import { generateKeyPairSync, sign, createHash } from 'node:crypto';
import type { ContentCandidate } from '@/process/services/contentCatalog/source';
import type { ContentCatalog } from '@/common/contentCatalog/schema';
export const pair = generateKeyPairSync('ed25519');
export const keys = { test: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString() };
export const image = Buffer.from('test-image');
export const digest = createHash('sha256').update(image).digest('hex');
export function withCatalog(c: ContentCandidate, catalog: ContentCatalog): ContentCandidate {
  const catalogBytes = Buffer.from(JSON.stringify(catalog));
  const manifest = {
    ...c.manifest,
    catalogSha256: createHash('sha256').update(catalogBytes).digest('hex'),
    catalogSizeBytes: catalogBytes.length,
  };
  const manifestBytes = Buffer.from(JSON.stringify(manifest));
  return { catalog, catalogBytes, manifest, manifestBytes, signature: sign(null, manifestBytes, pair.privateKey) };
}
export function candidate(sequence = 1): ContentCandidate {
  const catalog = {
    schemaVersion: 1 as const,
    releaseSequence: sequence,
    defaultLocale: 'en-US',
    publishedAt: new Date().toISOString(),
    models: [],
    entries: [],
    assets: [{ sha256: digest, path: 'cover.webp', mimeType: 'image/webp' as const, sizeBytes: image.length }],
  };
  const catalogBytes = Buffer.from(JSON.stringify(catalog));
  const manifest = {
    schemaVersion: 1 as const,
    channel: 'content-stable' as const,
    keyId: 'test',
    releaseSequence: sequence,
    publishedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 86400000).toISOString(),
    minClientVersion: '0.0.0',
    snapshotCommit: 'a'.repeat(40),
    catalogPath: 'catalog.json',
    catalogSha256: createHash('sha256').update(catalogBytes).digest('hex'),
    catalogSizeBytes: catalogBytes.length,
  };
  const manifestBytes = Buffer.from(JSON.stringify(manifest));
  return { catalog, catalogBytes, manifest, manifestBytes, signature: sign(null, manifestBytes, pair.privateKey) };
}
