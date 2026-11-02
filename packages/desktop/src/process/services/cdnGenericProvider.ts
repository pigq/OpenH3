/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { UpdateInfo } from 'electron-updater';
import type { WindowsUpdateInfo } from 'builder-util-runtime';
import { GenericProvider } from 'electron-updater/out/providers/GenericProvider';
import { resolveFiles as resolveProviderFiles } from 'electron-updater/out/providers/Provider';
import { getChannelFilename, newUrlFromBase } from 'electron-updater/out/util';
import log from 'electron-log';

type GenericProviderConfiguration = ConstructorParameters<typeof GenericProvider>[0];
type GenericProviderUpdater = ConstructorParameters<typeof GenericProvider>[1];
type GenericProviderRuntimeOptions = ConstructorParameters<typeof GenericProvider>[2];

export type CdnGenericProviderConfiguration = Omit<GenericProviderConfiguration, 'provider'> & {
  provider: 'custom';
  updateProvider?: unknown;
};

const withTrailingSlash = (url: string): string => (url.endsWith('/') ? url : `${url}/`);

export class CdnGenericProvider extends GenericProvider {
  private readonly _cdnBaseUrl: URL;
  // Parent stores `updater` privately; keep our own reference to rebuild the
  // channel-file URL for logging (the base `channel` getter is also private).
  private readonly _updater: GenericProviderUpdater;

  constructor(
    configuration: CdnGenericProviderConfiguration,
    updater: GenericProviderUpdater,
    runtimeOptions: GenericProviderRuntimeOptions
  ) {
    const genericConfiguration: GenericProviderConfiguration = {
      ...configuration,
      provider: 'generic',
    };
    super(genericConfiguration, updater, {
      ...runtimeOptions,
      isUseMultipleRangeRequest: false,
    });
    this._updater = updater;
    this._cdnBaseUrl = new URL(withTrailingSlash(configuration.url));
    log.debug('[auto-update] CDN provider initialized', {
      baseUrl: this._cdnBaseUrl.href,
      platform: runtimeOptions.platform,
      isUseMultipleRangeRequest: this.isUseMultipleRangeRequest,
    });
  }

  /**
   * Resolve the channel metadata file (e.g. `latest-mac.yml`) the updater fetches
   * to discover the newest version. Mirrors GenericProvider's private `channel`
   * getter, which is not accessible from a subclass.
   */
  private resolveLatestVersionUrl(): URL {
    const channelName = this._updater.channel ?? this.getDefaultChannelName();
    const channelFile = getChannelFilename(channelName);
    // `isAddNoCacheQuery` is a real getter on AppUpdater but absent from its public types.
    const addNoCacheQuery = Boolean((this._updater as unknown as { isAddNoCacheQuery?: boolean }).isAddNoCacheQuery);
    return newUrlFromBase(channelFile, this._cdnBaseUrl, addNoCacheQuery);
  }

  override async getLatestVersion(): Promise<UpdateInfo> {
    log.info('[auto-update] Checking latest version from URL:', this.resolveLatestVersionUrl().href);
    const info: WindowsUpdateInfo = await super.getLatestVersion();
    if (
      !info ||
      !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(info.version) ||
      !Array.isArray(info.files) ||
      !info.files.length ||
      info.files.some(
        (file) =>
          !file ||
          typeof file.url !== 'string' ||
          !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(file.url) ||
          typeof file.sha512 !== 'string' ||
          !/^[A-Za-z0-9+/]{86}==$/.test(file.sha512)
      ) ||
      (info.packages &&
        Object.values(info.packages).some(
          (file) => !file || typeof file.path !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(file.path)
        ))
    ) {
      throw new Error('UPDATE_OSS_METADATA_INVALID');
    }
    return info;
  }

  override resolveFiles(updateInfo: UpdateInfo): ReturnType<GenericProvider['resolveFiles']> {
    const resolved = resolveProviderFiles(
      updateInfo,
      this._cdnBaseUrl,
      (filePath) => `${updateInfo.version}/${filePath}`
    );
    log.info('[auto-update] Update download URL(s) resolved:', {
      version: updateInfo.version,
      files: resolved.map((file) => file.url.href),
      packages: resolved.map((file) => file.packageInfo?.path).filter(Boolean),
    });
    return resolved;
  }
}
