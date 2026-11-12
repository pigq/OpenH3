import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { ComfyPromptObserver } from '@/process/services/media/creation/ComfyPromptObserver';

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const task of cleanup.reverse()) await task();
  cleanup.length = 0;
});

async function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'comfy-observer-'));
  cleanup.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const promptId = crypto.randomUUID();
  let complete = false;
  let filename = 'generated.png';
  const calls: string[] = [];
  const pixels = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7L8AAAAASUVORK5CYII=',
    'base64'
  );
  const server = http.createServer((req, res) => {
    calls.push(`${req.method} ${req.url}`);
    const route = new URL(req.url ?? '/', 'http://localhost');
    res.setHeader('content-type', 'application/json');
    if (route.pathname === `/history/${promptId}`)
      res.end(
        JSON.stringify(
          complete
            ? {
                [promptId]: {
                  status: { completed: true, status_str: 'success' },
                  outputs: { '1': { images: [{ filename, type: 'output', subfolder: 'task' }] } },
                },
              }
            : {}
        )
      );
    else if (route.pathname === '/queue')
      res.end(JSON.stringify({ queue_pending: [], queue_running: [[1, promptId]] }));
    else if (route.pathname === '/view') {
      res.setHeader('content-type', 'image/png');
      res.end(pixels);
    } else {
      res.statusCode = 404;
      res.end('{}');
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanup.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const options = {
    filename: path.join(root, 'observed.json'),
    outputRoot: path.join(root, 'outputs'),
    verifyArtifact: vi.fn(async () => undefined),
  };
  const create = () => {
    const observer = new ComfyPromptObserver(options);
    cleanup.push(() => observer.close());
    return observer;
  };
  return {
    root,
    promptId,
    baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    calls,
    pixels,
    create,
    complete: () => {
      complete = true;
    },
    unsafe: () => {
      filename = '../secret.png';
    },
    options,
  };
}

it('observes one existing prompt, persists pending work and archives the output without any submission', async () => {
  const f = await fixture();
  let observer = f.create();
  const input = { conversationId: 'chat', baseUrl: f.baseUrl, promptId: f.promptId, kind: 'image' as const };
  const job = observer.observe(input);
  expect(observer.observe(input).id).toBe(job.id);
  await observer.tick();
  expect(observer.job(job.id, { conversationId: 'chat' })).toMatchObject({
    status: 'running',
    promptId: f.promptId,
    observationOnly: true,
  });
  observer.close();
  observer = f.create();
  expect(observer.observe(input).id).toBe(job.id);
  f.complete();
  await observer.tick();
  const finished = observer.job(job.id, { conversationId: 'chat' });
  expect(finished.status).toBe('succeeded');
  expect(fs.readFileSync(finished.artifacts[0].path)).toEqual(f.pixels);
  expect(finished.artifacts[0].path.startsWith(f.options.outputRoot)).toBe(true);
  expect(f.calls.every((call) => call.startsWith('GET '))).toBe(true);
  expect(f.calls.some((call) => call.includes('/prompt') || call.includes('/interrupt'))).toBe(false);
  expect(() => observer.job(job.id, { conversationId: 'other' })).toThrow('COMFY_SCOPE_MISMATCH');
  expect(() => observer.observe({ ...input, conversationId: 'other' })).toThrow('COMFY_SCOPE_MISMATCH');
  observer.close();
  expect(f.create().job(job.id, { conversationId: 'chat' }).artifacts).toEqual(finished.artifacts);
});

it('rejects non-loopback endpoints, redirects and unsafe history output paths', async () => {
  const f = await fixture();
  const observer = f.create();
  const input = { conversationId: 'chat', baseUrl: f.baseUrl, promptId: f.promptId, kind: 'image' as const };
  for (const baseUrl of ['https://example.com', 'http://127.0.0.1:8188/path', 'http://user:secret@localhost:8188'])
    expect(() => observer.observe({ ...input, baseUrl })).toThrow('COMFY_LOCAL_ENDPOINT_REQUIRED');
  f.complete();
  f.unsafe();
  const job = observer.observe(input);
  await observer.tick();
  expect(observer.job(job.id, { conversationId: 'chat' })).toMatchObject({
    status: 'failed',
    error: 'COMFY_OUTPUT_PATH_UNSAFE',
    artifacts: [],
  });
  expect(f.calls.some((call) => call.includes('/view'))).toBe(false);
});

it('keeps the observer available when an old archived output was removed', async () => {
  const f = await fixture();
  const input = { conversationId: 'chat', baseUrl: f.baseUrl, promptId: f.promptId, kind: 'image' as const };
  const observer = f.create();
  f.complete();
  const job = observer.observe(input);
  await observer.tick();
  fs.unlinkSync(observer.job(job.id, { conversationId: 'chat' }).artifacts[0].path);
  observer.close();
  const restarted = f.create();
  expect(restarted.job(job.id, { conversationId: 'chat' })).toMatchObject({
    status: 'failed',
    error: 'COMFY_OUTPUT_FILE_MISSING',
  });
  expect(restarted.observe(input).id).toBe(job.id);
  await restarted.tick();
  expect(restarted.job(job.id, { conversationId: 'chat' }).status).toBe('succeeded');
});

it('reports invalid decoded media as an output failure, instead of repeatedly downloading it as a connection failure', async () => {
  const f = await fixture();
  f.options.verifyArtifact.mockRejectedValue(new Error('COMFY_SMOKE_IMAGE_INVALID'));
  const observer = f.create();
  f.complete();
  const job = observer.observe({ conversationId: 'chat', baseUrl: f.baseUrl, promptId: f.promptId, kind: 'image' });
  await observer.tick();
  expect(observer.job(job.id, { conversationId: 'chat' })).toMatchObject({
    status: 'failed',
    error: 'COMFY_SMOKE_IMAGE_INVALID',
  });
  const downloads = f.calls.filter((call) => call.includes('/view')).length;
  await observer.tick();
  expect(f.calls.filter((call) => call.includes('/view'))).toHaveLength(downloads);
});

it('survives an unreadable receipt without overwriting it or disabling other media services', async () => {
  const f = await fixture();
  fs.writeFileSync(f.options.filename, '{broken');
  const observer = f.create();
  await observer.tick();
  expect(() =>
    observer.observe({ conversationId: 'chat', baseUrl: f.baseUrl, promptId: f.promptId, kind: 'image' })
  ).toThrow('COMFY_OBSERVER_STATE_INVALID');
  expect(fs.readFileSync(f.options.filename, 'utf8')).toBe('{broken');
});

it('isolates an unusable observer output location from media-service startup', async () => {
  const f = await fixture();
  fs.writeFileSync(f.options.outputRoot, 'existing file');
  const observer = f.create();
  expect(() =>
    observer.observe({ conversationId: 'chat', baseUrl: f.baseUrl, promptId: f.promptId, kind: 'image' })
  ).toThrow('COMFY_OBSERVER_STATE_INVALID');
  expect(fs.readFileSync(f.options.outputRoot, 'utf8')).toBe('existing file');
});

it('persists a retried handoff after the initial receipt write temporarily fails', async () => {
  const f = await fixture();
  const observer = f.create();
  const input = { conversationId: 'chat', baseUrl: f.baseUrl, promptId: f.promptId, kind: 'image' as const };
  const blockedTemporary = f.options.filename + '.tmp';
  fs.mkdirSync(blockedTemporary);
  expect(() => observer.observe(input)).toThrow();
  fs.rmdirSync(blockedTemporary);
  const retry = observer.observe(input);
  expect(fs.existsSync(f.options.filename)).toBe(true);
  observer.close();
  expect(f.create().observe(input).id).toBe(retry.id);
});

it('persists a retried failed-job reset before acknowledging the same prompt handoff', async () => {
  const f = await fixture();
  f.complete();
  f.unsafe();
  const observer = f.create();
  const input = { conversationId: 'chat', baseUrl: f.baseUrl, promptId: f.promptId, kind: 'image' as const };
  const job = observer.observe(input);
  await observer.tick();
  expect(observer.job(job.id, { conversationId: 'chat' }).status).toBe('failed');
  const blockedTemporary = f.options.filename + '.tmp';
  fs.mkdirSync(blockedTemporary);
  expect(() => observer.observe(input)).toThrow();
  fs.rmdirSync(blockedTemporary);
  expect(observer.observe(input).status).toBe('queued');
  observer.close();
  expect(f.create().job(job.id, { conversationId: 'chat' }).status).toBe('queued');
});
