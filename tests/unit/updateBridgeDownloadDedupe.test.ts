/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'fs';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
    getVersion: vi.fn(() => '1.0.0'),
    getPath: vi.fn(() => '/tmp/aionui-update-dedupe-test'),
    exit: vi.fn(),
    isPackaged: true,
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

const getDownloadHandler = async () => {
  vi.resetModules();
  const { initUpdateBridge } = await import('@process/bridge/updateBridge');
  const { ipcBridge } = await import('@/common');

  initUpdateBridge();

  const provider = vi.mocked(ipcBridge.update.download.provider);
  const lastCall = provider.mock.calls.at(-1);
  if (!lastCall) throw new Error('update.download handler not registered');
  return lastCall[0];
};

const getDownloadHandlers = async () => {
  vi.resetModules();
  const { initUpdateBridge } = await import('@process/bridge/updateBridge');
  const { ipcBridge } = await import('@/common');

  initUpdateBridge();

  const downloadProvider = vi.mocked(ipcBridge.update.download.provider);
  const cancelProvider = vi.mocked(ipcBridge.update.cancelDownload.provider);
  const downloadCall = downloadProvider.mock.calls.at(-1);
  const cancelCall = cancelProvider.mock.calls.at(-1);
  if (!downloadCall) throw new Error('update.download handler not registered');
  if (!cancelCall) throw new Error('update.download.cancel handler not registered');
  return {
    download: downloadCall[0],
    cancel: cancelCall[0],
    ipcBridge,
  };
};

describe('updateBridge manual download dedupe', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise<Response>(() => {}))
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reuses the active manual download for the same URL, fallback URL, and file name', async () => {
    const handler = await getDownloadHandler();
    const request = {
      url: 'https://github.com/pigq/OpenH3/releases/download/v2.2.0/AionUi-2.2.0-mac-arm64.dmg',
      fallbackUrl: 'https://github.com/pigq/OpenH3/releases/download/v2.2.0/AionUi-2.2.0-mac-arm64.dmg',
      file_name: 'AionUi-2.2.0-mac-arm64.dmg',
    };

    const first = await handler({
      ...request,
      downloadId: 'first-download',
    });
    const second = await handler({
      ...request,
      downloadId: 'second-download',
    });

    expect(first.success).toBe(true);
    expect(second.success).toBe(true);
    expect(second.data).toEqual(first.data);
    expect(first.data?.downloadId).toBe('first-download');
  });

  it('creates a new manual download after the prior matching task reaches a terminal state', async () => {
    fs.mkdirSync('/tmp/aionui-update-dedupe-test', { recursive: true });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        headers: new Headers({ 'content-length': '0' }),
        body: {
          getReader: () => ({
            read: async () => ({ done: true, value: undefined }),
          }),
        },
      })
    );

    const handler = await getDownloadHandler();
    const request = {
      url: 'https://github.com/pigq/OpenH3/releases/download/v2.2.0/AionUi-2.2.0-mac-arm64.dmg',
      fallbackUrl: 'https://github.com/pigq/OpenH3/releases/download/v2.2.0/AionUi-2.2.0-mac-arm64.dmg',
      file_name: 'AionUi-2.2.0-mac-arm64.dmg',
    };

    const first = await handler({
      ...request,
      downloadId: 'first-download',
    });

    const { ipcBridge } = await import('@/common');
    await expect
      .poll(() =>
        vi.mocked(ipcBridge.update.downloadProgress.emit).mock.calls.some(([evt]) => evt.status === 'completed')
      )
      .toBe(true);

    const second = await handler({
      ...request,
      downloadId: 'second-download',
    });

    expect(first.success).toBe(true);
    expect(second.success).toBe(true);
    expect(first.data?.downloadId).toBe('first-download');
    expect(second.data?.downloadId).toBe('second-download');
  });

  it('cancels an active manual download by download id and clears its dedupe slot', async () => {
    fs.mkdirSync('/tmp/aionui-update-dedupe-test', { recursive: true });
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init?: RequestInit) => {
        const signal = init?.signal;
        return new Promise<Response>((_resolve, reject) => {
          signal?.addEventListener('abort', () => {
            reject(new DOMException('aborted', 'AbortError'));
          });
        });
      })
    );

    const { download, cancel, ipcBridge } = await getDownloadHandlers();
    const request = {
      url: 'https://github.com/pigq/OpenH3/releases/download/v2.2.0/AionUi-2.2.0-mac-arm64.dmg',
      fallbackUrl: 'https://github.com/pigq/OpenH3/releases/download/v2.2.0/AionUi-2.2.0-mac-arm64.dmg',
      file_name: 'AionUi-2.2.0-mac-arm64.dmg',
    };

    const first = await download({
      ...request,
      downloadId: 'first-download',
    });
    const cancelResult = await cancel({ downloadId: 'first-download' });

    expect(first.success).toBe(true);
    expect(cancelResult).toEqual({ success: true });
    await expect
      .poll(() =>
        vi
          .mocked(ipcBridge.update.downloadProgress.emit)
          .mock.calls.some(([evt]) => evt.downloadId === 'first-download' && evt.status === 'cancelled')
      )
      .toBe(true);

    const second = await download({
      ...request,
      downloadId: 'second-download',
    });

    expect(second.success).toBe(true);
    expect(second.data?.downloadId).toBe('second-download');
  });

  it.each([
    [
      'missing digest',
      'https://bohuauhd.oss-cn-shenzhen.aliyuncs.com/updates/stable/3.0.8/OpenH3-3.0.8-win-x64.exe',
      undefined,
    ],
    ['empty digest', 'https://bohuauhd.oss-cn-shenzhen.aliyuncs.com/updates/stable/3.0.8/OpenH3-3.0.8-win-x64.exe', ''],
    [
      'HTTP scheme',
      'http://bohuauhd.oss-cn-shenzhen.aliyuncs.com/updates/stable/3.0.8/OpenH3-3.0.8-win-x64.exe',
      'a'.repeat(64),
    ],
    [
      'alternate port',
      'https://bohuauhd.oss-cn-shenzhen.aliyuncs.com:444/updates/stable/3.0.8/OpenH3-3.0.8-win-x64.exe',
      'a'.repeat(64),
    ],
    [
      'path traversal',
      'https://bohuauhd.oss-cn-shenzhen.aliyuncs.com/updates/stable/3.0.8/../3.0.8/OpenH3-3.0.8-win-x64.exe',
      'a'.repeat(64),
    ],
    [
      'prefix lookalike',
      'https://bohuauhd.oss-cn-shenzhen.aliyuncs.com/updates/stable-evil/3.0.8/OpenH3-3.0.8-win-x64.exe',
      'a'.repeat(64),
    ],
    [
      'sibling bucket',
      'https://other.oss-cn-shenzhen.aliyuncs.com/updates/stable/3.0.8/OpenH3-3.0.8-win-x64.exe',
      'a'.repeat(64),
    ],
    [
      'user info',
      'https://user@bohuauhd.oss-cn-shenzhen.aliyuncs.com/updates/stable/3.0.8/OpenH3-3.0.8-win-x64.exe',
      'a'.repeat(64),
    ],
  ])('rejects an OSS download with %s', async (_label, url, sha256) => {
    const handler = await getDownloadHandler();
    const result = await handler({
      url,
      fallbackUrl: 'https://github.com/pigq/OpenH3/releases/download/v3.0.8/OpenH3-3.0.8-win-x64.exe',
      sha256,
      file_name: 'OpenH3-3.0.8-win-x64.exe',
    });

    expect(result.success).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('falls back from OSS to GitHub and validates the streamed SHA-256', async () => {
    fs.mkdirSync('/tmp/aionui-update-dedupe-test', { recursive: true });
    const content = Buffer.from('verified installer bytes');
    const sha256 = createHash('sha256').update(content).digest('hex');
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('missing', { status: 503 }))
      .mockResolvedValueOnce(
        new Response(content, { status: 200, headers: { 'content-length': String(content.byteLength) } })
      );
    vi.stubGlobal('fetch', fetchMock);
    const handler = await getDownloadHandler();

    const result = await handler({
      url: 'https://bohuauhd.oss-cn-shenzhen.aliyuncs.com/updates/stable/3.0.8/OpenH3-3.0.8-win-x64.exe',
      fallbackUrl: 'https://github.com/pigq/OpenH3/releases/download/v3.0.8/OpenH3-3.0.8-win-x64.exe',
      sha256,
      file_name: 'OpenH3-3.0.8-win-x64.exe',
    });
    const { ipcBridge } = await import('@/common');

    expect(result.success).toBe(true);
    await expect
      .poll(() =>
        vi.mocked(ipcBridge.update.downloadProgress.emit).mock.calls.some(([evt]) => evt.status === 'completed')
      )
      .toBe(true);
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      'https://bohuauhd.oss-cn-shenzhen.aliyuncs.com/updates/stable/3.0.8/OpenH3-3.0.8-win-x64.exe',
      'https://github.com/pigq/OpenH3/releases/download/v3.0.8/OpenH3-3.0.8-win-x64.exe',
    ]);
  });

  it('rejects both sources when neither installer matches the validated SHA-256', async () => {
    fs.mkdirSync('/tmp/aionui-update-dedupe-test', { recursive: true });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('broken OSS bytes', { status: 200 }))
      .mockResolvedValueOnce(new Response('broken GitHub bytes', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const handler = await getDownloadHandler();

    const result = await handler({
      url: 'https://bohuauhd.oss-cn-shenzhen.aliyuncs.com/updates/stable/3.0.8/OpenH3-3.0.8-win-x64.exe',
      fallbackUrl: 'https://github.com/pigq/OpenH3/releases/download/v3.0.8/OpenH3-3.0.8-win-x64.exe',
      sha256: 'a'.repeat(64),
      file_name: 'OpenH3-3.0.8-win-x64.exe',
    });
    const { ipcBridge } = await import('@/common');

    expect(result.success).toBe(true);
    await expect
      .poll(() => vi.mocked(ipcBridge.update.downloadProgress.emit).mock.calls.some(([evt]) => evt.status === 'error'))
      .toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('rejects a GitHub redirect that leaves the download host allowlist', async () => {
    fs.mkdirSync('/tmp/aionui-update-dedupe-test', { recursive: true });
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 302, headers: { location: 'https://evil.example/OpenH3.exe' } }));
    vi.stubGlobal('fetch', fetchMock);
    const handler = await getDownloadHandler();
    const result = await handler({
      url: 'https://github.com/pigq/OpenH3/releases/download/v3.0.8/OpenH3-3.0.8-win-x64.exe',
      file_name: 'OpenH3-3.0.8-win-x64.exe',
    });
    const { ipcBridge } = await import('@/common');

    expect(result.success).toBe(true);
    await expect
      .poll(() => vi.mocked(ipcBridge.update.downloadProgress.emit).mock.calls.some(([evt]) => evt.status === 'error'))
      .toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('follows a signed GitHub release asset redirect and validates the installer digest', async () => {
    fs.mkdirSync('/tmp/aionui-update-dedupe-test', { recursive: true });
    const content = Buffer.from('verified GitHub installer bytes');
    const sha256 = createHash('sha256').update(content).digest('hex');
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: {
            location:
              'https://release-assets.githubusercontent.com/github-production-release-asset/123/OpenH3.exe?token=short-lived',
          },
        })
      )
      .mockResolvedValueOnce(new Response(content, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const handler = await getDownloadHandler();

    const result = await handler({
      url: 'https://github.com/pigq/OpenH3/releases/download/v3.0.8/OpenH3-3.0.8-win-x64.exe',
      sha256,
      file_name: 'OpenH3-3.0.8-win-x64.exe',
    });
    const { ipcBridge } = await import('@/common');

    expect(result.success).toBe(true);
    await expect
      .poll(() =>
        vi.mocked(ipcBridge.update.downloadProgress.emit).mock.calls.some(([evt]) => evt.status === 'completed')
      )
      .toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('keeps distinct verified digests in separate active download dedupe slots', async () => {
    fs.mkdirSync('/tmp/aionui-update-dedupe-test', { recursive: true });
    const handler = await getDownloadHandler();
    const request = {
      url: 'https://bohuauhd.oss-cn-shenzhen.aliyuncs.com/updates/stable/3.0.8/OpenH3-3.0.8-win-x64.exe',
      fallbackUrl: 'https://github.com/pigq/OpenH3/releases/download/v3.0.8/OpenH3-3.0.8-win-x64.exe',
      file_name: 'OpenH3-3.0.8-win-x64.exe',
    };
    const first = await handler({ ...request, sha256: 'a'.repeat(64), downloadId: 'digest-a' });
    const second = await handler({ ...request, sha256: 'b'.repeat(64), downloadId: 'digest-b' });

    expect(first.success).toBe(true);
    expect(second.success).toBe(true);
    expect(second.data?.downloadId).toBe('digest-b');
    expect(second.data?.file_path).not.toBe(first.data?.file_path);
  });
});
