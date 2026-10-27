import fs from 'node:fs/promises';
import path from 'node:path';
import { sign, verify, createPrivateKey } from 'node:crypto';
import { parseArgs } from 'node:util';
import { bundleModule, digest, canonical, atomicWrite, assertKeyring, isMain } from './helpers.mjs';
export function signingKey(privateKey, keyId, keyring) {
  assertKeyring(keyring);
  const key = privateKey?.type === 'private' ? privateKey : createPrivateKey(privateKey);
  const probe = Buffer.from('OpenH3 official content signing key check');
  if (
    key.asymmetricKeyType !== 'ed25519' ||
    !Object.hasOwn(keyring, keyId) ||
    !verify(null, probe, keyring[keyId], sign(null, probe, key))
  )
    throw Error('SIGNING_KEY_MISMATCH');
  return key;
}
export async function signCatalog({
  directory,
  snapshotCommit,
  keyId,
  keyring,
  privateKey,
  minClientVersion,
  now = Date.now(),
}) {
  const key = signingKey(privateKey, keyId, keyring);
  const { parseCatalog, manifestSchema } = await bundleModule('packages/desktop/src/common/contentCatalog/schema.ts');
  const bytes = await fs.readFile(path.join(directory, 'catalog.json'));
  const catalog = parseCatalog(JSON.parse(bytes));
  const manifest = manifestSchema.parse({
    schemaVersion: 1,
    channel: 'content-stable',
    keyId,
    releaseSequence: catalog.releaseSequence,
    publishedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 30 * 86400000).toISOString(),
    minClientVersion,
    snapshotCommit,
    catalogPath: 'catalog.json',
    catalogSha256: digest(bytes),
    catalogSizeBytes: bytes.length,
  });
  const encoded = Buffer.from(canonical(manifest));
  await atomicWrite(path.join(directory, 'manifest.json'), encoded);
  await atomicWrite(path.join(directory, 'manifest.sig'), sign(null, encoded, key));
  return manifest;
}
if (isMain(import.meta.url)) {
  const { values } = parseArgs({
    options: {
      directory: { type: 'string' },
      'snapshot-commit': { type: 'string' },
      'key-id': { type: 'string' },
      keyring: { type: 'string' },
      'min-client-version': { type: 'string' },
    },
  });
  await signCatalog({
    directory: values.directory,
    snapshotCommit: values['snapshot-commit'],
    keyId: values['key-id'],
    keyring: JSON.parse(await fs.readFile(values.keyring, 'utf8')),
    privateKey: await fs.readFile(process.env.OPENH3_CONTENT_PRIVATE_KEY_FILE),
    minClientVersion: values['min-client-version'],
  });
  console.log('Detached signature written. No publication performed.');
}
