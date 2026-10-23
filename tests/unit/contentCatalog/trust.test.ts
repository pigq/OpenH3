import { describe, it, expect } from 'vitest';
import { generateKeyPairSync, sign, createHash } from 'node:crypto';
import { verifyManifest, assertDigest } from '@/process/services/contentCatalog/trust';
const keys = generateKeyPairSync('ed25519');
const key = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const manifest = {
  schemaVersion: 1,
  channel: 'content-stable',
  keyId: 'test',
  releaseSequence: 2,
  publishedAt: '2026-10-22T00:00:00Z',
  expiresAt: '2026-11-01T00:00:00Z',
  minClientVersion: '1.0.0',
  snapshotCommit: 'a'.repeat(40),
  catalogPath: 'catalog.json',
  catalogSha256: 'b'.repeat(64),
  catalogSizeBytes: 10,
};
const bytes = Buffer.from(JSON.stringify(manifest));
const signature = sign(null, bytes, keys.privateKey);
const now = Date.parse('2026-10-23T00:00:00Z');
describe('signed catalog trust', () => {
  it('accepts a valid signed manifest', () =>
    expect(verifyManifest(bytes, signature, { test: key }, 1, now).releaseSequence).toBe(2));
  it('rejects altered manifests, unknown keys, replay and expiration', () => {
    expect(() =>
      verifyManifest(Buffer.from(JSON.stringify({ ...manifest, releaseSequence: 3 })), signature, { test: key }, 1, now)
    ).toThrow();
    expect(() => verifyManifest(bytes, signature, {}, 1, now)).toThrow();
    expect(() => verifyManifest(bytes, signature, { test: key }, 2, now)).toThrow('REPLAY');
    expect(() => verifyManifest(bytes, signature, { test: key }, 1, now + 40 * 86400000)).toThrow('EXPIRED');
  });
  it('checks file digests', () => {
    expect(() => assertDigest(Buffer.from('abc'), 'b'.repeat(64))).toThrow('DIGEST');
    expect(() => assertDigest(Buffer.from('abc'), createHash('sha256').update('abc').digest('hex'))).not.toThrow();
  });
  it('reports signed unknown protocols separately from invalid signatures', () => {
    const bytes = Buffer.from(JSON.stringify({ ...manifest, schemaVersion: 2 }));
    expect(() => verifyManifest(bytes, sign(null, bytes, keys.privateKey), { test: key }, 0, now)).toThrow(
      'SCHEMA_UNSUPPORTED'
    );
  });
});
