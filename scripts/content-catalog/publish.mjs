import fs from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { bundleModule, digest, isMain, canonical, atomicWrite } from './helpers.mjs';
import { signCatalog, signingKey } from './sign.mjs';
import { assertReferencedAssets, contentDiff } from './build.mjs';
const API = 'https://api.github.com/repos/pigq/OpenH3';
/** Publish immutable payload first. The signed channel ref is the final, fast-forward-only operation. */
export async function publishCatalog({
  directory,
  keyId,
  keyring,
  privateKey,
  minClientVersion,
  token,
  fetcher = fetch,
  rollbackReason,
}) {
  if (!token) throw Error('GITHUB_TOKEN_REQUIRED');
  signingKey(privateKey, keyId, keyring);
  const { parseCatalog } = await bundleModule('packages/desktop/src/common/contentCatalog/schema.ts');
  const { verifyManifest } = await bundleModule('packages/desktop/src/process/services/contentCatalog/trust.ts');
  const bytes = await fs.readFile(path.join(directory, 'catalog.json'));
  const catalog = parseCatalog(JSON.parse(bytes));
  assertReferencedAssets(catalog);
  async function api(route, method = 'GET', body, optional = false) {
    const res = await fetcher(API + route, {
      method,
      signal: AbortSignal.timeout(30000),
      redirect: 'error',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (optional && res.status === 404) return null;
    if (!res.ok) throw Error(`CONTENT_PUBLISH_HTTP_${res.status}`);
    return res.json();
  }
  const channel = await api('/git/ref/heads/content-stable', 'GET', undefined, true);
  let previousCatalog;
  if (channel) {
    const manifest = await api(`/contents/manifest.json?ref=${channel.object.sha}`);
    const sig = await api(`/contents/manifest.sig?ref=${channel.object.sha}`);
    const previous = verifyManifest(
      Buffer.from(manifest.content.replace(/\s/g, ''), 'base64'),
      Buffer.from(sig.content.replace(/\s/g, ''), 'base64'),
      keyring,
      0,
      Date.now(),
      true
    );
    if (catalog.releaseSequence <= previous.releaseSequence) throw Error('SEQUENCE_MUST_INCREASE');
    const payload = await fetcher(
      `https://raw.githubusercontent.com/pigq/OpenH3/${previous.snapshotCommit}/${previous.catalogPath}`,
      { redirect: 'error', signal: AbortSignal.timeout(30000) }
    );
    if (!payload.ok) throw Error(`CONTENT_PUBLISH_HTTP_${payload.status}`);
    const reader = payload.body?.getReader();
    if (!reader) throw Error('PREVIOUS_BODY_MISSING');
    let total = 0;
    const chunks = [];
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > previous.catalogSizeBytes) throw Error('PREVIOUS_SIZE_LIMIT');
        chunks.push(value);
      }
    } finally {
      await reader.cancel();
    }
    const previousBytes = Buffer.concat(chunks);
    if (previousBytes.length !== previous.catalogSizeBytes || digest(previousBytes) !== previous.catalogSha256)
      throw Error('PREVIOUS_DIGEST_MISMATCH');
    previousCatalog = parseCatalog(JSON.parse(previousBytes));
    if (previousCatalog.releaseSequence !== previous.releaseSequence) throw Error('PREVIOUS_SEQUENCE_INVALID');
    if (!rollbackReason) {
      for (const entry of [...catalog.models, ...catalog.entries]) {
        const prior = [...previousCatalog.models, ...previousCatalog.entries].find((e) => e.id === entry.id);
        if (prior && canonical(prior) !== canonical(entry) && entry.revision <= prior.revision)
          throw Error('REVISION_MUST_INCREASE');
      }
    }
  }
  if (
    rollbackReason !== undefined &&
    (typeof rollbackReason !== 'string' || rollbackReason.trim().length < 8 || rollbackReason.length > 1000)
  )
    throw Error('ROLLBACK_REASON_REQUIRED');
  await atomicWrite(
    path.join(directory, 'changes.json'),
    canonical({ ...contentDiff(previousCatalog, catalog), ...(rollbackReason ? { rollbackReason } : {}) })
  );
  const snapshots = await api('/git/ref/heads/content-snapshots', 'GET', undefined, true);
  async function blob(data) {
    const value = await api('/git/blobs', 'POST', { content: data.toString('base64'), encoding: 'base64' });
    if (!/^[a-f0-9]{40}$/.test(value.sha)) throw Error('GITHUB_RESPONSE_INVALID');
    return value.sha;
  }
  const tree = [];
  for (const asset of catalog.assets) {
    if (asset.path !== `assets/${asset.sha256}`) throw Error('ASSET_PATH_INVALID');
    const data = await fs.readFile(path.join(directory, asset.path));
    if (data.length !== asset.sizeBytes || digest(data) !== asset.sha256) throw Error('DIGEST_MISMATCH');
    tree.push({ path: asset.path, mode: '100644', type: 'blob', sha: await blob(data) });
  }
  tree.push({ path: 'catalog.json', mode: '100644', type: 'blob', sha: await blob(bytes) });
  tree.push({
    path: 'changes.json',
    mode: '100644',
    type: 'blob',
    sha: await blob(await fs.readFile(path.join(directory, 'changes.json'))),
  });
  const payloadTree = await api('/git/trees', 'POST', { tree });
  const payload = await api('/git/commits', 'POST', {
    message: `content: immutable revision ${catalog.releaseSequence}`,
    tree: payloadTree.sha,
    parents: snapshots ? [snapshots.object.sha] : [],
  });
  async function move(name, prior, sha) {
    await api(
      prior ? `/git/refs/heads/${name}` : '/git/refs',
      prior ? 'PATCH' : 'POST',
      prior ? { sha, force: false } : { ref: `refs/heads/${name}`, sha }
    );
  }
  await move('content-snapshots', snapshots, payload.sha);
  await signCatalog({ directory, snapshotCommit: payload.sha, keyId, keyring, privateKey, minClientVersion });
  const pointerTree = [];
  for (const filename of ['manifest.json', 'manifest.sig'])
    pointerTree.push({
      path: filename,
      mode: '100644',
      type: 'blob',
      sha: await blob(await fs.readFile(path.join(directory, filename))),
    });
  const signedTree = await api('/git/trees', 'POST', { tree: pointerTree });
  const signedCommit = await api('/git/commits', 'POST', {
    message: `content: activate signed revision ${catalog.releaseSequence}`,
    tree: signedTree.sha,
    parents: channel ? [channel.object.sha] : [],
  });
  await move('content-stable', channel, signedCommit.sha);
  return { sequence: catalog.releaseSequence, snapshotCommit: payload.sha, channelCommit: signedCommit.sha };
}
if (isMain(import.meta.url)) {
  const { values } = parseArgs({
    options: {
      publish: { type: 'boolean' },
      directory: { type: 'string' },
      'key-id': { type: 'string' },
      keyring: { type: 'string' },
      'min-client-version': { type: 'string' },
      'rollback-reason': { type: 'string' },
    },
  });
  if (!values.publish || process.env.GITHUB_REPOSITORY !== 'pigq/OpenH3' || process.env.GITHUB_ACTIONS !== 'true')
    throw Error('Use the manually approved official-content GitHub workflow.');
  console.log(
    await publishCatalog({
      directory: values.directory,
      keyId: values['key-id'],
      keyring: JSON.parse(await fs.readFile(values.keyring, 'utf8')),
      privateKey: await fs.readFile(process.env.OPENH3_CONTENT_PRIVATE_KEY_FILE),
      minClientVersion: values['min-client-version'],
      token: process.env.GITHUB_TOKEN,
      rollbackReason: values['rollback-reason'] || undefined,
    })
  );
}
