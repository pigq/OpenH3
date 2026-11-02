/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import type { UpdateInfo } from 'electron-updater';
import type { AppUpdater } from 'electron-updater/out/AppUpdater';
import type { ProviderRuntimeOptions } from 'electron-updater/out/providers/Provider';
import { CdnGenericProvider } from '@/process/services/cdnGenericProvider';
import { buildGitHubFeedOptions, buildUpdateFeedOptions } from '@/process/services/updateFeed';

const makeRuntimeOptions = (): ProviderRuntimeOptions => ({
  isUseMultipleRangeRequest: true,
  platform: 'darwin',
  executor: {
    request: vi.fn(),
  } as unknown as ProviderRuntimeOptions['executor'],
});

describe('GitHub update feed options', () => {
  it('builds the native GitHub provider for the unified repository', () => {
    const options = buildGitHubFeedOptions();

    expect(options).toEqual({ provider: 'github', owner: 'pigq', repo: 'OpenH3' });
  });

  it('builds an OSS custom provider with the fixed stable update base', () => {
    const options = buildUpdateFeedOptions('oss');

    expect(options).toMatchObject({
      provider: 'custom',
      url: 'https://bohuauhd.oss-cn-shenzhen.aliyuncs.com/updates/stable/',
      updateProvider: CdnGenericProvider,
    });
  });

  it('keeps the GitHub provider pinned to the public repository', () => {
    expect(buildUpdateFeedOptions('github')).toEqual({ provider: 'github', owner: 'pigq', repo: 'OpenH3' });
  });
});

describe('CdnGenericProvider', () => {
  it.each([
    ['missing files', { version: '3.0.8' }],
    ['empty files', { version: '3.0.8', files: [] }],
    ['missing hash', { version: '3.0.8', files: [{ url: 'OpenH3.exe' }] }],
    [
      'path traversal',
      { version: '3.0.8', files: [{ url: '../../OpenH3.exe', sha512: Buffer.alloc(64).toString('base64') }] },
    ],
    [
      'package path traversal',
      {
        version: '3.0.8',
        files: [{ url: 'OpenH3.exe', sha512: Buffer.alloc(64).toString('base64') }],
        packages: { x64: { path: '../../OpenH3.7z' } },
      },
    ],
  ])('rejects OSS metadata with %s before the native updater accepts it', async (_label, manifest) => {
    const runtime = makeRuntimeOptions();
    vi.mocked(runtime.executor.request).mockResolvedValueOnce(JSON.stringify(manifest));
    const provider = new CdnGenericProvider(
      { provider: 'custom', url: 'https://example.com/updates/stable/' },
      {} as AppUpdater,
      runtime
    );
    await expect(provider.getLatestVersion()).rejects.toThrow();
  });
  it('disables multi-range requests for the OSS provider', () => {
    const provider = new CdnGenericProvider(
      {
        provider: 'custom',
        url: 'https://bohuauhd.oss-cn-shenzhen.aliyuncs.com/updates/stable/',
      },
      {} as AppUpdater,
      makeRuntimeOptions()
    );

    expect(provider.isUseMultipleRangeRequest).toBe(false);
  });

  it('resolves relative update files under the version directory', () => {
    const provider = new CdnGenericProvider(
      {
        provider: 'custom',
        url: 'https://example.com/releases',
      },
      {} as AppUpdater,
      makeRuntimeOptions()
    );

    const files = provider.resolveFiles({
      version: '2.1.14',
      files: [
        {
          url: 'AionUi-2.1.14-mac-arm64.dmg',
          sha512: 'sha512-value',
        },
      ],
      path: 'AionUi-2.1.14-mac-arm64.dmg',
      sha512: 'sha512-value',
      releaseDate: '2026-06-08T00:00:00.000Z',
    } satisfies UpdateInfo);

    expect(files[0]?.url.href).toBe('https://example.com/releases/2.1.14/AionUi-2.1.14-mac-arm64.dmg');
  });
});
