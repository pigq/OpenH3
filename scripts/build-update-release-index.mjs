import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const INSTALLER_EXTENSIONS = new Set(['.exe', '.msi', '.dmg', '.zip', '.deb', '.rpm']);
const SHA256_PATTERN = /^sha256:([a-f0-9]{64})$/;

const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

const parseTag = (tagName) => {
  assert(
    typeof tagName === 'string' && /^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(tagName),
    'Release tag must be vMAJOR.MINOR.PATCH'
  );
  return tagName.slice(1);
};

const isSafeBasename = (name) => {
  if (typeof name !== 'string' || !name || name !== name.trim() || name === '.' || name === '..') return false;
  if (/[\\/\u0000-\u001f\u007f]/.test(name)) return false;
  const dot = name.lastIndexOf('.');
  return dot > 0 && INSTALLER_EXTENSIONS.has(name.slice(dot).toLowerCase());
};

const validateReleasePageUrl = (htmlUrl, version) => {
  const expected = `https://github.com/pigq/OpenH3/releases/tag/v${version}`;
  assert(htmlUrl === expected, 'Release page URL must match the canonical GitHub release URL');
};

const isPublishedAt = (value) =>
  typeof value === 'string' &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value) &&
  Number.isFinite(Date.parse(value));

/** Convert one public, stable GitHub Releases API response to schema version 1. */
export const buildUpdateReleaseIndex = (release) => {
  assert(isRecord(release), 'Release API response must be an object');
  assert(release.prerelease === false, 'Prerelease releases cannot be indexed');
  assert(release.draft === false, 'Draft releases cannot be indexed');

  const version = parseTag(release.tag_name);
  validateReleasePageUrl(release.html_url, version);
  assert(isPublishedAt(release.published_at), 'Release published_at is invalid');
  assert(typeof release.name === 'string', 'Release name is required');
  assert(typeof release.body === 'string', 'Release body is required');
  assert(Array.isArray(release.assets), 'Release assets must be an array');

  const assets = [];
  const names = new Set();
  for (const asset of release.assets) {
    assert(isRecord(asset), 'Release asset must be an object');
    if (typeof asset.name !== 'string') continue;
    const extension = asset.name.slice(asset.name.lastIndexOf('.')).toLowerCase();
    if (!INSTALLER_EXTENSIONS.has(extension)) continue;

    assert(isSafeBasename(asset.name), `Unsafe installer asset name: ${asset.name}`);
    assert(Number.isSafeInteger(asset.size) && asset.size > 0, `Installer asset size is invalid: ${asset.name}`);
    assert(!names.has(asset.name), `Duplicate installer asset name: ${asset.name}`);
    const digest = typeof asset.digest === 'string' ? SHA256_PATTERN.exec(asset.digest) : null;
    assert(digest, `Installer asset SHA-256 digest is invalid: ${asset.name}`);
    names.add(asset.name);
    assets.push({ name: asset.name, size: asset.size, sha256: digest[1] });
  }
  assert(assets.length > 0, 'Release has no supported installer assets');

  assets.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
  return {
    schemaVersion: 1,
    release: {
      tagName: release.tag_name,
      version,
      name: release.name,
      body: release.body,
      htmlUrl: release.html_url,
      publishedAt: release.published_at,
      prerelease: false,
      draft: false,
    },
    assets,
  };
};

const main = async (args) => {
  assert(args.length === 2, 'Usage: node scripts/build-update-release-index.mjs <release-api.json> <output.json>');
  const [inputPath, outputPath] = args;
  const release = JSON.parse(await readFile(inputPath, 'utf8'));
  const index = buildUpdateReleaseIndex(release);
  await writeFile(outputPath, `${JSON.stringify(index, null, 2)}\n`, 'utf8');
};

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
