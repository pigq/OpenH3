// These callbacks are serialized into the already-installed Electron main process.
// No Electron import, application launch or module-scope side effect is permitted here.
export async function installUpdaterFixture(
  { app, BrowserWindow },
  { expectedInstalledExe, feedUrl, auditPath, auditSession }
) {
  const main = process.mainModule;
  if (
    !app.isPackaged ||
    process.platform !== 'win32' ||
    app.getVersion() !== '3.0.1' ||
    !main?.filename ||
    typeof main.require !== 'function'
  )
    throw Error('Wrong packaged app/CJS context');
  const Module = main.require('node:module');
  const req = Module.createRequire(main.filename);
  const path = req('node:path');
  const appRoot = app.getAppPath();
  const inside = (value) => {
    const relative = path.relative(appRoot, value);
    return !!relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  };
  if (
    !inside(main.filename) ||
    path.resolve(process.execPath).toLowerCase() !== path.resolve(expectedInstalledExe).toLowerCase()
  )
    throw Error('Installed executable/main path mismatch');
  const feed = new URL(feedUrl);
  if (feed.protocol !== 'http:' || feed.hostname !== '127.0.0.1' || !feed.port || feed.username || feed.password)
    throw Error('Only explicit loopback fixture transport is allowed');

  // Preserve the real service initialize/broadcast/backend.stop registration. Cancel
  // only its actual periodic-check disposer; never emit closed or initialize our own service.
  const matches = (fn) => {
    const source = Function.prototype.toString.call(fn);
    return source.length < 240 && /clearTimeout\s*\(/.test(source) && /clearInterval\s*\(/.test(source);
  };
  let disposer;
  let observedRegistration = false;
  const observers = new Map();
  const inspect = (window, fn, registeredNow) => {
    if (!matches(fn)) return;
    if (disposer && disposer.fn !== fn) throw Error('Multiple candidate update scheduler disposers');
    if (!registeredNow && process.uptime() >= 29) throw Error('Cannot prove scheduler did not already run');
    fn();
    disposer = { window, fn };
    observedRegistration = registeredNow;
  };
  let rejectObserved;
  let pollTimer;
  const attach = (window) => {
    const observer = (event, fn) => {
      if (event === 'closed') {
        try {
          inspect(window, fn, true);
        } catch (error) {
          rejectObserved(error);
        }
      }
    };
    observers.set(window, observer);
    window.on('newListener', observer);
    for (const fn of window.listeners('closed')) inspect(window, fn, false);
  };
  const onCreated = (_event, window) => {
    try {
      attach(window);
    } catch (error) {
      rejectObserved(error);
    }
  };
  try {
    await new Promise((resolve, reject) => {
      rejectObserved = reject;
      const deadline = Date.now() + 60_000;
      app.on('browser-window-created', onCreated);
      for (const window of BrowserWindow.getAllWindows()) attach(window);
      const poll = () => {
        if (disposer) return resolve();
        if (Date.now() >= deadline) return reject(Error('Real updater scheduler/initialization was not observed'));
        pollTimer = setTimeout(poll, 25);
      };
      poll();
    });
  } finally {
    clearTimeout(pollTimer);
    app.off('browser-window-created', onCreated);
    for (const [window, observer] of observers) window.off('newListener', observer);
  }

  const updaterId = req.resolve('electron-updater');
  const cached = req.cache[updaterId];
  if (!inside(updaterId) || !cached?.loaded) throw Error('Installed product updater is not already loaded');
  const updater = cached.exports.autoUpdater;
  if (
    updater.constructor.name !== 'NsisUpdater' ||
    updater.autoDownload !== false ||
    updater.autoInstallOnAppQuit !== false ||
    updater.currentVersion.version !== app.getVersion()
  )
    throw Error('Normal production updater initialization mismatch');
  const semverId = Module.createRequire(updaterId).resolve('semver');
  const semver = req.cache[semverId];
  const descriptor = Object.getOwnPropertyDescriptor(updater, 'currentVersion');
  if (
    !inside(semverId) ||
    !semver?.loaded ||
    typeof semver.exports.parse !== 'function' ||
    !descriptor?.configurable ||
    !('value' in descriptor)
  )
    throw Error('Installed updater/semver layout unsupported');
  const syntheticVersion = semver.exports.parse('3.0.0');
  if (!syntheticVersion) throw Error('Invalid synthetic version fixture');
  if (
    typeof auditPath !== 'string' ||
    !/^[a-z]:\\/i.test(auditPath) ||
    /[\r\n"]/.test(auditPath) ||
    !/^[a-f0-9]{24}$/.test(auditSession ?? '')
  )
    throw Error('Explicit isolated audit file/session required');
  const fs = req('node:fs');
  const originalDoInstall = updater.doInstall;
  if (typeof originalDoInstall !== 'function') throw Error('Actual installed NsisUpdater.doInstall is unavailable');
  const fd = fs.openSync(auditPath, 'wx');
  const auditRecords = [];
  let sequence = 0;
  let installAttempts = 0;
  let auditFault;
  const audit = (kind, detail = {}) => {
    const record = {
      schemaVersion: 1,
      session: auditSession,
      sequence: sequence++,
      at: new Date().toISOString(),
      pid: process.pid,
      executable: process.execPath,
      kind,
      ...detail,
    };
    const line = JSON.stringify(record) + '\n';
    // A complete synchronous record is durable before native delegation.
    const written = fs.writeSync(fd, line);
    if (written !== Buffer.byteLength(line)) throw Error('Incomplete install-boundary audit write');
    fs.fsyncSync(fd);
    auditRecords.push(record);
  };
  const tryAudit = (kind, detail) => {
    try {
      audit(kind, typeof detail === 'function' ? detail() : detail);
    } catch (error) {
      auditFault ??= String(error?.message ?? error);
    }
  };
  const auditedDoInstall = function (...args) {
    const options = args[0];
    installAttempts++;
    tryAudit('do-install-enter', () => ({
      installerPath: this.installerPath,
      isSilent: options?.isSilent,
      isForceRunAfter: options?.isForceRunAfter,
      isAdminRightsRequired: options?.isAdminRightsRequired,
    }));
    let result;
    try {
      result = Reflect.apply(originalDoInstall, this, args);
    } catch (error) {
      tryAudit('do-install-throw', { error: String(error?.message ?? error) });
      throw error;
    }
    tryAudit('do-install-return', { result });
    return result;
  };
  Object.defineProperty(updater, 'doInstall', { value: auditedDoInstall, configurable: false, writable: false });
  const auditSnapshot = () => {
    if (updater.doInstall !== auditedDoInstall) throw Error('Real updater install audit wrapper was replaced');
    if (auditFault) throw Error(`Real updater install audit failed: ${auditFault}`);
    return {
      path: auditPath,
      session: auditSession,
      wrapperIntact: true,
      scope: 'this-installed-updater-doInstall-only',
      records: auditRecords.slice(),
    };
  };
  audit('fixture-installed', {
    appVersion: app.getVersion(),
    delegatedNativeMethod: 'NsisUpdater.doInstall',
    originalMethodSource: Function.prototype.toString.call(originalDoInstall),
  });
  app.on('will-quit', () => tryAudit('fixture-will-quit', { wrapperIntact: updater.doInstall === auditedDoInstall }));
  // The final row attests the preceding install-boundary audit prefix. The
  // runner reads this row only after retained OS handles prove exitCode=0;
  // this is not a power-loss durability test of the final fsync itself.
  process.on('exit', (exitCode) =>
    tryAudit('fixture-process-exit', {
      exitCode,
      installAttempts,
      auditPrefixHealthy: !auditFault,
      wrapperIntact: updater.doInstall === auditedDoInstall,
    })
  );
  const events = [];
  for (const name of [
    'checking-for-update',
    'update-available',
    'update-not-available',
    'download-progress',
    'update-downloaded',
    'update-cancelled',
    'error',
  ]) {
    updater.on(name, (value) => {
      events.push({
        at: new Date().toISOString(),
        name,
        version: value?.version,
        percent: value?.percent,
        transferred: value?.transferred,
        code: name === 'error' ? value?.code : undefined,
        error: name === 'error' ? String(value?.message ?? value) : undefined,
      });
      if (events.length > 512) events.shift();
    });
  }
  Object.defineProperty(updater, 'currentVersion', { ...descriptor, value: syntheticVersion });
  updater.setFeedURL({ provider: 'generic', url: feed.href });
  globalThis.__openH3UpdaterFixture = {
    updater,
    descriptor,
    events,
    auditSnapshot,
    nativeInstall: updater.install,
    nativeQuitAndInstall: updater.quitAndInstall,
  };
  return {
    pid: process.pid,
    executable: process.execPath,
    appRoot,
    appVersion: app.getVersion(),
    userData: app.getPath('userData'),
    updaterId,
    semverId,
    auditPath,
    auditSession,
    syntheticCurrentVersion: updater.currentVersion.version,
    observedRegistration,
    schedulerDisposer: Function.prototype.toString.call(disposer.fn),
  };
}

export function snapshotInstallAudit() {
  const fixture = globalThis.__openH3UpdaterFixture;
  if (!fixture?.auditSnapshot) throw Error('Missing real updater install audit');
  return fixture.auditSnapshot();
}

export async function nativeFixtureCheck() {
  const fixture = globalThis.__openH3UpdaterFixture;
  if (!fixture) throw Error('Missing installed runtime fixture');
  const result = await fixture.updater.checkForUpdates();
  return { isUpdateAvailable: result?.isUpdateAvailable, version: result?.updateInfo?.version };
}

export function snapshotUpdaterEvents() {
  const fixture = globalThis.__openH3UpdaterFixture;
  if (!fixture) throw Error('Missing installed runtime fixture');
  return fixture.events.slice();
}

// Keep the downloaded bytes and original helper intact. Only the loaded native
// singleton's in-memory reference is suspended; its original BaseUpdater methods
// must produce the rejection through the normal renderer provider.
export function suspendDownloadedUpdate({ app }) {
  const fixture = globalThis.__openH3UpdaterFixture;
  if (!fixture || !app.isPackaged || app.getVersion() !== '3.0.1' || fixture.suspendedDownload)
    throw Error('Missing/faulted installed download-state fixture');
  const updater = fixture.updater;
  if (
    typeof fixture.nativeInstall !== 'function' ||
    typeof fixture.nativeQuitAndInstall !== 'function' ||
    updater.install !== fixture.nativeInstall ||
    updater.quitAndInstall !== fixture.nativeQuitAndInstall ||
    updater.quitAndInstallCalled !== false
  )
    throw Error('Original loaded BaseUpdater install methods are unavailable or changed');
  const helper = updater.downloadedUpdateHelper;
  if (
    !helper?.file ||
    helper.file !== updater.installerPath ||
    helper.versionInfo?.version !== '3.0.1' ||
    !helper.downloadedFileInfo?.sha512 ||
    helper.packageFile != null ||
    !fixture.events.some((e) => e.name === 'update-downloaded' && e.version === '3.0.1')
  )
    throw Error('A real completed native download is required before suspension');
  const audit = fixture.auditSnapshot();
  if (audit.records.some((r) => /^do-install-|^fixture-(?:will-quit|process-exit)$/.test(r.kind)))
    throw Error('Install/quit was already attempted before download-state suspension');
  fixture.suspendedDownload = { helper, eventStart: fixture.events.length };
  updater.downloadedUpdateHelper = null;
  if (updater.installerPath !== null) throw Error('Original native installerPath did not reflect suspended helper');
  return {
    pid: process.pid,
    executable: process.execPath,
    installerPath: helper.file,
    sha512: helper.downloadedFileInfo.sha512,
    scope: 'original-BaseUpdater-synchronous-missing-download-state',
    nativeInstallSource: Function.prototype.toString.call(fixture.nativeInstall),
  };
}

export function inspectSynchronousHandoffRejection({ app }) {
  const fixture = globalThis.__openH3UpdaterFixture;
  if (!fixture?.suspendedDownload || !app.isPackaged || app.getVersion() !== '3.0.1')
    throw Error('No suspended real native download');
  const updater = fixture.updater;
  const records = fixture.auditSnapshot().records;
  const nativeErrors = fixture.events.slice(fixture.suspendedDownload.eventStart).filter((e) => e.name === 'error');
  if (nativeErrors.length !== 1 || nativeErrors[0].error !== "No update filepath provided, can't quit and install")
    throw Error('Original BaseUpdater native rejection error was not observed');
  const attempts = records.filter((r) => r.kind.startsWith('do-install-'));
  const willQuit = records.some((r) => /^fixture-(?:will-quit|process-exit)$/.test(r.kind));
  if (
    updater.downloadedUpdateHelper !== null ||
    updater.installerPath !== null ||
    updater.install !== fixture.nativeInstall ||
    updater.quitAndInstall !== fixture.nativeQuitAndInstall ||
    updater.quitAndInstallCalled !== false ||
    attempts.length ||
    willQuit
  )
    throw Error('Rejected handoff changed native state, attempted doInstall or quit');
  return {
    pid: process.pid,
    executable: process.execPath,
    installAttempts: 0,
    willQuit: false,
    quitAndInstallCalled: updater.quitAndInstallCalled,
    nativeErrors,
    audit: fixture.auditSnapshot(),
  };
}

export function restoreDownloadedUpdate({ app }) {
  const fixture = globalThis.__openH3UpdaterFixture;
  if (!fixture?.suspendedDownload || !app.isPackaged || app.getVersion() !== '3.0.1')
    throw Error('No suspended real native download to restore');
  const updater = fixture.updater;
  if (updater.downloadedUpdateHelper !== null) throw Error('Suspended native helper was unexpectedly replaced');
  const helper = fixture.suspendedDownload.helper;
  updater.downloadedUpdateHelper = helper;
  if (updater.downloadedUpdateHelper !== helper || updater.installerPath !== helper.file)
    throw Error('Original native downloaded helper was not restored exactly');
  fixture.suspendedDownload = undefined;
  return {
    restored: true,
    file: helper.file,
    sha512: helper.downloadedFileInfo.sha512,
    version: helper.versionInfo.version,
  };
}

// A rejected void provider does not emit subscribe.callback. Observe the actual
// service broadcast instead; a missing callback or deadline can only fail.
export async function invokeInstallAndObserveError(page, timeoutMs = 30_000) {
  return page.evaluate(
    ({ timeoutMs }) => {
      const api = window.electronAPI;
      if (!api?.emit || !api?.on) throw Error('Installed renderer IPC bridge missing');
      const id = `acceptance_refusal_${Date.now()}_${Math.random().toString(16).slice(2)}`;
      return new Promise((resolve, reject) => {
        let off;
        const finish = (error, value) => {
          clearTimeout(timer);
          off?.();
          if (error) reject(error);
          else resolve(value);
        };
        const timer = setTimeout(() => finish(Error('No real auto-update.status error before deadline')), timeoutMs);
        off = api.on((payload) => {
          try {
            const value = typeof payload?.value === 'string' ? JSON.parse(payload.value) : payload?.value;
            if (value?.name === `subscribe.callback-auto-update.quit-and-install${id}`)
              return finish(Error('Rejected install provider unexpectedly returned a success callback'));
            if (value?.name !== 'auto-update.status' || value.data?.status !== 'error') return;
            if (typeof value.data.error !== 'string' || !value.data.error)
              return finish(Error('Real updater error status has no message'));
            finish(null, { evidence: 'real-renderer-auto-update.status', status: value.data, requestId: id });
          } catch (error) {
            finish(error);
          }
        });
        api.emit('subscribe-auto-update.quit-and-install', { id }).catch((error) => finish(error));
      });
    },
    { timeoutMs }
  );
}

export async function readDownloadedUpdate({ app }) {
  const fixture = globalThis.__openH3UpdaterFixture;
  if (!fixture || !app.isPackaged || app.getVersion() !== '3.0.1')
    throw Error('Missing actual installed updater fixture');
  const updater = fixture.updater;
  const req = process.mainModule.require('node:module').createRequire(process.mainModule.filename);
  const path = req('node:path');
  const config = await updater.configOnDisk?.value;
  const name = config?.updaterCacheDirName;
  if (
    typeof name !== 'string' ||
    !name ||
    /[\\/:*?"<>|\r\n]/.test(name) ||
    /[. ]$/.test(name) ||
    name === '.' ||
    name === '..'
  )
    throw Error('Unsupported actual updater cache config');
  const cacheBase = updater.app?.baseCachePath;
  if (typeof cacheBase !== 'string' || !path.isAbsolute(cacheBase)) throw Error('Missing actual updater cache base');
  const cacheDir = path.join(cacheBase, name);
  const helper = updater.downloadedUpdateHelper;
  if (
    helper &&
    (path.resolve(helper.cacheDir) !== path.resolve(cacheDir) ||
      path.resolve(helper.cacheDirForPendingUpdate) !== path.resolve(path.join(cacheDir, 'pending')))
  )
    throw Error('Actual helper cache differs from installed config');
  return {
    appVersion: app.getVersion(),
    config: { provider: config.provider, owner: config.owner, repo: config.repo, updaterCacheDirName: name },
    cacheBase,
    cacheDirName: name,
    cacheDir,
    pendingDir: path.join(cacheDir, 'pending'),
    file: helper?.file ?? null,
    packageFile: helper?.packageFile ?? null,
    version: helper?.versionInfo?.version ?? null,
    sha512: helper?.downloadedFileInfo?.sha512 ?? null,
    isAdminRightsRequired: helper?.downloadedFileInfo?.isAdminRightsRequired ?? null,
  };
}

export function installedIdentity({ app }) {
  return {
    pid: process.pid,
    executable: process.execPath,
    resourcesPath: process.resourcesPath,
    platform: process.platform,
    arch: process.arch,
    appData: app.getPath('appData'),
    cwd: process.cwd(),
    appRoot: app.getAppPath(),
    version: app.getVersion(),
    packaged: app.isPackaged,
    userData: app.getPath('userData'),
  };
}

export function ordinaryQuit({ app }) {
  setImmediate(() => app.quit());
  return { requested: true };
}

export async function invokeProvider(page, key, data, timeoutMs = 30_000) {
  return page.evaluate(
    async ({ key, data, timeoutMs }) => {
      const api = window.electronAPI;
      if (!api?.emit || !api?.on) throw Error('Installed renderer IPC bridge missing');
      const id = `acceptance_${Date.now()}_${Math.random().toString(16).slice(2)}`;
      return new Promise((resolve, reject) => {
        let off;
        const timer = setTimeout(() => {
          off?.();
          reject(Error(`Provider timeout: ${key}`));
        }, timeoutMs);
        off = api.on((payload) => {
          try {
            const value = typeof payload?.value === 'string' ? JSON.parse(payload.value) : payload?.value;
            if (value?.name !== `subscribe.callback-${key}${id}`) return;
            clearTimeout(timer);
            off?.();
            resolve(value.data);
          } catch (error) {
            clearTimeout(timer);
            off?.();
            reject(error);
          }
        });
        api.emit(`subscribe-${key}`, { id, data }).catch((error) => {
          clearTimeout(timer);
          off?.();
          reject(error);
        });
      });
    },
    { key, data, timeoutMs }
  );
}
