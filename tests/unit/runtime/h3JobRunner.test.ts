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
import { ComfyRuntimeCoordinator } from '@/process/services/media/comfy/runtimeCoordinator';

it('archives completed outputs before returning the successful generation without submitting a new prompt', async () => {
  const store = memoryStore(createH3Job({ prompt: 'archive output' }, 'archive-job'));
  const result = {
    promptId: 'existing-prompt',
    artifacts: [{ filename: 'result.mp4', subfolder: '', type: 'output', mimeType: 'video/mp4' }],
  };
  const save = vi.fn(async () => undefined);
  const client = { generate: vi.fn(async () => result), resume: vi.fn(), cancel: vi.fn() };
  const runner = new H3JobRunner(store, client, { validate: async () => undefined }, undefined, save);
  await expect(runner.run('archive-job')).resolves.toMatchObject({ status: 'succeeded' });
  expect(save).toHaveBeenCalledExactlyOnceWith('archive-job', result);
  expect(client.generate).toHaveBeenCalledOnce();
});

it('coordinates legacy H3 OOM cleanup and retries the original spec once with a persisted allowance', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'h3-oom-'));
  try {
    const filename = path.join(directory, 'jobs.json');
    const store = new FileH3JobStore(filename);
    store.create(createH3Job({ prompt: 'exact quality', megapixels: 2, durationSeconds: 10, seed: 42 }, 'p'));
    const error = diagnoseComfyError({
      status: { messages: [['execution_error', { node_id: '7', exception_type: 'torch.OutOfMemoryError' }]] },
    });
    const client = {
      generate: vi.fn().mockRejectedValue(error),
      resume: vi.fn(),
      cancel: vi.fn(),
      runtimeResourceKey: async () => 'machine',
      runtimeSignature: () => 'h3-components',
      clearMemory: vi.fn().mockResolvedValue(undefined),
    };
    const runner = new H3JobRunner(
      store,
      client,
      { validate: async () => undefined },
      new ComfyRuntimeCoordinator({ directory: path.join(directory, 'leases') })
    );
    await expect(runner.run('p')).rejects.toThrow('OOM');
    expect(client.generate).toHaveBeenCalledTimes(2);
    expect(client.generate.mock.calls[1][0]).toEqual(client.generate.mock.calls[0][0]);
    const restored = new FileH3JobStore(filename);
    expect(restored.get('p')).toMatchObject({
      oomRetryCount: 1,
      remoteUncertain: false,
      memory: {
        failedNode: '7',
        cleanups: expect.arrayContaining([expect.objectContaining({ reason: 'oom', confirmed: true })]),
      },
    });
    restored.update('p', { status: 'queued', promptId: 'remote-2' });
    client.resume.mockRejectedValueOnce(error);
    await expect(
      new H3JobRunner(
        restored,
        client,
        { validate: async () => undefined },
        new ComfyRuntimeCoordinator({ directory: path.join(directory, 'leases') })
      ).run('p')
    ).rejects.toThrow('OOM');
    expect(client.generate).toHaveBeenCalledTimes(2);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

it.each([
  ['queued', false, 'MONITOR_SAME_JOB_UNTIL_TERMINAL'],
  ['running', false, 'MONITOR_SAME_JOB_UNTIL_TERMINAL'],
  ['succeeded', true, 'SHOW_RESULT_AND_CONTINUE_REMAINING_WORK'],
  ['failed', true, 'DIAGNOSE_AND_CONTINUE_AUTHORIZED_WORK'],
  ['cancelled', true, 'REPORT_CANCELLATION'],
] as const)('returns task-aware monitoring guidance for a %s snapshot', (status, terminal, nextAction) => {
  expect(h3AgentSnapshot({ ...createH3Job({ prompt: 'test' }), status })).toMatchObject({
    stopPolling: terminal,
    automaticRetryAllowed: false,
    terminal,
    nextAction,
  });
});

it.each(['queued', 'running', 'failed'] as const)(
  'requires recovery of an uncertain %s job without authorizing resubmission',
  (status) => {
    expect(
      h3AgentSnapshot({ ...createH3Job({ prompt: 'test' }, 'existing-job'), status, remoteUncertain: true })
    ).toMatchObject({
      id: 'existing-job',
      remoteUncertain: true,
      stopPolling: true,
      automaticRetryAllowed: false,
      nextAction: 'RECOVER_EXISTING_JOB_NO_RESUBMISSION',
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

it('retains a timed-out remote task for recovery without sending another prompt or cancelling it', async () => {
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
    expect(client.cancel).not.toHaveBeenCalled();
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
    const coordinator = { confirmSettled: vi.fn().mockResolvedValue(undefined) } as unknown as ComfyRuntimeCoordinator;
    const runner = new H3JobRunner(
      store,
      {
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
        runtimeResourceKey: async () => 'machine',
      },
      undefined,
      coordinator
    );
    const running = runner.run(initial.id).catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await runner.cancel(initial.id);
    await running;
    expect(cancelled).toBe('prompt-cancel');
    expect(store.get(initial.id)?.status).toBe('cancelled');
    expect(coordinator.confirmSettled).toHaveBeenCalledWith('machine', initial.id);
  });

  it('aborts a pre-submission H3 run before checking the remote queue', async () => {
    const initial = createH3Job({ prompt: 'test' }, 'job-pre-submit-cancel');
    const store = memoryStore({ ...initial, status: 'running' });
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => (markStarted = resolve));
    let observedSignal: AbortSignal | undefined;
    const runner = new H3JobRunner(
      store,
      {
        generate: vi.fn((_spec, signal) => {
          observedSignal = signal;
          markStarted();
          return new Promise((_resolve, reject) => {
            const abort = (): void => reject(new Error('H3_JOB_CANCELLED'));
            if (signal.aborted) abort();
            else signal.addEventListener('abort', abort, { once: true });
          });
        }),
        cancel: vi.fn(),
        resume: vi.fn(),
        confirmIdle: vi.fn(async () => {
          expect(observedSignal?.aborted).toBe(true);
        }),
        runtimeResourceKey: async () => 'machine',
        clearMemory: vi.fn(async () => undefined),
      },
      { validate: async () => undefined },
      {
        run: async (_resource, _signature, task) => task(),
        confirmSettled: vi.fn(async () => undefined),
      } as unknown as ComfyRuntimeCoordinator
    );

    const running = runner.run(initial.id).catch(() => undefined);
    await started;
    await expect(runner.cancel(initial.id)).resolves.toMatchObject({ status: 'cancelled' });
    await running;
  });

  it('records cancellation while waiting for the device lease as cancelled', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'h3-cancel-lease-'));
    const coordinator = new ComfyRuntimeCoordinator({ directory });
    let releaseDevice!: () => void;
    let deviceStarted!: () => void;
    const started = new Promise<void>((resolve) => (deviceStarted = resolve));
    const held = coordinator.run(
      'machine',
      'other-model',
      async () => {
        deviceStarted();
        await new Promise<void>((resolve) => (releaseDevice = resolve));
      },
      async () => undefined
    );
    await started;
    const initial = createH3Job({ prompt: 'test' }, 'job-lease-cancel');
    const store = memoryStore({ ...initial, status: 'running' });
    const generate = vi.fn();
    const runner = new H3JobRunner(
      store,
      {
        generate,
        cancel: vi.fn(),
        resume: vi.fn(),
        runtimeResourceKey: async () => 'machine',
        clearMemory: vi.fn(async () => undefined),
      },
      { validate: async () => undefined },
      new ComfyRuntimeCoordinator({ directory })
    );
    try {
      const running = runner.run(initial.id).catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 0));
      await expect(runner.cancel(initial.id)).resolves.toMatchObject({
        status: 'cancelled',
        error: 'H3_JOB_CANCELLED',
      });
      await running;
      expect(generate).not.toHaveBeenCalled();
    } finally {
      releaseDevice();
      await held;
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('does not clear a legacy H3 submission fence until an unknown prompt is confirmed idle', async () => {
    const initial = { ...createH3Job({ prompt: 'test' }, 'job-unknown-cancel'), status: 'running' as const };
    const store = memoryStore(initial);
    const coordinator = { confirmSettled: vi.fn().mockResolvedValue(undefined) } as unknown as ComfyRuntimeCoordinator;
    const runner = new H3JobRunner(
      store,
      {
        generate: vi.fn(),
        cancel: vi.fn(),
        resume: vi.fn(),
        confirmIdle: vi.fn().mockRejectedValue(new Error('H3_REMOTE_STATE_UNCONFIRMED')),
        runtimeResourceKey: async () => 'machine',
      },
      undefined,
      coordinator
    );
    await expect(runner.cancel(initial.id)).rejects.toThrow('H3_REMOTE_STATE_UNCONFIRMED');
    expect(coordinator.confirmSettled).not.toHaveBeenCalled();
    expect(store.get(initial.id)?.status).toBe('running');
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
