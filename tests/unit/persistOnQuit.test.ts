/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { appHandlers, appQuit } = vi.hoisted(() => ({
  appHandlers: {} as Record<string, Array<(...args: unknown[]) => void>>,
  appQuit: vi.fn(),
}));

const fireAppEvent = (event: string, ...args: unknown[]) => {
  for (const fn of appHandlers[event] ?? []) fn(...args);
};

vi.mock('electron', () => ({
  app: {
    on: (event: string, fn: (...args: unknown[]) => void) => {
      (appHandlers[event] ??= []).push(fn);
    },
    quit: appQuit,
  },
}));

import { trackPersistedWrite, __resetPersistOnQuitForTests } from '@/process/utils/persistOnQuit';
import { installQuitCleanup } from '@/process/startup/quitCleanup';

const deferredWrite = () => {
  let resolve!: () => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

// Give all currently queued Promise reactions a turn without polling pending writes.
const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve));

const installOrdinaryQuitHarness = () => {
  let isQuitting = false;
  let isExplicitQuit = false;
  let terminated = 0;
  const closeToTrayPreventions = vi.fn();
  const webUiQuitPreventions = vi.fn();
  const stopBackend = vi.fn(async () => {});
  const destroyTray = vi.fn();

  appQuit.mockImplementation(() => {
    if (terminated > 0) return;
    let prevented = false;
    fireAppEvent('before-quit', {
      preventDefault: () => {
        prevented = true;
      },
    });
    if (prevented) return;
    // Model index.ts close-to-tray and WebUI will-quit guards after before-quit.
    if (!isQuitting) {
      closeToTrayPreventions();
      return;
    }
    if (!isExplicitQuit) {
      webUiQuitPreventions();
      return;
    }
    terminated += 1;
  });

  installQuitCleanup({
    onBeforeQuit: (handler) => {
      (appHandlers['before-quit'] ??= []).push(handler);
    },
    quitApp: appQuit,
    setIsQuitting: (value) => {
      isQuitting = value;
    },
    markExplicitQuit: () => {
      isExplicitQuit = true;
    },
    destroyTray,
    disposeCronResumeListener: vi.fn(),
    stopBackend,
    destroyPetWindow: vi.fn(),
    logInfo: vi.fn(),
    logWarn: vi.fn(),
    logError: vi.fn(),
  });

  return {
    state: () => ({ isQuitting, isExplicitQuit, terminated }),
    closeToTrayPreventions,
    webUiQuitPreventions,
    stopBackend,
    destroyTray,
  };
};

describe('persistOnQuit', () => {
  beforeEach(() => {
    for (const key of Object.keys(appHandlers)) delete appHandlers[key];
    appQuit.mockReset();
    __resetPersistOnQuitForTests();
  });

  it('defers app.quit until a pending write resolves', async () => {
    let resolveWrite: (() => void) | undefined;
    trackPersistedWrite(
      new Promise<void>((r) => {
        resolveWrite = r;
      })
    );

    const preventDefault = vi.fn();
    fireAppEvent('before-quit', { preventDefault });
    expect(preventDefault).toHaveBeenCalled();
    expect(appQuit).not.toHaveBeenCalled();

    resolveWrite?.();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(appQuit).toHaveBeenCalled();
  });

  it('does not block quit when no writes are pending', async () => {
    // Track a write and let it settle so the pending set is empty.
    trackPersistedWrite(Promise.resolve());
    await Promise.resolve();
    await Promise.resolve();

    const preventDefault = vi.fn();
    fireAppEvent('before-quit', { preventDefault });
    expect(preventDefault).not.toHaveBeenCalled();
  });

  it('still allows quit when a tracked write rejects', async () => {
    let rejectWrite: ((reason: Error) => void) | undefined;
    trackPersistedWrite(
      new Promise<void>((_resolve, reject) => {
        rejectWrite = reject;
      })
    );

    const preventDefault = vi.fn();
    fireAppEvent('before-quit', { preventDefault });
    expect(preventDefault).toHaveBeenCalled();

    rejectWrite?.(new Error('disk full'));
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(appQuit).toHaveBeenCalled();
  });

  it('keeps blocking repeated before-quit events while writes are still flushing', async () => {
    let resolveWrite: (() => void) | undefined;
    trackPersistedWrite(
      new Promise<void>((resolve) => {
        resolveWrite = resolve;
      })
    );

    const firstPreventDefault = vi.fn();
    fireAppEvent('before-quit', { preventDefault: firstPreventDefault });
    expect(firstPreventDefault).toHaveBeenCalled();

    const secondPreventDefault = vi.fn();
    fireAppEvent('before-quit', { preventDefault: secondPreventDefault });
    expect(secondPreventDefault).toHaveBeenCalled();
    expect(appQuit).not.toHaveBeenCalled();

    resolveWrite?.();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(appQuit).toHaveBeenCalled();
  });

  it('waits for writes registered during a flush before requesting quit', async () => {
    const first = deferredWrite();
    const late = deferredWrite();
    trackPersistedWrite(first.promise);
    fireAppEvent('before-quit', { preventDefault: vi.fn() });
    trackPersistedWrite(late.promise);

    first.resolve();
    await nextTurn();
    const prematureQuitCalls = appQuit.mock.calls.length;
    const preventRepeatedQuit = vi.fn();
    fireAppEvent('before-quit', { preventDefault: preventRepeatedQuit });
    late.resolve();
    await nextTurn();

    expect(prematureQuitCalls).toBe(0);
    expect(preventRepeatedQuit).toHaveBeenCalledTimes(1);
    expect(appQuit).toHaveBeenCalledTimes(1);
  });

  it('waits for a late rejected write without suppressing its original rejection', async () => {
    const first = deferredWrite();
    const late = deferredWrite();
    trackPersistedWrite(first.promise);
    fireAppEvent('before-quit', { preventDefault: vi.fn() });
    expect(trackPersistedWrite(late.promise)).toBe(late.promise);
    const rejection = expect(late.promise).rejects.toThrow('late disk error');

    first.resolve();
    await nextTurn();
    const prematureQuitCalls = appQuit.mock.calls.length;
    late.reject(new Error('late disk error'));
    await rejection;
    await nextTurn();

    expect(prematureQuitCalls).toBe(0);
    expect(appQuit).toHaveBeenCalledTimes(1);
  });

  it('includes a late write registered by a deferred settlement reaction', async () => {
    const first = deferredWrite();
    const late = deferredWrite();
    trackPersistedWrite(first.promise);
    fireAppEvent('before-quit', { preventDefault: vi.fn() });
    const registerLate = first.promise.then(async () => {
      await Promise.resolve();
      trackPersistedWrite(late.promise);
    });

    first.resolve();
    await registerLate;
    await nextTurn();
    const prematureQuitCalls = appQuit.mock.calls.length;
    late.resolve();
    await nextTurn();

    expect(prematureQuitCalls).toBe(0);
    expect(appQuit).toHaveBeenCalledTimes(1);
  });

  it('starts a new flush if another quit attempt encounters a new write', async () => {
    const first = deferredWrite();
    trackPersistedWrite(first.promise);
    fireAppEvent('before-quit', { preventDefault: vi.fn() });
    first.resolve();
    await nextTurn();
    expect(appQuit).toHaveBeenCalledTimes(1);

    const next = deferredWrite();
    trackPersistedWrite(next.promise);
    const preventDefault = vi.fn();
    fireAppEvent('before-quit', { preventDefault });
    next.resolve();
    await nextTurn();

    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(appQuit).toHaveBeenCalledTimes(2);
  });

  it('does not create duplicate drains for repeated quit and track calls', async () => {
    const write = deferredWrite();
    expect(trackPersistedWrite(write.promise)).toBe(write.promise);
    expect(trackPersistedWrite(write.promise)).toBe(write.promise);
    for (let i = 0; i < 3; i += 1) {
      const preventDefault = vi.fn();
      fireAppEvent('before-quit', { preventDefault });
      expect(preventDefault).toHaveBeenCalledTimes(1);
    }
    await nextTurn();
    expect(appQuit).not.toHaveBeenCalled();

    write.resolve();
    await nextTurn();
    expect(appQuit).toHaveBeenCalledTimes(1);
  });

  it('allows an empty pending set synchronously without scheduling another quit', async () => {
    trackPersistedWrite(Promise.resolve());
    await nextTurn();
    const preventDefault = vi.fn();
    fireAppEvent('before-quit', { preventDefault });
    expect(preventDefault).not.toHaveBeenCalled();
    expect(appQuit).not.toHaveBeenCalled();
    await nextTurn();
    expect(appQuit).not.toHaveBeenCalled();
  });

  describe('ordinary app.quit integration with quitCleanup', () => {
    it.each(['persistence-first', 'cleanup-first'] as const)(
      'exits only after both batches settle with %s listener order',
      async (order) => {
        const first = deferredWrite();
        const late = deferredWrite();
        if (order === 'persistence-first') trackPersistedWrite(first.promise);
        const harness = installOrdinaryQuitHarness();
        if (order === 'cleanup-first') trackPersistedWrite(first.promise);

        appQuit();
        expect(harness.state()).toEqual({ isQuitting: true, isExplicitQuit: true, terminated: 0 });
        trackPersistedWrite(late.promise);
        appQuit();
        await nextTurn();
        first.resolve();
        await nextTurn();
        const stateBeforeLate = harness.state();
        late.resolve();
        await nextTurn();

        expect(stateBeforeLate.terminated).toBe(0);
        expect(harness.state()).toEqual({ isQuitting: true, isExplicitQuit: true, terminated: 1 });
        expect(harness.stopBackend).toHaveBeenCalledTimes(1);
        expect(harness.destroyTray).toHaveBeenCalledTimes(1);
        expect(harness.closeToTrayPreventions).not.toHaveBeenCalled();
        expect(harness.webUiQuitPreventions).not.toHaveBeenCalled();
      }
    );

    it('drains a write added by an earlier listener during the final retry quit', async () => {
      const first = deferredWrite();
      const reentrant = deferredWrite();
      let injectOnNextQuit = false;
      (appHandlers['before-quit'] ??= []).push(() => {
        if (injectOnNextQuit) {
          injectOnNextQuit = false;
          trackPersistedWrite(reentrant.promise);
        }
      });
      trackPersistedWrite(first.promise);
      const harness = installOrdinaryQuitHarness();
      appQuit();
      await nextTurn();
      injectOnNextQuit = true;
      first.resolve();
      await nextTurn();
      const stateBeforeReentrant = harness.state();
      appQuit();
      reentrant.reject(new Error('retry write failed'));
      await nextTurn();

      expect(injectOnNextQuit).toBe(false);
      expect(stateBeforeReentrant.terminated).toBe(0);
      expect(harness.state()).toEqual({ isQuitting: true, isExplicitQuit: true, terminated: 1 });
      expect(harness.stopBackend).toHaveBeenCalledTimes(1);
      expect(harness.closeToTrayPreventions).not.toHaveBeenCalled();
      expect(harness.webUiQuitPreventions).not.toHaveBeenCalled();
    });
  });
});
