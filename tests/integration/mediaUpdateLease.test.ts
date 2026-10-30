import { afterEach, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createH3Job } from '@/common/chat/document/h3Job';

const fixtures: Array<{ root: string; child: ChildProcess }> = [];
afterEach(async () => {
  for (const { root, child } of fixtures.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill();
      await exited;
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});

async function start(uncertain = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'media-update-http-'));
  if (uncertain)
    fs.writeFileSync(
      path.join(root, 'h3-jobs.json'),
      JSON.stringify([{ ...createH3Job({ prompt: 'fixture' }), status: 'failed', remoteUncertain: true }])
    );
  const listener = net.createServer();
  await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', resolve));
  const port = (listener.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => listener.close(() => resolve()));
  const child = spawn(
    process.execPath,
    [path.resolve('node_modules/tsx/dist/cli.mjs'), path.resolve('scripts/media-service.ts')],
    {
      cwd: path.resolve('.'),
      windowsHide: true,
      stdio: 'ignore',
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        AIONUI_DATA_DIR: root,
        AIONUI_MEDIA_PORT: String(port),
        OPENH3_UPDATE_CONTROL_TOKEN: 'update-fixture',
        AIONUI_MEDIA_UI_TOKEN: 'ui-fixture',
        AIONUI_H3_URL: 'http://127.0.0.1:1',
        AIONUI_H3_BUNDLE_ROOT: path.join(root, 'h3'),
      },
    }
  );
  fixtures.push({ root, child });
  const base = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) throw new Error('MEDIA_FIXTURE_EXITED');
    try {
      if ((await fetch(`${base}/health`)).ok) break;
    } catch {
      /* Wait for isolated fixture startup. */
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const control = (method: string, leaseId: string, token = 'update-fixture', expiresAt = Date.now() + 10_000) =>
    fetch(`${base}/api/system/update-lease`, {
      method,
      headers: { 'content-type': 'application/json', 'x-openh3-update-token': token },
      body: JSON.stringify({ leaseId, expiresAt }),
    });
  return { base, port, control };
}

describe('real media service update admission', () => {
  it('keeps a submitted request alive, fences new work only when idle, and restores admission on rollback', async () => {
    const { base, port, control } = await start();
    const id = '11111111-1111-4111-8111-111111111111';
    const payload = JSON.stringify({ requestId: id, conversationId: 'fixture' });
    const pending = http.request({
      hostname: '127.0.0.1',
      port,
      path: '/api/creation/bind',
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
    });
    const response = new Promise<number>((resolve, reject) => {
      pending.once('response', (res) => {
        res.resume();
        res.once('end', () => resolve(res.statusCode!));
      });
      pending.once('error', reject);
    });
    pending.write(payload.slice(0, -1));
    await fetch(`${base}/health`);
    expect(await (await control('POST', id)).json()).toEqual({ idle: false });
    pending.end(payload.slice(-1));
    expect(await response).toBe(200);
    expect(await (await control('POST', id)).json()).toEqual({ idle: true });
    const bind = () =>
      fetch(`${base}/api/creation/bind`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: payload,
      });
    expect((await bind()).status).toBe(503);
    expect(
      (
        await fetch(`${base}/api/comfy/runtime-context`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-openh3-ui-token': 'ui-fixture' },
          body: JSON.stringify({ backendPort: 33000 }),
        })
      ).status
    ).toBe(200);
    expect((await control('DELETE', id, 'wrong')).status).toBe(403);
    expect((await control('DELETE', id)).status).toBe(200);
    expect((await bind()).status).toBe(200);
    expect(
      await (await control('POST', '22222222-2222-4222-8222-222222222222', 'update-fixture', Date.now() - 1000)).json()
    ).toEqual({ idle: false });
  }, 30_000);

  it('defers replacement while a persisted H3 remote submission remains unconfirmed', async () => {
    const { control } = await start(true);
    expect(await (await control('POST', '33333333-3333-4333-8333-333333333333')).json()).toEqual({ idle: false });
  }, 30_000);
});
