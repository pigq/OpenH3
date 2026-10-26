/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/common/platform/bridge', () => ({
  bridge: {
    buildProvider: vi.fn(() => {
      const handlerMap = new Map<string, Function>();
      return {
        provider: vi.fn((handler: Function) => {
          handlerMap.set('handler', handler);
          return vi.fn();
        }),
        invoke: vi.fn(),
        _getHandler: () => handlerMap.get('handler'),
      };
    }),
    buildEmitter: vi.fn(() => ({
      emit: vi.fn(),
      on: vi.fn(),
    })),
  },
}));

vi.mock('electron', () => ({
  app: {
    getVersion: vi.fn(() => '2.1.40'),
    getPath: vi.fn(() => '/test/path'),
    exit: vi.fn(),
    isPackaged: true,
  },
  autoUpdater: {
    on: vi.fn(),
    removeListener: vi.fn(),
  },
}));

vi.mock('electron-updater', () => ({
  autoUpdater: {
    logger: null,
    autoDownload: false,
    autoInstallOnAppQuit: true,
    allowPrerelease: false,
    allowDowngrade: false,
    setFeedURL: vi.fn(),
    on: vi.fn(),
    removeListener: vi.fn(),
    checkForUpdates: vi.fn(),
    downloadUpdate: vi.fn(),
    quitAndInstall: vi.fn(),
    checkForUpdatesAndNotify: vi.fn(),
  },
}));

vi.mock('electron-log', () => ({
  default: {
    transports: { file: { level: 'info' } },
    debug: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  },
}));

vi.mock('@process/services/i18n', () => ({
  default: { t: (key: string) => key },
}));

// The fixtures below are mac-arm64 assets and both resolveCdnChannelFile and
// pickRecommendedAsset read the host platform/arch, so pin the runtime to keep
// results identical on every CI runner (linux/windows x64 would otherwise
// filter the assets out and pick no recommended asset).
import { afterAll, beforeAll } from 'vitest';

const realPlatform = process.platform;
const realArch = process.arch;
beforeAll(() => {
  Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
  Object.defineProperty(process, 'arch', { value: 'arm64', configurable: true });
});
afterAll(() => {
  Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true });
  Object.defineProperty(process, 'arch', { value: realArch, configurable: true });
});

const getCheckHandler = async () => {
  vi.resetModules();
  const { initUpdateBridge } = await import('@process/bridge/updateBridge');
  const { ipcBridge } = await import('@/common');
  initUpdateBridge();
  const provider = vi.mocked(ipcBridge.update.check.provider);
  const lastCall = provider.mock.calls.at(-1);
  if (!lastCall) throw new Error('update.check handler not registered');
  return lastCall[0];
};

const release = (tag_name = 'v2.1.45', extra = {}) => ({
  tag_name,
  html_url: 'https://github.com/pigq/OpenH3/releases/tag/' + tag_name,
  body: 'notes',
  draft: false,
  prerelease: false,
  assets: [
    {
      name: 'OpenH3-mac-arm64.dmg',
      browser_download_url: 'https://github.com/pigq/OpenH3/releases/download/' + tag_name + '/OpenH3-mac-arm64.dmg',
      size: 12,
    },
  ],
  ...extra,
});
describe('GitHub-only update checks', () => {
  afterEach(() => vi.unstubAllGlobals());
  const serve = (data: unknown, status = 200) =>
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(data), { status }))
    );
  it('uses the fixed repository and original asset URL', async () => {
    serve([release()]);
    const result = await (await getCheckHandler())({ repo: 'other/repo' });
    expect(result.success).toBe(true);
    expect(result.data?.updateAvailable).toBe(true);
    expect(result.data?.latest?.body).toBe('notes');
    expect(result.data?.latest?.assets[0].url).toContain('/pigq/OpenH3/releases/download/v2.1.45/');
    expect(result.data?.latest?.assets[0].fallbackUrl).toBeUndefined();
    expect(fetch).toHaveBeenCalledWith('https://api.github.com/repos/pigq/OpenH3/releases', expect.anything());
  });
  it('filters drafts, invalid tags and prereleases and sorts semver', async () => {
    serve([
      release('v9.0.0', { draft: true }),
      release('invalid'),
      release('v3.0.0-beta.1', { prerelease: true }),
      release('v2.1.41'),
      release(),
    ]);
    const result = await (await getCheckHandler())({});
    expect(result.data?.latest?.version).toBe('2.1.45');
  });
  it('allows opted-in prereleases', async () => {
    serve([release(), release('v3.0.0-beta.1', { prerelease: true })]);
    expect((await (await getCheckHandler())({ includePrerelease: true })).data?.latest?.version).toBe('3.0.0-beta.1');
  });
  it('does not downgrade', async () => {
    serve([release('v1.0.0')]);
    expect((await (await getCheckHandler())({})).data?.updateAvailable).toBe(false);
  });
  it('handles empty releases', async () => {
    serve([]);
    expect((await (await getCheckHandler())({})).data?.updateAvailable).toBe(false);
  });
  it('fails without another source when GitHub fails', async () => {
    serve({}, 503);
    expect((await (await getCheckHandler())({})).success).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
