/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { createShutdownRelaunchGate, shouldRegisterBackendStartup } from '@/process/startup/singleInstanceGating';

describe('shouldRegisterBackendStartup', () => {
  it('registers the backend startup flow only for the single-instance lock owner', () => {
    expect(shouldRegisterBackendStartup(true)).toBe(true);
  });

  it('never registers backend startup for a lock-losing instance', () => {
    expect(shouldRegisterBackendStartup(false)).toBe(false);
  });
});

it('defers a new launch while the old process is shutting down and schedules exactly one fresh instance', () => {
  let quitting = false;
  let launches = 0;
  const deferLaunch = createShutdownRelaunchGate({
    isQuitting: () => quitting,
    relaunch: () => {
      launches++;
    },
  });
  expect(deferLaunch()).toBe(false);
  expect(launches).toBe(0);
  quitting = true;
  expect(deferLaunch()).toBe(true);
  expect(deferLaunch()).toBe(true);
  expect(launches).toBe(1);
});

it('preserves the deep link from a deferred launch', () => {
  const links: Array<string | undefined> = [];
  const deferLaunch = createShutdownRelaunchGate({
    isQuitting: () => true,
    relaunch: (link) => {
      links.push(link);
    },
  });
  expect(deferLaunch('openh3://conversation/test')).toBe(true);
  expect(links).toEqual(['openh3://conversation/test']);
});
