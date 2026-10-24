import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  promises as fsPromises,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const repoRoot = resolve(__dirname, '../../..');
const require = createRequire(import.meta.url);
const modulePath = join(repoRoot, 'packages/shared-scripts/src/prepare-windows-media.js');
const prefix = 'ffmpeg-7.1.1-essentials_build/bin/';
const payloads = { 'ffmpeg.exe': Buffer.from('MZ-test-ffmpeg'), 'ffprobe.exe': Buffer.from('MZ-test-ffprobe') };
type Manifest = {
  url: string;
  archiveSha256: string;
  maxArchiveBytes: number;
  binaries: Array<{ filename: string; entry: string; sha256: string; size: number }>;
};
type Options = {
  projectRoot: string;
  platform: string;
  arch: string | number;
  manifest?: Manifest;
  download?: (manifest: Manifest) => Promise<Buffer>;
};
type MediaModule = ((context: {
  electronPlatformName: string;
  arch: number;
  packager: { projectDir: string };
}) => Promise<unknown>) & {
  WINDOWS_MEDIA: Manifest;
  prepareWindowsMedia: (options: Options) => Promise<unknown>;
};

function mediaModule(): MediaModule {
  expect(existsSync(modulePath), 'canonical media preparer must exist').toBe(true);
  return require(modulePath) as MediaModule;
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// Small stored ZIPs exercise the real reader without adding an archive-writer dependency.
function makeZip(entries: Array<{ name: string; bytes: Buffer; mode?: number }>): Buffer {
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50);
    header.writeUInt16LE(20, 4);
    header.writeUInt32LE(crc32(entry.bytes), 14);
    header.writeUInt32LE(entry.bytes.length, 18);
    header.writeUInt32LE(entry.bytes.length, 22);
    header.writeUInt16LE(name.length, 26);
    local.push(header, name, entry.bytes);
    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50);
    record.writeUInt16LE(0x0314, 4);
    record.writeUInt16LE(20, 6);
    record.writeUInt32LE(crc32(entry.bytes), 16);
    record.writeUInt32LE(entry.bytes.length, 20);
    record.writeUInt32LE(entry.bytes.length, 24);
    record.writeUInt16LE(name.length, 28);
    record.writeUInt32LE(((entry.mode ?? 0o100644) << 16) >>> 0, 38);
    record.writeUInt32LE(offset, 42);
    central.push(record, name);
    offset += header.length + name.length + entry.bytes.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}

const binaryEntries = Object.entries(payloads).map(([filename, bytes]) => ({ name: prefix + filename, bytes }));
const archive = makeZip([...binaryEntries, { name: prefix + 'ffplay.exe', bytes: Buffer.from('unrequested') }]);
function fixtureManifest(archiveBytes = archive): Manifest {
  return {
    ...mediaModule().WINDOWS_MEDIA,
    archiveSha256: sha256(archiveBytes),
    maxArchiveBytes: 4096,
    binaries: Object.entries(payloads).map(([filename, bytes]) => ({
      filename,
      entry: prefix + filename,
      sha256: sha256(bytes),
      size: bytes.length,
    })),
  };
}

let root: string;
let destination: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'openh3-media-packaging-'));
  destination = join(root, 'resources/ffmpeg/win32-x64');
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

function oldResources(): void {
  mkdirSync(destination, { recursive: true });
  writeFileSync(join(destination, 'ffmpeg.exe'), 'previous ffmpeg');
  writeFileSync(join(destination, 'ffprobe.exe'), 'previous ffprobe');
  writeFileSync(join(destination, 'LICENSE'), 'checked-in license');
  writeFileSync(join(destination, 'README.txt'), 'checked-in readme');
}

function expectOldResources(): void {
  expect(readFileSync(join(destination, 'ffmpeg.exe'), 'utf8')).toBe('previous ffmpeg');
  expect(readFileSync(join(destination, 'ffprobe.exe'), 'utf8')).toBe('previous ffprobe');
  expect(readFileSync(join(destination, 'LICENSE'), 'utf8')).toBe('checked-in license');
  expect(readFileSync(join(destination, 'README.txt'), 'utf8')).toBe('checked-in readme');
  expect(readdirSync(join(root, 'resources/ffmpeg'))).toEqual(['win32-x64']);
}

describe('Windows packaged media preparation', () => {
  it('pins the verified official Gyan 7.1.1 archive and both existing binary hashes', () => {
    const manifest = mediaModule().WINDOWS_MEDIA;
    expect(manifest.url).toBe(
      'https://github.com/GyanD/codexffmpeg/releases/download/7.1.1/ffmpeg-7.1.1-essentials_build.zip'
    );
    expect(manifest.archiveSha256).toBe('04861d3339c5ebe38b56c19a15cf2c0cc97f5de4fa8910e4d47e5e6404e4a2d4');
    expect(manifest.binaries.map((binary) => binary.sha256)).toEqual([
      'b90225987bdd042cca09a1efb5e34e9848f2d1dbf5fbcd388753a44145522997',
      '05e8fa639450f8191635192871ae37a3ec3e4638fa12f3b7d49c6522ba16a8ed',
    ]);
  });

  it.each(['x64', 1])(
    'stages only the two verified exact payloads for arch %s and preserves existing documents',
    async (arch) => {
      oldResources();
      const download = vi.fn(async () => archive);
      await mediaModule().prepareWindowsMedia({
        projectRoot: root,
        platform: 'win32',
        arch,
        manifest: fixtureManifest(),
        download,
      });
      for (const [filename, bytes] of Object.entries(payloads))
        expect(readFileSync(join(destination, filename))).toEqual(bytes);
      expect(readFileSync(join(destination, 'LICENSE'), 'utf8')).toBe('checked-in license');
      expect(readFileSync(join(destination, 'README.txt'), 'utf8')).toBe('checked-in readme');
      expect(existsSync(join(destination, 'ffplay.exe'))).toBe(false);
      expect(readdirSync(join(root, 'resources/ffmpeg'))).toEqual(['win32-x64']);
      expect(download).toHaveBeenCalledOnce();
    }
  );

  it('prepares a clean checkout containing no media directory', async () => {
    await mediaModule().prepareWindowsMedia({
      projectRoot: root,
      platform: 'win32',
      arch: 'x64',
      manifest: fixtureManifest(),
      download: async () => archive,
    });
    expect(readFileSync(join(destination, 'ffprobe.exe'))).toEqual(payloads['ffprobe.exe']);
  });

  it.each(['darwin', 'linux'])('does not touch resources or network on %s', async (platform) => {
    const download = vi.fn(async () => {
      throw new Error('unexpected network');
    });
    await mediaModule().prepareWindowsMedia({ projectRoot: root, platform, arch: 'arm64', download });
    expect(download).not.toHaveBeenCalled();
    expect(readdirSync(root)).toEqual([]);
  });

  it('exports a directly callable electron-builder beforePack hook', async () => {
    await mediaModule()({ electronPlatformName: 'linux', arch: 1, packager: { projectDir: root } });
    expect(readdirSync(root)).toEqual([]);
  });

  it.each(['arm64', 3, 'ia32', 0, 'universal', 4])(
    'rejects Windows arch %s without provisioning x64 or using network',
    async (arch) => {
      const download = vi.fn(async () => archive);
      await expect(
        mediaModule().prepareWindowsMedia({ projectRoot: root, platform: 'win32', arch, download })
      ).rejects.toThrow(/unsupported.*arch/i);
      expect(download).not.toHaveBeenCalled();
      expect(readdirSync(root)).toEqual([]);
    }
  );

  it('reuses existing resources only after both hashes validate', async () => {
    mkdirSync(destination, { recursive: true });
    for (const [filename, bytes] of Object.entries(payloads)) writeFileSync(join(destination, filename), bytes);
    const before = statSync(join(destination, 'ffmpeg.exe')).mtimeMs;
    const download = vi.fn(async () => {
      throw new Error('unexpected network');
    });
    await mediaModule().prepareWindowsMedia({
      projectRoot: root,
      platform: 'win32',
      arch: 'x64',
      manifest: fixtureManifest(),
      download,
    });
    expect(download).not.toHaveBeenCalled();
    expect(statSync(join(destination, 'ffmpeg.exe')).mtimeMs).toBe(before);
  });

  it('replaces same-size corrupted resources instead of trusting their presence', async () => {
    mkdirSync(destination, { recursive: true });
    for (const [filename, bytes] of Object.entries(payloads))
      writeFileSync(join(destination, filename), Buffer.alloc(bytes.length));
    const download = vi.fn(async () => archive);
    await mediaModule().prepareWindowsMedia({
      projectRoot: root,
      platform: 'win32',
      arch: 'x64',
      manifest: fixtureManifest(),
      download,
    });
    expect(download).toHaveBeenCalledOnce();
    expect(readFileSync(join(destination, 'ffmpeg.exe'))).toEqual(payloads['ffmpeg.exe']);
  });

  it('rejects an archive SHA mismatch without altering existing files', async () => {
    oldResources();
    const manifest = { ...fixtureManifest(), archiveSha256: '0'.repeat(64) };
    await expect(
      mediaModule().prepareWindowsMedia({
        projectRoot: root,
        platform: 'win32',
        arch: 'x64',
        manifest,
        download: async () => archive,
      })
    ).rejects.toThrow(/archive.*sha-?256/i);
    expectOldResources();
  });

  it('rejects an oversized downloaded archive without altering existing files', async () => {
    oldResources();
    const manifest = { ...fixtureManifest(), maxArchiveBytes: archive.length - 1 };
    await expect(
      mediaModule().prepareWindowsMedia({
        projectRoot: root,
        platform: 'win32',
        arch: 'x64',
        manifest,
        download: async () => archive,
      })
    ).rejects.toThrow(/archive.*limit/i);
    expectOldResources();
  });

  it.each([false, true])('bounds a real streamed download with Content-Length=%s', async (declaredLength) => {
    oldResources();
    const server = createServer((_request, response) => {
      if (declaredLength) response.setHeader('content-length', archive.length);
      response.write(archive.subarray(0, 10));
      response.end(archive.subarray(10));
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Missing loopback server port');
      const manifest = {
        ...fixtureManifest(),
        url: `http://127.0.0.1:${address.port}/archive.zip`,
        maxArchiveBytes: archive.length - 1,
      };
      await expect(
        mediaModule().prepareWindowsMedia({ projectRoot: root, platform: 'win32', arch: 'x64', manifest })
      ).rejects.toThrow(/archive.*limit/i);
      expectOldResources();
    } finally {
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
    }
  });

  it('rolls back both originals if the second staged rename fails', async () => {
    oldResources();
    const rename = fsPromises.rename.bind(fsPromises);
    vi.spyOn(fsPromises, 'rename').mockImplementation(async (from, to) => {
      if (String(from).includes('.win32-x64-stage-') && String(from).endsWith('ffprobe.exe')) {
        throw Object.assign(new Error('Injected publication failure'), { code: 'EACCES' });
      }
      return rename(from, to);
    });
    await expect(
      mediaModule().prepareWindowsMedia({
        projectRoot: root,
        platform: 'win32',
        arch: 'x64',
        manifest: fixtureManifest(),
        download: async () => archive,
      })
    ).rejects.toThrow('Injected publication failure');
    expectOldResources();
  });

  it('rejects a directory at a binary destination before changing any resource', async () => {
    oldResources();
    rmSync(join(destination, 'ffprobe.exe'));
    mkdirSync(join(destination, 'ffprobe.exe'));
    const download = vi.fn(async () => archive);
    await expect(
      mediaModule().prepareWindowsMedia({
        projectRoot: root,
        platform: 'win32',
        arch: 'x64',
        manifest: fixtureManifest(),
        download,
      })
    ).rejects.toThrow(/not a regular file/i);
    expect(download).not.toHaveBeenCalled();
    expect(readFileSync(join(destination, 'ffmpeg.exe'), 'utf8')).toBe('previous ffmpeg');
    expect(statSync(join(destination, 'ffprobe.exe')).isDirectory()).toBe(true);
    expect(readdirSync(join(root, 'resources/ffmpeg'))).toEqual(['win32-x64']);
  });

  it.each(['missing', 'bad-hash', 'oversized', 'duplicate', 'symlink', 'traversal', 'backslash'])(
    'rejects %s payloads before promoting either binary',
    async (scenario) => {
      oldResources();
      let entries = binaryEntries.map(({ name, bytes }) => ({ name, bytes, mode: 0o100644 }));
      if (scenario === 'missing') entries = entries.slice(0, 1);
      if (scenario === 'bad-hash') entries[1] = { ...entries[1], bytes: Buffer.alloc(entries[1].bytes.length) };
      if (scenario === 'oversized') entries[1] = { ...entries[1], bytes: Buffer.alloc(100) };
      if (scenario === 'duplicate') entries.push(entries[0]);
      if (scenario === 'symlink') entries[1] = { ...entries[1], mode: 0o120777 };
      if (scenario === 'traversal')
        entries.push({ name: '../escape.exe', bytes: Buffer.from('escape'), mode: 0o100644 });
      if (scenario === 'backslash')
        entries.push({ name: 'unsafe\\escape.exe', bytes: Buffer.from('escape'), mode: 0o100644 });
      const bytes = makeZip(entries);
      await expect(
        mediaModule().prepareWindowsMedia({
          projectRoot: root,
          platform: 'win32',
          arch: 'x64',
          manifest: fixtureManifest(bytes),
          download: async () => bytes,
        })
      ).rejects.toThrow();
      expectOldResources();
      expect(existsSync(join(root, 'escape.exe'))).toBe(false);
    }
  );
});

describe('media packaging integration', () => {
  it('prepares before extraResources copy while retaining the required afterPack media guard', () => {
    const config = readFileSync(join(repoRoot, 'packages/desktop/electron-builder.yml'), 'utf8');
    expect(config).toContain('beforePack: packages/shared-scripts/src/prepare-windows-media.js');
    expect(config).toContain('from: resources/ffmpeg/win32-${arch}');
    const guard = readFileSync(join(repoRoot, 'scripts/afterPack.js'), 'utf8');
    expect(guard).toContain("['ffmpeg.exe', 'ffprobe.exe']");
    expect(guard).toContain('Packaged app is missing required media binary(s)');
  });

  it('checks the Windows native build exit code immediately before printing success', () => {
    const workflow = readFileSync(join(repoRoot, '.github/workflows/pr-checks.yml'), 'utf8');
    expect(workflow).toMatch(
      /node scripts\/build-with-builder\.js x64 --win --x64\r?\n\s+if \(\$LASTEXITCODE -ne 0\) \{ exit \$LASTEXITCODE \}\r?\n\s+Write-Host "✓Build test passed/
    );
  });

  const itWithPwsh =
    spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', 'exit 0']).status === 0 ? it : it.skip;
  itWithPwsh('propagates a native failure and never prints the Windows success message', () => {
    const workflow = readFileSync(join(repoRoot, '.github/workflows/pr-checks.yml'), 'utf8');
    const section = workflow.split('- name: Build test (Windows x64)')[1].split('        env:')[0];
    const block = section
      .split('        run: |')[1]
      .replace(/^          /gm, '')
      .replaceAll('${{ matrix.platform }}', 'windows-x64');
    const node = process.execPath.replaceAll("'", "''");
    const result = spawnSync(
      'pwsh',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `function node { & '${node}' -e 'process.exit(23)' }\n${block}\nexit $LASTEXITCODE`,
      ],
      { encoding: 'utf8' }
    );
    expect(result.status, result.stderr).toBe(23);
    expect(result.stdout).not.toContain('Build test passed');
  });
});
