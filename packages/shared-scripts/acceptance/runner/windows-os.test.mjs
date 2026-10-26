import test from 'node:test';
import assert from 'node:assert/strict';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';

const subject = await import('./windows-os.mjs').catch(() => ({}));
const env = {
  GITHUB_ACTIONS: 'true',
  RUNNER_ENVIRONMENT: 'github-hosted',
  RUNNER_OS: 'Windows',
  RUNNER_TEMP: 'D:\\runner\\temp',
  APPDATA: 'C:\\Users\\runner\\AppData\\Roaming',
  LOCALAPPDATA: 'C:\\Users\\runner\\AppData\\Local',
  GH_TOKEN: 'secret',
};
const root = 'D:\\runner\\temp\\acceptance-123';
const planSource = (plan) =>
  plan.env.OPENH3_ACCEPTANCE_SCRIPT
    ? gunzipSync(Buffer.from(plan.env.OPENH3_ACCEPTANCE_SCRIPT, 'base64')).toString('utf8')
    : Buffer.from(plan.args.at(-1), 'base64').toString('utf16le');

test('OS adapter refuses local execution before any OS or Electron operation', () => {
  assert.equal(typeof subject.createWindowsAdapter, 'function', 'Missing fail-closed hosted Windows OS adapter');
  let touched = false;
  assert.throws(
    () =>
      subject.createWindowsAdapter(
        { ...env, GITHUB_ACTIONS: 'false' },
        {
          platform: 'win32',
          arch: 'x64',
          powershell: () => {
            touched = true;
          },
        }
      ),
    /GitHub-hosted/
  );
  assert.equal(touched, false);
});

test('dependency-injected OS adapters are always marked test-only without executing any operation', () => {
  const adapter = subject.createWindowsAdapter(env, {
    platform: 'win32',
    arch: 'x64',
    powershell: () => {
      throw Error('Must not execute an OS operation');
    },
  });
  assert.equal(adapter.testOnly, true, 'Injected OS adapters must not produce real installed evidence');
});

test(
  'the production OS adapter is explicitly non-test when no dependencies are injected',
  { skip: process.platform !== 'win32' || process.arch !== 'x64' },
  () => {
    assert.equal(subject.createWindowsAdapter(env).testOnly, false);
  }
);

test('path policy rejects ADS, ambiguous names, traversal and reserved device segments', () => {
  assert.equal(typeof subject.assertUnambiguousWindowsPath, 'function');
  assert.equal(subject.assertUnambiguousWindowsPath(`${root}\\Install Dir`), `${root}\\Install Dir`);
  for (const suffix of ['a:stream', 'bad.', 'bad ', 'CON.txt', 'lpt1', 'a\\..\\b', 'a?b', 'a|b'])
    assert.throws(() => subject.assertUnambiguousWindowsPath(`${root}\\${suffix}`));
});

test('only the exact installed media script argv with proven main parent identity is a media child', () => {
  assert.equal(typeof subject.isInstalledMediaChild, 'function');
  const executable = `${root}\\app\\OpenH3.exe`;
  const script = `${root}\\app\\resources\\app.asar.unpacked\\out\\main\\media-service.js`;
  const main = { pid: 100, created: '2026-10-26T00:00:00.000Z', executable, sid: 'S-1-owned' };
  const media = {
    pid: 102,
    parentPid: main.pid,
    created: '2026-10-26T00:00:01.000Z',
    executable,
    sid: main.sid,
    commandLine: `"${executable}" "${script}"`,
  };
  assert.equal(subject.isInstalledMediaChild(media, main, script), true);
  for (const changed of [
    { parentPid: 999 },
    { sid: 'S-1-unrelated' },
    { sid: undefined },
    { created: '2026-10-25T23:59:59.000Z' },
    { created: 'invalid' },
    { executable: `${root}\\other\\OpenH3.exe` },
    { commandLine: `"${executable}" "${root}\\other\\media-service.js"` },
    { commandLine: `"${executable}" "${script}" --updated` },
    { commandLine: `"${executable}" "${script}" --type=utility` },
    { commandLine: `"${executable}" "${script.replace('out\\main', 'out\\main\\..\\main')}"` },
    { commandLine: `"${root}\\other\\OpenH3.exe" "${script}"` },
    { commandLine: `"${executable}" --updated` },
  ])
    assert.equal(subject.isInstalledMediaChild({ ...media, ...changed }, main, script), false, JSON.stringify(changed));
  assert.equal(subject.isInstalledMediaChild(main, main, script), false);
});

test('PowerShell plan contains no user values in script/argv and installer arguments preserve /D last', () => {
  assert.equal(typeof subject.buildPowerShellPlan, 'function');
  const payload = {
    installerPath: `${root}\\candidate.exe`,
    installDir: `${root}\\Install Dir`,
    logPath: `${root}\\logs\\installer.jsonl`,
    session: '123456abcdef',
  };
  const plan = subject.buildPowerShellPlan('install', payload, env);
  assert.equal(plan.file, 'powershell.exe');
  assert.deepEqual(plan.args.slice(0, 4), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass']);
  assert.ok(
    plan.args.join(' ').length < 8_000,
    'Fixed PowerShell transport must stay well below Windows 32767 command-line limit as watcher grows'
  );
  const decoded = planSource(plan);
  assert.match(decoded, /ProcessStartInfo/);
  assert.match(decoded, /UseShellExecute = \$false/);
  assert.doesNotMatch(decoded, /RunAs|Stop-Process|taskkill|candidate\.exe|Install Dir/);
  assert.doesNotMatch(decoded, /return ,\$result/, 'Snapshot must not be boxed again inside @(Snapshot)');
  assert.doesNotMatch(
    decoded.slice(decoded.indexOf('function Snapshot'), decoded.indexOf('switch ($p.action)')),
    /if \(-not \$c\.ExecutablePath\) \{ continue \}/,
    'Missing CIM image must not hide a live registered PID'
  );
  const transported = JSON.parse(Buffer.from(plan.env.OPENH3_ACCEPTANCE_PAYLOAD, 'base64').toString('utf8'));
  assert.equal(transported.action, 'install');
  assert.match(transported.arguments, / \/D=D:\\runner\\temp\\acceptance-123\\Install Dir$/);
  assert.equal(plan.env.GH_TOKEN, undefined);
});

test('descendant registry requires live exact parent identity and allowlisted physical executable', () => {
  assert.equal(typeof subject.collectOwnedDescendants, 'function');
  const main = { pid: 5, created: '2026-10-25T00:00:00.000Z', executable: `${root}\\app\\OpenH3.exe` };
  const backend = {
    pid: 6,
    parentPid: 5,
    created: '2026-10-25T00:00:01.000Z',
    executable: `${root}\\app\\resources\\core.exe`,
  };
  const renderer = { pid: 7, parentPid: 5, created: '2026-10-25T00:00:02.000Z', executable: main.executable };
  const allowed = [main.executable, backend.executable];
  assert.deepEqual(
    subject.collectOwnedDescendants([main, backend, renderer], [main], allowed).map((p) => p.pid),
    [6, 7]
  );
  assert.deepEqual(subject.collectOwnedDescendants([backend], [main], allowed), []);
  assert.deepEqual(
    subject.collectOwnedDescendants([{ ...main, created: '2026-10-25T01:00:00.000Z' }, backend], [main], allowed),
    []
  );
  assert.deepEqual(subject.collectOwnedDescendants([main, backend], [main], [main.executable]), []);
});

test('normal-exit scope excludes update installer and its restarted main, not the old backend', () => {
  assert.equal(typeof subject.registeredLaunchTree, 'function');
  const main = { pid: 1, created: '2026-10-25T00:00:00.000Z', executable: `${root}\\app\\OpenH3.exe` };
  const backend = { pid: 2, parentPid: 1, created: '2026-10-25T00:00:01.000Z', executable: `${root}\\app\\core.exe` };
  const installer = {
    pid: 3,
    parentPid: 1,
    created: '2026-10-25T00:00:02.000Z',
    executable: `${env.LOCALAPPDATA}\\cache\\pending\\update.exe`,
  };
  const restart = { pid: 4, parentPid: 3, created: '2026-10-25T00:00:03.000Z', executable: main.executable };
  assert.deepEqual(
    subject
      .registeredLaunchTree([main, backend, installer, restart], main, [main.executable, backend.executable])
      .map((p) => p.pid),
    [1, 2]
  );
});

test('backend data directory is parsed from actual Windows argv with no fallback guesses', () => {
  assert.equal(typeof subject.backendDataDirectory, 'function');
  assert.equal(
    subject.backendDataDirectory(
      '"D:\\Program Files\\core.exe" --local --data-dir "C:\\Users\\runner\\AppData\\Roaming\\OpenH3\\OpenH3"'
    ),
    'C:\\Users\\runner\\AppData\\Roaming\\OpenH3\\OpenH3'
  );
  for (const commandLine of [
    'core.exe --local',
    'core.exe --data-dir D:\\a --data-dir D:\\b',
    'core.exe --data-dir "D:\\unterminated',
    'core.exe --data-dir D:\\a:ads',
  ])
    assert.throws(() => subject.backendDataDirectory(commandLine));
});

test('handoff observation plan retains exact SID/creation/image identities and normal window close', () => {
  const script = planSource(subject.buildPowerShellPlan('handoff-watch', {}, env));
  assert.match(script, /'handoff-watch'/);
  assert.match(script, /CloseMainWindow\(\)/);
  assert.match(script, /GetOwnerSid/);
  assert.match(script, /MainWindowHandle/);
  assert.match(script, /\$actual\.sid -ne \$r\.sid/);
  assert.doesNotMatch(script, /\$h\.record\.Keys/, 'JSON transported root records are PSCustomObject, not Hashtable');
  assert.equal(subject.backendPort('core.exe --port 43123 --local --data-dir D:\\data'), 43123);
  assert.throws(() => subject.backendPort('core.exe --port 12 --port 13'));
});

test('fake OS root creation rejects physical redirection before recording ownership', async () => {
  assert.equal(typeof subject.createWindowsAdapter, 'function');
  const calls = [];
  const adapter = subject.createWindowsAdapter(env, {
    platform: 'win32',
    arch: 'x64',
    powershell: async (action, data) => {
      calls.push([action, data]);
      return {};
    },
    fsOps: { realpath: async (p) => (p === root ? 'D:\\other' : p) },
  });
  await assert.rejects(adapter.ensureOwnedRoot(root), /physical|realpath/i);
  await assert.rejects(adapter.readFile(`${root}\\file`), /owned root/i);
  assert.equal(calls[0][0], 'path');
});

for (const variant of [
  'normal',
  'media-child',
  'gap-after-exit',
  'unknown-helper',
  'bad-native-argv',
  'extra-main',
  'stop-snapshot-failure',
  'premature-completion',
  'restart-stop-failure',
  'backend-nonzero-exit',
  'main-nonzero-exit',
  'refusal-main-replaced',
  'refusal-cache-changed',
])
  test(`fake native handoff rejects unproven boundaries and preserves owned cleanup: ${variant}`, async () => {
    const dir = `${root}\\app`;
    const executable = `${dir}\\OpenH3.exe`;
    const core = `${dir}\\resources\\core.exe`;
    const sid = 'S-1-5-21-owned-runner';
    const birth = (offset) => new Date(Date.now() + offset).toISOString();
    const main = { pid: 100, created: birth(-3000), ticks: '100', executable, sid };
    const media = {
      pid: 102,
      parentPid: main.pid,
      created: birth(-1500),
      ticks: '102',
      executable,
      sid,
      commandLine: `"${executable}" "${dir}\\resources\\app.asar.unpacked\\out\\main\\media-service.js"`,
    };
    const dataDir = `${env.APPDATA}\\OpenH3\\OpenH3`;
    const backend = {
      pid: 101,
      created: birth(-2000),
      ticks: '101',
      executable: core,
      sid,
      parentPid: main.pid,
      commandLine: `"${core}" --local --port 43123 --data-dir "${dataDir}"`,
    };
    const payload = Buffer.from('actual candidate fixture bytes');
    const digest = createHash('sha256').update(payload).digest('hex');
    const cacheDir = `${env.LOCALAPPDATA}\\openh3-updater`;
    const pendingDir = `${cacheDir}\\pending`;
    const downloadedFile = `${pendingDir}\\update.exe`;
    const baselineInstaller = {
      pid: 99,
      created: birth(-4000),
      ticks: '99',
      executable: `${root}\\candidate.exe`,
      sid,
    };
    let auditPath;
    let auditSession;
    const audit = [];
    const written = new Map();
    const physicalReads = new Set();
    let cleanupRegistry;
    let downloaded = false;
    let handedOff = false;
    let restartClosed = false;
    let pollsAfterRestartClose = 0;
    let handoffRecord;
    let finishHandoff;
    let closedWindow;
    const exitWatches = new Map();
    let restart;
    let failSnapshot = false;
    let handoffStopped = false;
    let nativeRejected = false;
    let restoredHelper = false;
    let suspendedHelper = false;
    const pauses = [];
    const session = '123456abcdef';
    const installEvent = {
      session,
      version: '3.0.1',
      updated: false,
      instDir: dir,
      event: 'session-end',
      message: 'result=success',
    };
    let nativeLog = [];
    const cache = () => ({
      appVersion: '3.0.1',
      config: { provider: 'github', owner: 'pigq', repo: 'OpenH3', updaterCacheDirName: 'openh3-updater' },
      cacheBase: env.LOCALAPPDATA,
      cacheDir,
      pendingDir,
      file: downloaded ? downloadedFile : null,
      packageFile: null,
      version: downloaded ? '3.0.1' : null,
      sha512: downloaded ? createHash('sha512').update(payload).digest('base64') : null,
      isAdminRightsRequired: false,
    });
    const logPath = `${root}\\nsis-temp\\aionui-installer-3.0.1-20261025-log.jsonl`;
    const writeAudit = (kind, detail = {}) =>
      audit.push({
        schemaVersion: 1,
        session: auditSession,
        sequence: audit.length,
        at: new Date().toISOString(),
        pid: main.pid,
        executable,
        kind,
        ...detail,
      });
    const page = {
      evaluate: async (fn, arg) => {
        if (arg?.route) return { ready: true };
        if (typeof arg === 'number') return { status: 'ok' };
        if (arg?.timeoutMs && !arg.key) {
          assert.equal(suspendedHelper, true, 'Only suspended real download state may trigger the refusal request');
          nativeRejected = true;
          return { evidence: 'real-renderer-auto-update.status', status: { status: 'error', error: 'native refused' } };
        }
        if (arg?.key) {
          assert.equal(arg.key, 'auto-update.quit-and-install');
          writeAudit('do-install-enter', {
            installerPath: downloadedFile,
            isSilent: true,
            isForceRunAfter: true,
            isAdminRightsRequired: false,
          });
          writeAudit('do-install-return', { result: true });
          writeAudit('fixture-will-quit', { wrapperIntact: true });
          writeAudit('fixture-process-exit', {
            exitCode: 0,
            auditPrefixHealthy: true,
            wrapperIntact: true,
            installAttempts: 1,
          });
          handedOff = true;
          const installer = {
            pid: 110,
            created: birth(1),
            ticks: '110',
            executable: downloadedFile,
            sid,
            parentPid: main.pid,
            sha256: digest,
            commandLine: `"${downloadedFile}" --updated ${variant === 'bad-native-argv' ? '' : '/S --force-run'}`,
          };
          restart = {
            pid: 120,
            created: birth(2),
            ticks: '120',
            executable,
            sid,
            parentPid: 888,
            commandLine: `"${executable}" --updated`,
          };
          const newBackend = {
            ...backend,
            pid: 121,
            parentPid: restart.pid,
            ticks: '121',
            created: birth(3),
            commandLine: `"${core}" --local --port 43124 --data-dir "${dataDir}"`,
          };
          restart.backend = newBackend;
          restart.media = { ...media, pid: 122, parentPid: restart.pid, ticks: '122', created: birth(3) };
          handoffRecord({ kind: 'observed', role: 'installer', record: installer });
          handoffRecord({ kind: 'observed', role: 'installer', record: installer });
          handoffRecord({ kind: 'process-exit', role: 'installer', record: { ...installer, exitCode: 0 } });
          if (variant === 'gap-after-exit')
            handoffRecord({ kind: 'observation-gap', error: 'retained identity became unavailable' });
          if (variant === 'unknown-helper')
            handoffRecord({
              kind: 'observed',
              role: 'nsis-installer',
              record: { ...installer, pid: 111, executable: `${root}\\nsis-temp\\foreign.exe` },
            });
          handoffRecord({ kind: 'restart-candidate', record: restart });
          nativeLog = [
            {
              ts: birth(4),
              session: 'abcdef123456',
              version: '3.0.1',
              updated: true,
              instDir: dir,
              event: 'session-end',
              message: 'result=success',
            },
          ];
          exitWatches.get(main.pid)?.({
            completed: true,
            exits: [
              { ...main, exitCode: variant === 'main-nonzero-exit' ? 1 : 0 },
              { ...backend, exitCode: variant === 'backend-nonzero-exit' ? 1 : 0 },
            ],
          });
          if (variant === 'premature-completion') finishHandoff({ completed: true });
          return undefined;
        }
        if (fn.toString().includes('childElementCount')) return true;
        return 43123;
      },
    };
    const adapter = subject.createWindowsAdapter(env, {
      platform: 'win32',
      arch: 'x64',
      sleep: async (duration) => {
        pauses.push(duration);
      },
      fsOps: {
        realpath: async (p) => {
          physicalReads.add(p);
          return p;
        },
        lstat: async () => {
          throw Object.assign(Error('absent'), { code: 'ENOENT' });
        },
        readFile: async (p) =>
          p === auditPath
            ? audit.map((r) => JSON.stringify(r)).join('\n') + '\n'
            : p === downloadedFile
              ? variant === 'refusal-cache-changed' && restoredHelper
                ? Buffer.from('changed bytes')
                : payload
              : p === logPath
                ? nativeLog.map((r) => JSON.stringify(r)).join('\n')
                : JSON.stringify(installEvent),
        writeFile: async (p, bytes) => {
          written.set(p, bytes);
          if (/handoff-watch-.*\.stop$/.test(p)) {
            handoffStopped = true;
            finishHandoff?.({ completed: true });
          }
          if (/exit-watch-.*\.stop$/.test(p))
            for (const finish of exitWatches.values()) finish({ completed: false, exits: [] });
        },
        readdir: async (p) =>
          p === `${root}\\nsis-temp` ? (handedOff ? ['aionui-installer-3.0.1-20261025-log.jsonl'] : []) : [],
      },
      powershell: async (action, data, options) => {
        if (action === 'install') {
          options.onRecord({ kind: 'started', record: baselineInstaller });
          return { ...baselineInstaller, exitCode: 0 };
        }
        if (action === 'executables') return { executables: [executable, core] };
        if (action === 'snapshot') {
          if (failSnapshot) throw Error('snapshot failed during observer stop');
          return {
            processes: handedOff
              ? restartClosed
                ? variant === 'media-child' && ++pollsAfterRestartClose === 1
                  ? [restart.media]
                  : []
                : [restart, restart.backend, ...(variant === 'media-child' ? [restart.media] : [])]
              : [
                  variant === 'refusal-main-replaced' && nativeRejected
                    ? { ...main, created: birth(500), ticks: 'reused' }
                    : main,
                  ...(nativeRejected ? [] : [backend]),
                  ...(variant === 'media-child' ? [media] : []),
                  ...(variant === 'extra-main' ? [{ ...main, pid: 199, ticks: '199', created: birth(-1000) }] : []),
                ],
          };
        }
        if (action === 'listeners') return { pids: [data.port === 43124 ? 121 : 101] };
        if (action === 'exit-watch') {
          options.onRecord({ kind: 'ready' });
          return new Promise((resolve) => {
            exitWatches.set(data.registry[0].pid, resolve);
          });
        }
        if (action === 'handoff-watch') {
          handoffRecord = options.onRecord;
          options.onRecord({ kind: 'ready' });
          return new Promise((resolve) => {
            finishHandoff = resolve;
          });
        }
        if (action === 'window') return { visible: true, hwnd: '12345', record: data.record };
        if (action === 'close-window') {
          closedWindow = data.record;
          restartClosed = true;
          exitWatches.get(restart.pid)?.({
            completed: true,
            exits: [
              { ...restart, exitCode: 0 },
              { ...restart.backend, exitCode: variant === 'backend-nonzero-exit' ? 1 : 0 },
            ],
          });
          return { requested: true, hwnd: '12345' };
        }
        if (action === 'cleanup') {
          cleanupRegistry = data.registry;
          return { cleaned: [] };
        }
        return {};
      },
      fetch: async (url) => ({
        ok: true,
        json: async () =>
          url.endsWith('/health')
            ? { status: 'ok' }
            : {
                success: true,
                data: url.includes('settings') ? { 'system.closeToTray': false } : { id: 'system_default_user' },
              },
      }),
      loadElectron: async () => ({
        launch: async () => ({
          firstWindow: async () => page,
          windows: () => [page],
          browserWindow: async () => ({ evaluate: async () => true, dispose: async () => {} }),
          evaluate: async (fn, arg) => {
            if (fn.name === 'installUpdaterFixture') {
              auditPath = arg.auditPath;
              auditSession = arg.auditSession;
              writeAudit('fixture-installed', { appVersion: '3.0.1', delegatedNativeMethod: 'NsisUpdater.doInstall' });
              return { appVersion: '3.0.1', syntheticCurrentVersion: '3.0.0', auditPath, auditSession };
            }
            if (fn.name === 'installedIdentity')
              return {
                pid: main.pid,
                executable,
                appRoot: `${dir}\\resources\\app.asar`,
                packaged: true,
                version: '3.0.1',
                userData: `${env.APPDATA}\\OpenH3`,
              };
            if (fn.name === 'readDownloadedUpdate') return cache();
            if (fn.name === 'suspendDownloadedUpdate') {
              assert.equal(typeof handoffRecord, 'function', 'Retain native handles before pre-install backend stop');
              suspendedHelper = true;
              return { pid: main.pid, executable, installerPath: downloadedFile, sha512: cache().sha512 };
            }
            if (fn.name === 'inspectSynchronousHandoffRejection') {
              assert.equal(nativeRejected, true);
              return {
                pid: main.pid,
                executable,
                installAttempts: 0,
                willQuit: false,
                nativeErrors: [{ error: "No update filepath provided, can't quit and install" }],
              };
            }
            if (fn.name === 'restoreDownloadedUpdate') {
              restoredHelper = true;
              suspendedHelper = false;
              return { restored: true, file: downloadedFile, sha512: cache().sha512, version: '3.0.1' };
            }
            if (fn.name === 'snapshotInstallAudit')
              return {
                path: auditPath,
                session: auditSession,
                wrapperIntact: true,
                scope: 'this-installed-updater-doInstall-only',
                records: audit.slice(),
              };
            throw Error('Unexpected evaluate: ' + fn.name);
          },
          close: () => {
            throw Error('No Playwright force close');
          },
        }),
      }),
    });
    await adapter.ensureOwnedRoot(root);
    await adapter.assertFreshProductProfile();
    await adapter.install({
      installerPath: baselineInstaller.executable,
      installDir: dir,
      logPath: `${root}\\installer.jsonl`,
      session,
      version: '3.0.1',
    });
    if (variant === 'extra-main') {
      await assert.rejects(
        adapter.launchInstalled({
          executablePath: executable,
          cwd: root,
          mode: 'candidate-updater',
          feedUrl: 'http://127.0.0.1:43111/',
        }),
        /exclusive|additional|unique/i
      );
      await adapter.cleanup();
      return;
    }
    const app = await adapter.launchInstalled({
      executablePath: executable,
      cwd: root,
      mode: 'candidate-updater',
      feedUrl: 'http://127.0.0.1:43111/',
    });
    const observer = await app.startUpdateObservation({ expectedInstallerSha256: digest });
    downloaded = true;
    assert.equal((await observer.prepareHandoff({ expectedInstallerSha256: digest })).file, downloadedFile);
    if (variant === 'stop-snapshot-failure') {
      failSnapshot = true;
      await assert.rejects(observer.stop(), /cleanup|snapshot|observation/i);
      assert.equal(handoffStopped, true, 'Observer must stop native watcher after refresh failure');
      assert.ok(
        [...written.keys()].some((p) => /updater-observation-.*\.json$/.test(p)),
        'Observer failure evidence must still be saved'
      );
      failSnapshot = false;
      await adapter.cleanup();
      return;
    }
    if (variant.startsWith('refusal-')) {
      await assert.rejects(
        app.exerciseSynchronousHandoffRejection({ expectedInstallerSha256: digest }),
        /main|identity|digest|cache/i
      );
      assert.equal(restoredHelper, true, 'Always restore only the saved helper even when refusal evidence fails');
      await observer.stop().catch(() => {});
      await adapter.cleanup();
      return;
    }
    const refusal = await app.exerciseSynchronousHandoffRejection({ expectedInstallerSha256: digest });
    assert.equal(refusal.sameMainAlive, true);
    assert.equal(refusal.native.installAttempts, 0);
    assert.equal(refusal.restored.sha256, digest);
    assert.ok(
      pauses.some((duration) => duration >= 1500),
      'Prove Windows main remains alive beyond the former force-exit timer'
    );
    assert.equal((await observer.proveNoInstaller({ durationMs: 1 })).installers.length, 0);
    await app.invokeUpdate('auto-update.quit-and-install');
    if (!['normal', 'media-child', 'restart-stop-failure', 'backend-nonzero-exit'].includes(variant)) {
      await assert.rejects(
        observer.waitForInstaller(),
        /gap|helper|argv|command|identity|observation|explicit stop|exit/i
      );
      await observer.stop().catch(() => {});
      await adapter.cleanup();
      return;
    }
    const handoff = await observer.waitForInstaller();
    assert.equal(handoff.exitCode, 0);
    assert.equal(handoff.session, 'abcdef123456');
    assert.equal(handoff.complete, true);
    assert.equal((await app.waitNormallyExited()).normalExit, true);
    if (variant === 'backend-nonzero-exit')
      assert.equal(
        (await app.waitNormallyExited()).exits.find((p) => p.pid === backend.pid).exitCode,
        1,
        'Preserve actual product stop exit code instead of inventing zero'
      );
    const automatic = await observer.waitForRestart();
    assert.equal(automatic.observedAutomaticRestart, true);
    assert.equal(automatic.main.pid, restart.pid);
    assert.equal(automatic.attribution, 'fresh-VM-exclusive-install-native-audit-NSIS-session-new-updated-identity');
    assert.equal(
      automatic.parentChainSupplemental,
      false,
      'Explorer-parent restart must not claim a verified installer parent'
    );
    if (variant === 'restart-stop-failure') {
      failSnapshot = true;
      await assert.rejects(observer.stop(), /cleanup|snapshot|observation/i);
      assert.equal(handoffStopped, true);
      assert.ok(
        [...written.keys()].some((p) => /exit-watch-.*\.stop$/.test(p)),
        'Observer must also stop retained restart handle watcher'
      );
      failSnapshot = false;
      await adapter.cleanup();
      return;
    }
    assert.equal((await observer.quitRestartNormally()).normalExit, true);
    assert.equal(closedWindow.pid, restart.pid);
    await observer.stop();
    await adapter.cleanup();
    if (variant === 'media-child') {
      assert.ok(
        cleanupRegistry.some((p) => p.pid === media.pid && p.role === 'media-service'),
        'Initial media role stays in owned registry'
      );
      assert.ok(
        cleanupRegistry.some((p) => p.pid === restart.media.pid),
        'Restart media child stays in owned registry'
      );
      assert.equal(automatic.main.pid, restart.pid, 'The same-exe media child must not be mistaken for automatic main');
      assert.ok(pollsAfterRestartClose >= 2, 'Restart normal close must wait for its same-exe media descendant');
      assert.ok(
        physicalReads.has(`${dir}\\resources\\app.asar.unpacked\\out\\main\\media-service.js`),
        'The exact installed media script must pass the physical path check before the media exception'
      );
    }
    assert.ok(
      [...written.keys()].some((p) => p.includes('evidence') && p.endsWith('.jsonl')),
      'Actual native NSIS log must be retained in uploaded evidence'
    );
  });

test('handoff script binds native observed bytes and never owns arbitrary temp helpers', () => {
  const script = planSource(subject.buildPowerShellPlan('handoff-watch', {}, env));
  const observed = script.slice(script.indexOf("'handoff-watch'"), script.indexOf("{ $_ -in 'window'"));
  assert.match(
    script,
    /function Sha256File\(\[string\]\$value\)[\s\S]+?\[Security\.Cryptography\.SHA256\]::Create\(\)/
  );
  assert.doesNotMatch(script, /Get-FileHash/);
  assert.match(observed, /Sha256File \$r\.executable/);
  assert.match(observed, /Sha256File \$p\.installerPath/);
  assert.match(observed, /Unknown native installer helper/);
});

test('fake installer records actual started identity, verifies actual JSONL, and never imports Electron', async () => {
  assert.equal(typeof subject.createWindowsAdapter, 'function');
  const installDir = `${root}\\app`;
  const actual = { pid: 42, created: '2026-10-25T00:00:00.000Z', executable: `${root}\\candidate.exe`, ticks: '1234' };
  const event = {
    session: '123456abcdef',
    version: '3.0.0',
    updated: false,
    instDir: installDir,
    event: 'session-end',
    message: 'result=success',
  };
  const calls = [];
  const adapter = subject.createWindowsAdapter(env, {
    platform: 'win32',
    arch: 'x64',
    fsOps: { realpath: async (p) => p, readFile: async () => JSON.stringify(event) },
    powershell: async (action, data, options) => {
      calls.push([action, data]);
      if (action === 'install') {
        options.onRecord({ kind: 'started', record: actual });
        return { exitCode: 0, ...actual };
      }
      if (action === 'cleanup') return { cleaned: data.registry };
      return {};
    },
    loadElectron: () => {
      throw Error('must not load Electron');
    },
  });
  await adapter.ensureOwnedRoot(root);
  const installed = await adapter.install({
    installerPath: actual.executable,
    installDir,
    logPath: `${root}\\installer.jsonl`,
    session: event.session,
    version: event.version,
  });
  assert.deepEqual(installed.events, [event]);
  assert.equal(installed.pid, 42);
  assert.deepEqual(await adapter.cleanup(), [actual]);
  assert.equal(calls.find((c) => c[0] === 'install')[1].childEnv.AIONUI_DISABLE_AUTO_UPDATE, '1');
});

test('cleanup retains started installer identity even if later installer wait fails', async () => {
  assert.equal(typeof subject.createWindowsAdapter, 'function');
  const actual = { pid: 42, created: '2026-10-25T00:00:00.000Z', executable: `${root}\\candidate.exe`, ticks: '1234' };
  let cleaned;
  const adapter = subject.createWindowsAdapter(env, {
    platform: 'win32',
    arch: 'x64',
    fsOps: { realpath: async (p) => p },
    powershell: async (action, data, options) => {
      if (action === 'install') {
        options.onRecord({ kind: 'started', record: actual });
        throw Error('wait failed');
      }
      if (action === 'cleanup') {
        cleaned = data.registry;
        return { cleaned };
      }
      return {};
    },
  });
  await adapter.ensureOwnedRoot(root);
  await assert.rejects(
    adapter.install({
      installerPath: actual.executable,
      installDir: `${root}\\app`,
      logPath: `${root}\\installer.jsonl`,
      session: '123456abcdef',
      version: '3.0.0',
    }),
    /wait failed/
  );
  await adapter.cleanup();
  assert.deepEqual(cleaned, [actual]);
});

test('cleanup still attempts exact owned identities and hosts restoration after snapshot failure', async () => {
  const actual = {
    pid: 42,
    created: '2026-10-25T00:00:00.000Z',
    executable: `${root}\\candidate.exe`,
    ticks: '1234',
    sid: 'S-1-owned',
  };
  const event = {
    session: '123456abcdef',
    version: '3.0.1',
    updated: false,
    instDir: `${root}\\app`,
    event: 'session-end',
    message: 'result=success',
  };
  let cleanupRecords;
  let restored = false;
  const adapter = subject.createWindowsAdapter(env, {
    platform: 'win32',
    arch: 'x64',
    fsOps: { realpath: async (p) => p, readFile: async () => JSON.stringify(event) },
    powershell: async (action, data, options) => {
      if (action === 'install') {
        options.onRecord({ kind: 'started', record: actual });
        return { ...actual, exitCode: 0 };
      }
      if (action === 'snapshot') throw Error('snapshot unavailable');
      if (action === 'cleanup') {
        cleanupRecords = data.registry;
        return { cleaned: data.registry };
      }
      if (action === 'cdn-disable') restored = true;
      return {};
    },
  });
  await adapter.ensureOwnedRoot(root);
  await adapter.enableCdnIsolation();
  await adapter.install({
    installerPath: actual.executable,
    installDir: event.instDir,
    logPath: `${root}\\installer.jsonl`,
    session: event.session,
    version: event.version,
  });
  await assert.rejects(
    adapter.cleanup(),
    (error) => error instanceof AggregateError && error.errors.some((e) => e.message === 'snapshot unavailable')
  );
  assert.deepEqual(cleanupRecords, [actual]);
  assert.equal(restored, true);
});

test('serialized owned cleanup catches each identity failure before continuing and returns all failures', () => {
  const script = planSource(subject.buildPowerShellPlan('cleanup', {}, env));
  const cleanup = script.slice(script.indexOf("  'cleanup' {"), script.indexOf('  default {'));
  assert.match(cleanup, /\$cleanupErrors\s*=\s*@\(\)/);
  assert.match(
    cleanup,
    /catch\s*\{\s*\$cleanupErrors\s*\+=\s*@\{[^}]*pid=\$r\.pid[^}]*error=\$_\.Exception\.Message[^}]*\}/
  );
  assert.match(cleanup, /finally\s*\{[\s\S]*?if\s*\(\$proc\)[\s\S]*?\$proc\.Dispose\(\)/);
  assert.match(cleanup, /Emit\s+@\{kind='result';\s*cleaned=\$cleaned;\s*errors=\$cleanupErrors\}/);
});

test('owned cleanup preserves per-identity failures as terminal errors while still restoring its hosts block', async () => {
  const records = [42, 43].map((pid) => ({
    pid,
    created: '2026-10-25T00:00:00.000Z',
    executable: `${root}\\candidate-${pid}.exe`,
    ticks: String(pid),
    sid: 'S-1-owned',
  }));
  const event = {
    session: '123456abcdef',
    version: '3.0.1',
    updated: false,
    instDir: `${root}\\app`,
    event: 'session-end',
    message: 'result=success',
  };
  let attempted;
  let restored = false;
  const adapter = subject.createWindowsAdapter(env, {
    platform: 'win32',
    arch: 'x64',
    fsOps: { realpath: async (p) => p, readFile: async () => JSON.stringify(event) },
    powershell: async (action, data, options) => {
      if (action === 'install') {
        const record = records.find((r) => r.executable === data.installerPath);
        options.onRecord({ kind: 'started', record });
        return { ...record, exitCode: 0 };
      }
      if (action === 'snapshot') return { processes: [] };
      if (action === 'cleanup') {
        attempted = data.registry;
        return {
          cleaned: [records[0]],
          errors: [{ ...records[1], error: 'fixture identity exited during inspection' }],
        };
      }
      if (action === 'cdn-disable') restored = true;
      return {};
    },
  });
  await adapter.ensureOwnedRoot(root);
  await adapter.enableCdnIsolation();
  for (const record of records)
    await adapter.install({
      installerPath: record.executable,
      installDir: event.instDir,
      logPath: `${root}\\installer-${record.pid}.jsonl`,
      session: event.session,
      version: event.version,
    });
  await assert.rejects(
    adapter.cleanup(),
    (error) =>
      error instanceof AggregateError &&
      error.errors.some((e) => /43/.test(e.message) && /identity exited during inspection/.test(e.message))
  );
  assert.deepEqual(attempted, [...records].reverse());
  assert.equal(restored, true);
});

test('CDN guard uses a deterministic exact owned block and restores only its block', async () => {
  const calls = [];
  const adapter = subject.createWindowsAdapter(env, {
    platform: 'win32',
    arch: 'x64',
    fsOps: { realpath: async (p) => p },
    powershell: async (action, data) => {
      calls.push([action, data]);
      if (action === 'cdn-enable') return { hosts: 'C:\\Windows\\System32\\drivers\\etc\\hosts', enabled: true };
      if (action === 'cleanup') return { cleaned: [] };
      return {};
    },
  });
  await adapter.ensureOwnedRoot(root);
  assert.equal(typeof adapter.enableCdnIsolation, 'function', 'Missing hosted-only CDN isolation');
  await adapter.enableCdnIsolation();
  await adapter.cleanup();
  const add = calls.find((c) => c[0] === 'cdn-enable')[1];
  const remove = calls.find((c) => c[0] === 'cdn-disable')[1];
  assert.equal(add.block, remove.block);
  assert.match(add.block, /0\.0\.0\.0 openh3-legacy-update\.invalid\r\n:: openh3-legacy-update\.invalid/);
  assert.match(add.block, /OPENH3-ACCEPTANCE-[a-f0-9]{16}/);
  const decoded = planSource(subject.buildPowerShellPlan('cdn-enable', add, env));
  assert.match(decoded, /AppendAllText/);
  assert.match(decoded, /Acceptance isolation hosts block was not persisted/);
});

test('failed CDN enable still attempts only its exact block restoration', async () => {
  let restored;
  const adapter = subject.createWindowsAdapter(env, {
    platform: 'win32',
    arch: 'x64',
    fsOps: { realpath: async (p) => p },
    powershell: async (action, data) => {
      if (action === 'cdn-enable') throw Error('helper crashed after possible append');
      if (action === 'cdn-disable') restored = data.block;
      return {};
    },
  });
  await adapter.ensureOwnedRoot(root);
  await assert.rejects(adapter.enableCdnIsolation(), /helper crashed/);
  await adapter.cleanup();
  assert.match(restored ?? '', /OPENH3-ACCEPTANCE-/);
});

test('read-only Authenticode adapter refuses corrupt/unknown status instead of fabricating a signature', async () => {
  let status = 'HashMismatch';
  const adapter = subject.createWindowsAdapter(env, {
    platform: 'win32',
    arch: 'x64',
    fsOps: { realpath: async (p) => p },
    powershell: async (action) => (action === 'signature' ? { status, subject: null, thumbprint: null } : {}),
  });
  await adapter.ensureOwnedRoot(root);
  assert.equal(typeof adapter.inspectSignature, 'function');
  await assert.rejects(adapter.inspectSignature(`${root}\\candidate.exe`), /signature|Authenticode/i);
  status = 'NotSigned';
  assert.equal((await adapter.inspectSignature(`${root}\\candidate.exe`)).status, 'NotSigned');
});

test('fresh profile check refuses any preexisting current or legacy runner profile and never deletes', async () => {
  let exists = false;
  const checked = [];
  const adapter = subject.createWindowsAdapter(env, {
    platform: 'win32',
    arch: 'x64',
    fsOps: {
      realpath: async (p) => p,
      lstat: async (p) => {
        checked.push(p);
        if (!exists) throw Object.assign(Error('missing'), { code: 'ENOENT' });
        return { isDirectory: () => true };
      },
    },
    powershell: async () => ({}),
  });
  await adapter.ensureOwnedRoot(root);
  assert.equal(typeof adapter.assertFreshProductProfile, 'function');
  await adapter.assertFreshProductProfile();
  assert.deepEqual(checked, [`${env.APPDATA}\\OpenH3`, `${env.APPDATA}\\AionUi`]);
  exists = true;
  await assert.rejects(adapter.assertFreshProductProfile(), /preexisting/i);
});

test('launch registers actual evaluated main instead of shell pid and normal quit waits genuine backend exit', async () => {
  const installDir = `${root}\\app`;
  const executable = `${installDir}\\OpenH3.exe`;
  const backendExe = `${installDir}\\resources\\core.exe`;
  const installer = { pid: 40, created: '2026-10-25T00:00:00.000Z', executable: `${root}\\candidate.exe`, ticks: '1' };
  const main = { pid: 50, created: '2026-10-25T00:00:01.000Z', executable, ticks: '2', sid: 'S-1-owned' };
  const media = {
    pid: 52,
    parentPid: main.pid,
    created: '2026-10-25T00:00:03.000Z',
    executable,
    ticks: '4',
    sid: main.sid,
    commandLine: `"${executable}" "${installDir}\\resources\\app.asar.unpacked\\out\\main\\media-service.js"`,
  };
  const backend = {
    pid: 51,
    parentPid: 50,
    created: '2026-10-25T00:00:02.000Z',
    executable: backendExe,
    ticks: '3',
    commandLine: `"${backendExe}" --local --data-dir "${env.APPDATA}\\OpenH3\\OpenH3"`,
  };
  let quitRequested = false;
  let pollsAfterQuit = 0;
  let launchEnv;
  let pythonPlan;
  let cleanupRegistry;
  let visibleChecks = 0;
  let readyChecks = 0;
  let quitCount = 0;
  let finishExitWatch;
  const writes = new Map();
  let auditPath;
  let auditSession;
  const audit = [];
  const packageBytes = Buffer.from('actual fake downloaded installer bytes');
  const order = [];
  const event = {
    session: '123456abcdef',
    version: '3.0.1',
    updated: false,
    instDir: installDir,
    event: 'session-end',
    message: 'result=success',
  };
  const identity = {
    pid: main.pid,
    executable,
    appRoot: `${installDir}\\resources\\app.asar`,
    packaged: true,
    version: '3.0.1',
    userData: `${env.APPDATA}\\OpenH3`,
  };
  const page = {
    waitForFunction: async () => {},
    evaluate: async (_fn, argument) => {
      if (argument?.route) return { test: 'real API result' };
      if (argument?.key) return { success: true };
      if (typeof argument === 'number') return { status: 'ok' };
      if (_fn.toString().includes('childElementCount')) {
        readyChecks++;
        return true;
      }
      return 43123;
    },
  };
  const adapter = subject.createWindowsAdapter(
    { ...env, HTTP_PROXY: 'http://proxy', OPENH3_BACKEND_BIN: 'C:\\foreign.exe' },
    {
      platform: 'win32',
      arch: 'x64',
      sleep: async () => {},
      fsOps: {
        realpath: async (p) => p,
        readFile: async (p) =>
          p === auditPath
            ? audit.map((r) => JSON.stringify(r)).join('\n') + '\n'
            : p.endsWith('update.exe')
              ? packageBytes
              : JSON.stringify(event),
        writeFile: async (p, bytes) => {
          writes.set(p, bytes);
        },
        lstat: async () => {
          throw Object.assign(Error('absent'), { code: 'ENOENT' });
        },
        readdir: async (p) => {
          if (p === `${root}\\nsis-temp`) return [];
          throw Error('Must batch Windows reparse/exe audit, not spawn a helper for every installed file');
        },
      },
      powershell: async (action, data, options) => {
        if (action === 'install') {
          options.onRecord({ kind: 'started', record: installer });
          return { ...installer, exitCode: 0 };
        }
        if (action === 'snapshot') {
          const processes = quitRequested
            ? ++pollsAfterQuit === 1
              ? [backend, media]
              : pollsAfterQuit === 2
                ? [media]
                : []
            : [main, backend, media];
          if (quitRequested && processes.length === 0)
            finishExitWatch?.({
              exits: [
                { ...main, exitCode: 0 },
                { ...backend, exitCode: 0 },
              ],
              completed: true,
            });
          return { processes };
        }
        if (action === 'listeners') return { pids: [51] };
        if (action === 'executables') return { executables: [executable, backendExe] };
        if (action === 'exit-watch') {
          options.onRecord({ kind: 'ready' });
          return new Promise((resolve) => {
            finishExitWatch = resolve;
          });
        }
        if (action === 'cleanup') {
          cleanupRegistry = data.registry;
          return { cleaned: [] };
        }
        return {};
      },
      loadElectron: async () => ({
        launch: async (options) => {
          launchEnv = options.env;
          return {
            process: () => ({ pid: 999, killed: false }),
            close: () => {
              throw Error('Must not force-close to call quit normal');
            },
            firstWindow: async () => {
              order.push('firstWindow');
              return page;
            },
            windows: () => [page],
            browserWindow: async () => ({
              evaluate: async () => {
                visibleChecks++;
                return visibleChecks > 1;
              },
              dispose: async () => {},
            }),
            evaluate: async (fn, arg) => {
              order.push(fn.name);
              if (fn.name === 'installUpdaterFixture') {
                auditPath = arg.auditPath;
                auditSession = arg.auditSession;
                audit.push({
                  schemaVersion: 1,
                  session: auditSession,
                  sequence: 0,
                  at: new Date().toISOString(),
                  pid: 50,
                  executable,
                  kind: 'fixture-installed',
                  appVersion: '3.0.1',
                  delegatedNativeMethod: 'NsisUpdater.doInstall',
                });
                return {
                  pid: 50,
                  executable,
                  appVersion: '3.0.1',
                  syntheticCurrentVersion: '3.0.0',
                  auditPath,
                  auditSession,
                };
              }
              if (fn.name === 'snapshotInstallAudit')
                return {
                  path: auditPath,
                  session: auditSession,
                  wrapperIntact: true,
                  scope: 'this-installed-updater-doInstall-only',
                  records: audit.slice(),
                };
              if (fn.name === 'readDownloadedUpdate')
                return {
                  config: { provider: 'github', owner: 'pigq', repo: 'OpenH3', updaterCacheDirName: 'openh3-updater' },
                  cacheBase: env.LOCALAPPDATA,
                  cacheDir: `${env.LOCALAPPDATA}\\openh3-updater`,
                  pendingDir: `${env.LOCALAPPDATA}\\openh3-updater\\pending`,
                  file: null,
                };
              if (fn.name === 'nativeFixtureCheck') return { isUpdateAvailable: true, version: '3.0.1' };
              if (fn.name === 'snapshotUpdaterEvents') return [{ name: 'update-available' }];
              if (fn.name === 'installedIdentity') return identity;
              if (fn.name === 'ordinaryQuit') {
                quitRequested = true;
                quitCount++;
                audit.push({
                  schemaVersion: 1,
                  session: auditSession,
                  sequence: audit.length,
                  at: new Date().toISOString(),
                  pid: 50,
                  executable,
                  kind: 'fixture-will-quit',
                  wrapperIntact: true,
                });
                audit.push({
                  schemaVersion: 1,
                  session: auditSession,
                  sequence: audit.length,
                  at: new Date().toISOString(),
                  pid: 50,
                  executable,
                  kind: 'fixture-process-exit',
                  exitCode: 0,
                  auditPrefixHealthy: true,
                  wrapperIntact: true,
                  installAttempts: 0,
                });
                return { requested: true };
              }
              throw Error('Unexpected evaluation');
            },
          };
        },
      }),
      runPython: async (plan) => {
        pythonPlan = plan;
        return { quick_check: 'ok' };
      },
    }
  );
  await adapter.ensureOwnedRoot(root);
  await adapter.install({
    installerPath: installer.executable,
    installDir,
    logPath: `${root}\\installer.jsonl`,
    session: event.session,
    version: '3.0.1',
  });
  const launched = await adapter.launchInstalled({
    executablePath: executable,
    mode: 'candidate-updater',
    cwd: root,
    feedUrl: 'http://127.0.0.1:43111/',
  });
  assert.equal(
    order[0],
    'installUpdaterFixture',
    'Real scheduler must be cancelled before other remote evaluation/ready waits'
  );
  assert.ok(order.indexOf('installUpdaterFixture') < order.indexOf('firstWindow'));
  assert.equal(launched.fixtureIdentity.syntheticCurrentVersion, '3.0.0');
  assert.deepEqual(await launched.nativeCheck(), { isUpdateAvailable: true, version: '3.0.1' });
  assert.deepEqual(await launched.updaterEvents(), [{ name: 'update-available' }]);
  assert.deepEqual(await launched.invokeUpdate('auto-update.download.cancel'), { success: true });
  assert.equal(launched.identity.pid, 50);
  assert.equal(launched.backendDataDir, `${env.APPDATA}\\OpenH3\\OpenH3`);
  assert.deepEqual(launched.systemInfo, { test: 'real API result' });
  assert.deepEqual(launched.health, { status: 'ok' });
  assert.equal(visibleChecks, 2, 'Visibility must be waited, not a one-shot race with ready-to-show');
  assert.ok(readyChecks > 0, 'Must prove real nonempty renderer root, not firstWindow alone');
  assert.equal(launchEnv.HTTP_PROXY, undefined);
  assert.equal(launchEnv.OPENH3_BACKEND_BIN, undefined);
  assert.equal(launchEnv.AIONUI_DISABLE_AUTO_UPDATE, undefined);
  assert.equal(launchEnv.GITHUB_ACTIONS, undefined);
  assert.equal(launchEnv.TEMP, `${root}\\nsis-temp`);
  assert.ok(auditPath?.startsWith(`${root}\\evidence\\os\\`));
  assert.match(auditSession, /^[a-f0-9]{24}$/);
  assert.equal(
    typeof launched.startUpdateObservation,
    'function',
    'Stage B requires an explicit fail-closed observation interface'
  );
  const observer = await launched.startUpdateObservation({ expectedInstallerSha256: 'a'.repeat(64) });
  const absence = await observer.proveNoInstaller({ durationMs: 1 });
  assert.equal(absence.complete, true);
  assert.equal(absence.scope, 'this-installed-updater-doInstall-only');
  assert.equal(absence.globalOSProcessAbsenceProven, false);
  assert.deepEqual(absence.installers, []);
  await assert.rejects(observer.prepareHandoff({ expectedInstallerSha256: 'b'.repeat(64) }), /hash|digest/i);
  await assert.rejects(observer.waitForInstaller(), (error) => error.code === 'NOT_COVERED');
  await assert.rejects(observer.waitForRestart(), (error) => error.code === 'NOT_COVERED');
  await assert.rejects(observer.quitRestartNormally(), (error) => error.code === 'NOT_COVERED');
  assert.equal((await launched.quitNormally()).normalExit, true);
  const waitResult = await launched.waitNormallyExited();
  assert.equal(waitResult.normalExit, true);
  assert.deepEqual(
    waitResult.exits.map((e) => e.exitCode),
    [0, 0],
    'Normal exit requires actual retained main/backend handle codes'
  );
  assert.equal(quitCount, 1, 'Wait-only method must not send app.quit again');
  assert.ok(pollsAfterQuit >= 3, 'Backend and same-exe media must really disappear; main exit alone is insufficient');
  const closedAbsence = await observer.proveNoInstaller({ durationMs: 1 });
  assert.equal(closedAbsence.complete, true);
  assert.equal(closedAbsence.audit.records.at(-1).kind, 'fixture-process-exit');
  const terminal = audit.pop();
  await assert.rejects(observer.proveNoInstaller({ durationMs: 1 }), /terminal|process-exit/i);
  audit.push(terminal);
  audit.pop();
  audit.push({
    schemaVersion: 1,
    session: auditSession,
    sequence: audit.length,
    at: new Date().toISOString(),
    pid: 50,
    executable,
    kind: 'do-install-enter',
  });
  audit.push({ ...terminal, sequence: audit.length, installAttempts: 1 });
  await assert.rejects(observer.proveNoInstaller({ durationMs: 1 }), /install attempt/i);
  audit.pop();
  audit.pop();
  audit.push(terminal);
  const observed = await observer.stop();
  assert.equal(observed.globalOSProcessAbsenceProven, false);
  assert.ok(observed.observedProcesses.some((p) => p.pid === main.pid));
  assert.ok(
    [...writes.keys()].some((p) => /updater-observation-.*\.json$/.test(p)),
    'Known gaps and genuine snapshot records must survive in evidence'
  );
  await adapter.sqliteQuickCheck(`${launched.backendDataDir}\\aionui-backend.db`);
  assert.match(pythonPlan.args[2], /mode=ro/);
  assert.match(pythonPlan.args[2], /PRAGMA quick_check/);
  await assert.rejects(adapter.sqliteQuickCheck('C:\\foreign\\aionui-backend.db'), /actual recorded/);
  await adapter.cleanup();
  assert.ok(cleanupRegistry.some((p) => p.pid === 50));
  assert.ok(cleanupRegistry.some((p) => p.pid === 51));
  assert.ok(
    cleanupRegistry.some((p) => p.pid === media.pid),
    'Media child retains its normal-exit and cleanup obligation'
  );
  assert.equal(
    cleanupRegistry.some((p) => p.pid === 999),
    false
  );
});
