import fs from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { bundleModule, digest, atomicWrite, canonical, isMain, assertKeyring } from './helpers.mjs';
export function contentDiff(before, after) {
  const old = new Map([...(before?.models ?? []), ...(before?.entries ?? [])].map((e) => [e.id, e]));
  const added = [],
    changed = [];
  for (const e of [...after.models, ...after.entries]) {
    const previous = old.get(e.id);
    if (!previous) added.push(e.id);
    else if (canonical(e) !== canonical(previous)) changed.push(e.id);
    old.delete(e.id);
  }
  return { from: before?.releaseSequence ?? null, to: after.releaseSequence, added, changed, removed: [...old.keys()] };
}
export function assertReferencedAssets(catalog) {
  const referenced = new Set();
  for (const entry of [...catalog.models, ...catalog.entries]) {
    referenced.add(entry.cover);
    if ('media' in entry && entry.media) referenced.add(entry.media);
  }
  if (catalog.assets.some((asset) => !referenced.has(asset.sha256))) throw Error('ASSET_UNREFERENCED');
}
export async function buildCatalog({ input, assetsDir, out, keyring, sequence, previous }) {
  assertKeyring(keyring);
  const { parseCatalog } = await bundleModule('packages/desktop/src/common/contentCatalog/schema.ts');
  const { CONTENT_CAPABILITIES } = await bundleModule('packages/desktop/src/common/contentCatalog/policy.ts');
  const source = JSON.parse((await fs.readFile(input, 'utf8')).replace(/^\uFEFF/, ''));
  const catalog = parseCatalog({ ...source.catalog, ...(sequence === undefined ? {} : { releaseSequence: sequence }) });
  if (catalog.releaseSequence < 1) throw Error('SEQUENCE_INVALID');
  const approvals = source.approvals;
  for (const entry of [...catalog.models, ...catalog.entries]) {
    if (
      !Array.isArray(approvals) ||
      !approvals.some(
        (a) =>
          a.id === entry.id &&
          a.revision === entry.revision &&
          a.status === 'published' &&
          typeof a.approvedBy === 'string' &&
          a.approvedBy.trim() &&
          Number.isFinite(Date.parse(a.approvedAt))
      )
    )
      throw Error('APPROVAL_REQUIRED');
    if (entry.requiredCapabilities.some((c) => !CONTENT_CAPABILITIES.includes(c))) throw Error('CAPABILITY_UNKNOWN');
    if ('family' in entry && !CONTENT_CAPABILITIES.includes(`comfy.${entry.family}`)) throw Error('CAPABILITY_UNKNOWN');
    if (/require.? review|unknown|pending|todo/i.test(entry.attribution.license))
      throw Error('ATTRIBUTION_REVIEW_REQUIRED');
  }
  assertReferencedAssets(catalog);
  if (previous) {
    for (const entry of [...catalog.entries, ...catalog.models]) {
      const prior = [...previous.entries, ...previous.models].find((e) => e.id === entry.id);
      if (prior && canonical(prior) !== canonical(entry) && entry.revision <= prior.revision)
        throw Error('REVISION_MUST_INCREASE');
    }
  }
  const files = [];
  const base = await fs.realpath(assetsDir);
  for (const asset of catalog.assets) {
    const filename = path.resolve(base, asset.path);
    const real = await fs.realpath(filename);
    const stat = await fs.lstat(filename);
    if (!real.startsWith(base + path.sep) || stat.isSymbolicLink() || !stat.isFile() || stat.size !== asset.sizeBytes)
      throw Error('ASSET_INVALID');
    const bytes = await fs.readFile(filename);
    if (bytes.subarray(0, 80).toString().startsWith('version https://git-lfs.github.com/spec/'))
      throw Error('LFS_POINTER');
    if (digest(bytes) !== asset.sha256) throw Error('DIGEST_MISMATCH');
    const valid =
      asset.mimeType === 'image/png'
        ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
        : asset.mimeType === 'image/jpeg'
          ? bytes[0] === 255 && bytes[1] === 216
          : asset.mimeType === 'image/webp'
            ? bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP'
            : bytes.toString('ascii', 4, 8) === 'ftyp';
    if (!valid) throw Error('MEDIA_INVALID');
    files.push({ bytes, hash: asset.sha256 });
    asset.path = `assets/${asset.sha256}`;
  }
  const required = new Set([...catalog.models, ...catalog.entries].map((e) => e.cover));
  if (catalog.assets.filter((a) => required.has(a.sha256)).reduce((n, a) => n + a.sizeBytes, 0) > 128 * 1024 * 1024)
    throw Error('SIZE_LIMIT');
  catalog.models.sort((a, b) => a.id.localeCompare(b.id));
  catalog.entries.sort((a, b) => a.id.localeCompare(b.id));
  catalog.assets.sort((a, b) => a.sha256.localeCompare(b.sha256));
  const encoded = canonical(catalog);
  if (Buffer.byteLength(encoded) > 8 * 1024 * 1024) throw Error('SIZE_LIMIT');
  await fs.mkdir(path.dirname(out), { recursive: true });
  await fs.mkdir(out);
  for (const { bytes, hash } of files) await atomicWrite(path.join(out, 'assets', hash), bytes);
  await atomicWrite(path.join(out, 'catalog.json'), encoded);
  await atomicWrite(path.join(out, 'changes.json'), canonical(contentDiff(previous, catalog)));
  return catalog;
}
if (isMain(import.meta.url)) {
  const { values } = parseArgs({
    options: {
      input: { type: 'string' },
      'assets-dir': { type: 'string' },
      out: { type: 'string' },
      keyring: { type: 'string' },
      sequence: { type: 'string' },
      previous: { type: 'string' },
    },
  });
  await buildCatalog({
    input: values.input,
    assetsDir: values['assets-dir'],
    out: values.out,
    keyring: JSON.parse(await fs.readFile(values.keyring, 'utf8')),
    sequence: values.sequence === undefined ? undefined : Number(values.sequence),
    previous: values.previous ? JSON.parse(await fs.readFile(values.previous, 'utf8')) : undefined,
  });
  console.log('Verified content snapshot built. No publication performed.');
}
