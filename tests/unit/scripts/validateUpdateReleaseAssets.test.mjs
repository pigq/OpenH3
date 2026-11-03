import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { deflateRawSync } from 'node:zlib';
import yaml from 'js-yaml';
import { afterEach, describe, expect, it } from 'vitest';
import { validateUpdateReleaseAssets } from '../../../scripts/validate-update-release-assets.mjs';

const roots = new Set();

const makeReleaseDirectory = (mutate) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'openh3-release-assets-'));
  roots.add(directory);
  const files = [
    ['latest.yml', 'OpenH3-3.0.8-win-x64.exe'],
    ['latest-win-arm64.yml', 'OpenH3-3.0.8-win-arm64.exe'],
    ['latest-mac.yml', 'OpenH3-3.0.8-mac-x64.dmg'],
    ['latest-arm64-mac.yml', 'OpenH3-3.0.8-mac-arm64.dmg'],
    ['latest-linux.yml', 'OpenH3-3.0.8-linux-x64.deb'],
    ['latest-linux-arm64.yml', 'OpenH3-3.0.8-linux-arm64.deb'],
  ];
  const installerBytes = Buffer.from('installer bytes');
  const sha512 = crypto.createHash('sha512').update(installerBytes).digest('base64');
  for (const [manifestName, installerName] of files) {
    fs.writeFileSync(path.join(directory, installerName), installerBytes);
    const manifest = {
      version: '3.0.8',
      files: [{ url: installerName, sha512, size: installerBytes.length }],
      path: installerName,
      sha512,
    };
    if (manifestName.includes('mac')) {
      const zipName = installerName.replace('.dmg', '.zip');
      fs.writeFileSync(path.join(directory, zipName), installerBytes);
      manifest.files.push({ url: zipName, sha512, size: installerBytes.length });
    }
    fs.writeFileSync(path.join(directory, manifestName), yaml.dump(mutate?.(manifest, manifestName) ?? manifest));
  }
  return directory;
};

afterEach(() => {
  for (const directory of roots) fs.rmSync(directory, { recursive: true, force: true });
  roots.clear();
});

describe('validateUpdateReleaseAssets', () => {
  it('accepts all platform metadata when installer sizes and SHA-512 values match', () => {
    const directory = makeReleaseDirectory();
    expect(validateUpdateReleaseAssets({ directory, version: '3.0.8' })).toMatchObject({
      valid: true,
      version: '3.0.8',
    });
  });

  it('accepts a Windows x64-only release without requiring unpublished platform metadata', () => {
    const directory = makeReleaseDirectory();
    for (const name of fs.readdirSync(directory)) {
      if (!['latest.yml', 'OpenH3-3.0.8-win-x64.exe'].includes(name)) fs.unlinkSync(path.join(directory, name));
    }
    expect(validateUpdateReleaseAssets({ directory, version: '3.0.8' })).toEqual({
      valid: true,
      version: '3.0.8',
      metadataFiles: 1,
      installerFiles: 1,
    });
  });

  it('rejects an installer whose platform metadata is missing', () => {
    const directory = makeReleaseDirectory();
    fs.unlinkSync(path.join(directory, 'latest-win-arm64.yml'));
    expect(() => validateUpdateReleaseAssets({ directory, version: '3.0.8' })).toThrow(/metadata/i);
  });

  it('rejects an additional installer that is not referenced by any platform metadata', () => {
    const directory = makeReleaseDirectory();
    fs.writeFileSync(path.join(directory, 'OpenH3-3.0.8-win-x64.msi'), 'unreferenced installer');
    expect(() => validateUpdateReleaseAssets({ directory, version: '3.0.8' })).toThrow(/metadata/i);
  });

  it('rejects an empty release directory', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'openh3-release-assets-'));
    roots.add(directory);
    expect(() => validateUpdateReleaseAssets({ directory, version: '3.0.8' })).toThrow(/metadata/i);
  });

  it('rejects channel files that all reference the same Windows x64 installer', () => {
    const directory = makeReleaseDirectory((manifest) => ({
      ...manifest,
      path: 'OpenH3-3.0.8-win-x64.exe',
      files: [{ ...manifest.files[0], url: 'OpenH3-3.0.8-win-x64.exe' }],
    }));
    expect(() => validateUpdateReleaseAssets({ directory, version: '3.0.8' })).toThrow(/platform|arch/i);
  });

  it.each([
    [
      'wrong metadata version',
      (manifest, name) => (name === 'latest.yml' ? { ...manifest, version: '3.0.7' } : manifest),
    ],
    [
      'wrong SHA-512',
      (manifest, name) =>
        name === 'latest.yml' ? { ...manifest, files: [{ ...manifest.files[0], sha512: 'wrong' }] } : manifest,
    ],
    [
      'missing indicated blockmap',
      (manifest, name) =>
        name === 'latest.yml' ? { ...manifest, files: [{ ...manifest.files[0], blockMapSize: 5 }] } : manifest,
    ],
  ])('rejects %s', (label, mutate) => {
    const directory = makeReleaseDirectory(mutate);
    if (label === 'missing indicated blockmap') {
      expect(() => validateUpdateReleaseAssets({ directory, version: '3.0.8' })).toThrow(/blockmap/i);
    } else {
      expect(() => validateUpdateReleaseAssets({ directory, version: '3.0.8' })).toThrow();
    }
  });

  it('rejects a metadata reference to a missing installer', () => {
    const directory = makeReleaseDirectory((manifest, name) =>
      name === 'latest.yml' ? { ...manifest, files: [{ ...manifest.files[0], url: 'missing.exe' }] } : manifest
    );
    expect(() => validateUpdateReleaseAssets({ directory, version: '3.0.8' })).toThrow(/missing/i);
  });

  it('rejects a blockmap that has no matching installer', () => {
    const directory = makeReleaseDirectory();
    fs.writeFileSync(path.join(directory, 'orphan.exe.blockmap'), 'blockmap');
    expect(() => validateUpdateReleaseAssets({ directory, version: '3.0.8' })).toThrow(/blockmap/i);
  });

  it('rejects a release index whose installer digest differs from the downloaded file', () => {
    const directory = makeReleaseDirectory();
    fs.writeFileSync(
      path.join(directory, 'releases.json'),
      JSON.stringify({
        schemaVersion: 1,
        release: { version: '3.0.8', tagName: 'v3.0.8', prerelease: false, draft: false },
        assets: [{ name: 'OpenH3-3.0.8-win-x64.exe', size: 15, sha256: 'a'.repeat(64) }],
      })
    );
    expect(() => validateUpdateReleaseAssets({ directory, version: '3.0.8' })).toThrow(/index/i);
  });

  it('accepts a valid embedded blockmap without requiring an external blockmap file', () => {
    const directory = makeReleaseDirectory();
    const filePath = path.join(directory, 'OpenH3-3.0.8-win-x64.exe');
    const blockmap = deflateRawSync(Buffer.from(JSON.stringify({ version: '2', files: [] })));
    const footer = Buffer.alloc(4);
    footer.writeUInt32BE(blockmap.length);
    const bytes = Buffer.concat([fs.readFileSync(filePath), blockmap, footer]);
    fs.writeFileSync(filePath, bytes);
    const manifestPath = path.join(directory, 'latest.yml');
    const manifest = yaml.load(fs.readFileSync(manifestPath, 'utf8'));
    manifest.files[0].size = bytes.length;
    manifest.files[0].sha512 = crypto.createHash('sha512').update(bytes).digest('base64');
    manifest.files[0].blockMapSize = blockmap.length;
    manifest.sha512 = manifest.files[0].sha512;
    fs.writeFileSync(manifestPath, yaml.dump(manifest));
    expect(validateUpdateReleaseAssets({ directory, version: '3.0.8' }).valid).toBe(true);
  });
});
