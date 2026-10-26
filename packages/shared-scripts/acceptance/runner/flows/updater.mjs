// Real installed updater orchestration; all OS actions are supplied by the
// hosted-only adapter. Injected tests are never eligible for the evidence gate.
import assert from 'node:assert/strict';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { assertInstallerSuccess } from '../../windows-upgrade-contract.mjs';
import { seedInstalledProfile, verifyInstalledProfile } from '../../windows-installed-seed.mjs';
import { createFixtureFeed } from '../../windows-update-fixture-server.mjs';
import { digest } from '../artifacts.mjs';

async function waitEvent(app, predicate, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const events = await app.updaterEvents();
    const event = events.find(predicate);
    if (event) return { event, events };
    assert.ok(!events.some((e) => e.name === 'error'), 'Unexpected native updater error while waiting');
    if (Date.now() >= deadline) throw Error('Native updater event deadline exceeded');
    await sleep(100);
  }
}
function assertIdentity(app, expectedExe, prior) {
  const identity = app.identity;
  assert.equal(identity.packaged, true);
  assert.equal(identity.version, '3.0.1');
  assert.equal(identity.platform, 'win32');
  assert.equal(identity.arch, 'x64');
  assert.equal(
    path.win32.normalize(identity.executable).toLowerCase(),
    path.win32.normalize(expectedExe).toLowerCase()
  );
  if (prior) {
    assert.equal(identity.userData, prior.identity.userData, 'Relaunch changed actual userData');
    assert.equal(app.backendDataDir, prior.backendDataDir, 'Relaunch changed actual backend data directory');
  }
}

export async function runUpdaterScenario(config, io, services = {}) {
  const { scenario, root, evidenceDir, installerPath, installerBytes, manifestBytes, context, repoRoot } = config;
  assert.ok(['cancel', 'disconnect', 'corrupt', 'downloaded-quit', 'install'].includes(scenario));
  const installDir = path.win32.join(root, 'app');
  const cwd = path.win32.join(root, 'control');
  const workspaceDir = path.win32.join(root, 'user-workspace');
  const modelsDir = path.win32.join(root, 'user-models');
  for (const directory of [cwd, workspaceDir, modelsDir]) await io.ensureOwnedDirectory(directory);
  const marker = `updater-${context.runId}-${context.runAttempt}-${scenario}-中文`;
  const userFiles = [
    [path.win32.join(workspaceDir, 'upgrade-user-file.txt'), `User workspace sentinel ${marker}\n`],
    [
      path.win32.join(modelsDir, 'user-owned-NOT-A-VALID-MODEL.marker'),
      `NOT valid model weights; no inference. ${marker}\n`,
    ],
  ];
  for (const [file, bytes] of userFiles) await io.writeFile(file, Buffer.from(bytes));
  const snapshot = async () =>
    Promise.all(userFiles.map(async ([file]) => ({ path: file, sha256: digest(await io.readFile(file)) })));
  const beforeFiles = await snapshot();
  const session = randomBytes(6).toString('hex');
  const installed = await io.install({
    installerPath,
    installDir,
    logPath: path.win32.join(evidenceDir, 'installer-candidate-baseline.jsonl'),
    session,
    version: '3.0.1',
  });
  assert.equal(installed.exitCode, 0);
  assertInstallerSuccess(installed.events, { session, version: '3.0.1', updated: false, installDir });
  const feed = await (services.createFeed ?? createFixtureFeed)({
    manifestText: manifestBytes.toString('utf8'),
    installerBytes,
    fileName: 'OpenH3-3.0.1-win-x64.exe',
    mode: scenario === 'cancel' ? 'slow' : ['disconnect', 'corrupt'].includes(scenario) ? scenario : 'normal',
  });
  let observer;
  let app;
  let failure;
  let cleanupError;
  const evidence = {
    status: 'NOT-COVERED',
    fixture: {
      installedVersion: '3.0.1',
      syntheticCurrentVersion: '3.0.0',
      payloadVersion: '3.0.1',
      officialOldUpdaterTested: false,
      serviceStrictGreaterThanOrUiDiscoveryTested: false,
    },
    installed,
  };
  try {
    const exe = path.win32.join(installDir, 'OpenH3.exe');
    app = await io.launchInstalled({ executablePath: exe, mode: 'candidate-updater', cwd, feedUrl: feed.url });
    assertIdentity(app, exe);
    assert.equal(app.fixtureIdentity?.appVersion, '3.0.1');
    assert.equal(app.fixtureIdentity.syntheticCurrentVersion, '3.0.0');
    evidence.fixture.runtime = app.fixtureIdentity;
    evidence.resources = await services.resourceAudit(app.identity, repoRoot);
    const seed = services.seed ?? seedInstalledProfile;
    const verify = services.verify ?? verifyInstalledProfile;
    observer = await app.startUpdateObservation({ expectedInstallerSha256: digest(installerBytes) });
    const baseline = await seed({ request: app.request, marker, workspaceDir });
    evidence.baseline = baseline;
    evidence.identity = app.identity;
    evidence.backendDataDir = app.backendDataDir;
    const nativeCheck = await app.nativeCheck();
    assert.equal(nativeCheck.isUpdateAvailable, true);
    assert.equal(nativeCheck.version, '3.0.1');
    evidence.nativeCheck = nativeCheck;
    // Attach a rejection handler immediately; cancellation/download IPC resolves
    // independently and must not produce an unhandled promise rejection.
    const downloading = app.invokeUpdate('auto-update.download', undefined, 600_000).then(
      (value) => ({ value }),
      (error) => ({ error: String(error?.message ?? error) })
    );
    if (scenario === 'cancel') {
      evidence.progress = (
        await waitEvent(app, (e) => e.name === 'download-progress' && Number(e.transferred) > 0)
      ).event;
      assert.equal((await app.invokeUpdate('auto-update.download.cancel')).success, true);
      const download = await downloading;
      assert.equal(download.error, undefined);
      assert.equal(download.value?.success, true);
      await waitEvent(app, (e) => e.name === 'update-cancelled');
      evidence.downloadResult = download.value;
    } else {
      const download = await downloading;
      assert.equal(download.error, undefined, 'Download IPC itself failed instead of returning real provider result');
      evidence.downloadResult = download.value;
      if (['disconnect', 'corrupt'].includes(scenario)) {
        assert.equal(download.value?.success, false, 'Corrupt/disconnected payload must not download successfully');
        const events = await app.updaterEvents();
        const errors = events.filter((e) => e.name === 'error');
        const transfers = feed.requests.filter((r) => r.pathname === '/OpenH3-3.0.1-win-x64.exe');
        if (scenario === 'corrupt') {
          assert.ok(
            errors.some((e) => e.code === 'ERR_CHECKSUM_MISMATCH' || /sha512 checksum mismatch/i.test(e.error ?? '')),
            'Corrupt scenario requires actual SHA512 checksum rejection, not another error'
          );
          assert.ok(
            transfers.some(
              (r) =>
                r.mode === 'corrupt' && r.finished === true && r.bytesWritten === r.payloadSize && r.payloadSize > 0
            ),
            'No complete corrupted payload response'
          );
        } else {
          assert.ok(
            errors.some(
              (e) =>
                /ERR_(?:CONNECTION_(?:CLOSED|RESET)|INCOMPLETE_CHUNKED_ENCODING|CONTENT_LENGTH_MISMATCH)|ECONNRESET/.test(
                  e.code ?? ''
                ) ||
                /aborted by the server|net::ERR_(?:CONNECTION_(?:CLOSED|RESET)|CONTENT_LENGTH_MISMATCH)|socket hang up|premature close/i.test(
                  e.error ?? ''
                )
            ),
            'Disconnect scenario requires actual transport-abort error'
          );
          assert.ok(
            transfers.some(
              (r) =>
                r.mode === 'disconnect' &&
                r.disconnected === true &&
                r.finished === false &&
                r.bytesWritten > 0 &&
                r.bytesWritten < r.payloadSize
            ),
            'No intentionally aborted partial payload response'
          );
        }
      } else {
        assert.equal(download.value?.success, true);
        await waitEvent(app, (e) => e.name === 'update-downloaded', 600_000);
      }
    }
    evidence.events = await app.updaterEvents();
    if (['cancel', 'disconnect', 'corrupt'].includes(scenario))
      assert.equal(
        evidence.events.some((e) => e.name === 'update-downloaded'),
        false,
        'Failed/cancelled transfer became downloaded'
      );
    assert.ok(
      feed.requests.some((r) => r.pathname === '/latest.yml'),
      'No real native manifest request'
    );
    assert.ok(
      feed.requests.some((r) => r.pathname === '/OpenH3-3.0.1-win-x64.exe'),
      'No real native package request'
    );
    evidence.runningSeed = await verify({ request: app.request, baseline });
    if (scenario === 'install') {
      // This method must prove the actual updater cache, installer child chain,
      // NSIS JSONL success and automatic restart, never Start-Process a payload.
      assert.equal(typeof observer.prepareHandoff, 'function', 'Missing real handoff observer');
      await observer.prepareHandoff({ expectedInstallerSha256: digest(installerBytes) });
      // Retain the real main/backend handles before normal pre-install cleanup
      // stops the backend. The first request must reject in the original native
      // BaseUpdater; its restored helper is then retried by the same real IPC.
      evidence.synchronousHandoffFailure = await app.exerciseSynchronousHandoffRejection({
        expectedInstallerSha256: digest(installerBytes),
      });
      const refusal = evidence.synchronousHandoffFailure;
      assert.equal(refusal.scope, 'original-BaseUpdater-synchronous-missing-download-state');
      assert.equal(refusal.renderer?.evidence, 'real-renderer-auto-update.status');
      assert.equal(refusal.renderer.status?.status, 'error');
      assert.equal(refusal.native?.pid, app.identity.pid);
      assert.equal(refusal.native.installAttempts, 0);
      assert.equal(refusal.native.willQuit, false);
      assert.ok(
        refusal.native.nativeErrors?.some((e) => e.error === "No update filepath provided, can't quit and install")
      );
      assert.equal(refusal.sameMainAlive, true);
      assert.equal(refusal.restored?.restored, true);
      assert.equal(refusal.restored.sha256, digest(installerBytes));
      evidence.afterRejectedHandoff = await observer.proveNoInstaller({ durationMs: 1_500 });
      assert.equal(evidence.afterRejectedHandoff.complete, true);
      assert.deepEqual(evidence.afterRejectedHandoff.installers, [], 'Rejected handoff attempted an installer');
      const callback = app.invokeUpdate('auto-update.quit-and-install', undefined, 30_000).then(
        (value) => ({ value }),
        (error) => ({ disconnected: String(error?.message ?? error) })
      );
      evidence.installerHandoff = await observer.waitForInstaller();
      assert.equal(evidence.installerHandoff.complete, true, 'Incomplete process-start observation');
      assert.equal(evidence.installerHandoff.exitCode, 0, 'Real updater installer did not exit successfully');
      assertInstallerSuccess(evidence.installerHandoff.events, {
        session: evidence.installerHandoff.session,
        version: '3.0.1',
        updated: true,
        installDir,
      });
      evidence.oldExit = await app.waitNormallyExited();
      assert.equal(evidence.oldExit.normalExit, true);
      evidence.automaticRestart = await observer.waitForRestart();
      assert.equal(evidence.automaticRestart.observedAutomaticRestart, true);
      evidence.handoffCallback = await callback;
      // The real automatic restart is observed separately. Closing it normally
      // is required before an independently controlled Playwright relaunch.
      evidence.automaticRestartExit = await observer.quitRestartNormally();
      assert.equal(evidence.automaticRestartExit.normalExit, true);
    } else {
      evidence.beforeQuit = await observer.proveNoInstaller({ durationMs: 2_000 });
      assert.equal(evidence.beforeQuit.complete, true);
      assert.deepEqual(evidence.beforeQuit.installers, [], 'Unexpected installer during download/exit scenario');
      evidence.ordinaryExit = await app.quitNormally();
      assert.equal(evidence.ordinaryExit.normalExit, true);
      evidence.afterOrdinaryQuit = await observer.proveNoInstaller({ durationMs: 5_000 });
      assert.equal(evidence.afterOrdinaryQuit.complete, true);
      assert.deepEqual(evidence.afterOrdinaryQuit.installers, [], 'Ordinary quit triggered an installer');
    }
    evidence.closedDb = await io.sqliteQuickCheck(path.win32.join(app.backendDataDir, 'aionui-backend.db'));
    assert.equal(evidence.closedDb.quick_check, 'ok');
    const relaunched = await io.launchInstalled({ executablePath: exe, mode: 'candidate-manual', cwd });
    assertIdentity(relaunched, exe, app);
    evidence.controlledRelaunch = {
      identity: relaunched.identity,
      persisted: await verify({ request: relaunched.request, baseline }),
      resources: await services.resourceAudit(relaunched.identity, repoRoot),
    };
    evidence.controlledRelaunch.exit = await relaunched.quitNormally();
    assert.equal(evidence.controlledRelaunch.exit.normalExit, true);
    evidence.relaunchDb = await io.sqliteQuickCheck(path.win32.join(relaunched.backendDataDir, 'aionui-backend.db'));
    assert.equal(evidence.relaunchDb.quick_check, 'ok');
    const afterFiles = await snapshot();
    assert.deepEqual(afterFiles, beforeFiles, 'User workspace/model sentinel changed');
    evidence.userFiles = { before: beforeFiles, after: afterFiles, validModelOrInferenceTested: false };
    evidence.status = 'PASS';
  } catch (error) {
    failure = error;
    evidence.status = error.code === 'NOT_COVERED' ? 'NOT-COVERED' : 'FAIL';
    evidence.error = error.message;
  } finally {
    // Capture events before the watcher/feed close, then save the final result
    // only after cleanup. A teardown failure must not leave a PASS side report.
    try {
      evidence.requests = [...feed.requests];
      if (app) {
        try {
          evidence.events = await app.updaterEvents();
        } catch {
          /* process may have normally exited */
        }
      }
    } finally {
      try {
        await observer?.stop();
      } catch (error) {
        cleanupError = error;
      }
      try {
        await feed.close();
      } catch (error) {
        cleanupError ??= error;
      }
      if (cleanupError) {
        evidence.status = 'FAIL';
        evidence.cleanupError = cleanupError.message;
      }
      await io.writeJson(path.win32.join(evidenceDir, 'updater.json'), evidence);
    }
  }
  if (cleanupError) throw cleanupError;
  if (failure) throw failure;
  return evidence;
}
