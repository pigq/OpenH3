import test from 'node:test';
import assert from 'node:assert/strict';
import { createFixtureFeed } from './windows-update-fixture-server.mjs';

test('loopback feed serves unchanged manifest/payload and rejects unknown paths', async () => {
  const bytes = Buffer.from('fixture-bytes-not-a-real-exe');
  const feed = await createFixtureFeed({
    manifestText: 'version: 3.0.1\n',
    installerBytes: bytes,
    fileName: 'OpenH3-3.0.1-win-x64.exe',
  });
  try {
    assert.match(feed.url, /^http:\/\/127\.0\.0\.1:\d+\/$/);
    assert.equal(await (await fetch(feed.url + 'latest.yml')).text(), 'version: 3.0.1\n');
    assert.deepEqual(Buffer.from(await (await fetch(feed.url + 'OpenH3-3.0.1-win-x64.exe')).arrayBuffer()), bytes);
    assert.equal((await fetch(feed.url + 'unknown')).status, 404);
    assert.equal(feed.requests.length, 3);
  } finally {
    await feed.close();
  }
});

test('corrupt mode changes response bytes only, not original candidate or manifest', async () => {
  const bytes = Buffer.from('immutable-candidate');
  const feed = await createFixtureFeed({
    manifestText: 'original',
    installerBytes: bytes,
    fileName: 'OpenH3-3.0.1-win-x64.exe',
    mode: 'corrupt',
  });
  try {
    const actual = Buffer.from(await (await fetch(feed.url + 'OpenH3-3.0.1-win-x64.exe')).arrayBuffer());
    assert.notDeepEqual(actual, bytes);
    assert.equal(bytes.toString(), 'immutable-candidate');
    assert.equal(await (await fetch(feed.url + 'latest.yml')).text(), 'original');
    const served = feed.requests.find((r) => r.pathname.endsWith('.exe'));
    assert.equal(served.mode, 'corrupt');
    assert.equal(served.finished, true);
    assert.equal(served.bytesWritten, bytes.length);
    assert.equal(served.payloadSize, bytes.length);
  } finally {
    await feed.close();
  }
});

test('disconnected transfer fails rather than returning successful complete payload', async () => {
  const feed = await createFixtureFeed({
    manifestText: 'original',
    installerBytes: Buffer.alloc(4096, 1),
    fileName: 'OpenH3-3.0.1-win-x64.exe',
    mode: 'disconnect',
  });
  try {
    await assert.rejects(async () => (await fetch(feed.url + 'OpenH3-3.0.1-win-x64.exe')).arrayBuffer());
    const served = feed.requests[0];
    assert.equal(served.mode, 'disconnect');
    assert.equal(served.disconnected, true);
    assert.equal(served.finished, false);
    assert.ok(served.bytesWritten > 0 && served.bytesWritten < served.payloadSize);
  } finally {
    await feed.close();
  }
});

test('slow transport streams a first chunk and can close an unfinished owned connection', async () => {
  const bytes = Buffer.alloc(1024 * 1024, 7);
  const feed = await createFixtureFeed({
    manifestText: 'original',
    installerBytes: bytes,
    fileName: 'OpenH3-3.0.1-win-x64.exe',
    mode: 'slow',
  });
  try {
    const response = await fetch(feed.url + 'OpenH3-3.0.1-win-x64.exe');
    assert.equal(response.status, 200);
    assert.equal(Number(response.headers.get('content-length')), bytes.length);
    const reader = response.body.getReader();
    const first = await reader.read();
    assert.equal(first.done, false);
    assert.ok(first.value.length > 0 && first.value.length < bytes.length);
    assert.equal(feed.requests[0].pathname, '/OpenH3-3.0.1-win-x64.exe');
    await reader.cancel();
  } finally {
    await feed.close();
  }
});
