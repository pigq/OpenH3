import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { H3ArtifactArchive, serveH3ArtifactFile } from '@/process/services/media/creation/h3ArtifactArchive';
import type { H3Artifact } from '@/common/chat/document/h3Job';

let directory: string;
const artifact: H3Artifact = { filename: 'prior.mp4', subfolder: 'video', type: 'output', mimeType: 'video/mp4' };
beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'h3-artifact-history-'));
});
afterEach(() => fs.rmSync(directory, { recursive: true, force: true }));
const archive = () =>
  new H3ArtifactArchive({
    directory: path.join(directory, 'saved'),
    outputRoots: () => [path.join(directory, 'ComfyUI', 'output')],
  });

it('recovers a historical exact output while ComfyUI is offline and keeps it after restart', async () => {
  const output = path.join(directory, 'ComfyUI', 'output', 'video');
  fs.mkdirSync(output, { recursive: true });
  fs.writeFileSync(path.join(output, artifact.filename), '0123456789');
  const upstream = vi.fn(async () => {
    throw new Error('ComfyUI stopped');
  });
  const saved = await archive().resolve('historical-job', 0, artifact, upstream);
  expect(fs.readFileSync(saved, 'utf8')).toBe('0123456789');
  fs.rmSync(path.join(directory, 'ComfyUI'), { recursive: true });
  expect(await archive().resolve('historical-job', 0, artifact, upstream)).toBe(saved);
  expect(upstream).not.toHaveBeenCalled();
});

it('archives an upstream output once and never starts ComfyUI for playback', async () => {
  const upstream = vi.fn(async () => new Response('video bytes', { headers: { 'content-type': 'video/mp4' } }));
  const a = archive();
  const [first, second] = await Promise.all([
    a.resolve('remote-job', 0, artifact, upstream),
    a.resolve('remote-job', 0, artifact, upstream),
  ]);
  expect(first).toBe(second);
  expect(upstream).toHaveBeenCalledOnce();
  expect(fs.readFileSync(first, 'utf8')).toBe('video bytes');
});

it('rejects traversal and symlink output escapes', async () => {
  await expect(archive().resolve('../escape', 0, artifact)).rejects.toThrow('H3_ARTIFACT');
  await expect(archive().resolve('job', 0, { ...artifact, subfolder: '../other' })).rejects.toThrow('H3_ARTIFACT');
  const outside = path.join(directory, 'outside');
  const output = path.join(directory, 'ComfyUI', 'output');
  fs.mkdirSync(outside);
  fs.mkdirSync(output, { recursive: true });
  fs.writeFileSync(path.join(outside, artifact.filename), 'unrelated');
  fs.symlinkSync(outside, path.join(output, 'video'), process.platform === 'win32' ? 'junction' : 'dir');
  await expect(archive().resolve('job', 0, artifact)).rejects.toThrow('H3_ARTIFACT_UNAVAILABLE');
});

it('serves offline archived video with seekable byte ranges and rejects invalid ranges', async () => {
  const filename = path.join(directory, 'sample.mp4');
  fs.writeFileSync(filename, '0123456789');
  const server = http.createServer((request, response) =>
    serveH3ArtifactFile(request, response, filename, 'video/mp4')
  );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`;
  try {
    const response = await fetch(url, { headers: { Range: 'bytes=2-5' } });
    expect(response.status).toBe(206);
    expect(response.headers.get('content-range')).toBe('bytes 2-5/10');
    expect(await response.text()).toBe('2345');
    expect((await fetch(url, { headers: { Range: 'bytes=99-' } })).status).toBe(416);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
