/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { ipcBridge } from '@/common';
import type { AutoUpdateStatus, UpdateDownloadProgressEvent } from '@/common/update/updateTypes';
import { uuid } from '@/common/utils';
import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { formatByteRate, formatByteSize } from '@/renderer/services/i18n/format';
import {
  initialUpdateNotificationState,
  updateNotificationReducer,
  type UpdateNotificationEvent,
  type UpdateNotificationActiveTask,
  type UpdateNotificationOpenSource,
  type UpdateNotificationProgress,
  type UpdateNotificationState,
} from './updateNotificationState';
import { getIncludePrerelease, runUpdateCheck, type CheckUpdateOutcome } from './checkForUpdatesShared';
import {
  dismissUpdateInstallConfirmation,
  confirmUpdateInstall,
  setUpdateReadyState,
  setSidebarUpdateState,
  SIDEBAR_UPDATE_ACTION_EVENT,
} from './updateReadyState';
import { IS_DISCONTINUED_BUILD } from '@/renderer/utils/discontinuedBuild';
import { OPEN_MIGRATION_DIALOG_EVENT } from './UpdateMigrationDialog';

type AvailableOutcome = Extract<CheckUpdateOutcome, { kind: 'available' }>;

export const UPDATE_AVAILABLE_EVENT = 'openh3-update-available';
export const LEGACY_UPDATE_AVAILABLE_EVENT = 'aionui-update-available';
export const OPEN_UPDATE_MODAL_EVENT = 'openh3-open-update-modal';
export const LEGACY_OPEN_UPDATE_MODAL_EVENT = 'aionui-open-update-modal';

declare const __APP_VERSION__: string;

export const formatUpdateSize = (bytes: number, language?: string) => formatByteSize(bytes, language);

const toAutoProgress = (evt: AutoUpdateStatus, language?: string): UpdateNotificationProgress | null => {
  if (!evt.progress) return null;
  return {
    percent: Math.round(evt.progress.percent),
    transferred: evt.progress.transferred,
    total: evt.progress.total,
    speed: formatByteRate(evt.progress.bytesPerSecond, language),
  };
};

const toManualProgress = (evt: UpdateDownloadProgressEvent, language?: string): UpdateNotificationProgress => ({
  percent: Math.round(evt.percent ?? 0),
  transferred: evt.receivedBytes ?? 0,
  total: evt.totalBytes ?? 0,
  speed: formatByteRate(evt.bytesPerSecond ?? 0, language),
});

const createInitialState = (): UpdateNotificationState => ({
  ...initialUpdateNotificationState,
  currentVersion: __APP_VERSION__,
});

const reduceNotificationState = (
  current: UpdateNotificationState,
  event: UpdateNotificationEvent
): UpdateNotificationState => updateNotificationReducer(current, event).state;

const RELEASES_PAGE_URL = 'https://github.com/pigq/OpenH3/releases';

const getVersionLabelFromState = (state: UpdateNotificationState): string =>
  state.updateInfo?.version || state.autoUpdateInfo?.version || '';

export const useUpdateNotificationController = () => {
  const { t, i18n } = useTranslation();
  const [state, dispatchState] = useReducer(reduceNotificationState, undefined, createInitialState);
  const stateRef = useRef(state);
  const mountedRef = useRef(true);
  const checkingRef = useRef(false);
  const silentCheckRef = useRef(false);
  const pendingManualRef = useRef<{ requestId: string; events: Map<string, UpdateDownloadProgressEvent> } | null>(null);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      setSidebarUpdateState(null);
      dismissUpdateInstallConfirmation();
    };
  }, []);
  useEffect(() => {
    setSidebarUpdateState(state);
  }, [state]);
  const restoreDownloadedPendingRef = useRef(true);
  const dispatch = useCallback((event: UpdateNotificationEvent) => {
    if (!mountedRef.current) return;
    stateRef.current = reduceNotificationState(stateRef.current, event);
    dispatchState(event);
  }, []);

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  const loadManualReleaseInfoForDisplay = useCallback(async () => {
    try {
      const res = await ipcBridge.update.check.invoke({
        includePrerelease: getIncludePrerelease(),
      });
      if (res?.success && res.data?.latest) {
        dispatch({
          type: 'manualReleaseInfoLoaded',
          updateInfo: res.data.latest,
          releasePageUrl: res.data.latest.htmlUrl || '',
        });
      }
    } catch (error) {
      console.warn('Manual release info check error:', error);
      dispatch({
        type: 'manualReleaseInfoFailed',
        releasePageUrl: stateRef.current.releasePageUrl || RELEASES_PAGE_URL,
      });
    }
  }, []);

  const dispatchAutoAvailable = useCallback(
    (evt: AutoUpdateStatus) => {
      dispatch({
        type: 'autoStatusAvailable',
        version: evt.version || '',
        currentVersion: evt.currentVersion || __APP_VERSION__,
        releaseNotes: evt.releaseNotes,
      });
      void loadManualReleaseInfoForDisplay();
    },
    [loadManualReleaseInfoForDisplay]
  );

  const checkForUpdates = useCallback(
    async (silent = false) => {
      if (['downloading', 'downloaded', 'preparing-install'].includes(stateRef.current.status)) return;
      if (checkingRef.current) {
        if (!silent) {
          silentCheckRef.current = false;
          dispatch({ type: 'checkStarted' });
        }
        return;
      }
      checkingRef.current = true;
      silentCheckRef.current = silent;
      if (!silent) dispatch({ type: 'checkStarted' });

      const outcome = await runUpdateCheck({
        includePrerelease: getIncludePrerelease(),
        fallbackVersion: __APP_VERSION__,
        checkFailedLabel: t('update.checkFailed'),
      });

      const effectiveSilent = silentCheckRef.current;
      checkingRef.current = false;
      silentCheckRef.current = false;
      if (!mountedRef.current || ['downloading', 'downloaded', 'preparing-install'].includes(stateRef.current.status))
        return;
      if (effectiveSilent && outcome.kind === 'error') return;
      switch (outcome.kind) {
        case 'available':
          dispatch({
            type: 'checkAvailable',
            silent: effectiveSilent,
            currentVersion: outcome.currentVersion,
            updateInfo: outcome.updateInfo,
            releasePageUrl: outcome.releasePageUrl,
            autoUpdateAvailable: outcome.autoUpdateAvailable,
            autoUpdateInfo: outcome.autoUpdateInfo,
          });
          return;
        case 'upToDate':
          dispatch({
            type: 'checkUpToDate',
            silent: effectiveSilent,
            currentVersion: outcome.currentVersion,
            updateInfo: outcome.updateInfo,
            releasePageUrl: outcome.releasePageUrl,
          });
          return;
        case 'error':
          dispatch({ type: 'checkError', message: outcome.message });
          return;
      }
    },
    [t]
  );

  // Present an already-fetched "available" outcome directly, with no checking
  // flash and no second IPC check. Respects an in-progress/ready download so a
  // background download is never clobbered by a fresh available result.
  const presentAvailableOutcome = useCallback((outcome: AvailableOutcome) => {
    const current = stateRef.current;
    if (current.status === 'downloading' || current.status === 'downloaded' || current.status === 'preparing-install') {
      dispatch({ type: 'openRequested', source: 'about', userInitiated: true });
      return;
    }
    dispatch({
      type: 'checkAvailable',
      currentVersion: outcome.currentVersion,
      updateInfo: outcome.updateInfo,
      releasePageUrl: outcome.releasePageUrl,
      autoUpdateAvailable: outcome.autoUpdateAvailable,
      autoUpdateInfo: outcome.autoUpdateInfo,
    });
  }, []);

  const restoreDownloadedUpdate = useCallback(async () => {
    try {
      const res = await ipcBridge.autoUpdate.restoreDownloaded.invoke();
      if (!res?.success || !res.data?.ready || !res.data.version) {
        restoreDownloadedPendingRef.current = false;
        return;
      }
      dispatch({
        type: 'autoDownloadedRestored',
        version: res.data.version,
        currentVersion: res.data.currentVersion || __APP_VERSION__,
        releaseNotes: res.data.releaseNotes,
        size: res.data.size,
      });
    } catch (error) {
      console.warn('Restore downloaded auto-update error:', error);
    } finally {
      restoreDownloadedPendingRef.current = false;
    }
  }, [dispatch]);

  useEffect(() => {
    void restoreDownloadedUpdate();
  }, [restoreDownloadedUpdate]);

  useEffect(() => {
    let cancelled = false;
    void ipcBridge.update.consumeInstallerLastFailure
      .invoke()
      .then((res) => {
        if (cancelled || !res?.success || !res.data) return;
        dispatch({ type: 'installerLastFailureConsumed', marker: res.data });
      })
      .catch((error) => {
        console.warn('Consume installer last failure marker error:', error);
      });
    return () => {
      cancelled = true;
    };
  }, [dispatch]);

  const openUpdateNotification = useCallback(
    (source: UpdateNotificationOpenSource, userInitiated: boolean) => {
      // Discontinued build: every manual entry point (tray / menu / IPC-open)
      // opens the migration card instead of checking. Flag is compile-time, so
      // this branch is stripped from normal builds.
      if (IS_DISCONTINUED_BUILD) {
        window.dispatchEvent(new CustomEvent(OPEN_MIGRATION_DIALOG_EVENT));
        return;
      }
      if (source === 'startup') {
        void checkForUpdates(true);
        return;
      }
      const current = stateRef.current;
      dispatch({ type: 'openRequested', source, userInitiated });
      if (
        current.status !== 'downloading' &&
        current.status !== 'downloaded' &&
        current.status !== 'preparing-install'
      ) {
        void checkForUpdates();
      }
    },
    [checkForUpdates]
  );

  useEffect(() => {
    const handledOpenDetails = new WeakSet<object>();
    const removeOpenListener = ipcBridge.update.open.on((evt) => {
      openUpdateNotification(evt?.source ?? 'menu', true);
    });
    const handleWindowOpen = (evt: Event) => {
      const detail = (evt as CustomEvent<{ source?: UpdateNotificationOpenSource }>).detail;
      // Active code emits canonical and legacy events together. Handle the
      // shared detail object only once while still accepting legacy-only input.
      if (detail && typeof detail === 'object') {
        if (handledOpenDetails.has(detail)) return;
        handledOpenDetails.add(detail);
      }
      const source = detail?.source ?? 'about';
      openUpdateNotification(source, true);
    };
    window.addEventListener(OPEN_UPDATE_MODAL_EVENT, handleWindowOpen);
    window.addEventListener(LEGACY_OPEN_UPDATE_MODAL_EVENT, handleWindowOpen);

    // The About button runs its own check and only reveals the card when an
    // update is actually available, handing over the already-fetched outcome.
    const handledAvailableOutcomes = new WeakSet<object>();
    const handleAvailable = (evt: Event) => {
      const outcome = (evt as CustomEvent<AvailableOutcome>).detail;
      if (outcome && typeof outcome === 'object') {
        if (handledAvailableOutcomes.has(outcome)) return;
        handledAvailableOutcomes.add(outcome);
      }
      if (outcome?.kind === 'available') {
        presentAvailableOutcome(outcome);
      }
    };
    window.addEventListener(UPDATE_AVAILABLE_EVENT, handleAvailable);
    window.addEventListener(LEGACY_UPDATE_AVAILABLE_EVENT, handleAvailable);

    return () => {
      removeOpenListener();
      window.removeEventListener(OPEN_UPDATE_MODAL_EVENT, handleWindowOpen);
      window.removeEventListener(LEGACY_OPEN_UPDATE_MODAL_EVENT, handleWindowOpen);
      window.removeEventListener(UPDATE_AVAILABLE_EVENT, handleAvailable);
      window.removeEventListener(LEGACY_UPDATE_AVAILABLE_EVENT, handleAvailable);
    };
  }, [openUpdateNotification, presentAvailableOutcome]);

  useEffect(() => {
    const removeListener = ipcBridge.autoUpdate.status.on((evt: AutoUpdateStatus) => {
      if (!evt) return;

      switch (evt.status) {
        case 'available':
          if (
            checkingRef.current ||
            ['downloading', 'downloaded', 'preparing-install'].includes(stateRef.current.status)
          )
            break;
          if (restoreDownloadedPendingRef.current) {
            break;
          }
          dispatchAutoAvailable(evt);
          break;
        case 'downloading': {
          const progress = toAutoProgress(evt, i18n.language);
          if (progress) {
            dispatch({ type: 'autoProgress', progress });
          }
          break;
        }
        case 'downloaded':
          dispatch({ type: 'autoDownloaded' });
          break;
        case 'preparing-install':
          dispatch({ type: 'autoPreparingInstall', version: evt.version });
          break;
        case 'error':
          if (silentCheckRef.current) break;
          dispatch({ type: 'autoError', message: evt.error || t('update.downloadFailed') });
          break;
        case 'checking':
        case 'not-available':
        case 'cancelled':
          break;
      }
    });

    return () => removeListener();
  }, [dispatchAutoAvailable, t, i18n.language]);

  useEffect(() => {
    const removeProgressListener = ipcBridge.update.downloadProgress.on((evt: UpdateDownloadProgressEvent) => {
      if (!evt) return;
      const pending = pendingManualRef.current;
      if (pending && evt.downloadId !== pending.requestId) {
        // IPC terminal events can precede the response that hands us an
        // existing deduplicated task. Retain only a bounded latest state.
        if (pending.events.size >= 8 && !pending.events.has(evt.downloadId))
          pending.events.delete(pending.events.keys().next().value!);
        pending.events.set(evt.downloadId, evt);
      }
      dispatch({
        type: 'manualProgress',
        downloadId: evt.downloadId,
        status: evt.status,
        progress: toManualProgress(evt, i18n.language),
        filePath: evt.file_path,
        error: evt.error || t('update.downloadFailed'),
      });
    });

    return () => removeProgressListener();
  }, [t, i18n.language]);

  const openReleasePage = useCallback(() => {
    if (!state.releasePageUrl) return;
    void ipcBridge.shell.openExternal.invoke(state.releasePageUrl).catch((error) => {
      console.error('Failed to open release page:', error);
    });
  }, [state.releasePageUrl]);

  const startAutoDownload = useCallback(async () => {
    dispatch({ type: 'autoDownloadStarted' });
    const res = await ipcBridge.autoUpdate.download.invoke();
    if (!res?.success) {
      dispatch({ type: 'autoError', message: res?.msg || t('update.downloadStartFailed') });
    }
  }, [t]);

  const startManualInstallDownload = useCallback(async () => {
    const asset = state.updateInfo?.recommendedAsset;
    if (!asset) return;

    const callerDownloadId = uuid();
    const pending = { requestId: callerDownloadId, events: new Map<string, UpdateDownloadProgressEvent>() };
    pendingManualRef.current = pending;
    dispatch({ type: 'manualDownloadStarted', downloadId: callerDownloadId });

    try {
      const res = await ipcBridge.update.download.invoke({
        downloadId: callerDownloadId,
        url: asset.url,
        fallbackUrl: asset.fallbackUrl,
        file_name: asset.name,
      });
      if (stateRef.current.activeTask?.id !== callerDownloadId) {
        if (pendingManualRef.current === pending && !stateRef.current.activeTask && res?.success && res.data)
          await ipcBridge.update.cancelDownload.invoke({ downloadId: res.data.downloadId });
        return;
      }
      if (!res?.success || !res.data) throw new Error(res?.msg || t('update.downloadStartFailed'));
      dispatch({
        type: 'manualDownloadReady',
        requestId: callerDownloadId,
        downloadId: res.data.downloadId,
        filePath: res.data.file_path,
      });
      const buffered = pending.events.get(res.data.downloadId);
      if (buffered)
        dispatch({
          type: 'manualProgress',
          downloadId: buffered.downloadId,
          status: buffered.status,
          progress: toManualProgress(buffered, i18n.language),
          filePath: buffered.file_path,
          error: buffered.error || t('update.downloadFailed'),
        });
    } catch (error) {
      dispatch({
        type: 'manualProgress',
        downloadId: callerDownloadId,
        status: 'error',
        progress: stateRef.current.progress,
        error: String(error),
      });
    } finally {
      if (pendingManualRef.current === pending) pendingManualRef.current = null;
    }
  }, [state.updateInfo?.recommendedAsset, t, i18n.language]);

  const startDownload = useCallback(() => {
    if (['downloading', 'downloaded', 'preparing-install'].includes(stateRef.current.status)) return;
    dispatch({ type: 'restoreRequested' });
    if (state.autoUpdateAvailable) {
      void startAutoDownload().catch((error) => dispatch({ type: 'autoError', message: String(error) }));
      return;
    }
    if (!state.updateInfo?.recommendedAsset) {
      openReleasePage();
      return;
    }
    void startManualInstallDownload().catch((error) => dispatch({ type: 'autoError', message: String(error) }));
  }, [startAutoDownload, startManualInstallDownload, state.autoUpdateAvailable, state.updateInfo, openReleasePage]);

  const performInstall = useCallback(() => {
    const current = stateRef.current;
    if (current.status !== 'downloaded') return;
    if (current.downloadPath) {
      void ipcBridge.shell.openFile
        .invoke(current.downloadPath)
        .catch((error) => dispatch({ type: 'autoError', message: String(error) }));
      return;
    }
    const version = getVersionLabelFromState(current);
    dispatch({ type: 'autoPreparingInstall', version });
    setUpdateReadyState({
      ready: true,
      version,
      preparing: true,
    });
    void ipcBridge.autoUpdate.quitAndInstall.invoke().catch(() => {
      if (stateRef.current.status !== 'preparing-install') return;
      dispatch({
        type: 'autoError',
        message: t('update.errors.prepareInstallFailed'),
      });
    });
  }, [dispatch, t]);

  const quitAndInstall = useCallback(() => {
    if (stateRef.current.status !== 'downloaded') return;
    confirmUpdateInstall(
      {
        title: t('update.readyToInstall'),
        content: t('update.confirmInstallDescription'),
        okText: t('update.confirmInstall'),
        cancelText: t('update.cancel'),
      },
      performInstall
    );
  }, [performInstall, t]);

  useEffect(() => {
    const handle = () => {
      const current = stateRef.current;
      if (current.status === 'available') startDownload();
      else if (current.status === 'downloaded') quitAndInstall();
      else if (current.status === 'error') void checkForUpdates();
      else dispatch({ type: 'restoreRequested' });
    };
    window.addEventListener(SIDEBAR_UPDATE_ACTION_EVENT, handle);
    return () => window.removeEventListener(SIDEBAR_UPDATE_ACTION_EVENT, handle);
  }, [startDownload, quitAndInstall, checkForUpdates]);

  const openFile = useCallback(() => {
    if (!state.downloadPath) return;
    void ipcBridge.shell.openFile.invoke(state.downloadPath);
  }, [state.downloadPath]);

  const showInFolder = useCallback(() => {
    if (!state.downloadPath) return;
    void ipcBridge.shell.showItemInFolder.invoke(state.downloadPath);
  }, [state.downloadPath]);

  const viewInstallerLastFailureLog = useCallback(() => {
    const logPath = state.installerLastFailure?.logPath;
    if (!logPath) return;
    void ipcBridge.shell.showItemInFolder.invoke(logPath);
  }, [state.installerLastFailure?.logPath]);

  const dismiss = useCallback((reason: 'later' | 'close') => {
    dispatch({ type: 'dismissRequested', reason });
  }, []);

  const cancelTask = useCallback(async (task: UpdateNotificationActiveTask | null) => {
    if (!task) return;
    if (task.kind === 'manual') {
      await ipcBridge.update.cancelDownload.invoke({ downloadId: task.id });
      return;
    }
    await ipcBridge.autoUpdate.cancelDownload.invoke();
  }, []);

  const cancelDownload = useCallback(() => {
    const task = stateRef.current.activeTask;
    dispatch({ type: 'cancelDownloadRequested' });
    void cancelTask(task).catch((error) => {
      dispatch({
        type: 'autoError',
        message: error instanceof Error ? error.message : String(error),
      });
    });
  }, [cancelTask]);

  const minimize = useCallback(() => {
    dispatch({ type: 'minimizeRequested' });
  }, []);

  const restore = useCallback(() => {
    dispatch({ type: 'restoreRequested' });
  }, []);

  const versionLabel = useMemo(() => getVersionLabelFromState(state), [state]);
  const showManualInstallFallback = Boolean(state.autoUpdateAvailable && state.updateInfo?.recommendedAsset);

  useEffect(() => {
    if ((state.status === 'downloaded' || state.status === 'preparing-install') && versionLabel) {
      setUpdateReadyState({
        ready: true,
        version: versionLabel,
        filePath: state.downloadPath || undefined,
        preparing: state.status === 'preparing-install',
      });
      return;
    }
    if (state.status === 'available' || state.status === 'idle' || state.status === 'error') {
      setUpdateReadyState({
        ready: false,
        version: '',
      });
    }
  }, [state.downloadPath, state.status, versionLabel]);

  return {
    state,
    versionLabel,
    showManualInstallFallback,
    actions: {
      checkForUpdates,
      openReleasePage,
      startManualInstallDownload,
      startDownload,
      quitAndInstall,
      openFile,
      showInFolder,
      viewInstallerLastFailureLog,
      dismiss,
      cancelDownload,
      minimize,
      restore,
    },
  };
};
