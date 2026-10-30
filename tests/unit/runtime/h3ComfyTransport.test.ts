import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { build } from 'esbuild';
import { createH3Job } from '@/common/chat/document/h3Job';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import { describe, expect, it } from 'vitest';
import type { H3Activity } from '@/common/chat/document/h3Job';
import { H3ComfyClient } from '@/process/services/runtime/H3ComfyClient';

// Node's fetch rejects these ports before opening a socket. A port returned by
// listen(0) can occasionally land in this list on a busy Windows runner.
const FETCH_BLOCKED_PORTS = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102, 103, 104, 109, 110,
  111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532,
  540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061,
  6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080,
]);

async function listenOnFetchSafePort(server: ReturnType<typeof createServer>) {
  while (true) {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    if (!FETCH_BLOCKED_PORTS.has(port)) return port;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function fixture(mode: 'events' | 'disconnect' | 'missing' | 'error') {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'h3-transport-'));
  const workflowPath = path.join(directory, 'workflow.json');
  fs.writeFileSync(workflowPath, JSON.stringify({ '1': { class_type: 'TestNode', inputs: {} } }));
  let submissions = 0,
    histories = 0,
    clientId = '',
    connectedId = '';
  const server = createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url?.startsWith('/object_info/')) {
      res.end(JSON.stringify(mode === 'missing' ? {} : { TestNode: { input: {}, output: [] } }));
      return;
    }
    if (req.url === '/prompt') {
      submissions++;
      let body = '';
      for await (const part of req) body += part;
      clientId = JSON.parse(body).client_id;
      res.end(JSON.stringify({ prompt_id: 'mine' }));
      return;
    }
    if (req.url === '/history/mine') {
      histories++;
      if (histories === 1) {
        res.end('{}');
        setTimeout(() => {
          for (const ws of sockets.clients) {
            if (mode === 'disconnect') {
              ws.close();
              continue;
            }
            ws.send(JSON.stringify({ type: 'execution_success', data: { prompt_id: 'other' } }));
            ws.send(JSON.stringify({ type: 'progress', data: { prompt_id: 'mine', value: 2, max: 4 } }));
            ws.send(
              JSON.stringify(
                mode === 'error'
                  ? {
                      type: 'execution_error',
                      data: { prompt_id: 'mine', node_id: '1', exception_type: 'torch.OutOfMemoryError' },
                    }
                  : { type: 'execution_success', data: { prompt_id: 'mine' } }
              )
            );
          }
        }, 10);
      } else
        res.end(
          JSON.stringify({
            mine: {
              status: { completed: true },
              outputs: { out: { videos: [{ filename: 'result.mp4', type: 'output' }] } },
            },
          })
        );
      return;
    }
    res.statusCode = 404;
    res.end('{}');
  });
  const sockets = new WebSocketServer({ server });
  sockets.on('connection', (_socket, req) => {
    connectedId = new URL(req.url!, 'http://local').searchParams.get('clientId')!;
  });
  const port = await listenOnFetchSafePort(server);
  return {
    client: new H3ComfyClient({
      baseUrl: `http://127.0.0.1:${port}`,
      workflowPath,
      pollIntervalMs: 5,
      eventCheckIntervalMs: 1000,
    }),
    stats: () => ({ submissions, histories, clientId, connectedId }),
    close: async () => {
      for (const ws of sockets.clients) ws.terminate();
      await new Promise<void>((resolve) => sockets.close(() => resolve()));
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      fs.rmSync(directory, { recursive: true, force: true });
    },
  };
}

describe('H3 preflight and WebSocket transport integration', () => {
  it('enforces the persisted barrier through the real media-service HTTP routes', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'h3-service-loop-'));
    let present = true;
    const backend = createServer((req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify(
          req.url?.endsWith('/cancel')
            ? { cancelled: true }
            : req.url === '/queue'
              ? { queue_running: present ? [[0, 'remote']] : [], queue_pending: [] }
              : {}
        )
      );
    });
    const backendPort = await listenOnFetchSafePort(backend);
    const reservation = createServer();
    const servicePort = await listenOnFetchSafePort(reservation);
    await new Promise<void>((resolve) => reservation.close(() => resolve()));
    const serviceFile = path.join(directory, 'service.cjs');
    await build({
      entryPoints: ['scripts/media-service.ts'],
      outfile: serviceFile,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      external: ['better-sqlite3', 'electron'],
      logLevel: 'silent',
      tsconfig: 'tsconfig.json',
    });
    fs.writeFileSync(
      path.join(directory, 'h3-jobs.json'),
      JSON.stringify([
        { ...createH3Job({ prompt: 'test' }, 'blocked'), status: 'failed', promptId: 'remote', remoteUncertain: true },
      ])
    );
    const child = spawn(process.execPath, [serviceFile], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        NODE_PATH: path.resolve('node_modules'),
        AIONUI_DATA_DIR: directory,
        AIONUI_MEDIA_PORT: String(servicePort),
        AIONUI_H3_URL: `http://127.0.0.1:${backendPort}`,
      },
    });
    let diagnostics = '';
    child.stderr?.on('data', (data) => {
      diagnostics += String(data);
    });
    const request = (route: string, init?: RequestInit) =>
      fetch(`http://127.0.0.1:${servicePort}${route}`, { ...init, signal: AbortSignal.timeout(10_000) });
    try {
      let ready = false;
      for (let attempt = 0; attempt < 50; attempt++) {
        try {
          const response = await request('/api/h3/jobs/blocked');
          await response.text();
          ready = true;
          break;
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      }
      expect(ready, diagnostics).toBe(true);
      const missing = await request('/api/h3/jobs/missing');
      expect(missing.status).toBe(404);
      await missing.text();
      for (const route of ['/api/h3/jobs', '/api/h3/free-memory']) {
        const response = await request(route, { method: 'POST', body: JSON.stringify({ prompt: 'replacement' }) });
        expect(response.status).toBe(409);
        await response.text();
      }
      const failedCancel = await request('/api/h3/jobs/blocked?action=cancel', { method: 'POST' });
      expect(failedCancel.status).toBe(400);
      expect(await failedCancel.json()).toMatchObject({ error: 'H3_COMFY_CANCEL_UNCONFIRMED' });
      expect(await (await request('/api/h3/jobs/blocked')).json()).toMatchObject({ remoteUncertain: true });
      present = false;
      const stopped = await request('/api/h3/jobs/blocked?action=cancel', { method: 'POST' });
      expect(await stopped.json()).toMatchObject({ status: 'failed', remoteUncertain: false });
      const stream = await request('/api/h3/jobs/blocked/events');
      expect(await stream.text()).toContain('"remoteUncertain":false');
    } finally {
      const exited = new Promise<void>((resolve) => {
        if (child.exitCode !== null) resolve();
        else child.once('exit', () => resolve());
      });
      child.kill();
      await exited;
      backend.closeAllConnections();
      await new Promise<void>((resolve) => backend.close(() => resolve()));
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }, 30_000);
  it.each(['events', 'disconnect'] as const)(
    'completes through %s with one submission and authoritative history',
    async (mode) => {
      const test = await fixture(mode);
      const progress: number[] = [];
      const activities: H3Activity[] = [];
      try {
        const result = await test.client.generate({ prompt: 'test' }, new AbortController().signal, (v, activity) => {
          progress.push(v);
          if (activity) activities.push(activity);
        });
        expect(result.artifacts[0].filename).toBe('result.mp4');
        const stats = test.stats();
        expect(stats.submissions).toBe(1);
        expect(stats.histories).toBe(2);
        expect(stats.clientId).toBe(stats.connectedId);
        expect(stats.clientId).not.toBe('aionui-video-agent');
        expect(progress.slice(0, -1).every((v) => v === 0)).toBe(true);
        expect(progress.at(-1)).toBe(1);
        if (mode === 'events')
          expect(activities).toContainEqual(expect.objectContaining({ phase: 'node-progress', value: 2, max: 4 }));
      } finally {
        await test.close();
      }
    }
  );
  it('blocks missing nodes before submitting any GPU work', async () => {
    const test = await fixture('missing');
    try {
      await expect(test.client.generate({ prompt: 'test' }, new AbortController().signal)).rejects.toThrow(
        'MISSING_NODE'
      );
      expect(test.stats().submissions).toBe(0);
    } finally {
      await test.close();
    }
  });
  it('turns execution errors into diagnosis without waiting for history', async () => {
    const test = await fixture('error');
    try {
      await expect(test.client.generate({ prompt: 'test' }, new AbortController().signal)).rejects.toThrow('OOM');
      expect(test.stats().histories).toBe(1);
    } finally {
      await test.close();
    }
  });
  it('fails explicitly when a ComfyUI restart loses the remote history', async () => {
    const test = await fixture('disconnect');
    try {
      const client = new H3ComfyClient({
        baseUrl: test.client.getBaseUrl(),
        workflowPath: `${process.cwd()}/nonexistent.json`,
        maxWaitMs: 1,
      });
      await expect(client.resume('lost-prompt', new AbortController().signal)).rejects.toMatchObject({
        message: 'H3_COMFY_HISTORY_TIMEOUT',
      });
    } finally {
      await test.close();
    }
  });
});
