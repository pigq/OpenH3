import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createProvenance, verifyBundle, verifyOfficial, assertContext } from './artifacts.mjs';

const sha = 'a'.repeat(40);
const bytes = Buffer.from('fake exe bytes for pure workflow test, never executed');
const sha512 = createHash('sha512').update(bytes).digest('base64');
const manifest = {
  version: '3.0.1',
  path: 'OpenH3-3.0.1-win-x64.exe',
  sha512,
  files: [{ url: 'OpenH3-3.0.1-win-x64.exe', sha512, size: bytes.length }],
};
const manifestBytes = Buffer.from(JSON.stringify(manifest));
const packageBytes = Buffer.from('{"version":"3.0.1"}');
const lockBytes = Buffer.from('fixed lockfile fixture');
const context = { repository: 'pigq/OpenH3', sourceSha: sha, runId: '1234', runAttempt: '1' };

test('candidate binds exact reviewed SHA/run, lock/source files, original exe and manifest bytes', () => {
  const provenance = createProvenance({
    context,
    manifest,
    manifestBytes,
    installerBytes: bytes,
    packageBytes,
    lockBytes,
    signature: { status: 'NotSigned' },
  });
  assert.equal(provenance.sourceSha, sha);
  assert.equal(provenance.installer.sha512, sha512);
  assert.doesNotThrow(() =>
    verifyBundle({ context, provenance, manifest, manifestBytes, installerBytes: bytes, packageBytes, lockBytes })
  );
  for (const changed of [
    { context: { ...context, sourceSha: 'b'.repeat(40) } },
    { context: { ...context, runId: '9999' } },
    { installerBytes: Buffer.from('wrong payload') },
    { manifestBytes: Buffer.from('changed YAML bytes') },
    { lockBytes: Buffer.from('changed lock') },
    { packageBytes: Buffer.from('{"version":"3.0.0"}') },
    { provenance: { ...provenance, repository: 'other/repository' } },
  ])
    assert.throws(() =>
      verifyBundle({
        context,
        provenance,
        manifest,
        manifestBytes,
        installerBytes: bytes,
        packageBytes,
        lockBytes,
        ...changed,
      })
    );
});

test('non-final version, unverifiable contexts and missing signature observations are rejected', () => {
  for (const changed of [
    { sourceSha: 'branch-name' },
    { runId: '1;echo bad' },
    { repository: 'pigq/notOpenH3' },
    { runAttempt: '' },
  ])
    assert.throws(() => assertContext({ ...context, ...changed }));
  assert.throws(() =>
    createProvenance({
      context,
      manifest,
      manifestBytes,
      installerBytes: bytes,
      packageBytes: Buffer.from('{"version":"3.0.0"}'),
      lockBytes,
      signature: { status: 'NotSigned' },
    })
  );
  assert.throws(() =>
    createProvenance({
      context,
      manifest,
      manifestBytes,
      installerBytes: bytes,
      packageBytes,
      lockBytes,
      signature: {},
    })
  );
});

test('official bytes are never accepted by name/version alone', () => {
  assert.throws(() => verifyOfficial(bytes), /official/);
});
