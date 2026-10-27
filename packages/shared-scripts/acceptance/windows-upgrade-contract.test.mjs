import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  assertHostedRunner,
  assertWithinWindows,
  installerArguments,
  childEnvironment,
  parseInstallerJsonl,
  assertInstallerSuccess,
  assertArtifactManifest,
  selectOwnedProcesses,
} from './windows-upgrade-contract.mjs';

const hosted = {
  GITHUB_ACTIONS: 'true',
  RUNNER_ENVIRONMENT: 'github-hosted',
  RUNNER_OS: 'Windows',
  RUNNER_TEMP: 'D:\\a\\_temp',
};

test('hosted environment contract rejects host, self-hosted and wrong architecture without app imports', () => {
  assert.doesNotThrow(() => assertHostedRunner(hosted, 'win32', 'x64'));
  for (const env of [{}, { ...hosted, RUNNER_ENVIRONMENT: 'self-hosted' }, { ...hosted, GITHUB_ACTIONS: '' }])
    assert.throws(() => assertHostedRunner(env, 'win32', 'x64'));
  assert.throws(() => assertHostedRunner(hosted, 'linux', 'x64'));
  assert.throws(() => assertHostedRunner(hosted, 'win32', 'arm64'));
});

test('Windows containment rejects root, sibling-prefix, dot traversal and device paths', () => {
  const root = 'D:\\a\\_temp';
  assert.equal(
    assertWithinWindows(root, 'd:\\a\\_temp\\openh3 acceptance\\app'),
    'd:\\a\\_temp\\openh3 acceptance\\app'
  );
  for (const p of [root, 'D:\\', root + '-other\\app', root + '\\..\\app', '\\\\?\\D:\\a\\_temp\\app', 'C:relative'])
    assert.throws(() => assertWithinWindows(root, p));
});

test('silent manual installer command has currentuser and unquoted /D last', () => {
  const line = installerArguments({
    installDir: 'D:\\a\\_temp\\with spaces\\app',
    logPath: 'D:\\a\\_temp\\logs\\one.jsonl',
    session: '012345abcdef',
  });
  assert.equal(
    line,
    '/S /currentuser --installer-log="D:\\a\\_temp\\logs\\one.jsonl" --installer-session=012345abcdef /D=D:\\a\\_temp\\with spaces\\app'
  );
  assert.ok(!line.includes('--updated'));
  assert.throws(() => installerArguments({ installDir: 'D:\\bad"path', logPath: 'D:\\log', session: 'x' }));
});

test('only new child loses CI guards; all app children lose credentials', () => {
  const parent = {
    ...hosted,
    CI: 'true',
    Path: 'C:\\Windows',
    GH_TOKEN: 'redacted',
    win_csc_key_password: 'redacted',
    AIONUI_E2E_TEST: '1',
    AIONUI_DEBUG_AUTO_UPDATE_CURRENT_VERSION: '2.0.0',
  };
  const old = childEnvironment(parent, 'official-old');
  assert.equal(old.CI, 'true');
  assert.equal(old.AIONUI_DISABLE_AUTO_UPDATE, '1');
  const next = childEnvironment(parent, 'candidate-updater');
  for (const key of [
    'CI',
    'GITHUB_ACTIONS',
    'GH_TOKEN',
    'win_csc_key_password',
    'AIONUI_E2E_TEST',
    'AIONUI_DEBUG_AUTO_UPDATE_CURRENT_VERSION',
  ])
    assert.ok(!(key in next));
  assert.equal(parent.GH_TOKEN, 'redacted');
  assert.equal(parent.GITHUB_ACTIONS, 'true');
});

test('installer success is session/version/path scoped and rejects fatal failure', () => {
  const expected = { session: '012345abcdef', version: '3.0.1', updated: false, installDir: 'D:\\a\\_temp\\app' };
  const event = {
    event: 'session-end',
    message: 'event=session-end result=success detail=customInstall',
    session: expected.session,
    version: expected.version,
    updated: false,
    instDir: expected.installDir,
  };
  const parsed = parseInstallerJsonl('\uFEFF' + JSON.stringify(event) + '\r\n');
  assert.doesNotThrow(() => assertInstallerSuccess(parsed, expected));
  assert.throws(() => assertInstallerSuccess([{ ...event, session: 'unrelated' }], expected));
  assert.throws(() => assertInstallerSuccess([{ ...event, instDir: 'D:\\elsewhere' }], expected));
  assert.throws(() =>
    assertInstallerSuccess([...parsed, { ...event, event: 'failure', fatal: true, code: 'E1003' }], expected)
  );
  assert.throws(() =>
    assertInstallerSuccess([...parsed, { ...event, message: 'event=session-end result=fail code=E1003' }], expected)
  );
  assert.doesNotThrow(() =>
    assertInstallerSuccess(
      [{ ...event, event: 'session-begin', instDir: '', message: 'event=session-begin detail=preInit' }, ...parsed],
      expected
    )
  );
  assert.throws(() => parseInstallerJsonl('{bad json}'));
});

test('candidate manifest must describe exact 3.0.1 bytes, not spoofed 3.0.0', () => {
  const bytes = Buffer.from('not-an-executable-test-fixture');
  const sha512 = createHash('sha512').update(bytes).digest('base64');
  const manifest = {
    version: '3.0.1',
    files: [{ url: 'OpenH3-3.0.1-win-x64.exe', sha512, size: bytes.length }],
    path: 'OpenH3-3.0.1-win-x64.exe',
    sha512,
  };
  assert.doesNotThrow(() => assertArtifactManifest(manifest, bytes, '3.0.1'));
  for (const broken of [
    { ...manifest, version: '3.0.0' },
    { ...manifest, files: [{ ...manifest.files[0], url: '../escape.exe' }] },
    { ...manifest, sha512: 'bad' },
  ])
    assert.throws(() => assertArtifactManifest(broken, bytes, '3.0.1'));
  assert.throws(() => assertArtifactManifest(manifest, Buffer.from('corrupted'), '3.0.1'));
});

test('cleanup selects only registered PID + creation time + exact owned executable', () => {
  const registered = [{ pid: 10, created: '2026-10-25T01:00:00Z', executable: 'D:\\a\\_temp\\app\\OpenH3.exe' }];
  const good = { pid: 10, created: registered[0].created, executable: registered[0].executable };
  const others = [
    { ...good, pid: 11 },
    { ...good, created: 'reused-pid' },
    { ...good, executable: 'C:\\Users\\real\\OpenH3.exe' },
  ];
  assert.deepEqual(selectOwnedProcesses([good, ...others], registered), [good]);
  assert.deepEqual(
    selectOwnedProcesses([{ ...good, created: undefined }], [{ ...registered[0], created: undefined }]),
    []
  );
  assert.deepEqual(selectOwnedProcesses([{ ...good, pid: 0 }], [{ ...registered[0], pid: 0 }]), []);
  assert.deepEqual(
    selectOwnedProcesses([{ ...good, executable: 'OpenH3.exe' }], [{ ...registered[0], executable: 'OpenH3.exe' }]),
    []
  );
  assert.equal(path.win32.basename(good.executable), 'OpenH3.exe');
});
