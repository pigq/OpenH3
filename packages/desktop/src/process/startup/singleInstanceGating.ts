/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Decide whether this process is allowed to register the backend startup flow
 * (whenReady -> handleAppReady -> startBackendOrExit).
 *
 * Only the instance that owns the single-instance lock may spawn aioncore. A
 * lock-losing instance must never register backend startup; otherwise it races
 * the first instance's aioncore over the same data directory, which produced
 * the "local data repair failed" false alarm in Sentry 135525166.
 *
 * Extracted as a pure function so the gating decision is unit-testable without
 * importing index.ts (whose module top-level runs heavy Electron side effects).
 */
export function shouldRegisterBackendStartup(gotTheLock: boolean): boolean {
  return gotTheLock === true;
}

/** A second launch during asynchronous quit must run after the old process exits. */
export function createShutdownRelaunchGate(deps: {
  isQuitting: () => boolean;
  relaunch: (deepLinkUrl?: string) => void;
}): (deepLinkUrl?: string) => boolean {
  let scheduled = false;
  return (deepLinkUrl) => {
    if (!deps.isQuitting()) return false;
    if (!scheduled) {
      deps.relaunch(deepLinkUrl);
      scheduled = true;
    }
    return true;
  };
}
