import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { H3Job } from '@/common/chat/document/h3Job';
import { H3JobRunner } from '@/process/services/runtime/H3JobRunner';
import { H3ReferencePreflight } from '@/process/services/runtime/H3ReferencePreflight';
import type { H3JobStore } from '@/process/services/runtime/H3JobStore';

function store(): H3JobStore {
  const jobs = new Map<string, H3Job>();
  return {
    get: (id) => jobs.get(id),
    create: (job) => {
      jobs.set(job.id, job);
      return job;
    },
    update: (id, patch) => {
      const job = { ...jobs.get(id)!, ...patch };
      jobs.set(id, job);
      return job;
    },
    listActive: () => [...jobs.values()].filter((job) => job.status === 'queued' || job.status === 'running'),
    listBlocked: () => [...jobs.values()].filter((job) => job.remoteUncertain),
  };
}

describe('H3 reference preflight', () => {
  it('accepts 2-15 second clips and ignores image references', async () => {
    const durations = new Map([
      ['clip.mp4', 2],
      ['sound.wav', 15],
    ]);
    const probe = vi.fn(async (filename: string) => durations.get(filename) ?? 0);
    await new H3ReferencePreflight({ probeDuration: probe, fileExists: () => true }).validate([
      { type: 'image', path: 'still.png' },
      { type: 'video', path: 'clip.mp4' },
      { type: 'audio', path: 'sound.wav' },
    ]);
    expect(probe.mock.calls.map(([filename]) => filename)).toEqual(['clip.mp4', 'sound.wav']);
  });

  it.each([
    { duration: 1.99, error: 'H3_REFERENCE_DURATION_TOO_SHORT' },
    { duration: 15.01, error: 'H3_REFERENCE_DURATION_TOO_LONG' },
  ])('rejects an individual reference with duration $duration', async ({ duration, error }) => {
    const preflight = new H3ReferencePreflight({ probeDuration: async () => duration, fileExists: () => true });
    await expect(preflight.validate([{ type: 'video', path: 'clip.mp4' }])).rejects.toThrow(error);
  });

  it('rejects video totals above 15 seconds', async () => {
    const preflight = new H3ReferencePreflight({ probeDuration: async () => 8, fileExists: () => true });
    await expect(
      preflight.validate([
        { type: 'video', path: 'a.mp4' },
        { type: 'video', path: 'b.mp4' },
      ])
    ).rejects.toThrow('H3_REFERENCE_TOTAL_DURATION_EXCEEDED:video');
  });

  it('tracks video and audio totals independently', async () => {
    const durations = new Map([
      ['a.mp4', 15],
      ['b.wav', 15],
    ]);
    const preflight = new H3ReferencePreflight({
      probeDuration: async (filename) => durations.get(filename)!,
      fileExists: () => true,
    });
    await expect(
      preflight.validate([
        { type: 'video', path: 'a.mp4' },
        { type: 'audio', path: 'b.wav' },
      ])
    ).resolves.toBeUndefined();
  });

  it('rejects audio totals above 15 seconds', async () => {
    const preflight = new H3ReferencePreflight({ probeDuration: async () => 8, fileExists: () => true });
    await expect(
      preflight.validate([
        { type: 'audio', path: 'a.wav' },
        { type: 'audio', path: 'b.wav' },
      ])
    ).rejects.toThrow('H3_REFERENCE_TOTAL_DURATION_EXCEEDED:audio');
  });

  it('does not persist a job when media preflight fails', async () => {
    const jobStore = store();
    const preflight = { validate: vi.fn().mockRejectedValue(new Error('H3_REFERENCE_DURATION_TOO_SHORT')) };
    const runner = new H3JobRunner(jobStore, undefined, preflight);
    await expect(runner.enqueue({ prompt: 'test', references: [{ type: 'video', path: 'clip.mp4' }] })).rejects.toThrow(
      'H3_REFERENCE_DURATION_TOO_SHORT'
    );
    expect(jobStore.listActive()).toEqual([]);
  });

  it('parses a structured ffprobe duration response', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aionui-h3-preflight-'));
    const source = path.join(directory, 'clip.mp4');
    fs.writeFileSync(source, 'fixture');
    const run = vi.fn().mockResolvedValue({ stdout: '{"format":{"duration":"3.25"}}' });
    await new H3ReferencePreflight({ runProbe: run }).validate([{ type: 'video', path: source }]);
    expect(run).toHaveBeenCalledWith(expect.any(String), expect.arrayContaining(['-of', 'json', '--', source]));
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it('uses the longest stream duration when the container duration is unavailable', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aionui-h3-preflight-stream-'));
    const source = path.join(directory, 'clip.mkv');
    fs.writeFileSync(source, 'fixture');
    const run = vi.fn().mockResolvedValue({
      stdout: '{"format":{},"streams":[{"duration":"2.5"},{"duration":"4.75"}]}',
    });
    await expect(
      new H3ReferencePreflight({ runProbe: run }).validate([{ type: 'video', path: source }])
    ).resolves.toBeUndefined();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it('rejects malformed ffprobe output', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aionui-h3-preflight-invalid-'));
    const source = path.join(directory, 'clip.mp4');
    fs.writeFileSync(source, 'fixture');
    const preflight = new H3ReferencePreflight({ runProbe: async () => ({ stdout: '{"format":{}}' }) });
    await expect(preflight.validate([{ type: 'video', path: source }])).rejects.toThrow(
      'H3_REFERENCE_DURATION_UNAVAILABLE'
    );
    fs.rmSync(directory, { recursive: true, force: true });
  });
});
