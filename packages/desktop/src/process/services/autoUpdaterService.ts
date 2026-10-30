/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { autoUpdater } from 'electron-updater';
import type { ProgressInfo, ResolvedUpdateFileInfo, UpdateInfo } from 'electron-updater';
import type { UpdateInfoAndProvider } from 'electron-updater/out/AppUpdater';
import type { DownloadedUpdateHelper } from 'electron-updater/out/DownloadedUpdateHelper';
import type { StdioOptions } from 'node:child_process';
import { findFile } from 'electron-updater/out/providers/Provider';
import { CancellationError, CancellationToken } from 'builder-util-runtime';
import type { AutoUpdateReadyResult } from '@/common/update/updateTypes';
import { app, autoUpdater as nativeAutoUpdater, shell } from 'electron';
import log from 'electron-log';
import { EventEmitter } from 'events';
import fs from 'fs';
import path from 'path';
import { gt, parse } from 'semver';
import {
  recordAutoUpdateNativeInstallError,
  recordAutoUpdateNativeInstallReady,
  recordAutoUpdateNativeInstallTimeout,
  recordAutoUpdateQuitAndInstall,
  recordAutoUpdateStatus,
} from './autoUpdateDiagnostics';
import { buildGitHubFeedOptions } from './updateFeed';

const FORCE_DEV_AUTO_UPDATE_ENV = 'AIONUI_FORCE_DEV_AUTO_UPDATE';
const DEBUG_AUTO_UPDATE_CURRENT_VERSION_ENV = 'AIONUI_DEBUG_AUTO_UPDATE_CURRENT_VERSION';
const MAC_NATIVE_INSTALL_READY_TIMEOUT_MS = 60_000;
const INSTALL_IDLE_POLL_MS = 5000;

/**
 * Returns the appropriate update channel name based on the current platform and architecture.
 * Returns undefined for the default channel (Windows x64 / Linux x64).
 */
export function getUpdateChannel(): string | undefined {
  const { platform, arch } = process;

  // electron-updater appends a platform suffix to the channel name:
  //   macOS  → "-mac"       (e.g. "latest" → "latest-mac.yml")
  //   Linux  → "-linux"     (+ arch suffix for non-x64, e.g. "latest-linux-arm64.yml")
  //   Windows → ""          (no suffix, e.g. "latest.yml")
  //
  // Linux arm64 is handled natively by electron-updater (appends "-linux-arm64"),
  // so only Windows arm64 and macOS arm64 need a custom channel.

  if (platform === 'win32' && arch === 'arm64') {
    // "latest-win-arm64" + "" → "latest-win-arm64.yml"
    return 'latest-win-arm64';
  }
  if (platform === 'darwin' && arch === 'arm64') {
    // "latest-arm64" + "-mac" → "latest-arm64-mac.yml"
    return 'latest-arm64';
  }
  // macOS x64  → default "latest" + "-mac"         → "latest-mac.yml"
  // Linux x64  → default "latest" + "-linux"       → "latest-linux.yml"
  // Linux arm64→ default "latest" + "-linux-arm64"  → "latest-linux-arm64.yml"
  // Win x64    → default "latest" + ""             → "latest.yml"
  return undefined;
}

export interface AutoUpdateStatus {
  status:
    | 'checking'
    | 'available'
    | 'not-available'
    | 'downloading'
    | 'downloaded'
    | 'preparing-install'
    | 'error'
    | 'cancelled';
  version?: string;
  /** Current installed version — reflects the dev debug override when set. */
  currentVersion?: string;
  releaseDate?: string;
  releaseNotes?: string;
  progress?: {
    bytesPerSecond: number;
    percent: number;
    transferred: number;
    total: number;
  };
  error?: string;
}

/** Callback type for broadcasting update status */
export type StatusBroadcastCallback = (status: AutoUpdateStatus) => void;
export type BeforeQuitAndInstallCallback = () => void | Promise<void>;
/** Acquired atomically by authoritative workers after draining all work. */
export type UpdateInstallLease = { release: () => void | Promise<void> };
export type UpdateInstallGuard = () => Promise<UpdateInstallLease | null>;

type AutoUpdaterCacheAccess = {
  updateInfoAndProvider?: UpdateInfoAndProvider | null;
  getOrCreateDownloadHelper?: () => Promise<DownloadedUpdateHelper>;
  constructor?: { name?: string };
};

type AutoUpdaterInstallAccess = {
  quitAndInstallCalled?: boolean;
  installerPath?: string | null;
  app?: { quit: () => void };
  spawnLog?: (command: string, args?: string[], env?: NodeJS.ProcessEnv, stdio?: StdioOptions) => Promise<boolean>;
};

/** Events emitted by AutoUpdaterService */
export interface AutoUpdaterEvents {
  'update-status': (status: AutoUpdateStatus) => void;
}

class AutoUpdaterService extends EventEmitter {
  private _isInitialized = false;
  private _eventHandlersSetup = false;
  private _allowPrerelease = false;
  private _statusBroadcastCallback: StatusBroadcastCallback | null = null;
  private _beforeQuitAndInstallCallback: BeforeQuitAndInstallCallback | null = null;
  private _installGuard: UpdateInstallGuard | null = null;
  private _installTimer: ReturnType<typeof setTimeout> | undefined;
  private _installPromise: Promise<void> | null = null;
  private _automaticCheckPromise: Promise<void> | null = null;
  private _installHandedOff = false;
  private _installHandoffPending = false;
  private _installHandoffError: Error | null = null;
  private _installHandoffAttempt: { failed: boolean } | null = null;
  private _restoreWindowsHandoff: (() => void) | null = null;
  private _installLease: UpdateInstallLease | null = null;
  private _installRecoveryPromise: Promise<void> | null = null;
  private _macExitTimer: ReturnType<typeof setTimeout> | undefined;
  private _attemptedInstallVersion: string | undefined;
  private _activeDownloadPromise: Promise<{ success: boolean; error?: string }> | null = null;
  private _activeDownloadCancellationToken: CancellationToken | null = null;
  private _ignoreActiveDownloadEvents = false;
  private _nativeInstallReady = process.platform !== 'darwin';
  private _nativeInstallReadyWait: {
    promise: Promise<void>;
    reject: (error: Error) => void;
    resolve: () => void;
    startedAt: number;
    timer: ReturnType<typeof setTimeout>;
  } | null = null;
  private _downloadedUpdateVersion: string | undefined;
  private _hasDownloadedUpdate = false;
  /** Stores registered autoUpdater event handlers for cleanup and test access */
  private readonly _autoUpdaterHandlers = new Map<string, (...args: unknown[]) => void>();
  private readonly _nativeAutoUpdaterHandlers = new Map<string, (...args: unknown[]) => void>();

  constructor() {
    super();
    // Configure logging
    autoUpdater.logger = log;
    (autoUpdater.logger as typeof log).transports.file.level = 'debug';

    // Downloads are started by the main-process policy after strict stable-version
    // validation. Never let electron-updater install implicitly on app quit.
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = false;
    this.configureDevAutoUpdateDebug();
    const githubFeedOptions = buildGitHubFeedOptions();

    // Set the correct update channel based on platform and architecture before
    // any update checks are performed
    const channel = getUpdateChannel();
    if (channel !== undefined) {
      autoUpdater.channel = channel;
      log.info(`Update channel set to: ${channel}`);
    }
    autoUpdater.setFeedURL(githubFeedOptions);
    log.info('Update feed set to GitHub provider');
    log.debug('[auto-update] GitHub feed configured', {
      provider: githubFeedOptions.provider,
      url: 'https://github.com/pigq/OpenH3/releases',
      channel: channel ?? 'latest',
      platform: process.platform,
      arch: process.arch,
    });
  }

  private configureDevAutoUpdateDebug(): void {
    if (app.isPackaged || process.env[FORCE_DEV_AUTO_UPDATE_ENV] !== '1') {
      return;
    }

    autoUpdater.forceDevUpdateConfig = true;
    log.warn(`[auto-update] Forced dev auto-update checks enabled by ${FORCE_DEV_AUTO_UPDATE_ENV}`);

    // In dev mode electron-updater reads "dev-app-update.yml" from the app path to
    // resolve `updaterCacheDirName` during download. It does not exist in the repo,
    // so the download step fails with ENOENT. The feed itself is provided via
    // setFeedURL(), so this file only needs to satisfy the cache-dir lookup. Write a
    // minimal config to a temp path and point the updater at it. Must run before
    // setFeedURL() — the updateConfigPath setter clears the injected provider.
    this.ensureDevUpdateConfig();

    const debugCurrentVersion = process.env[DEBUG_AUTO_UPDATE_CURRENT_VERSION_ENV];
    if (!debugCurrentVersion) {
      return;
    }

    const parsedVersion = parse(debugCurrentVersion);
    if (!parsedVersion) {
      log.warn(`[auto-update] Ignoring invalid ${DEBUG_AUTO_UPDATE_CURRENT_VERSION_ENV}: ${debugCurrentVersion}`);
      return;
    }

    Object.defineProperty(autoUpdater, 'currentVersion', {
      configurable: true,
      value: parsedVersion,
    });
    log.warn(`[auto-update] Debug current version override enabled: ${parsedVersion.version}`);
  }

  /**
   * Write a minimal dev-app-update.yml and point the updater at it, so the
   * download step's `updaterCacheDirName` lookup succeeds in dev mode. The
   * `provider`/`url` here are placeholders — the real feed comes from
   * setFeedURL() — but `updaterCacheDirName` must match the packaged value
   * (electron-builder defaults it to the appId) to reuse the same cache dir.
   */
  private ensureDevUpdateConfig(): void {
    try {
      const devConfig = [
        'provider: github',
        'owner: pigq',
        'repo: OpenH3',
        'updaterCacheDirName: com.openh3.app',
        '',
      ].join('\n');
      const configPath = path.join(app.getPath('userData'), 'dev-app-update.yml');
      fs.writeFileSync(configPath, devConfig, 'utf-8');
      autoUpdater.updateConfigPath = configPath;
      log.warn(`[auto-update] Dev update config written to: ${configPath}`);
    } catch (err) {
      log.error('[auto-update] Failed to write dev update config:', err);
    }
  }

  private moveCwdOutOfInstallDirForWindowsHandoff(): void {
    if (process.platform !== 'win32') {
      return;
    }

    try {
      const safeCwd = path.join(app.getPath('temp'), 'openh3-updater-cwd');
      fs.mkdirSync(safeCwd, { recursive: true });
      process.chdir(safeCwd);
      log.info('[auto-update] Moved process cwd before Windows installer handoff', { cwd: safeCwd });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.warn('[auto-update] Failed to move process cwd before Windows installer handoff', { error: message });
    }
  }

  /**
   * Initialize the service with an optional status broadcast callback.
   * This decouples the service from any specific window implementation.
   */
  initialize(statusBroadcastCallback?: StatusBroadcastCallback): void {
    this._statusBroadcastCallback = statusBroadcastCallback ?? null;
    this._isInitialized = true;

    // Setup event handlers only once
    if (!this._eventHandlersSetup) {
      this.setupEventHandlers();
      this._eventHandlersSetup = true;
    }
  }

  /**
   * Set the status broadcast callback (can be called after initialize)
   */
  setStatusBroadcastCallback(callback: StatusBroadcastCallback | null): void {
    this._statusBroadcastCallback = callback;
  }

  setBeforeQuitAndInstall(callback: BeforeQuitAndInstallCallback | null): void {
    this._beforeQuitAndInstallCallback = callback;
  }

  /** The guard must reserve Core and media workers, including background work. */
  setInstallGuard(guard: UpdateInstallGuard | null): void {
    this._installGuard = guard;
    this.scheduleAutomaticInstall();
  }

  /** Background stable checks run in main even when the renderer is unavailable. */
  async runAutomaticUpdateCheck(): Promise<void> {
    if (!app.isPackaged || !this._isInitialized || this._installHandedOff) return;
    if (this._automaticCheckPromise) return this._automaticCheckPromise;
    this._automaticCheckPromise = (async () => {
      if (this._hasDownloadedUpdate && !this.wasInstallAttempted(this._downloadedUpdateVersion!)) {
        this.scheduleAutomaticInstall();
        return;
      }
      if (this._activeDownloadPromise) return;
      this.setAllowPrerelease(false);
      await this.checkForUpdates();
    })();
    try {
      await this._automaticCheckPromise;
    } finally {
      this._automaticCheckPromise = null;
    }
  }

  private automaticAttemptPath(): string {
    return path.join(app.getPath('userData'), 'automatic-update-attempt.json');
  }

  private rememberInstallAttempt(): void {
    const version = this._downloadedUpdateVersion;
    if (!version) return;
    this._attemptedInstallVersion = version;
    fs.writeFileSync(
      this.automaticAttemptPath(),
      JSON.stringify({
        currentVersion: app.getVersion(),
        targetVersion: version,
      })
    );
  }

  private wasInstallAttempted(version: string): boolean {
    if (this._attemptedInstallVersion === version) return true;
    try {
      const attempt = JSON.parse(fs.readFileSync(this.automaticAttemptPath(), 'utf8')) as {
        currentVersion?: string;
        targetVersion?: string;
      };
      return attempt.currentVersion === app.getVersion() && attempt.targetVersion === version;
    } catch (error) {
      // A corrupted marker is not evidence that a previous handoff is safe to repeat.
      return (error as NodeJS.ErrnoException).code !== 'ENOENT';
    }
  }

  private scheduleAutomaticInstall(): void {
    const version = this._downloadedUpdateVersion;
    const parsed = version ? parse(version) : null;
    const installed = parse(app.getVersion());
    if (
      !app.isPackaged ||
      !this._isInitialized ||
      !this._hasDownloadedUpdate ||
      !parsed ||
      parsed.prerelease.length ||
      !installed ||
      !gt(parsed, installed) ||
      !this._installGuard ||
      this._installTimer ||
      this._installPromise ||
      this._installHandedOff ||
      this.wasInstallAttempted(version!)
    )
      return;
    this._installTimer = setTimeout(() => {
      this._installTimer = undefined;
      void this.quitAndInstall()
        .catch((error: unknown) => {
          log.warn('[auto-update] Automatic install deferred or failed', { error: String(error) });
        })
        .finally(() => this.scheduleAutomaticInstall());
    }, INSTALL_IDLE_POLL_MS);
    this._installTimer.unref?.();
  }

  /**
   * Check if the service has been initialized
   */
  get isInitialized(): boolean {
    return this._isInitialized;
  }

  /**
   * Reset the service state (for production use)
   */
  reset(): void {
    this._isInitialized = false;
    // Note: _eventHandlersSetup is NOT reset to avoid duplicate handler registration
    this._allowPrerelease = false;
    this._statusBroadcastCallback = null;
    this._beforeQuitAndInstallCallback = null;
    this._installGuard = null;
    clearTimeout(this._installTimer);
    this._installTimer = undefined;
    this._installPromise = null;
    this._automaticCheckPromise = null;
    this._installHandedOff = false;
    this._installHandoffPending = false;
    this._installHandoffError = null;
    this._installHandoffAttempt = null;
    this._restoreWindowsHandoff?.();
    this._installLease = null;
    clearTimeout(this._macExitTimer);
    this._macExitTimer = undefined;
    this._attemptedInstallVersion = undefined;
    this._activeDownloadPromise = null;
    this._activeDownloadCancellationToken = null;
    this._ignoreActiveDownloadEvents = false;
    this.clearNativeInstallReadyWait();
    this._nativeInstallReady = process.platform !== 'darwin';
    this._downloadedUpdateVersion = undefined;
    this._hasDownloadedUpdate = false;
  }

  /**
   * Reset the service state completely, including event handlers.
   * Use this only in tests where you need to reset handler state.
   */
  resetForTest(): void {
    this._isInitialized = false;
    this._eventHandlersSetup = false;
    this._allowPrerelease = false;
    this._statusBroadcastCallback = null;
    this._beforeQuitAndInstallCallback = null;
    this._installGuard = null;
    clearTimeout(this._installTimer);
    this._installTimer = undefined;
    this._installPromise = null;
    this._automaticCheckPromise = null;
    this._installHandedOff = false;
    this._installHandoffPending = false;
    this._installHandoffError = null;
    this._installHandoffAttempt = null;
    this._restoreWindowsHandoff?.();
    this._installLease = null;
    clearTimeout(this._macExitTimer);
    this._macExitTimer = undefined;
    this._attemptedInstallVersion = undefined;
    this._activeDownloadPromise = null;
    this._activeDownloadCancellationToken = null;
    this._ignoreActiveDownloadEvents = false;
    this.clearNativeInstallReadyWait();
    this._nativeInstallReady = process.platform !== 'darwin';
    this._downloadedUpdateVersion = undefined;
    this._hasDownloadedUpdate = false;
    // Remove listeners from this EventEmitter instance
    this.removeAllListeners();
    // Remove each registered handler from autoUpdater to prevent
    // duplicate handler accumulation across multiple initialize() calls in tests
    for (const [event, handler] of this._autoUpdaterHandlers) {
      autoUpdater.removeListener(
        event as Parameters<typeof autoUpdater.removeListener>[0],
        handler as Parameters<typeof autoUpdater.removeListener>[1]
      );
    }
    this._autoUpdaterHandlers.clear();
    for (const [event, handler] of this._nativeAutoUpdaterHandlers) {
      nativeAutoUpdater.removeListener(
        event as Parameters<typeof nativeAutoUpdater.removeListener>[0],
        handler as Parameters<typeof nativeAutoUpdater.removeListener>[1]
      );
    }
    this._nativeAutoUpdaterHandlers.clear();
  }

  /**
   * Trigger a registered autoUpdater event handler by event name with optional arguments.
   * Intended for use in tests only — do not call in production code.
   * Throws if the handler for the given event has not been registered yet.
   */
  triggerEventForTest(event: string, ...args: unknown[]): void {
    const handler = this._autoUpdaterHandlers.get(event);
    if (!handler) {
      throw new Error(`No handler registered for autoUpdater event "${event}". Did you call initialize() first?`);
    }
    handler(...args);
  }

  /**
   * Set whether to allow prerelease/dev updates.
   * Only tracks the flag; prerelease filtering is handled by the manual GitHub
   * API check. Does not touch `autoUpdater.allowDowngrade` (see note below).
   */
  setAllowPrerelease(allow: boolean): void {
    this._allowPrerelease = allow;
    // Do NOT set autoUpdater.allowPrerelease here.
    // electron-updater's prerelease mode conflicts with custom channel names
    // (e.g. 'latest-arm64'): it treats the channel as a prerelease identifier
    // and tries to match it against tag prerelease components, which always fails
    // with "No published versions on GitHub".
    // Prerelease filtering is handled by the manual update check (GitHub API) instead.
    log.info(`Prerelease updates ${allow ? 'enabled' : 'disabled'} (manual check only)`);
  }

  /**
   * Get current prerelease setting
   */
  get allowPrerelease(): boolean {
    return this._allowPrerelease;
  }

  private setupEventHandlers(): void {
    const register = <T extends unknown[]>(event: string, handler: (...args: T) => void) => {
      // Cast to satisfy overloaded autoUpdater.on signature
      autoUpdater.on(event as Parameters<typeof autoUpdater.on>[0], handler as Parameters<typeof autoUpdater.on>[1]);
      this._autoUpdaterHandlers.set(event, handler as (...args: unknown[]) => void);
    };

    const registerNative = <T extends unknown[]>(event: string, handler: (...args: T) => void) => {
      nativeAutoUpdater.on(
        event as Parameters<typeof nativeAutoUpdater.on>[0],
        handler as Parameters<typeof nativeAutoUpdater.on>[1]
      );
      this._nativeAutoUpdaterHandlers.set(event, handler as (...args: unknown[]) => void);
    };

    if (process.platform === 'darwin') {
      registerNative('update-downloaded', () => {
        this.handleNativeInstallReady();
      });
      registerNative('error', (error: Error) => {
        this.handleInstallHandoffError(error);
        void this.handleNativeInstallError(error);
      });
    }

    register('checking-for-update', () => {
      log.info('Checking for updates...');
      this.resetNativeInstallReady();
      this.broadcastStatus({ status: 'checking' });
    });

    register('update-available', (info: UpdateInfo) => {
      log.info(`Update available: ${info.version}`);
      this.resetNativeInstallReady(info.version);
      this.broadcastStatus({
        status: 'available',
        version: info.version,
        // Reflects the dev debug override (autoUpdater.currentVersion) when set,
        // so the "current → new" display matches the version used for comparison.
        currentVersion: autoUpdater.currentVersion?.version,
        releaseDate: info.releaseDate,
        releaseNotes: typeof info.releaseNotes === 'string' ? info.releaseNotes : undefined,
      });
    });

    register('update-not-available', () => {
      log.info('Application is up to date');
      this.broadcastStatus({ status: 'not-available' });
    });

    register('download-progress', (progress: ProgressInfo) => {
      if (this._ignoreActiveDownloadEvents) {
        log.debug('[auto-update] Ignoring download-progress after cancellation');
        return;
      }
      log.debug(`Download progress: ${progress.percent.toFixed(2)}%`);
      this.broadcastStatus({
        status: 'downloading',
        progress: {
          bytesPerSecond: progress.bytesPerSecond,
          percent: progress.percent,
          transferred: progress.transferred,
          total: progress.total,
        },
      });
    });

    register('update-downloaded', (info: UpdateInfo) => {
      if (this._ignoreActiveDownloadEvents) {
        log.debug('[auto-update] Ignoring update-downloaded after cancellation');
        return;
      }
      log.info('Update downloaded');
      this._activeDownloadPromise = null;
      this._activeDownloadCancellationToken = null;
      this._downloadedUpdateVersion = info.version;
      this._hasDownloadedUpdate = true;
      if (process.platform === 'darwin' && !this._nativeInstallReady) {
        log.debug('[auto-update] macOS service-level update-downloaded received before native install readiness', {
          version: info.version,
        });
      }
      this.broadcastStatus({
        status: 'downloaded',
        version: info.version,
      });
      this.scheduleAutomaticInstall();
    });

    register('update-cancelled', () => {
      log.info('Update download cancelled');
      this._activeDownloadPromise = null;
      this._activeDownloadCancellationToken = null;
      this._ignoreActiveDownloadEvents = false;
      this.broadcastStatus({ status: 'cancelled' });
    });

    register('error', (error: Error) => {
      if (this._ignoreActiveDownloadEvents) {
        log.debug('[auto-update] Ignoring error after cancellation');
        return;
      }
      log.error('Auto-updater error:', error);
      this.handleInstallHandoffError(error);
      this._activeDownloadPromise = null;
      this._activeDownloadCancellationToken = null;
      this.broadcastStatus({
        status: 'error',
        error: this.describeAutoUpdateError(error),
      });
    });
  }

  /**
   * In dev mode the running shell is the stock Electron bundle (com.github.Electron),
   * while the downloaded archive contains the packaged app (com.openh3.app). Squirrel.Mac
   * looks for a bundle matching the *running* id, fails to find it, and reports
   * "Could not locate update bundle". This is expected in dev and cannot be reproduced
   * without a packaged build, so surface a clearer message instead of the raw error.
   */
  private describeAutoUpdateError(error: Error): string {
    const message = error.message;
    if (!app.isPackaged && /Could not locate update bundle/i.test(message)) {
      return `[dev] Download succeeded; install cannot complete in dev mode (the install step requires a packaged build). Original error: ${message}`;
    }
    return message;
  }

  private resetNativeInstallReady(version?: string): void {
    void this.rejectNativeInstallReadyWaitWithLocalizedError('update.errors.prepareInstallFailed');
    this._nativeInstallReady = process.platform !== 'darwin';
    this._downloadedUpdateVersion = version;
    this._hasDownloadedUpdate = false;
  }

  private getAutoUpdateDiagnosticOptions() {
    return {
      currentAppVersion: app.getVersion(),
      userDataPath: app.getPath('userData'),
    };
  }

  private getNativeInstallReadyElapsedMs(): number | undefined {
    return this._nativeInstallReadyWait ? Date.now() - this._nativeInstallReadyWait.startedAt : undefined;
  }

  private clearNativeInstallReadyWait(): void {
    if (!this._nativeInstallReadyWait) return;
    clearTimeout(this._nativeInstallReadyWait.timer);
    this._nativeInstallReadyWait = null;
  }

  private async rejectNativeInstallReadyWaitWithLocalizedError(i18nKey: string): Promise<void> {
    const wait = this._nativeInstallReadyWait;
    if (!wait) return;
    this.clearNativeInstallReadyWait();
    const { default: i18n } = await import('./i18n');
    wait.reject(new Error(i18n.t(i18nKey)));
  }

  private handleNativeInstallReady(): void {
    this._nativeInstallReady = true;
    const elapsedMs = this.getNativeInstallReadyElapsedMs();
    log.info('[auto-update] Native Squirrel update ready; continuing install', {
      elapsedMs,
      platform: process.platform,
      version: this._downloadedUpdateVersion,
    });
    recordAutoUpdateNativeInstallReady(
      { elapsedMs, version: this._downloadedUpdateVersion },
      this.getAutoUpdateDiagnosticOptions()
    );
    const wait = this._nativeInstallReadyWait;
    this.clearNativeInstallReadyWait();
    wait?.resolve();
  }

  private async handleNativeInstallError(error: Error): Promise<void> {
    const elapsedMs = this.getNativeInstallReadyElapsedMs();
    const message = this.describeAutoUpdateError(error);
    log.error('[auto-update] Native updater readiness failed', {
      elapsedMs,
      error: message,
      platform: process.platform,
      version: this._downloadedUpdateVersion,
    });
    recordAutoUpdateNativeInstallError(
      { elapsedMs, error: message, version: this._downloadedUpdateVersion },
      this.getAutoUpdateDiagnosticOptions()
    );
    const { default: i18n } = await import('./i18n');
    const userMessage = i18n.t('update.errors.prepareInstallFailed');
    this.broadcastStatus({
      status: 'error',
      error: userMessage,
    });
    const wait = this._nativeInstallReadyWait;
    this.clearNativeInstallReadyWait();
    wait?.reject(new Error(userMessage));
  }

  private async waitForNativeInstallReady(): Promise<void> {
    if (process.platform !== 'darwin' || this._nativeInstallReady) return;
    if (this._nativeInstallReadyWait) return this._nativeInstallReadyWait.promise;

    log.info('[auto-update] macOS install requested before native readiness; waiting for native updater', {
      platform: process.platform,
      timeoutMs: MAC_NATIVE_INSTALL_READY_TIMEOUT_MS,
      version: this._downloadedUpdateVersion,
    });
    this.broadcastStatus({ status: 'preparing-install', version: this._downloadedUpdateVersion });

    const startedAt = Date.now();
    let resolveWait!: () => void;
    let rejectWait!: (error: Error) => void;
    const promise = new Promise<void>((resolve, reject) => {
      resolveWait = resolve;
      rejectWait = reject;
    });
    const timer = setTimeout(async () => {
      const elapsedMs = Date.now() - startedAt;
      log.warn('[auto-update] Timed out waiting for native Squirrel update readiness', {
        elapsedMs,
        platform: process.platform,
        version: this._downloadedUpdateVersion,
      });
      recordAutoUpdateNativeInstallTimeout(
        { elapsedMs, version: this._downloadedUpdateVersion },
        this.getAutoUpdateDiagnosticOptions()
      );
      const { default: i18n } = await import('./i18n');
      const userMessage = i18n.t('update.errors.prepareInstallTimeout');
      this.broadcastStatus({
        status: 'error',
        error: userMessage,
      });
      const wait = this._nativeInstallReadyWait;
      this.clearNativeInstallReadyWait();
      wait?.reject(new Error(userMessage));
    }, MAC_NATIVE_INSTALL_READY_TIMEOUT_MS);

    this._nativeInstallReadyWait = { promise, reject: rejectWait, resolve: resolveWait, startedAt, timer };
    // With autoInstallOnAppQuit disabled, MacUpdater has only prepared its local
    // feed. Start native staging after explicit confirmation, without arming its
    // quitAndInstall listener until readiness and pre-install cleanup complete.
    try {
      nativeAutoUpdater.checkForUpdates();
    } catch (error) {
      void this.handleNativeInstallError(error instanceof Error ? error : new Error('Native update staging failed'));
    }
    return promise;
  }

  /**
   * Broadcast status to both EventEmitter listeners and the registered callback
   */
  private broadcastStatus(status: AutoUpdateStatus): void {
    recordAutoUpdateStatus(status, this.getAutoUpdateDiagnosticOptions());

    // Emit to internal listeners (for testing and extensibility)
    this.emit('update-status', status);

    // Call the registered callback if available
    if (this._statusBroadcastCallback) {
      this._statusBroadcastCallback(status);
    }
  }

  async checkForUpdates(): Promise<{ success: boolean; updateInfo?: UpdateInfo; error?: string }> {
    try {
      if (!this._isInitialized) {
        throw new Error('AutoUpdaterService not initialized');
      }

      log.debug('[auto-update] checkForUpdates requested', {
        allowPrerelease: this._allowPrerelease,
        channel: autoUpdater.channel ?? 'latest',
        currentVersion: app.getVersion(),
        appIsPackaged: app.isPackaged,
      });

      if (this._allowPrerelease) {
        log.info('Skipping electron-updater check for prerelease manual mode');
        log.debug('[auto-update] GitHub stable feed skipped because prerelease mode is handled by GitHub API');
        return { success: true };
      }

      const result = await autoUpdater.checkForUpdates();
      if (!result) {
        const { default: i18n } = await import('./i18n');
        log.debug('[auto-update] checkForUpdates returned null');
        return { success: false, error: i18n.t('update.errors.checkReturnedNull') };
      }
      // Only report updateInfo when electron-updater internally confirms the update is available.
      // When isUpdateAvailable is false, updateInfoAndProvider is NOT set internally,
      // so a subsequent downloadUpdate() call would fail with "Please check update first".
      if (!result.isUpdateAvailable) {
        log.debug('[auto-update] no update available from GitHub feed', {
          version: result.updateInfo.version,
        });
        return { success: true };
      }

      // Defense-in-depth: never surface a same-or-older feed version as an update.
      // electron-updater's isUpdateAvailable can be true for a downgrade when a
      // channel is rolled back or allowDowngrade drifts on; require strict semver
      // greater-than against the installed version before reporting it.
      const feedVersion = parse(result.updateInfo.version);
      const installedVersion = parse(app.getVersion());
      if (feedVersion && installedVersion && !gt(feedVersion, installedVersion)) {
        log.debug('[auto-update] feed version not newer than installed; ignoring', {
          feedVersion: feedVersion.version,
          installedVersion: installedVersion.version,
        });
        return { success: true };
      }
      log.debug('[auto-update] update available from GitHub feed', {
        version: result.updateInfo.version,
        releaseDate: result.updateInfo.releaseDate,
      });
      if (
        app.isPackaged &&
        feedVersion &&
        installedVersion &&
        !feedVersion.prerelease.length &&
        !this.wasInstallAttempted(feedVersion.version)
      ) {
        void this.downloadUpdate().then((result) => {
          if (!result.success) {
            this.broadcastStatus({ status: 'error', version: feedVersion.version, error: result.error });
          }
        });
      }
      return {
        success: true,
        updateInfo: result.updateInfo,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.error('Check for updates failed:', message);
      return {
        success: false,
        error: message,
      };
    }
  }

  async restoreDownloadedUpdateIfAvailable(): Promise<{
    success: boolean;
    data: AutoUpdateReadyResult;
    error?: string;
  }> {
    try {
      if (!this._isInitialized) {
        throw new Error('AutoUpdaterService not initialized');
      }

      // Avoid a startup network check unless an already-downloaded package may exist.
      const helper = await (autoUpdater as unknown as AutoUpdaterCacheAccess).getOrCreateDownloadHelper?.();
      if (!helper || !fs.existsSync(path.join(helper.cacheDirForPendingUpdate, 'update-info.json'))) {
        return { success: true, data: { ready: false } };
      }
      const checkResult = await this.checkForUpdates();
      if (!checkResult.success || !checkResult.updateInfo) {
        return {
          success: checkResult.success,
          data: { ready: false },
          error: checkResult.error,
        };
      }

      const cachedUpdate = await this.getValidCachedDownloadedUpdate();
      if (!cachedUpdate) {
        return { success: true, data: { ready: false } };
      }

      const downloadResult = await this.downloadUpdate();
      if (!downloadResult.success) {
        return {
          success: false,
          data: { ready: false },
          error: downloadResult.error,
        };
      }

      const data: AutoUpdateReadyResult = {
        ready: true,
        version: checkResult.updateInfo.version,
        currentVersion: autoUpdater.currentVersion?.version,
        filePath: cachedUpdate.filePath,
      };
      if (typeof checkResult.updateInfo.releaseNotes === 'string') {
        data.releaseNotes = checkResult.updateInfo.releaseNotes;
      }
      if (typeof cachedUpdate.fileInfo.info.size === 'number') {
        data.size = cachedUpdate.fileInfo.info.size;
      }

      return {
        success: true,
        data,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.error('[auto-update] Restore downloaded update failed:', message);
      return {
        success: false,
        data: { ready: false },
        error: message,
      };
    }
  }

  private async getValidCachedDownloadedUpdate(): Promise<{
    filePath: string;
    fileInfo: ResolvedUpdateFileInfo;
  } | null> {
    const updater = autoUpdater as unknown as AutoUpdaterCacheAccess;
    const updateInfoAndProvider = updater.updateInfoAndProvider;
    if (!updateInfoAndProvider || !updater.getOrCreateDownloadHelper) {
      return null;
    }

    const fileInfo = this.selectAutoUpdateFile(updateInfoAndProvider.provider.resolveFiles(updateInfoAndProvider.info));
    if (!fileInfo) {
      log.warn('[auto-update] No platform update file found for cached update restore');
      return null;
    }

    const downloadedUpdateHelper = await updater.getOrCreateDownloadHelper();
    const updateFileName = this.getCacheUpdateFileName(fileInfo);
    const updateFile = path.join(downloadedUpdateHelper.cacheDirForPendingUpdate, updateFileName);
    const filePath = await downloadedUpdateHelper.validateDownloadedPath(
      updateFile,
      updateInfoAndProvider.info,
      fileInfo,
      log
    );

    return filePath ? { filePath, fileInfo } : null;
  }

  private selectAutoUpdateFile(files: ResolvedUpdateFileInfo[]): ResolvedUpdateFileInfo | null {
    const updaterName = (autoUpdater as unknown as AutoUpdaterCacheAccess).constructor?.name;
    if (updaterName === 'MacUpdater' || process.platform === 'darwin') {
      return findFile(files, 'zip', ['pkg', 'dmg']) ?? null;
    }
    if (updaterName === 'NsisUpdater' || process.platform === 'win32') {
      return findFile(files, 'exe') ?? null;
    }
    if (updaterName === 'DebUpdater') {
      return findFile(files, 'deb', ['AppImage', 'rpm', 'pacman']) ?? null;
    }
    if (updaterName === 'RpmUpdater') {
      return findFile(files, 'rpm', ['AppImage', 'deb', 'pacman']) ?? null;
    }
    if (updaterName === 'PacmanUpdater') {
      return findFile(files, 'pacman', ['AppImage', 'deb', 'rpm']) ?? null;
    }
    return findFile(files, 'AppImage', ['rpm', 'deb', 'pacman']) ?? null;
  }

  private getCacheUpdateFileName(fileInfo: ResolvedUpdateFileInfo): string {
    const urlPath = decodeURIComponent(fileInfo.url.pathname);
    const extension = path.extname(urlPath);
    if (extension && urlPath.toLowerCase().endsWith(extension.toLowerCase())) {
      return path.basename(urlPath);
    }
    return fileInfo.info.url;
  }

  async downloadUpdate(): Promise<{ success: boolean; error?: string }> {
    if (this._activeDownloadPromise) {
      log.debug('[auto-update] downloadUpdate reused active download');
      return this._activeDownloadPromise;
    }

    const cancellationToken = new CancellationToken();
    this._activeDownloadCancellationToken = cancellationToken;

    const runDownload = async (): Promise<{ success: boolean; error?: string }> => {
      try {
        if (!this._isInitialized) {
          throw new Error('AutoUpdaterService not initialized');
        }

        log.debug('[auto-update] downloadUpdate requested');
        this._ignoreActiveDownloadEvents = false;
        const updateInfo = (autoUpdater as unknown as AutoUpdaterCacheAccess).updateInfoAndProvider?.info;
        this.broadcastStatus({
          status: 'downloading',
          version: updateInfo?.version,
          progress: { bytesPerSecond: 0, percent: 0, transferred: 0, total: 0 },
        });
        await autoUpdater.downloadUpdate(cancellationToken);
        log.debug('[auto-update] downloadUpdate started');
        return { success: true };
      } catch (error) {
        if (error instanceof CancellationError || (error instanceof Error && error.message === 'cancelled')) {
          log.info('[auto-update] downloadUpdate cancelled');
          return { success: true };
        }
        const message = error instanceof Error ? error.message : String(error);
        log.error('Download update failed:', message);
        return {
          success: false,
          error: message,
        };
      }
    };

    const promise = runDownload();
    this._activeDownloadPromise = promise;
    const result = await promise;
    if (!result.success && this._activeDownloadPromise === promise) this._activeDownloadPromise = null;
    return result;
  }

  async cancelDownload(): Promise<{ success: boolean; error?: string }> {
    if (!this._activeDownloadPromise) {
      this.broadcastStatus({ status: 'cancelled' });
      return { success: true };
    }

    log.info('[auto-update] Cancelling active auto-update download');
    this._activeDownloadCancellationToken?.cancel();
    this._activeDownloadCancellationToken = null;
    this._activeDownloadPromise = null;
    this._ignoreActiveDownloadEvents = true;
    this.broadcastStatus({ status: 'cancelled' });
    return { success: true };
  }

  async quitAndInstall(): Promise<void> {
    if (this._installRecoveryPromise) await this._installRecoveryPromise;
    if (this._installHandedOff) return;
    if (this._installPromise) return this._installPromise;
    clearTimeout(this._installTimer);
    this._installTimer = undefined;
    this._installPromise = this.installWhenIdle();
    try {
      await this._installPromise;
    } finally {
      this._installPromise = null;
      this.scheduleAutomaticInstall();
    }
  }

  private async releaseInstallLease(): Promise<void> {
    if (this._installRecoveryPromise) return this._installRecoveryPromise;
    const lease = this._installLease;
    this._installLease = null;
    if (!lease) return;
    const recovery = Promise.resolve().then(() => lease.release());
    this._installRecoveryPromise = recovery;
    try {
      await recovery;
    } finally {
      if (this._installRecoveryPromise === recovery) this._installRecoveryPromise = null;
    }
  }

  private handleInstallHandoffError(error: unknown): void {
    if (!this._installHandoffPending && !this._installHandedOff) return;
    this._installHandoffError = error instanceof Error ? error : new Error('Auto-updater rejected the install handoff');
    if (this._installHandoffAttempt) this._installHandoffAttempt.failed = true;
    this._installHandoffPending = false;
    this._installHandedOff = false;
    clearTimeout(this._installTimer);
    this._installTimer = undefined;
    clearTimeout(this._macExitTimer);
    this._macExitTimer = undefined;
    // BaseUpdater resets this flag only for synchronous failures. NSIS may
    // dispatch a spawn error later, after doInstall already returned true.
    const updater = autoUpdater as unknown as AutoUpdaterInstallAccess;
    if (typeof updater.quitAndInstallCalled === 'boolean') updater.quitAndInstallCalled = false;
    void this.releaseInstallLease().catch((recoveryError: unknown) => {
      log.error('[auto-update] Could not recover workers after install failure', recoveryError);
    });
  }

  private guardWindowsInstallerQuit(attempt: { failed: boolean }): () => void {
    const updater = autoUpdater as unknown as AutoUpdaterInstallAccess;
    const adapter = updater.app;
    const spawnLog = updater.spawnLog;
    if (process.platform !== 'win32' || !adapter || !spawnLog) return () => undefined;
    this._restoreWindowsHandoff?.();
    const quit = adapter.quit;
    const installerPath = updater.installerPath;
    const openPath = shell.openPath;
    const pending = new Set<Promise<unknown>>();
    let quitRequested = false;
    const track = <T>(promise: Promise<T>): Promise<T> => {
      pending.add(promise);
      void promise.then(
        () => pending.delete(promise),
        () => pending.delete(promise)
      );
      return promise;
    };
    const trackedSpawn: NonNullable<AutoUpdaterInstallAccess['spawnLog']> = (...args) =>
      track(spawnLog.apply(updater, args));
    const trackedOpenPath: typeof shell.openPath = (filePath) => {
      if (filePath !== installerPath) return openPath.call(shell, filePath);
      // NSIS retries ENOENT through openPath. Electron resolves launch failures
      // with an error string, which NSIS's rejection-only handler otherwise misses.
      return track(
        openPath.call(shell, filePath).then((error: string) => {
          if (error) throw new Error(error);
          return error;
        })
      );
    };
    const restore = () => {
      if (updater.spawnLog === trackedSpawn) updater.spawnLog = spawnLog;
      if (adapter.quit === gatedQuit) adapter.quit = quit;
      if (shell.openPath === trackedOpenPath) shell.openPath = openPath;
      if (this._restoreWindowsHandoff === restore) this._restoreWindowsHandoff = null;
    };
    const gatedQuit = () => {
      if (quitRequested) return;
      quitRequested = true;
      // NSIS returns true before spawnLog settles; BaseUpdater then queues quit.
      // Preserve its elevation/openPath fallbacks, but wait for every launch
      // promise before letting that queued quit reach Electron's cleanup hooks.
      void (async () => {
        while (pending.size) await Promise.allSettled(pending);
        restore();
        if (!attempt.failed) quit.call(adapter);
      })().catch((error: unknown) => {
        restore();
        this.handleInstallHandoffError(error);
      });
    };
    updater.spawnLog = trackedSpawn;
    adapter.quit = gatedQuit;
    shell.openPath = trackedOpenPath;
    this._restoreWindowsHandoff = restore;
    return restore;
  }

  private async installWhenIdle(): Promise<void> {
    if (!this._installGuard) throw new Error('UPDATE_ACTIVITY_GUARD_UNAVAILABLE');
    // Wait for native readiness before reserving workers; the readiness handshake
    // can take a minute and must not prevent users starting unrelated work.
    try {
      await this.waitForNativeInstallReady();
    } catch (error) {
      // Native staging errors are terminal for this target until an explicit
      // retry. Unknown worker activity, by contrast, is safely polled again.
      try {
        this.rememberInstallAttempt();
      } catch (markerError) {
        log.error('[auto-update] Could not persist failed install attempt', markerError);
      }
      throw error;
    }
    const lease = await this._installGuard();
    if (!lease) {
      this.scheduleAutomaticInstall();
      return;
    }
    this._installLease = lease;
    this._installHandoffError = null;
    this._installHandoffAttempt = { failed: false };
    try {
      // Persist before stopping workers so a failed installer cannot restart-loop.
      this.rememberInstallAttempt();
      await this.performQuitAndInstall();
      if (this._installHandoffError) {
        const { default: i18n } = await import('./i18n');
        throw new Error(i18n.t('update.errors.prepareInstallFailed'), { cause: this._installHandoffError });
      }
      this._installHandedOff = true;
    } catch (error) {
      this.handleInstallHandoffError(error);
      await this.releaseInstallLease();
      throw error;
    }
  }

  private async performQuitAndInstall(): Promise<void> {
    this.broadcastStatus({ status: 'preparing-install', version: this._downloadedUpdateVersion });

    if (this._beforeQuitAndInstallCallback) {
      log.info('Running pre-install cleanup before quitAndInstall...');
      try {
        await this._beforeQuitAndInstallCallback();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log.error('[auto-update] pre-install cleanup failed', {
          error: message,
          platform: process.platform,
          version: this._downloadedUpdateVersion,
        });
        const { default: i18n } = await import('./i18n');
        this.broadcastStatus({
          status: 'error',
          error: i18n.t('update.errors.prepareInstallFailed'),
        });
        throw error;
      }
    }

    log.info('Quitting and installing update...');
    try {
      this.moveCwdOutOfInstallDirForWindowsHandoff();
      // Workers are reserved and idle. Apply silently in place and restart.
      // NSIS receives --updated /S --force-run; no data reset.
      // BaseUpdater can reject synchronously via an error event without throwing.
      // The retained lease is also recovered by the permanent error listener if
      // installer startup fails after this synchronous method has returned.
      let handoffError: Error | undefined;
      const restoreWindowsHandoff = this.guardWindowsInstallerQuit(this._installHandoffAttempt!);
      const captureHandoffError = (error: unknown): void => {
        handoffError ??= error instanceof Error ? error : new Error('Auto-updater rejected the install handoff');
      };
      autoUpdater.on('error', captureHandoffError);
      try {
        this._installHandoffPending = true;
        autoUpdater.quitAndInstall(true, true);
      } catch (error) {
        restoreWindowsHandoff();
        throw error;
      } finally {
        autoUpdater.removeListener('error', captureHandoffError);
      }
      if (handoffError) {
        restoreWindowsHandoff();
        throw handoffError;
      }
      recordAutoUpdateQuitAndInstall(this.getAutoUpdateDiagnosticOptions());
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.error('[auto-update] quitAndInstall handoff failed', {
        error: message,
        platform: process.platform,
        version: this._downloadedUpdateVersion,
      });
      const { default: i18n } = await import('./i18n');
      const userMessage = i18n.t('update.errors.prepareInstallFailed');
      this.broadcastStatus({
        status: 'error',
        error: userMessage,
      });
      throw new Error(userMessage, { cause: error });
    }
    // On macOS, autoUpdater.quitAndInstall() closes all windows but the
    // 'window-all-closed' handler does NOT call app.quit() (standard macOS
    // behavior + close-to-tray). This leaves the process alive and Squirrel
    // cannot finish replacing the app bundle. Force-exit after a short delay
    // to let Squirrel receive the install signal.
    if (process.platform === 'darwin') {
      this._macExitTimer = setTimeout(() => {
        this._macExitTimer = undefined;
        app.exit(0);
      }, 1000);
    }
  }

  /**
   * Check for updates and notify (for startup)
   */
  async checkForUpdatesAndNotify(): Promise<void> {
    try {
      // Ensure clean state: prevent stale allowDowngrade=true from prior setAllowPrerelease(true) calls
      autoUpdater.allowDowngrade = false;
      await autoUpdater.checkForUpdatesAndNotify();
    } catch (error) {
      log.error('Auto-update check failed:', error);
    }
  }
}

// Singleton instance
export const autoUpdaterService = new AutoUpdaterService();

/** Schedule silent checks; the window owner must dispose this on close. */
export const scheduleUpdateChecks = (check: () => void): (() => void) => {
  let interval: ReturnType<typeof setInterval> | undefined;
  const startup = setTimeout(() => {
    check();
    interval = setInterval(check, 6 * 60 * 60 * 1000);
  }, 30_000);
  return () => {
    clearTimeout(startup);
    clearInterval(interval);
  };
};
