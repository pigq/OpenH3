import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { H3SetupTask } from '@/process/services/runtime/H3SetupTask';
const roots: string[] = [];
it('pauses a download only after its worker settles and preserves network mode', async () => {
  const task = new H3SetupTask(file(), async (_root, progress, _download, signal) => {
    progress('downloading', { filename: 'model', bytes: 3, totalBytes: 6 });
    await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
  });
  task.start('bundle', true);
  await Promise.resolve();
  expect(task.status()).toMatchObject({ filename: 'model', bytes: 3, download: true });
  await task.pause();
  expect(task.busy()).toBe(false);
  expect(task.status()).toMatchObject({ phase: 'paused', download: true, bytes: 3 });
});
it('does not interrupt extraction', async () => {
  const task = new H3SetupTask(file(), async (_root, progress) => {
    progress('extracting');
  });
  task.start('bundle');
  await Promise.resolve();
  await expect(task.pause()).rejects.toThrow('NOT_PAUSABLE');
  await task.wait();
});
function file() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'h3-setup-'));
  roots.push(root);
  return path.join(root, 'state.json');
}
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
it('persists stages and does not mark installation as generation ready', async () => {
  const task = new H3SetupTask(file(), async (_root, progress) => {
    progress('extracting');
  });
  task.start('bundle');
  await task.wait();
  expect(task.status().phase).toBe('installed');
});
it('rejects duplicate installation and preserves failures for retry', async () => {
  let fail = true;
  const task = new H3SetupTask(file(), async () => {
    if (fail) throw new Error('bad archive');
  });
  task.start('bundle');
  expect(() => task.start('other')).toThrow('BUSY');
  await task.wait();
  expect(task.status()).toMatchObject({ phase: 'failed', error: 'bad archive' });
  fail = false;
  task.start('bundle');
  await task.wait();
  expect(task.status().phase).toBe('installed');
});
it('recovers interrupted installs as paused without silently running them', () => {
  const state = file();
  fs.writeFileSync(state, JSON.stringify({ phase: 'extracting', bundleRoot: 'bundle' }));
  const task = new H3SetupTask(state, async () => {
    throw new Error('must not run');
  });
  expect(task.status()).toMatchObject({ phase: 'paused', bundleRoot: 'bundle' });
});
it('recovers a truncated state file as a retryable failure instead of throwing during service startup', () => {
  const state = file();
  fs.writeFileSync(state, '{"phase":"downloading"');
  const task = new H3SetupTask(state, async () => {
    throw new Error('must not run');
  });
  expect(task.status()).toEqual({ phase: 'failed', error: 'H3_SETUP_STATE_CORRUPTED' });
  expect(task.busy()).toBe(false);
});
it('passes explicit network opt-in and recovers interrupted download state', async () => {
  const state = file();
  fs.writeFileSync(state, JSON.stringify({ phase: 'downloading', bundleRoot: 'bundle' }));
  let network = false;
  const task = new H3SetupTask(state, async (_root, progress, download) => {
    network = download;
    progress('downloading');
  });
  expect(task.status().phase).toBe('paused');
  task.start('bundle', true);
  await task.wait();
  expect(network).toBe(true);
  expect(task.status().phase).toBe('installed');
});

it.each(['null', '[]', '42'])('handles invalid persisted state %s without a startup crash', (raw) => {
  const state = file();
  fs.writeFileSync(state, raw);
  expect(new H3SetupTask(state, async () => undefined).status()).toMatchObject({
    phase: 'failed',
    error: 'H3_SETUP_STATE_INVALID',
  });
});
it('keeps storage failures observable without rejecting the background install promise', async () => {
  const state = file();
  const task = new H3SetupTask(state, async () => {
    fs.mkdirSync(state + '.tmp');
    throw new Error('installation failed');
  });
  task.start('bundle');
  await expect(task.wait()).resolves.toBeUndefined();
  expect(task.status()).toMatchObject({ phase: 'failed', error: 'H3_SETUP_STATE_WRITE_FAILED' });
});
