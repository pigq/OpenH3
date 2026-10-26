import test from 'node:test';
import assert from 'node:assert/strict';
import { runUpdaterScenario } from './updater.mjs';

function fake(
  scenario,
  {
    gap = false,
    missingNative = false,
    unexpectedDownload = false,
    missingHandoff = false,
    wrongSession = false,
    noRestart = false,
    wrongError = false,
    incompleteCorrupt = false,
    stopFails = false,
    invalidRefusal = false,
    damagedRelaunchContent = false,
    transportLengthMismatch = false,
  } = {}
) {
  const calls = [];
  let installed = false;
  let downloads = 0;
  let running = true;
  const events = [{ name: 'checking-for-update' }, { name: 'update-available', version: '3.0.1' }];
  const files = new Map();
  const reports = [];
  const identity = {
    pid: 123,
    version: '3.0.1',
    packaged: true,
    platform: 'win32',
    arch: 'x64',
    executable: 'D:\\temp\\owned\\app\\OpenH3.exe',
    appRoot: 'D:\\temp\\owned\\app\\resources\\app.asar',
    resourcesPath: 'D:\\temp\\owned\\app\\resources',
    userData: 'C:\\Users\\runner\\AppData\\Roaming\\OpenH3',
  };
  const app = () => ({
    identity,
    backendDataDir: identity.userData + '\\OpenH3',
    request: {},
    systemInfo: {},
    fixtureIdentity: { appVersion: '3.0.1', syntheticCurrentVersion: '3.0.0', executable: identity.executable },
    async quitNormally() {
      calls.push('ordinary-quit');
      running = false;
      return { normalExit: true };
    },
    async nativeCheck() {
      calls.push('native-check');
      return { isUpdateAvailable: !missingNative, version: '3.0.1' };
    },
    async updaterEvents() {
      return [...events];
    },
    async invokeUpdate(key) {
      calls.push(key);
      if (key === 'auto-update.download') {
        downloads++;
        if (scenario === 'cancel') {
          events.push({ name: 'download-progress', transferred: 5 });
          return { success: true };
        }
        if (['disconnect', 'corrupt'].includes(scenario)) {
          events.push({
            name: 'error',
            error: wrongError
              ? 'permission denied'
              : scenario === 'corrupt'
                ? 'sha512 checksum mismatch, expected X, got Y'
                : transportLengthMismatch
                  ? 'net::ERR_CONTENT_LENGTH_MISMATCH'
                  : 'Request has been aborted by the server',
            code: !wrongError && scenario === 'corrupt' ? 'ERR_CHECKSUM_MISMATCH' : undefined,
          });
          return { success: false, error: 'fixture download rejected' };
        }
        events.push({ name: 'update-downloaded', version: '3.0.1' });
        return { success: true };
      }
      if (key === 'auto-update.download.cancel') {
        events.push({ name: 'update-cancelled' });
        if (unexpectedDownload) events.push({ name: 'update-downloaded' });
        return { success: true };
      }
      if (key === 'auto-update.quit-and-install') {
        running = false;
        return undefined;
      }
      throw Error('Unimplemented fake handoff');
    },
    async exerciseSynchronousHandoffRejection() {
      calls.push('original-native-sync-refusal');
      return {
        scope: 'original-BaseUpdater-synchronous-missing-download-state',
        renderer: {
          evidence: 'real-renderer-auto-update.status',
          status: { status: 'error', error: 'native refused' },
        },
        native: {
          pid: identity.pid,
          installAttempts: 0,
          willQuit: false,
          nativeErrors: [{ error: "No update filepath provided, can't quit and install" }],
        },
        sameMainAlive: !invalidRefusal,
        restored: {
          restored: true,
          sha256: (await import('../artifacts.mjs')).digest(Buffer.from('pure fake never executed')),
        },
      };
    },
    async startUpdateObservation() {
      calls.push('observation-start');
      const observer = {
        async proveNoInstaller() {
          if (gap) throw Object.assign(Error('NOT-COVERED: process observation gap'), { code: 'NOT_COVERED' });
          return { complete: true, installers: [] };
        },
        async prepareHandoff() {
          calls.push('prepare-handoff');
        },
        async waitForInstaller() {
          calls.push('native-installer');
          return {
            complete: true,
            session: '012345abcdef',
            exitCode: 0,
            events: [
              {
                session: '012345abcdef',
                version: '3.0.1',
                updated: !wrongSession,
                instDir: 'D:\\temp\\owned\\app',
                event: 'session-end',
                message: 'result=success',
              },
            ],
          };
        },
        async waitForRestart() {
          calls.push('automatic-restart');
          return { observedAutomaticRestart: !noRestart };
        },
        async quitRestartNormally() {
          calls.push('automatic-restart-normal-quit');
          return { normalExit: true };
        },
        async stop() {
          calls.push('observation-stop');
          if (stopFails) throw Error('Failed to stop owned observer');
        },
      };
      if (missingHandoff) delete observer.prepareHandoff;
      return observer;
    },
    async waitNormallyExited() {
      calls.push('wait-old-normal-exit');
      return { normalExit: true };
    },
  });
  const io = {
    async ensureOwnedDirectory() {},
    async writeFile(file, bytes) {
      files.set(file, Buffer.from(bytes));
    },
    async readFile(file) {
      return files.get(file);
    },
    async writeJson(_file, value) {
      reports.push(structuredClone(value));
    },
    async install(args) {
      installed = true;
      calls.push('install');
      return {
        exitCode: 0,
        events: [
          {
            session: args.session,
            version: '3.0.1',
            updated: false,
            instDir: args.installDir,
            event: 'session-end',
            message: 'result=success',
          },
        ],
      };
    },
    async launchInstalled(args) {
      assert.ok(installed);
      calls.push(args.mode);
      running = true;
      return app();
    },
    async sqliteQuickCheck() {
      assert.equal(running, false);
      return { quick_check: 'ok' };
    },
  };
  const services = {
    createFeed: async () => ({
      url: 'http://127.0.0.1:12345/',
      requests: [
        { pathname: '/latest.yml' },
        {
          pathname: '/OpenH3-3.0.1-win-x64.exe',
          mode: scenario,
          payloadSize: 20,
          bytesWritten: scenario === 'disconnect' || incompleteCorrupt ? 10 : 20,
          finished: scenario !== 'disconnect' && !incompleteCorrupt,
          disconnected: scenario === 'disconnect',
        },
      ],
      async close() {
        calls.push('feed-close');
      },
    }),
    seed: async () => ({ marker: 'fake' }),
    verify: async () => ({ persisted: true }),
    resourceAudit: async () => {
      calls.push('resource-audit');
      if (damagedRelaunchContent && calls.filter((c) => c === 'resource-audit').length > 1)
        throw Error('Installed content-catalog asset changed after native overwrite');
      return { missing: [], failures: [], content: { families: 8, templates: 52 } };
    },
  };
  const config = {
    scenario,
    root: 'D:\\temp\\owned',
    evidenceDir: 'D:\\temp\\owned\\evidence',
    installerPath: 'D:\\temp\\owned\\candidate\\OpenH3-3.0.1-win-x64.exe',
    installerBytes: Buffer.from('pure fake never executed'),
    manifestBytes: Buffer.from('fake manifest'),
    context: { runId: '1', runAttempt: '1' },
    repoRoot: 'D:\\repo',
  };
  return { io, services, config, calls, reports, downloads: () => downloads };
}

test('synthetic updater native-check plus genuine IPC cancel, transport errors and ordinary quit have separate claims', async () => {
  for (const scenario of ['cancel', 'disconnect', 'corrupt', 'downloaded-quit']) {
    const f = fake(scenario);
    const result = await runUpdaterScenario(f.config, f.io, f.services);
    assert.equal(result.status, 'PASS');
    assert.equal(result.fixture.installedVersion, '3.0.1');
    assert.equal(result.fixture.syntheticCurrentVersion, '3.0.0');
    assert.equal(result.fixture.officialOldUpdaterTested, false);
    assert.ok(f.calls.indexOf('observation-start') < f.calls.indexOf('auto-update.download'));
    assert.ok(f.calls.includes('ordinary-quit'));
    assert.ok(f.calls.includes('candidate-manual'));
    assert.equal(f.downloads(), 1);
    assert.equal(f.calls.at(-1), 'feed-close');
  }
});

test('observation gaps, unavailable native update and downloaded-after-cancel cannot pass', async () => {
  for (const options of [{ gap: true }, { missingNative: true }, { unexpectedDownload: true }]) {
    const f = fake('cancel', options);
    await assert.rejects(runUpdaterScenario(f.config, f.io, f.services));
    assert.ok(f.calls.includes('feed-close'));
  }
});

test('install requires real observed NSIS updated session and automatic restart, distinct from controlled relaunch', async () => {
  const f = fake('install');
  const result = await runUpdaterScenario(f.config, f.io, f.services);
  assert.equal(result.status, 'PASS');
  assert.equal(result.automaticRestartExit.normalExit, true);
  assert.equal(result.controlledRelaunch.exit.normalExit, true);
  assert.ok(f.calls.indexOf('prepare-handoff') < f.calls.indexOf('auto-update.quit-and-install'));
  assert.ok(f.calls.indexOf('prepare-handoff') < f.calls.indexOf('original-native-sync-refusal'));
  assert.ok(f.calls.indexOf('original-native-sync-refusal') < f.calls.indexOf('auto-update.quit-and-install'));
  assert.equal(result.synchronousHandoffFailure.sameMainAlive, true);
  assert.ok(f.calls.indexOf('automatic-restart') < f.calls.indexOf('candidate-manual'));
  assert.ok(f.calls.indexOf('automatic-restart-normal-quit') < f.calls.indexOf('candidate-manual'));
  assert.equal(
    f.calls.filter((c) => c === 'install').length,
    1,
    'No manual installer may masquerade as native handoff'
  );
  assert.equal(
    f.calls.filter((c) => c === 'resource-audit').length,
    2,
    'Re-audit actual installed resources after overwrite'
  );
  assert.equal(result.controlledRelaunch.resources.content.templates, 52);
  for (const options of [{ missingHandoff: true }, { wrongSession: true }, { noRestart: true }]) {
    const g = fake('install', options);
    await assert.rejects(runUpdaterScenario(g.config, g.io, g.services));
  }
});

test('install cannot pass without a proven synchronous refusal or with damaged installed content after retry', async () => {
  for (const options of [{ invalidRefusal: true }, { damagedRelaunchContent: true }]) {
    const f = fake('install', options);
    await assert.rejects(runUpdaterScenario(f.config, f.io, f.services));
    assert.equal(f.reports.at(-1).status, 'FAIL');
  }
});

test('corrupt requires completed bad bytes plus checksum mismatch; disconnect requires actual partial server abort', async () => {
  const truncated = fake('disconnect', { transportLengthMismatch: true });
  assert.equal((await runUpdaterScenario(truncated.config, truncated.io, truncated.services)).status, 'PASS');
  for (const [scenario, options] of [
    ['corrupt', { wrongError: true }],
    ['corrupt', { incompleteCorrupt: true }],
    ['disconnect', { wrongError: true }],
  ]) {
    const f = fake(scenario, options);
    await assert.rejects(runUpdaterScenario(f.config, f.io, f.services));
  }
});

test('observer cleanup failure is not saved as a successful updater evidence report', async () => {
  const f = fake('downloaded-quit', { stopFails: true });
  await assert.rejects(runUpdaterScenario(f.config, f.io, f.services), /Failed to stop/);
  assert.equal(f.reports.at(-1).status, 'FAIL');
});
