import { describe, expect, it } from 'vitest';
import {
  buildStableReleaseAssets,
  parseStableReleaseIndex,
  type StableReleaseIndexV1,
} from '@/process/services/updateReleaseManifest';

const validIndex: StableReleaseIndexV1 = {
  schemaVersion: 1,
  release: {
    tagName: 'v3.0.8',
    version: '3.0.8',
    name: 'OpenH3 3.0.8',
    body: 'Stable notes',
    htmlUrl: 'https://github.com/pigq/OpenH3/releases/tag/v3.0.8',
    publishedAt: '2026-11-02T00:00:00Z',
    prerelease: false,
    draft: false,
  },
  assets: [{ name: 'OpenH3-3.0.8-win-x64.exe', size: 1024, sha256: 'a'.repeat(64) }],
};

describe('stable update release manifest', () => {
  it('parses a stable release and derives OSS and GitHub asset URLs', () => {
    const parsed = parseStableReleaseIndex(validIndex);
    expect(parsed).toEqual(validIndex);
    expect(buildStableReleaseAssets(parsed)).toEqual([
      {
        name: 'OpenH3-3.0.8-win-x64.exe',
        size: 1024,
        sha256: 'a'.repeat(64),
        url: 'https://bohuauhd.oss-cn-shenzhen.aliyuncs.com/updates/stable/3.0.8/OpenH3-3.0.8-win-x64.exe',
        fallbackUrl: 'https://github.com/pigq/OpenH3/releases/download/v3.0.8/OpenH3-3.0.8-win-x64.exe',
      },
    ]);
  });

  it.each([
    ['schema version mismatch', { schemaVersion: 2 }],
    ['tag and version mismatch', { release: { tagName: 'v3.0.9' } }],
    ['prerelease', { release: { prerelease: true } }],
    ['draft', { release: { draft: true } }],
    ['path separator', { assets: [{ name: '../OpenH3.exe' }] }],
    ['unsupported extension', { assets: [{ name: 'OpenH3.tar.gz' }] }],
    ['non-positive size', { assets: [{ size: 0 }] }],
    ['invalid SHA-256', { assets: [{ sha256: 'not-a-digest' }] }],
    ['unsafe release page', { release: { htmlUrl: 'http://github.com/pigq/OpenH3/releases/tag/v3.0.8' } }],
    ['untrusted URL field', { assets: [{ url: 'https://evil.example/file.exe' }] }],
  ])('rejects %s', (_caseName, override) => {
    const merged = structuredClone(validIndex);
    if ('schemaVersion' in override) merged.schemaVersion = override.schemaVersion as number;
    if ('release' in override) Object.assign(merged.release, override.release);
    if ('assets' in override) Object.assign(merged.assets[0]!, override.assets?.[0]);
    if ('assets' in override && override.assets?.[0]?.name?.startsWith('../')) {
      merged.assets[0]!.name = '../OpenH3.exe';
    }
    expect(() => parseStableReleaseIndex(merged)).toThrow();
  });

  it('rejects a stable index without installers so the check can fall back to GitHub', () => {
    expect(() => parseStableReleaseIndex({ ...validIndex, assets: [] })).toThrow();
  });
});
