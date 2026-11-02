/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { GitHubReleaseAsset, StableReleaseAssetV1, StableReleaseIndexV1 } from '@/common/update/updateTypes';
import semver from 'semver';

export type { StableReleaseAssetV1, StableReleaseIndexV1 };

const OSS_RELEASE_BASE = 'https://bohuauhd.oss-cn-shenzhen.aliyuncs.com/updates/stable';
const GITHUB_RELEASE_BASE = 'https://github.com/pigq/OpenH3/releases/download';
const INSTALLER_EXTENSIONS = new Set(['.exe', '.msi', '.dmg', '.zip', '.deb', '.rpm']);
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const hasOnlyKeys = (value: Record<string, unknown>, allowed: readonly string[]) =>
  Object.keys(value).every((key) => allowed.includes(key));

const isSafeBasename = (name: string) => {
  if (!name || name !== name.trim() || name === '.' || name === '..') return false;
  if (
    /[\\/]/.test(name) ||
    [...name].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
  )
    return false;
  const extension = name.slice(name.lastIndexOf('.')).toLowerCase();
  return name.lastIndexOf('.') > 0 && INSTALLER_EXTENSIONS.has(extension);
};

const parseVersion = (tagName: string, version: string) => {
  if (!/^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(tagName)) {
    throw new Error('UPDATE_RELEASE_TAG_INVALID');
  }
  const normalized = semver.valid(tagName.slice(1));
  if (!normalized || normalized !== version || semver.prerelease(normalized)) {
    throw new Error('UPDATE_RELEASE_VERSION_INVALID');
  }
  return normalized;
};

const isPublishedAt = (value: string) =>
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value) && Number.isFinite(Date.parse(value));

const validateReleasePageUrl = (value: string, version: string) => {
  const expectedUrl = `https://github.com/pigq/OpenH3/releases/tag/v${version}`;
  if (value !== expectedUrl) throw new Error('UPDATE_RELEASE_URL_INVALID');
  const parsed = new URL(value);
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'github.com') throw new Error('UPDATE_RELEASE_URL_INVALID');
};

const parseAsset = (value: unknown): StableReleaseAssetV1 => {
  if (!isRecord(value) || !hasOnlyKeys(value, ['name', 'size', 'sha256'])) {
    throw new Error('UPDATE_RELEASE_ASSET_INVALID');
  }
  const { name, size, sha256 } = value;
  if (typeof name !== 'string' || !isSafeBasename(name)) throw new Error('UPDATE_RELEASE_ASSET_NAME_INVALID');
  if (typeof size !== 'number' || !Number.isSafeInteger(size) || size <= 0) {
    throw new Error('UPDATE_RELEASE_ASSET_SIZE_INVALID');
  }
  if (typeof sha256 !== 'string' || !SHA256_PATTERN.test(sha256)) {
    throw new Error('UPDATE_RELEASE_ASSET_DIGEST_INVALID');
  }
  return { name, size, sha256 };
};

/** Parse and validate the public, stable release index before deriving download URLs. */
export const parseStableReleaseIndex = (value: unknown): StableReleaseIndexV1 => {
  if (!isRecord(value) || !hasOnlyKeys(value, ['schemaVersion', 'release', 'assets'])) {
    throw new Error('UPDATE_RELEASE_INDEX_INVALID');
  }
  if (value.schemaVersion !== 1 || !isRecord(value.release) || !Array.isArray(value.assets)) {
    throw new Error('UPDATE_RELEASE_INDEX_SCHEMA_INVALID');
  }

  const release = value.release;
  if (
    !hasOnlyKeys(release, ['tagName', 'version', 'name', 'body', 'htmlUrl', 'publishedAt', 'prerelease', 'draft']) ||
    typeof release.tagName !== 'string' ||
    typeof release.version !== 'string' ||
    typeof release.name !== 'string' ||
    typeof release.body !== 'string' ||
    typeof release.htmlUrl !== 'string' ||
    typeof release.publishedAt !== 'string' ||
    release.prerelease !== false ||
    release.draft !== false
  ) {
    throw new Error('UPDATE_RELEASE_METADATA_INVALID');
  }

  const version = parseVersion(release.tagName, release.version);
  validateReleasePageUrl(release.htmlUrl, version);
  if (!isPublishedAt(release.publishedAt)) throw new Error('UPDATE_RELEASE_PUBLISHED_AT_INVALID');

  const assets = value.assets.map(parseAsset);
  if (!assets.length || new Set(assets.map(({ name }) => name)).size !== assets.length) {
    throw new Error('UPDATE_RELEASE_ASSET_DUPLICATE');
  }

  return {
    schemaVersion: 1,
    release: {
      tagName: release.tagName,
      version,
      name: release.name,
      body: release.body,
      htmlUrl: release.htmlUrl,
      publishedAt: release.publishedAt,
      prerelease: false,
      draft: false,
    },
    assets,
  };
};

/** Build canonical CDN and GitHub URLs; input asset URLs are never consumed. */
export const buildStableReleaseAssets = (index: StableReleaseIndexV1): GitHubReleaseAsset[] => {
  const parsed = parseStableReleaseIndex(index);
  return parsed.assets.map((asset) => {
    const encodedName = encodeURIComponent(asset.name);
    return {
      name: asset.name,
      size: asset.size,
      sha256: asset.sha256,
      url: `${OSS_RELEASE_BASE}/${parsed.release.version}/${encodedName}`,
      fallbackUrl: `${GITHUB_RELEASE_BASE}/v${parsed.release.version}/${encodedName}`,
    };
  });
};
