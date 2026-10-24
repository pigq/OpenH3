/** Prepare the pinned Windows media payload before electron-builder copies extraResources. */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const yauzl = require('yauzl');

const WINDOWS_MEDIA = Object.freeze({
  url: 'https://github.com/GyanD/codexffmpeg/releases/download/7.1.1/ffmpeg-7.1.1-essentials_build.zip',
  archiveSha256: '04861d3339c5ebe38b56c19a15cf2c0cc97f5de4fa8910e4d47e5e6404e4a2d4',
  maxArchiveBytes: 96 * 1024 * 1024,
  binaries: Object.freeze([
    Object.freeze({
      filename: 'ffmpeg.exe',
      entry: 'ffmpeg-7.1.1-essentials_build/bin/ffmpeg.exe',
      size: 87429632,
      sha256: 'b90225987bdd042cca09a1efb5e34e9848f2d1dbf5fbcd388753a44145522997',
    }),
    Object.freeze({
      filename: 'ffprobe.exe',
      entry: 'ffmpeg-7.1.1-essentials_build/bin/ffprobe.exe',
      size: 87291904,
      sha256: '05e8fa639450f8191635192871ae37a3ec3e4638fa12f3b7d49c6522ba16a8ed',
    }),
  ]),
});

async function downloadArchive(manifest) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120000);
  try {
    const response = await fetch(manifest.url, { signal: controller.signal });
    if (!response.ok || !response.body) throw new Error(`Media archive download failed: HTTP ${response.status}`);
    if (Number(response.headers.get('content-length')) > manifest.maxArchiveBytes) {
      await response.body.cancel();
      throw new Error('Media archive exceeds download size limit');
    }
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > manifest.maxArchiveBytes) throw new Error('Media archive exceeds download size limit');
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  } finally {
    controller.abort();
    clearTimeout(timeout);
  }
}

async function matchesBinary(file, binary) {
  let stat;
  try {
    stat = await fs.promises.lstat(file);
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
  if (!stat.isFile() && !stat.isSymbolicLink())
    throw new Error(`Media binary destination is not a regular file: ${file}`);
  if (!stat.isFile() || stat.size !== binary.size) return false;
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex') === binary.sha256;
}

function extractBinaries(bytes, staging, manifest) {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(bytes, { lazyEntries: true, strictFileNames: true, validateEntrySizes: true }, (error, zip) => {
      if (error) return reject(error);
      const found = new Set();
      let settled = false;
      let entries = 0;
      const fail = (failure) => {
        if (settled) return;
        settled = true;
        zip.close();
        reject(failure);
      };
      zip.on('error', fail);
      zip.on('entry', (entry) => {
        const extract = async () => {
          if (++entries > 2048) throw new Error('Media archive exceeds entry count limit');
          const segments = entry.fileName.replace(/\/$/, '').split('/');
          if (/[\\:]/.test(entry.fileName) || segments.some((part) => !part || part === '.' || part === '..')) {
            throw new Error('Unsafe media archive entry');
          }
          const binary = manifest.binaries.find((item) => item.entry === entry.fileName);
          if (!binary) return;
          if (found.has(binary.filename)) throw new Error(`Duplicate media payload: ${binary.filename}`);
          found.add(binary.filename);
          const fileType = (entry.externalFileAttributes >>> 16) & 0xf000;
          if ((fileType !== 0 && fileType !== 0x8000) || entry.uncompressedSize !== binary.size) {
            throw new Error(`Invalid media payload type or size: ${binary.filename}`);
          }
          const input = await new Promise((done, failed) => {
            zip.openReadStream(entry, (failure, stream) => (failure ? failed(failure) : done(stream)));
          });
          let size = 0;
          const hash = crypto.createHash('sha256');
          const verify = new Transform({
            transform(chunk, _encoding, callback) {
              size += chunk.length;
              if (size > binary.size)
                return callback(new Error(`Media payload exceeds size limit: ${binary.filename}`));
              hash.update(chunk);
              callback(null, chunk);
            },
          });
          await pipeline(input, verify, fs.createWriteStream(path.join(staging, binary.filename), { flags: 'wx' }));
          if (size !== binary.size || hash.digest('hex') !== binary.sha256) {
            throw new Error(`Media payload SHA-256 or size mismatch: ${binary.filename}`);
          }
        };
        extract().then(() => {
          if (!settled) zip.readEntry();
        }, fail);
      });
      zip.on('end', () => {
        if (settled) return;
        const missing = manifest.binaries.filter((binary) => !found.has(binary.filename));
        if (missing.length)
          return fail(new Error(`Missing media payload: ${missing.map((binary) => binary.filename).join(', ')}`));
        settled = true;
        zip.close();
        resolve();
      });
      zip.readEntry();
    });
  });
}

async function publishBinaries(staging, destination, binaries) {
  await fs.promises.mkdir(destination, { recursive: true });
  const changes = [];
  try {
    for (const binary of binaries) {
      const target = path.join(destination, binary.filename);
      const backup = path.join(staging, `${binary.filename}.previous`);
      const change = { target, backup, previous: false, installed: false };
      changes.push(change);
      try {
        await fs.promises.rename(target, backup);
        change.previous = true;
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      await fs.promises.rename(path.join(staging, binary.filename), target);
      change.installed = true;
    }
  } catch (error) {
    const failures = [];
    for (const change of changes.toReversed()) {
      try {
        if (change.installed) await fs.promises.unlink(change.target);
        if (change.previous) await fs.promises.rename(change.backup, change.target);
      } catch (failure) {
        failures.push(failure);
      }
    }
    if (failures.length) {
      throw new AggregateError(
        [error, ...failures],
        `Media rollback failed; original files retained under ${staging}`,
        { cause: error }
      );
    }
    throw error;
  }
  for (const change of changes) if (change.previous) await fs.promises.unlink(change.backup);
}

/** Downloads can be injected by callers; production pins are never overridden by environment variables or PATH. */
async function prepareWindowsMedia({
  projectRoot,
  platform,
  arch,
  manifest = WINDOWS_MEDIA,
  download = downloadArchive,
}) {
  if (platform !== 'win32') return;
  if (arch !== 'x64' && arch !== 1) throw new Error(`Unsupported Windows media architecture: ${arch}`);
  const parent = path.resolve(projectRoot, 'resources/ffmpeg');
  const destination = path.join(parent, 'win32-x64');
  for (const directory of [path.resolve(projectRoot, 'resources'), parent, destination]) {
    try {
      if (!(await fs.promises.lstat(directory)).isDirectory())
        throw new Error(`Media resource path is not a regular directory: ${directory}`);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  const existing = await Promise.all(
    manifest.binaries.map((binary) => matchesBinary(path.join(destination, binary.filename), binary))
  );
  if (existing.every(Boolean)) return;

  const bytes = await download(manifest);
  if (!Buffer.isBuffer(bytes) || bytes.length > manifest.maxArchiveBytes)
    throw new Error('Media archive exceeds size limit');
  if (crypto.createHash('sha256').update(bytes).digest('hex') !== manifest.archiveSha256)
    throw new Error('Media archive SHA-256 mismatch');
  await fs.promises.mkdir(parent, { recursive: true });
  const staging = await fs.promises.mkdtemp(path.join(parent, '.win32-x64-stage-'));
  try {
    await extractBinaries(bytes, staging, manifest);
    await publishBinaries(staging, destination, manifest.binaries);
  } finally {
    // Preserve originals if rollback itself failed. Never recursively remove a computed path outside this staging parent.
    const retained = (await fs.promises.readdir(staging)).some((filename) => filename.endsWith('.previous'));
    if (
      !retained &&
      path.dirname(path.resolve(staging)) === parent &&
      path.basename(staging).startsWith('.win32-x64-stage-')
    ) {
      await fs.promises.rm(staging, { recursive: true, force: true });
    }
  }
}

async function beforePack(context) {
  if (context.electronPlatformName !== 'win32') return;
  await prepareWindowsMedia({
    projectRoot: context.packager.projectDir,
    platform: context.electronPlatformName,
    arch: context.arch,
  });
}

module.exports = beforePack;
module.exports.prepareWindowsMedia = prepareWindowsMedia;
module.exports.WINDOWS_MEDIA = WINDOWS_MEDIA;
