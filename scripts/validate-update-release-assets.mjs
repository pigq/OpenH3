#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';

const require = createRequire(import.meta.url);
const yaml = require('js-yaml');

const METADATA_FILES = [
  'latest.yml',
  'latest-win-arm64.yml',
  'latest-mac.yml',
  'latest-arm64-mac.yml',
  'latest-linux.yml',
  'latest-linux-arm64.yml',
];
const INSTALLER_EXTENSIONS = new Set(['.exe', '.msi', '.dmg', '.zip', '.deb', '.rpm']);
const CHANNEL_TARGETS = {
  'latest.yml': { platform: 'win', arch: 'x64', extensions: ['.exe', '.msi'], required: '.exe' },
  'latest-win-arm64.yml': { platform: 'win', arch: 'arm64', extensions: ['.exe', '.msi'], required: '.exe' },
  'latest-mac.yml': { platform: 'mac', arch: 'x64', extensions: ['.dmg', '.zip'], required: '.zip' },
  'latest-arm64-mac.yml': { platform: 'mac', arch: 'arm64', extensions: ['.dmg', '.zip'], required: '.zip' },
  'latest-linux.yml': { platform: 'linux', arch: 'x64', extensions: ['.deb', '.rpm'], required: '.deb' },
  'latest-linux-arm64.yml': { platform: 'linux', arch: 'arm64', extensions: ['.deb', '.rpm'], required: '.deb' },
};

const fail = (message) => {
  throw new Error(message);
};

const isSafeAssetName = (name) =>
  typeof name === 'string' &&
  name.length > 0 &&
  name === path.basename(name) &&
  /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) &&
  INSTALLER_EXTENSIONS.has(path.extname(name).toLowerCase());

const hashFile = (filePath) => crypto.createHash('sha512').update(fs.readFileSync(filePath)).digest('base64');

const validateReleaseIndex = (directory, version) => {
  const indexPath = path.join(directory, 'releases.json');
  if (!fs.existsSync(indexPath)) return;
  const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
  if (
    index?.schemaVersion !== 1 ||
    index.release?.version !== version ||
    index.release?.tagName !== `v${version}` ||
    index.release?.prerelease !== false ||
    index.release?.draft !== false ||
    !Array.isArray(index.assets) ||
    index.assets.length === 0
  )
    fail('Invalid stable release index');

  const indexedNames = new Set();
  for (const asset of index.assets) {
    if (!asset || !isSafeAssetName(asset.name) || indexedNames.has(asset.name)) {
      fail('Release index has an unsafe or duplicate installer');
    }
    const filePath = path.join(directory, asset.name);
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      fail(`Release index references missing installer ${asset.name}`);
    }
    const bytes = fs.readFileSync(filePath);
    const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
    if (bytes.length !== asset.size || sha256 !== asset.sha256) {
      fail(`Release index SHA-256 or size does not match ${asset.name}`);
    }
    indexedNames.add(asset.name);
  }
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isFile() && isSafeAssetName(entry.name) && !indexedNames.has(entry.name)) {
      fail(`Installer is missing from release index: ${entry.name}`);
    }
  }
};

const validateManifest = (directory, version, manifestName, installerNames) => {
  const manifestPath = path.join(directory, manifestName);
  if (!fs.existsSync(manifestPath)) fail(`Missing updater metadata: ${manifestName}`);

  const manifest = yaml.load(fs.readFileSync(manifestPath, 'utf8'));
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    fail(`Invalid YAML metadata: ${manifestName}`);
  }
  if (manifest.version !== version) {
    fail(`${manifestName} version is ${String(manifest.version)}, expected ${version}`);
  }
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) {
    fail(`${manifestName} has no installer files`);
  }

  const manifestFileNames = new Set();
  for (const [index, file] of manifest.files.entries()) {
    if (!file || typeof file !== 'object' || !isSafeAssetName(file.url)) {
      fail(`${manifestName} contains an unsafe installer path`);
    }
    const installerPath = path.join(directory, file.url);
    if (!fs.existsSync(installerPath) || !fs.statSync(installerPath).isFile()) {
      fail(`${manifestName} references missing installer ${file.url}`);
    }
    const actualSize = fs.statSync(installerPath).size;
    if (!Number.isSafeInteger(file.size) || file.size <= 0 || file.size !== actualSize) {
      fail(`${manifestName} size does not match ${file.url}`);
    }
    if (
      typeof file.sha512 !== 'string' ||
      !/^[A-Za-z0-9+/]{86}==$/.test(file.sha512) ||
      Buffer.from(file.sha512, 'base64').toString('base64') !== file.sha512
    ) {
      fail(`${manifestName} has an invalid SHA-512 for ${file.url}`);
    }
    if (hashFile(installerPath) !== file.sha512) {
      fail(`${manifestName} SHA-512 does not match ${file.url}`);
    }

    installerNames.add(file.url);
    manifestFileNames.add(file.url);
    const blockMapSize = file.blockMapSize ?? (index === 0 ? manifest.blockMapSize : undefined);
    if (blockMapSize !== undefined) {
      // electron-builder's blockMapSize describes an embedded, raw-deflate map
      // followed by its big-endian size footer, not an external .blockmap file.
      const bytes = fs.readFileSync(installerPath);
      if (
        !Number.isSafeInteger(blockMapSize) ||
        blockMapSize <= 0 ||
        blockMapSize + 4 > bytes.length ||
        bytes.readUInt32BE(bytes.length - 4) !== blockMapSize
      ) {
        fail(`Embedded blockmap size does not match ${file.url}`);
      }
      try {
        const blockmap = JSON.parse(
          inflateRawSync(bytes.subarray(-blockMapSize - 4, -4), { maxOutputLength: 16 * 1024 * 1024 })
        );
        if (blockmap?.version !== '2' || !Array.isArray(blockmap.files)) fail('Invalid embedded blockmap');
      } catch {
        fail(`Invalid embedded blockmap in ${file.url}`);
      }
    }
  }

  if (manifest.path !== undefined && !manifestFileNames.has(manifest.path)) {
    fail(`${manifestName} path does not match a listed installer`);
  }
  if (manifest.sha512 !== undefined && manifest.path) {
    const file = manifest.files.find((entry) => entry.url === manifest.path);
    if (!file || manifest.sha512 !== file.sha512)
      fail(`${manifestName} top-level SHA-512 does not match its installer`);
  }
  const target = CHANNEL_TARGETS[manifestName];
  for (const name of manifestFileNames) {
    const canonical = `OpenH3-${version}-${target.platform}-${target.arch}`;
    // The release-script smoke fixture preserves historical Linux names.
    const legacyLinux =
      target.platform === 'linux' ? `OpenH3-${version}${target.arch === 'arm64' ? '-arm64' : ''}.deb` : null;
    if (!target.extensions.some((extension) => name === `${canonical}${extension}`) && name !== legacyLinux) {
      fail(`${manifestName} references the wrong platform or architecture: ${name}`);
    }
  }
  if (![...manifestFileNames].some((name) => path.extname(name) === target.required)) {
    fail(`${manifestName} is missing its ${target.platform}/${target.arch} updater format ${target.required}`);
  }
};

export function validateUpdateReleaseAssets({ directory, version }) {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) {
    fail(`Invalid stable release version: ${version}`);
  }
  if (!fs.existsSync(directory) || !fs.statSync(directory).isDirectory()) {
    fail(`Release asset directory not found: ${directory}`);
  }

  const installerNames = new Set();
  let metadataFiles = 0;
  for (const manifestName of METADATA_FILES) {
    if (!fs.existsSync(path.join(directory, manifestName))) continue;
    validateManifest(directory, version, manifestName, installerNames);
    metadataFiles++;
  }
  if (metadataFiles === 0) fail('Release has no updater metadata');

  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    if (INSTALLER_EXTENSIONS.has(path.extname(entry.name).toLowerCase()) && !installerNames.has(entry.name)) {
      fail(`Installer is missing from updater metadata: ${entry.name}`);
    }
    if (!entry.name.endsWith('.blockmap')) continue;
    const installerName = entry.name.slice(0, -'.blockmap'.length);
    if (!isSafeAssetName(installerName) || !installerNames.has(installerName)) {
      fail(`Blockmap has no metadata-linked installer: ${entry.name}`);
    }
  }

  validateReleaseIndex(directory, version);

  return { valid: true, version, metadataFiles, installerFiles: installerNames.size };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const [, , directory, version, ...extra] = process.argv;
  if (!directory || !version || extra.length) {
    console.error('Usage: node scripts/validate-update-release-assets.mjs <directory> <version>');
    process.exit(2);
  }
  try {
    const result = validateUpdateReleaseAssets({ directory, version });
    console.log(
      `Validated ${result.metadataFiles} metadata files and ${result.installerFiles} installers for ${result.version}`
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
