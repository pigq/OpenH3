import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { assertArtifactManifest, OFFICIAL } from '../windows-upgrade-contract.mjs';

export const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

export function assertContext(context) {
  assert.equal(context.repository, 'pigq/OpenH3');
  assert.match(context.sourceSha, /^[a-f0-9]{40}$/);
  assert.match(context.runId, /^[1-9][0-9]*$/);
  assert.match(context.runAttempt, /^[1-9][0-9]*$/);
}

export function createProvenance({
  context,
  manifest,
  manifestBytes,
  installerBytes,
  packageBytes,
  lockBytes,
  signature,
}) {
  assertContext(context);
  assert.equal(JSON.parse(packageBytes.toString('utf8')).version, '3.0.1');
  assert.ok(
    ['Valid', 'NotSigned'].includes(signature?.status),
    'Authenticode must be observed and valid or explicitly unsigned'
  );
  const installer = assertArtifactManifest(manifest, installerBytes, '3.0.1');
  return {
    schemaVersion: 1,
    ...context,
    version: '3.0.1',
    platform: 'win32',
    arch: 'x64',
    installer,
    manifest: { name: 'latest.yml', sha256: digest(manifestBytes) },
    source: { packageSha256: digest(packageBytes), bunLockSha256: digest(lockBytes) },
    signature: {
      status: signature.status,
      subject: signature.subject ?? null,
      thumbprint: signature.thumbprint ?? null,
    },
    build: { command: 'node scripts/build-with-builder.js x64 --win --x64', publish: 'never' },
  };
}

export function verifyBundle(input) {
  const { provenance } = input;
  assertContext(input.context);
  assert.equal(provenance?.schemaVersion, 1);
  const expected = createProvenance({ ...input, signature: provenance.signature });
  assert.deepEqual(provenance, expected, 'Candidate source/run/provenance or original artifact bytes differ');
  return expected;
}

export function verifyOfficial(bytes) {
  assert.equal(bytes.length, OFFICIAL.size, 'Wrong official asset byte length');
  assert.equal(digest(bytes), OFFICIAL.sha256, 'Wrong official v3.0.0 installer SHA256');
  return { ...OFFICIAL };
}
