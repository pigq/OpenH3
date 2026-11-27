/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { GithubOptions } from 'builder-util-runtime';
import { STABLE_OSS_UPDATE_BASE_URL } from '@/common/update/updateSources';
import { CdnGenericProvider } from './cdnGenericProvider';

export type UpdateFeedSource = 'oss' | 'github';

export { STABLE_OSS_UPDATE_BASE_URL };

export const buildGitHubFeedOptions = (): GithubOptions => ({ provider: 'github', owner: 'pigq', repo: 'OpenH3' });

export const buildUpdateFeedOptions = (source: UpdateFeedSource) => {
  if (source === 'github') return buildGitHubFeedOptions();
  return {
    provider: 'custom' as const,
    url: STABLE_OSS_UPDATE_BASE_URL,
    channel: 'latest',
    updateProvider: CdnGenericProvider,
  };
};
