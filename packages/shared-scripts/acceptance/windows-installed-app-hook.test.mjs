import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import * as hook from './windows-installed-app-hook.mjs';
const { installUpdaterFixture, nativeFixtureCheck, snapshotUpdaterEvents, invokeProvider } = hook;

function fixture({
  cached = true,
  initialized = true,
  uptime = 1,
  scheduler = true,
  auditIoFailure = false,
  terminalFsyncFailure = false,
} = {}) {
  class NsisUpdater extends EventEmitter {
    constructor() {
      super();
      this.currentVersion = { version: '3.0.1' };
      this.autoDownload = initialized ? false : true;
      this.autoInstallOnAppQuit = false;
    }
    setFeedURL(feed) {
      this.feed = feed;
    }
    async checkForUpdates() {
      this.emit('checking-for-update');
      this.emit('update-available', { version: '3.0.1' });
      return { isUpdateAvailable: true, updateInfo: { version: '3.0.1' } };
    }
    doInstall(options) {
      this.verifyBeforeDelegate?.();
      this.delegated = options;
      if (options.throwFixture) throw Error('real delegate failed');
      return true;
    }
  }
  const root = 'D:\\runner\\app\\resources\\app.asar';
  const executable = 'D:\\runner\\app\\OpenH3.exe';
  const updaterId = root + '\\node_modules\\electron-updater\\out\\main.js';
  const semverId = root + '\\node_modules\\semver\\index.js';
  const updater = new NsisUpdater();
  updater.installerPath = 'D:\\runner\\cache\\pending\\OpenH3-3.0.1-win-x64.exe';
  const auditRecords = [];
  const auditOps = [];
  let syncCount = 0;
  const fs = {
    openSync: (_file, flag) => {
      assert.equal(flag, 'wx');
      auditOps.push('open');
      return 42;
    },
    writeSync: (_fd, text) => {
      auditOps.push('write');
      auditRecords.push(JSON.parse(text));
      return Buffer.byteLength(text);
    },
    fsyncSync: () => {
      auditOps.push('fsync');
      if (
        (auditIoFailure && ++syncCount === 2) ||
        (terminalFsyncFailure && auditRecords.at(-1)?.kind === 'fixture-process-exit')
      )
        throw Error('fixture fsync failed');
    },
  };
  const req = (name) => {
    if (name === 'node:path') return path.win32;
    if (name === 'node:fs') return fs;
    throw Error('Unexpected require: ' + name);
  };
  req.resolve = (name) =>
    name === 'electron-updater'
      ? updaterId
      : name === 'semver'
        ? semverId
        : (() => {
            throw Error('Unexpected resolve');
          })();
  req.cache = {
    [updaterId]: { loaded: cached, exports: { autoUpdater: updater } },
    [semverId]: { loaded: true, exports: { parse: (version) => ({ version }) } },
  };
  const window = new EventEmitter();
  let cleared = 0;
  const startup = setTimeout(() => {}, 600_000);
  startup.unref();
  const interval = undefined;
  if (scheduler)
    window.on('closed', function stopChecks() {
      clearTimeout(startup);
      clearInterval(interval);
    });
  window.on('closed', () => {
    cleared++;
  });
  const app = Object.assign(new EventEmitter(), {
    isPackaged: true,
    getVersion: () => '3.0.1',
    getAppPath: () => root,
    getPath: () => 'D:\\runner\\profile\\OpenH3',
  });
  const pendingTimers = new Set();
  const schedule = (fn, delay) => {
    const timer = setTimeout(() => {
      pendingTimers.delete(timer);
      fn();
    }, delay);
    timer.unref();
    pendingTimers.add(timer);
    return timer;
  };
  const unschedule = (timer) => {
    pendingTimers.delete(timer);
    clearTimeout(timer);
  };
  const mainProcess = Object.assign(new EventEmitter(), {
    platform: 'win32',
    execPath: executable,
    pid: 123,
    uptime: () => uptime,
    mainModule: {
      filename: root + '\\out\\main\\index.js',
      require: (name) => {
        assert.equal(name, 'node:module');
        return { createRequire: () => req };
      },
    },
  });
  const context = vm.createContext({
    URL,
    Map,
    Date,
    Buffer,
    setTimeout: schedule,
    clearTimeout: unschedule,
    setImmediate,
    process: mainProcess,
  });
  return {
    updater,
    context,
    mainProcess,
    app,
    window,
    pendingTimers,
    auditRecords,
    auditOps,
    auditPath: 'D:\\runner\\updater-audit.jsonl',
    auditSession: '012345abcdef012345abcdef',
    BrowserWindow: { getAllWindows: () => [window] },
    executable,
    get cleared() {
      return cleared;
    },
  };
}

test('installed doInstall instrumentation fsyncs an attempt before delegating the unchanged real call', async () => {
  const f = fixture();
  const setup = vm.runInContext(`(${installUpdaterFixture.toString()})`, f.context);
  await setup(
    { app: f.app, BrowserWindow: f.BrowserWindow },
    {
      expectedInstalledExe: f.executable,
      feedUrl: 'http://127.0.0.1:43111/',
      auditPath: f.auditPath,
      auditSession: f.auditSession,
    }
  );
  assert.equal(f.auditRecords[0]?.kind, 'fixture-installed');
  assert.equal(f.auditRecords.filter((r) => r.kind === 'do-install-enter').length, 0);
  const options = { isSilent: true, isForceRunAfter: true, isAdminRightsRequired: false };
  f.updater.verifyBeforeDelegate = () => {
    assert.equal(f.auditRecords.at(-1).kind, 'do-install-enter');
    assert.equal(f.auditOps.at(-1), 'fsync');
  };
  assert.equal(f.updater.doInstall(options), true);
  assert.equal(f.updater.delegated, options, 'Do not clone/replace real install options');
  assert.equal(f.auditRecords.at(-2).kind, 'do-install-enter');
  assert.equal(f.auditRecords.at(-2).installerPath, f.updater.installerPath);
  assert.equal(f.auditRecords.at(-1).kind, 'do-install-return');
  assert.equal(f.auditRecords.at(-1).result, true);
  assert.equal(f.auditOps.at(-1), 'fsync');
  assert.throws(() => f.updater.doInstall({ throwFixture: true }), /real delegate failed/);
  assert.equal(f.auditRecords.at(-1).kind, 'do-install-throw');
  f.app.emit('will-quit');
  f.mainProcess.emit('exit', 0);
  assert.equal(f.auditRecords.at(-1).kind, 'fixture-process-exit');
  assert.equal(f.auditRecords.at(-1).installAttempts, 2);
  assert.equal(f.auditRecords.at(-1).auditPrefixHealthy, true);
});

test('audit I/O failure invalidates evidence but never replaces actual native return or throw', async () => {
  const f = fixture({ auditIoFailure: true });
  const setup = vm.runInContext(`(${installUpdaterFixture.toString()})`, f.context);
  await setup(
    { app: f.app, BrowserWindow: f.BrowserWindow },
    {
      expectedInstalledExe: f.executable,
      feedUrl: 'http://127.0.0.1:43111/',
      auditPath: f.auditPath,
      auditSession: f.auditSession,
    }
  );
  const options = { isSilent: true };
  assert.equal(f.updater.doInstall(options), true);
  assert.equal(f.updater.delegated, options);
  const snapshot = vm.runInContext(`(${hook.snapshotInstallAudit.toString()})`, f.context);
  assert.throws(() => snapshot(), /audit.*fail|fsync/i);
  assert.throws(() => f.updater.doInstall({ throwFixture: true }), /real delegate failed/);
  f.mainProcess.emit('exit', 0);
  assert.equal(f.auditRecords.at(-1).auditPrefixHealthy, false);
});

test('readable final row attests the preceding audit prefix, not power-loss durability of its own fsync', async () => {
  const f = fixture({ terminalFsyncFailure: true });
  const setup = vm.runInContext(`(${installUpdaterFixture.toString()})`, f.context);
  await setup(
    { app: f.app, BrowserWindow: f.BrowserWindow },
    {
      expectedInstalledExe: f.executable,
      feedUrl: 'http://127.0.0.1:43111/',
      auditPath: f.auditPath,
      auditSession: f.auditSession,
    }
  );
  f.app.emit('will-quit');
  f.mainProcess.emit('exit', 0);
  const final = f.auditRecords.at(-1);
  assert.equal(final.kind, 'fixture-process-exit');
  assert.equal(final.auditPrefixHealthy, true);
  assert.equal(final.installAttempts, 0);
  assert.deepEqual(
    f.auditRecords.map((r) => r.sequence),
    [0, 1, 2]
  );
});

test('serialized setup uses cached installed singleton, preserves disk version and other window listeners', async () => {
  const f = fixture();
  const setup = vm.runInContext(`(${installUpdaterFixture.toString()})`, f.context);
  const result = await setup(
    { app: f.app, BrowserWindow: f.BrowserWindow },
    {
      expectedInstalledExe: f.executable,
      feedUrl: 'http://127.0.0.1:43111/',
      auditPath: f.auditPath,
      auditSession: f.auditSession,
    }
  );
  assert.equal(result.appVersion, '3.0.1');
  assert.equal(result.syntheticCurrentVersion, '3.0.0');
  assert.equal(f.app.getVersion(), '3.0.1');
  assert.equal(f.cleared, 0);
  assert.equal(f.updater.feed.provider, 'generic');
  const check = vm.runInContext(`(${nativeFixtureCheck.toString()})`, f.context);
  assert.deepEqual(JSON.parse(JSON.stringify(await check())), { isUpdateAvailable: true, version: '3.0.1' });
  const snapshot = vm.runInContext(`(${snapshotUpdaterEvents.toString()})`, f.context);
  assert.equal(snapshot().at(-1).name, 'update-available');
  f.updater.emit('error', Object.assign(Error('native checksum failed'), { code: 'ERR_CHECKSUM_MISMATCH' }));
  assert.equal(snapshot().at(-1).code, 'ERR_CHECKSUM_MISMATCH');
});

test('setup fails closed for wrong executable, late timer and unavailable installed cache', async () => {
  for (const options of [{ cached: false }, { initialized: false }, { uptime: 31 }, { wrongExe: true }]) {
    const f = fixture(options);
    const setup = vm.runInContext(`(${installUpdaterFixture.toString()})`, f.context);
    await assert.rejects(
      setup(
        { app: f.app, BrowserWindow: f.BrowserWindow },
        {
          expectedInstalledExe: options.wrongExe ? 'C:\\Users\\real\\OpenH3.exe' : f.executable,
          feedUrl: 'http://127.0.0.1:43111/',
          auditPath: f.auditPath,
          auditSession: f.auditSession,
        }
      )
    );
  }
});

test('setup never accepts a remote or HTTPS bypass fixture', async () => {
  const f = fixture();
  const setup = vm.runInContext(`(${installUpdaterFixture.toString()})`, f.context);
  await assert.rejects(
    setup(
      { app: f.app, BrowserWindow: f.BrowserWindow },
      { expectedInstalledExe: f.executable, feedUrl: 'https://example.com/' }
    )
  );
});

test('late registration errors clean the observer and outstanding polling timer', async () => {
  const f = fixture({ scheduler: false });
  const setup = vm.runInContext(`(${installUpdaterFixture.toString()})`, f.context);
  const pending = setup(
    { app: f.app, BrowserWindow: f.BrowserWindow },
    {
      expectedInstalledExe: f.executable,
      feedUrl: 'http://127.0.0.1:43111/',
      auditPath: f.auditPath,
      auditSession: f.auditSession,
    }
  );
  f.window.on('closed', function first() {
    clearTimeout(undefined);
    clearInterval(undefined);
  });
  f.window.on('closed', function second() {
    clearTimeout(undefined);
    clearInterval(undefined);
  });
  await assert.rejects(pending, /Multiple candidate/);
  assert.equal(f.pendingTimers.size, 0);
  assert.equal(f.window.listenerCount('newListener'), 0);
  assert.equal(f.app.listenerCount('browser-window-created'), 0);
});

test('real subscribe/callback adapter deterministically cleans listeners on response, malformed payload and timeout', async () => {
  let listener,
    malformed = false,
    offCount = 0,
    uncaught;
  const timers = new Map();
  const responses = [];
  let timerId = 0;
  const context = vm.createContext({
    Date,
    Math,
    JSON,
    Promise,
    setTimeout: (callback, duration) => {
      assert.equal(duration, 100);
      timers.set(++timerId, callback);
      return timerId;
    },
    clearTimeout: (id) => timers.delete(id),
    window: {
      electronAPI: {
        on: (fn) => {
          listener = fn;
          return () => {
            offCount++;
          };
        },
        emit: async (name, data) => {
          assert.equal(name, 'subscribe-auto-update.download.cancel');
          responses.push(() => {
            try {
              listener({
                value: malformed
                  ? '{invalid-json'
                  : JSON.stringify({
                      name: `subscribe.callback-auto-update.download.cancel${data.id}`,
                      data: { success: true },
                    }),
              });
            } catch (error) {
              uncaught = error;
            }
          });
        },
      },
    },
  });
  const page = { evaluate: (fn, argument) => vm.runInContext(`(${fn.toString()})`, context)(argument) };
  const valid = invokeProvider(page, 'auto-update.download.cancel', undefined, 100);
  assert.equal(timers.size, 1);
  responses.shift()();
  assert.deepEqual(JSON.parse(JSON.stringify(await valid)), { success: true });
  assert.equal(offCount, 1);
  assert.equal(timers.size, 0);
  malformed = true;
  const invalid = assert.rejects(invokeProvider(page, 'auto-update.download.cancel', undefined, 100), /JSON/);
  responses.shift()();
  await invalid;
  assert.equal(uncaught, undefined);
  assert.equal(offCount, 2);
  assert.equal(timers.size, 0);
  const timedOut = assert.rejects(
    invokeProvider(page, 'auto-update.download.cancel', undefined, 100),
    /Provider timeout: auto-update.download.cancel/
  );
  const [id, expire] = [...timers][0];
  timers.delete(id);
  expire();
  await timedOut;
  assert.equal(offCount, 3);
  assert.equal(timers.size, 0);
});

test('serialized download identity reads actual installed helper and on-disk cache config without creating helper', async () => {
  assert.equal(typeof hook.readDownloadedUpdate, 'function');
  const f = fixture();
  const setup = vm.runInContext(`(${installUpdaterFixture.toString()})`, f.context);
  await setup(
    { app: f.app, BrowserWindow: f.BrowserWindow },
    {
      expectedInstalledExe: f.executable,
      feedUrl: 'http://127.0.0.1:43111/',
      auditPath: f.auditPath,
      auditSession: f.auditSession,
    }
  );
  f.updater.app = { baseCachePath: 'C:\\Users\\runner\\AppData\\Local' };
  f.updater.configOnDisk = {
    value: Promise.resolve({
      provider: 'github',
      owner: 'pigq',
      repo: 'OpenH3',
      updaterCacheDirName: 'openh3-updater',
    }),
  };
  f.updater.downloadedUpdateHelper = null;
  const read = vm.runInContext(`(${hook.readDownloadedUpdate.toString()})`, f.context);
  const empty = await read({ app: f.app });
  assert.equal(empty.file, null);
  assert.deepEqual(JSON.parse(JSON.stringify(empty.config)), {
    provider: 'github',
    owner: 'pigq',
    repo: 'OpenH3',
    updaterCacheDirName: 'openh3-updater',
  });
  assert.equal(empty.cacheDir, 'C:\\Users\\runner\\AppData\\Local\\openh3-updater');
  assert.equal(f.updater.downloadedUpdateHelper, null, 'Must not call getOrCreateDownloadHelper');
  f.updater.downloadedUpdateHelper = {
    cacheDir: empty.cacheDir,
    cacheDirForPendingUpdate: `${empty.cacheDir}\\pending`,
    file: `${empty.cacheDir}\\pending\\OpenH3-3.0.1-win-x64.exe`,
    packageFile: null,
    versionInfo: { version: '3.0.1' },
    downloadedFileInfo: { sha512: 'real-digest', isAdminRightsRequired: false },
  };
  const actual = await read({ app: f.app });
  assert.equal(actual.file, f.updater.downloadedUpdateHelper.file);
  assert.equal(actual.version, '3.0.1');
  assert.equal(actual.sha512, 'real-digest');
  f.updater.configOnDisk.value = Promise.resolve({ updaterCacheDirName: '..\\escape' });
  await assert.rejects(read({ app: f.app }), /cache/i);
});

test('serialized missing-download fixture exercises the original BaseUpdater rejection and restores the exact helper', async () => {
  for (const name of ['suspendDownloadedUpdate', 'inspectSynchronousHandoffRejection', 'restoreDownloadedUpdate'])
    assert.equal(typeof hook[name], 'function', `Missing ${name}`);
  const f = fixture();
  // Evaluate the installed dependency's actual BaseUpdater methods with inert
  // AppUpdater/Electron seams. No child process or application is started.
  const require = createRequire(import.meta.url);
  const baseExports = {};
  let nativeQuit = 0;
  vm.runInNewContext(readFileSync(require.resolve('electron-updater/out/BaseUpdater.js'), 'utf8'), {
    exports: baseExports,
    setImmediate,
    require: (name) => {
      if (name === 'child_process') return {};
      if (name === './AppUpdater') return { AppUpdater: EventEmitter };
      if (name === 'electron') return { autoUpdater: { emit() {} } };
      throw Error('Unexpected native dependency: ' + name);
    },
  });
  const base = baseExports.BaseUpdater.prototype;
  const helper = {
    file: 'D:\\runner\\cache\\pending\\OpenH3-3.0.1-win-x64.exe',
    packageFile: null,
    versionInfo: { version: '3.0.1' },
    downloadedFileInfo: { sha512: 'actual-sha512', isAdminRightsRequired: false },
  };
  Object.defineProperty(f.updater, 'installerPath', {
    configurable: true,
    get: base.__lookupGetter__('installerPath'),
  });
  Object.assign(f.updater, {
    downloadedUpdateHelper: helper,
    quitAndInstallCalled: false,
    install: base.install,
    quitAndInstall: base.quitAndInstall,
    dispatchError(error) {
      this.emit('error', error);
    },
    _logger: { info() {}, warn() {} },
    app: {
      quit() {
        nativeQuit++;
      },
    },
  });
  const setup = vm.runInContext(`(${installUpdaterFixture.toString()})`, f.context);
  await setup(
    { app: f.app, BrowserWindow: f.BrowserWindow },
    {
      expectedInstalledExe: f.executable,
      feedUrl: 'http://127.0.0.1:43111/',
      auditPath: f.auditPath,
      auditSession: f.auditSession,
    }
  );
  f.updater.emit('update-downloaded', { version: '3.0.1' });
  const suspend = vm.runInContext(`(${hook.suspendDownloadedUpdate.toString()})`, f.context);
  const inspect = vm.runInContext(`(${hook.inspectSynchronousHandoffRejection.toString()})`, f.context);
  const restore = vm.runInContext(`(${hook.restoreDownloadedUpdate.toString()})`, f.context);
  const suspended = suspend({ app: f.app });
  assert.equal(suspended.installerPath, helper.file);
  assert.equal(f.updater.downloadedUpdateHelper, null);
  assert.throws(() => inspect({ app: f.app }), /native.*rejection|native.*error/i);
  f.updater.quitAndInstall(true, true);
  const rejected = inspect({ app: f.app });
  assert.equal(rejected.pid, 123);
  assert.equal(rejected.installAttempts, 0);
  assert.equal(rejected.willQuit, false);
  assert.match(rejected.nativeErrors[0].error, /No update filepath provided/);
  assert.equal(f.updater.quitAndInstallCalled, false);
  assert.equal(nativeQuit, 0);
  assert.equal(restore({ app: f.app }).restored, true);
  assert.equal(f.updater.downloadedUpdateHelper, helper, 'Do not clone or regenerate the actual downloaded helper');
  f.updater.quitAndInstall(true, true);
  await new Promise(setImmediate);
  assert.equal(nativeQuit, 1);
  assert.equal(f.auditRecords.filter((r) => r.kind === 'do-install-enter').length, 1);
});

test('real renderer install refusal is proven by an error status, never a missing callback or timeout', async () => {
  assert.equal(typeof hook.invokeInstallAndObserveError, 'function');
  for (const mode of ['status', 'timeout', 'callback']) {
    let listener;
    let offCount = 0;
    const page = {
      evaluate: (fn, argument) =>
        vm.runInNewContext(`(${fn.toString()})`, {
          Date,
          Math,
          JSON,
          Promise,
          setTimeout,
          clearTimeout,
          window: {
            electronAPI: {
              on(fn) {
                listener = fn;
                return () => {
                  offCount++;
                };
              },
              async emit(name, data) {
                assert.equal(name, 'subscribe-auto-update.quit-and-install');
                if (mode === 'timeout') return;
                listener({
                  value: JSON.stringify(
                    mode === 'status'
                      ? { name: 'auto-update.status', data: { status: 'error', error: 'native refused' } }
                      : { name: `subscribe.callback-auto-update.quit-and-install${data.id}` }
                  ),
                });
              },
            },
          },
        })(argument),
    };
    if (mode === 'status') {
      const result = await hook.invokeInstallAndObserveError(page, 25);
      assert.equal(result.status.status, 'error');
      assert.equal(result.evidence, 'real-renderer-auto-update.status');
    } else await assert.rejects(hook.invokeInstallAndObserveError(page, 25), /status|callback/i);
    assert.equal(offCount, 1);
  }
});
