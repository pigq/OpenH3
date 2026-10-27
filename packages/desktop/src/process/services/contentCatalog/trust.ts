import { createHash, createPublicKey, verify } from 'node:crypto';
import { manifestSchema, type ContentManifest } from '../../../common/contentCatalog/schema';
export class ContentCatalogError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'ContentCatalogError';
  }
}
export type ContentKeyring = Readonly<Record<string, string>>;
export function assertDigest(bytes: Uint8Array, expected: string): void {
  if (createHash('sha256').update(bytes).digest('hex') !== expected) throw new ContentCatalogError('DIGEST_MISMATCH');
}
export function verifyManifest(
  bytes: Uint8Array,
  signature: Uint8Array,
  keys: ContentKeyring,
  highest: number,
  now = Date.now(),
  cached = false
): ContentManifest {
  if (bytes.byteLength > 256 * 1024 || signature.byteLength !== 64) throw new ContentCatalogError('MANIFEST_INVALID');
  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(bytes).toString('utf8'));
  } catch {
    throw new ContentCatalogError('MANIFEST_INVALID');
  }
  const keyId = raw && typeof raw === 'object' && 'keyId' in raw ? raw.keyId : undefined;
  if (typeof keyId !== 'string' || !Object.hasOwn(keys, keyId)) throw new ContentCatalogError('TRUST_UNCONFIGURED');
  const key = createPublicKey(keys[keyId]);
  if (key.asymmetricKeyType !== 'ed25519' || !verify(null, bytes, key, signature))
    throw new ContentCatalogError('SIGNATURE_INVALID');
  if (raw && typeof raw === 'object' && 'schemaVersion' in raw && raw.schemaVersion !== 1)
    throw new ContentCatalogError('SCHEMA_UNSUPPORTED');
  const parsed = manifestSchema.safeParse(raw);
  if (!parsed.success) throw new ContentCatalogError('MANIFEST_INVALID');
  const m = parsed.data as ContentManifest;
  const published = Date.parse(m.publishedAt);
  const expires = Date.parse(m.expiresAt);
  if (expires <= published || expires - published > 31 * 86400000) throw new ContentCatalogError('MANIFEST_INVALID');
  if (!cached) {
    if (m.releaseSequence <= highest) throw new ContentCatalogError('REPLAY');
    if (published > now + 300000) throw new ContentCatalogError('CLOCK_INVALID');
    if (expires <= now) throw new ContentCatalogError('MANIFEST_EXPIRED');
  }
  return m;
}
