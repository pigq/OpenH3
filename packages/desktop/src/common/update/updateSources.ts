/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

const STABLE_OSS_UPDATE_HOST = 'openh3-download.bohuauhd.top';
const LEGACY_OSS_UPDATE_HOST = 'bohuauhd.oss-cn-shenzhen.aliyuncs.com';

export const STABLE_OSS_UPDATE_BASE_URL = `https://${STABLE_OSS_UPDATE_HOST}/updates/stable/`;
export const STABLE_OSS_UPDATE_INDEX_URL = `${STABLE_OSS_UPDATE_BASE_URL}releases.json`;

/** Recognize only the canonical update host and its original OSS origin. */
export const isOssUpdateHost = (hostname: string): boolean =>
  hostname === STABLE_OSS_UPDATE_HOST || hostname === LEGACY_OSS_UPDATE_HOST;
