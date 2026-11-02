import { describe, expect, it } from 'vitest';
import { buildUpdateReleaseIndex } from '../../../scripts/build-update-release-index.mjs';

const release = (overrides = {}) => ({
  tag_name: 'v3.0.8',
  name: 'OpenH3 3.0.8',
  body: 'Stable notes',
  html_url: 'https://github.com/pigq/OpenH3/releases/tag/v3.0.8',
  published_at: '2026-11-02T00:00:00Z',
  prerelease: false,
  draft: false,
  assets: [
    {
      name: 'OpenH3-3.0.8-win-x64.exe',
      size: 1024,
      digest: `sha256:${'a'.repeat(64)}`,
      browser_download_url: 'https://github.com/pigq/OpenH3/releases/download/v3.0.8/OpenH3-3.0.8-win-x64.exe',
    },
  ],
  ...overrides,
});

describe('buildUpdateReleaseIndex', () => {
  it('keeps deterministic stable metadata and installer integrity digests', () => {
    expect(buildUpdateReleaseIndex(release())).toEqual({
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
    });
  });

  it.each([
    ['prerelease', { prerelease: true }],
    ['draft', { draft: true }],
    ['invalid tag', { tag_name: 'release-3.0.8' }],
    ['missing digest', { assets: [{ name: 'OpenH3.exe', size: 1 }] }],
    ['invalid digest', { assets: [{ name: 'OpenH3.exe', size: 1, digest: 'md5:abcd' }] }],
    [
      'duplicate names',
      {
        assets: [
          { name: 'OpenH3-3.0.8-win-x64.exe', size: 1, digest: `sha256:${'a'.repeat(64)}` },
          { name: 'OpenH3-3.0.8-win-x64.exe', size: 2, digest: `sha256:${'b'.repeat(64)}` },
        ],
      },
    ],
    ['no installable assets', { assets: [{ name: 'notes.txt', size: 1, digest: `sha256:${'a'.repeat(64)}` }] }],
  ])('rejects %s', (_caseName, overrides) => {
    expect(() => buildUpdateReleaseIndex(release(overrides))).toThrow();
  });
});
