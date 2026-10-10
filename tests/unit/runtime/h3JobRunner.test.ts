import { describe, expect, it } from 'vitest';
import { createH3Job, h3AgentSnapshot, type H3Job } from '@/common/chat/document/h3Job';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { vi } from 'vitest';
import { FileH3JobStore, type H3JobStore } from '@/process/services/runtime/H3JobStore';

function memoryStore(initial: H3Job): H3JobStore {
  let job = initial;
  return {
    get: () => job,
    create: (next) => (job = next),
    update: (_id, patch) => (job = { ...job, ...patch }),
    listActive: () => (['queued', 'running'].includes(job.status) ? [job] : []),
    listBlocked: () => (job.remoteUncertain ? [job] : []),
  };
}
import { H3JobRunner } from '@/process/services/runtime/H3JobRunner';
import { diagnoseComfyError } from '@/process/services/runtime/h3ComfyError';

it.each(['queued', 'running', 'succeeded', 'failed', 'cancelled'] as const)(
  'ends Agent polling for a %s snapshot',
  (status) => {
    expect(h3AgentSnapshot({ ...createH3Job({ prompt: 'test' }), status })).toMatchObject({
      stopPolling: true,
      automaticRetryAllowed: false,
      terminal: !['queued', 'running'].includes(status),
    });
  }
);

it('recovers an interrupted cancellation as a persistent barrier, never as a resumed generation', () => {
  const store = memoryStore({
    ...createH3Job({ prompt: 'test' }, 'p'),
    status: 'running',
    promptId: 'remote',
    cancelRequested: true,
  });
  const client = { generate: vi.fn(), resume: vi.fn(), cancel: vi.fn() };
  const runner = new H3JobRunner(store, client);
  runner.recover();
  expect(runner.blocked()).toBe(true);
  expect(store.get('p')).toMatchObject({ status: 'failed', remoteUncertain: true, cancelRequested: false });
  expect(client.resume).not.toHaveBeenCalled();
});

it('unblocks automatically after a previously unreachable prompt is confirmed stopped', async () => {
  const store = memoryStore({
    ...createH3Job({ prompt: 'test' }, 'p'),
    status: 'failed',
    remoteUncertain: true,
    promptId: 'remote',
  });
  const client = {
    generate: vi.fn(),
    resume: vi.fn(),
    cancel: vi.fn(),
    confirmStopped: vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(undefined),
  };
  const runner = new H3JobRunner(store, client);
  await runner.reconcile();
  expect(runner.blocked()).toBe(true);
  await runner.reconcile();
  expect(runner.blocked()).toBe(false);
  expect(client.generate).not.toHaveBeenCalled();
  expect(client.cancel).not.toHaveBeenCalled();
});

it('preserves artifacts when completion races with a user cancellation', async () => {
  const store = memoryStore({ ...createH3Job({ prompt: 'test' }, 'p'), status: 'running', promptId: 'remote' });
  const result = {
    promptId: 'remote',
    artifacts: [{ filename: 'done.mp4', subfolder: '', type: 'output', mimeType: 'video/mp4' }],
  };
  const runner = new H3JobRunner(store, {
    generate: vi.fn(),
    resume: vi.fn(),
    cancel: vi.fn().mockResolvedValue(result),
  });
  await expect(runner.cancel('p')).resolves.toMatchObject({
    status: 'succeeded',
    artifacts: [{ filename: 'done.mp4' }],
  });
});

it('persists a dispatch barrier when a timed-out remote task cannot be stopped, including after restart', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'h3-fence-'));
  try {
    const filename = path.join(directory, 'jobs.json');
    const store = new FileH3JobStore(filename);
    store.create({ ...createH3Job({ prompt: 'old' }, 'old'), promptId: 'remote' });
    const client = {
      generate: vi.fn(),
      resume: vi.fn().mockRejectedValue(new Error('H3_COMFY_HISTORY_TIMEOUT')),
      cancel: vi.fn().mockRejectedValue(new Error('offline')),
    };
    await expect(new H3JobRunner(store, client).run('old')).rejects.toThrow('H3_COMFY_HISTORY_TIMEOUT');
    expect(client.cancel).toHaveBeenCalledWith('remote');
    const restored = new FileH3JobStore(filename);
    expect(restored.get('old')).toMatchObject({
      status: 'failed',
      remoteUncertain: true,
      finishedAt: expect.any(String),
    });
    const runner = new H3JobRunner(restored, client);
    runner.recover();
    await expect(runner.enqueue({ prompt: 'new' })).rejects.toThrow('H3_REMOTE_STATE_UNCONFIRMED');
    client.cancel.mockResolvedValue(undefined);
    await runner.cancel('old');
    expect(restored.get('old')?.remoteUncertain).toBe(false);
    await expect(runner.enqueue({ prompt: 'new' })).resolves.toHaveProperty('status', 'queued');
    expect(client.generate).not.toHaveBeenCalled();
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('H3 job runner', () => {
  it('persists structured runtime diagnosis for Agent job queries', async () => {
    const store = memoryStore(createH3Job({ prompt: 'test' }, 'diagnose'));
    const error = diagnoseComfyError({
      status: { messages: [['execution_error', { node_id: '1', exception_type: 'torch.OutOfMemoryError' }]] },
    });
    const runner = new H3JobRunner(store, {
      generate: vi.fn().mockRejectedValue(error),
      cancel: vi.fn(),
      resume: vi.fn(),
    });
    await expect(runner.run('diagnose')).rejects.toThrow('OOM');
    expect(store.get('diagnose')).toMatchObject({
      status: 'failed',
      diagnosis: { category: 'OOM', nodeId: '1', retryable: false },
    });
  });
  it('migrates persisted single-image jobs to the automatic FL2VA route', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aionui-h3-store-'));
    const filename = path.join(directory, 'jobs.json');
    fs.writeFileSync(
      filename,
      JSON.stringify([
        {
          id: 'legacy',
          spec: { prompt: 'portrait', referenceImagePath: 'portrait.png' },
          status: 'succeeded',
          progress: 1,
          artifacts: [],
        },
      ])
    );
    const job = new FileH3JobStore(filename).get('legacy');
    expect(job?.resolvedMode).toBe('fl2v');
    expect(job?.spec.references).toEqual([{ type: 'image', path: 'portrait.png' }]);
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it('persists safe resource paths when a generation succeeds', async () => {
    const initial = createH3Job({ prompt: 'test' }, 'job-1');
    const state = new Map([[initial.id, initial]]);
    const store = {
      get: (id: string) => state.get(id),
      create: (job: typeof initial) => {
        state.set(job.id, job);
        return job;
      },
      update: (id: string, patch: Partial<typeof initial>) => {
        const next = { ...state.get(id)!, ...patch };
        state.set(id, next);
        return next;
      },
      listBlocked: () => [...state.values()].filter((job) => job.remoteUncertain),
      listActive: () => [...state.values()].filter((job) => job.status === 'running' || job.status === 'queued'),
    };
    const client = {
      generate: async () => ({
        promptId: 'prompt-1',
        artifacts: [{ filename: 'clip.mp4', subfolder: 'video', type: 'output', mimeType: 'video/mp4' }],
      }),
      cancel: async () => undefined,
      resume: vi.fn(),
    };
    const job = await new H3JobRunner(store, client).run('job-1');
    expect(job.status).toBe('succeeded');
    expect(job.artifacts[0].resourcePath).toBe('/api/h3/jobs/job-1/artifacts/0');
  });

  it('calls the runtime cancellation endpoint before marking a running job cancelled', async () => {
    const initial = createH3Job({ prompt: 'test' }, 'job-cancel');
    const state = new Map<string, H3Job>([[initial.id, { ...initial, status: 'running' }]]);
    let cancelled = '';
    const store = {
      get: (id: string) => state.get(id),
      create: (job: typeof initial) => {
        state.set(job.id, job);
        return job;
      },
      update: (id: string, patch: Partial<typeof initial>) => {
        const next = { ...state.get(id)!, ...patch };
        state.set(id, next);
        return next;
      },
      listBlocked: () => [...state.values()].filter((job) => job.remoteUncertain),
      listActive: () => [...state.values()],
    };
    const runner = new H3JobRunner(store, {
      generate: async (_spec, signal, _progress, submitted) => {
        submitted?.('prompt-cancel');
        return new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('H3_JOB_CANCELLED')));
        });
      },
      cancel: async (promptId: string) => {
        cancelled = promptId;
      },
      resume: vi.fn(),
    });
    const running = runner.run(initial.id).catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await runner.cancel(initial.id);
    await running;
    expect(cancelled).toBe('prompt-cancel');
    expect(store.get(initial.id)?.status).toBe('cancelled');
  });

  it('resumes the persisted remote prompt after recovery without submitting again', async () => {
    const store = memoryStore({
      ...createH3Job({ prompt: 'test' }, 'job-recover'),
      status: 'running',
      promptId: 'remote-1',
    });
    const client = {
      generate: vi.fn(),
      cancel: vi.fn(),
      resume: vi.fn().mockResolvedValue({ promptId: 'remote-1', artifacts: [] }),
    };
    const runner = new H3JobRunner(store, client);
    runner.recover();
    await runner.run('job-recover');
    expect(client.generate).not.toHaveBeenCalled();
    expect(client.resume.mock.calls[0][0]).toBe('remote-1');
  });

  it('does not resubmit an ambiguous interrupted submission', () => {
    const job = { ...createH3Job({ prompt: 'test' }, 'ambiguous-job'), status: 'running' as const };
    const store = memoryStore(job);
    new H3JobRunner(store).recover();
    expect(store.listActive()).toEqual([]);
    expect(store.get(job.id)?.error).toBe('H3_SUBMISSION_STATE_UNKNOWN');
  });

  it('keeps the current state when upstream cancellation fails', async () => {
    const store = memoryStore({ ...createH3Job({ prompt: 'test' }), status: 'running', promptId: 'remote-2' });
    const runner = new H3JobRunner(store, {
      generate: vi.fn(),
      resume: vi.fn(),
      cancel: vi.fn().mockRejectedValue(new Error('offline')),
    });
    await expect(runner.cancel('job')).rejects.toThrow('offline');
    expect(store.get('job')?.status).toBe('running');
  });

  it('does not cancel completed jobs or alter their artifacts', async () => {
    const job = { ...createH3Job({ prompt: 'test' }), status: 'succeeded' as const, promptId: 'remote-3' };
    const store = memoryStore(job);
    const client = { generate: vi.fn(), resume: vi.fn(), cancel: vi.fn() };
    expect(await new H3JobRunner(store, client).cancel(job.id)).toEqual(job);
    expect(client.cancel).not.toHaveBeenCalled();
  });
});
it('retains execution timing across recovery and persisted history', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'h3-timing-'));
  const filename = path.join(directory, 'jobs.json');
  try {
    const store = new FileH3JobStore(filename);
    const initial = createH3Job({ prompt: 'test' }, 'timed');
    store.create({ ...initial, status: 'running', promptId: 'existing-prompt', startedAt: '2026-09-22T00:00:00.000Z' });
    const runner = new H3JobRunner(store, {
      generate: vi.fn(),
      cancel: vi.fn(),
      resume: vi.fn().mockResolvedValue({ promptId: 'existing-prompt', artifacts: [] }),
    });
    runner.recover();
    await runner.run('timed');
    const restored = new FileH3JobStore(filename).get('timed')!;
    expect(restored.startedAt).toBe('2026-09-22T00:00:00.000Z');
    expect(Number.isFinite(Date.parse(restored.finishedAt!))).toBe(true);
    expect(restored.status).toBe('succeeded');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

it('persists backend activity for subsequent Agent queries and emits it to subscribers', async () => {
  const store = memoryStore(createH3Job({ prompt: 'test' }, 'activity'));
  const activity = {
    phase: 'node-progress' as const,
    nodeId: '125',
    value: 1,
    max: 4,
    updatedAt: new Date().toISOString(),
  };
  const runner = new H3JobRunner(store, {
    generate: async (_spec, _signal, progress) => {
      progress?.(0, activity);
      expect(store.get('activity')?.activity).toEqual(activity);
      return { promptId: 'p', artifacts: [] };
    },
    cancel: vi.fn(),
    resume: vi.fn(),
  });
  const received = vi.fn();
  await runner.run('activity', received);
  expect(received).toHaveBeenCalledWith(expect.objectContaining({ status: 'running', progress: 0, activity }));
});
