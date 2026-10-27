import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import {
  ComfyRuntimeCoordinator,
  comfyRuntimeResourceKey,
  comfyRuntimeSignature,
} from '@/process/services/media/comfy/runtimeCoordinator';
import type { ComfyProfile } from '@/common/chat/document/creation/comfy';
import { runComfyInstallSmoke, type ComfySmokeReceipt } from '@/process/services/media/comfy/smokeRunner';

let directory = '';
afterEach(() => {
  if (directory) fs.rmSync(directory, { recursive: true, force: true });
  vi.useRealTimers();
});

describe('coordinated install smoke recovery', () => {
  function receipt(): ComfySmokeReceipt {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'comfy-smoke-'));
    return {
      planHash: 'fixed-plan',
      snapshotDirectory: directory,
      status: 'pending',
      profile: {
        id: 'smoke',
        family: 'z-image',
        name: 'test',
        kind: 'image',
        version: '1',
        quantization: 'bf16',
        state: 'downloaded',
        capabilities: ['text-to-image'],
        environment: { root: '/comfy', python: '/comfy/python', baseUrl: 'http://localhost:8188' },
        components: [],
        nodes: [],
        workflowPath: '/comfy/workflow.json',
        bindings: {},
        defaults: {},
      },
    };
  }

  const oom = () =>
    Object.assign(new Error('terminal OOM'), {
      diagnosis: { category: 'OOM' as const, retryable: false as const, action: 'REVIEW_MEMORY_BUDGET' as const },
    });

  it('persists one OOM allowance before cleanup and never grants another after restart', async () => {
    const initial = receipt();
    const filename = path.join(directory, 'receipt.json');
    const steps: string[] = [];
    const generate = vi.fn(async () => {
      steps.push('generate');
      throw oom();
    });
    const engine = {
      generate,
      runtimeResourceKey: async () => 'machine',
      clearMemory: vi.fn(async () => {
        steps.push('free');
        expect(JSON.parse(fs.readFileSync(filename, 'utf8'))).toMatchObject({
          status: 'retry-ready',
          oomRetryCount: 1,
        });
      }),
    };
    const options = {
      engine,
      coordinator: new ComfyRuntimeCoordinator({ directory: path.join(directory, 'leases') }),
      save: (saved: ComfySmokeReceipt) => fs.writeFileSync(filename, JSON.stringify(saved)),
    };
    const input = { prompt: 'keep parameters', width: 1024, height: 1024, seed: 42 };
    await expect(runComfyInstallSmoke(initial, input, new AbortController().signal, options)).rejects.toThrow(
      'terminal OOM'
    );
    expect(steps.slice(0, 3)).toEqual(['generate', 'free', 'generate']);
    expect(generate).toHaveBeenCalledTimes(2);
    expect(generate.mock.calls[1].slice(0, 3)).toEqual(generate.mock.calls[0].slice(0, 3));
    const saved: ComfySmokeReceipt = JSON.parse(fs.readFileSync(filename, 'utf8'));
    expect(saved).toMatchObject({ status: 'failed', oomRetryCount: 1 });
    await expect(
      runComfyInstallSmoke(saved, input, new AbortController().signal, {
        ...options,
        coordinator: new ComfyRuntimeCoordinator({ directory: path.join(directory, 'leases') }),
      })
    ).rejects.toThrow('terminal OOM');
    expect(generate).toHaveBeenCalledTimes(2);
  });

  it('does not retry when OOM cleanup cannot be confirmed', async () => {
    const initial = receipt();
    let saved = initial;
    const engine = {
      generate: vi.fn().mockRejectedValue(oom()),
      runtimeResourceKey: async () => 'machine',
      clearMemory: vi.fn().mockRejectedValue(new Error('COMFY_MEMORY_CLEAR_UNCONFIRMED')),
    };
    await expect(
      runComfyInstallSmoke(initial, { prompt: 'same quality' }, new AbortController().signal, {
        engine,
        save: (next) => {
          saved = next;
        },
        coordinator: new ComfyRuntimeCoordinator({ directory: path.join(directory, 'leases') }),
      })
    ).rejects.toThrow('COMFY_MEMORY_CLEAR_UNCONFIRMED');
    expect(engine.generate).toHaveBeenCalledOnce();
    expect(saved).toMatchObject({ status: 'retry-ready', oomRetryCount: 1 });
  });

  it('releases the device fence after the engine confirms a cancelled smoke prompt is terminal', async () => {
    const initial = receipt();
    const leases = path.join(directory, 'leases');
    const engine = {
      generate: vi.fn(async (_profile, _input, _signal, _progress, onSubmitted) => {
        onSubmitted?.('cancelled-remote');
        throw Object.assign(new Error('COMFY_JOB_CANCELLED'), { remoteTerminal: true });
      }),
      runtimeResourceKey: async () => 'machine',
      clearMemory: vi.fn(async () => undefined),
    };
    await expect(
      runComfyInstallSmoke(initial, { prompt: 'cancel' }, new AbortController().signal, {
        engine,
        save: () => undefined,
        coordinator: new ComfyRuntimeCoordinator({ directory: leases }),
      })
    ).rejects.toThrow('COMFY_JOB_CANCELLED');
    await expect(
      new ComfyRuntimeCoordinator({ directory: leases }).run(
        'machine',
        'next',
        async () => 'allowed',
        async () => undefined
      )
    ).resolves.toBe('allowed');
  });

  it('keeps an ambiguous smoke submission fenced across restart and resumes without resubmitting', async () => {
    const initial = receipt();
    let saved = initial;
    const leases = path.join(directory, 'leases');
    const engine = {
      generate: vi.fn(async (_profile, _input, _signal, _progress, _submitted, onSubmitting) => {
        onSubmitting?.('reserved-remote');
        throw new Error('COMFY_SUBMISSION_STATE_UNKNOWN');
      }),
      resume: vi.fn().mockResolvedValue({ promptId: 'reserved-remote', artifacts: [] }),
      runtimeResourceKey: async () => 'machine',
      clearMemory: vi.fn(async () => undefined),
    };
    const options = {
      engine,
      save: (next: ComfySmokeReceipt) => {
        saved = next;
      },
      coordinator: new ComfyRuntimeCoordinator({ directory: leases }),
    };
    await expect(
      runComfyInstallSmoke(initial, { prompt: 'same' }, new AbortController().signal, options)
    ).rejects.toThrow('COMFY_SUBMISSION_STATE_UNKNOWN');
    const coordinator = new ComfyRuntimeCoordinator({ directory: leases });
    await expect(
      coordinator.run(
        'machine',
        'other',
        async () => undefined,
        async () => undefined
      )
    ).rejects.toThrow('COMFY_REMOTE_STATE_UNCONFIRMED');
    await expect(
      runComfyInstallSmoke(saved, { prompt: 'same' }, new AbortController().signal, { ...options, coordinator })
    ).resolves.toHaveProperty('result.promptId', 'reserved-remote');
    expect(engine.generate).toHaveBeenCalledOnce();
    expect(engine.resume).toHaveBeenCalledOnce();
    expect(engine.clearMemory).not.toHaveBeenCalled();
  });

  it('does not turn successful eviction into failure when a diagnostic file cannot be written', async () => {
    const initial = receipt();
    const blocked = path.join(directory, 'not-a-directory');
    fs.writeFileSync(blocked, 'file');
    initial.snapshotDirectory = blocked;
    const engine = {
      generate: vi.fn().mockRejectedValueOnce(oom()).mockResolvedValueOnce({ promptId: 'retried', artifacts: [] }),
      runtimeResourceKey: async () => 'machine',
      clearMemory: vi.fn(async () => undefined),
    };
    await expect(
      runComfyInstallSmoke(initial, { prompt: 'same' }, new AbortController().signal, {
        engine,
        save: () => undefined,
        coordinator: new ComfyRuntimeCoordinator({ directory: path.join(directory, 'leases') }),
      })
    ).resolves.toHaveProperty('result.promptId', 'retried');
    expect(engine.generate).toHaveBeenCalledTimes(2);
  });
});

describe('shared Comfy runtime coordinator', () => {
  it('retains the cache across workflow variants with the same component set', async () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'comfy-coordinator-'));
    const coordinator = new ComfyRuntimeCoordinator({ directory });
    const profile: ComfyProfile = {
      id: 'same-components',
      family: 'h3',
      name: 'H3',
      kind: 'video',
      version: 'v1',
      quantization: 'bf16',
      capabilities: ['text-to-video'],
      state: 'verified',
      environment: { root: '/comfy', python: '/comfy/python', baseUrl: 'http://127.0.0.1:8188' },
      components: [{ role: 'diffusion', name: 'H3', path: '/comfy/h3.safetensors', version: 'v1', precision: 'bf16' }],
      nodes: [{ id: 'core', version: 'v1' }],
      workflowPath: '/comfy/t2v.json',
      workflowSha256: 'a'.repeat(64),
      bindings: {},
      defaults: {},
    };
    const cleanup = vi.fn(async () => undefined);
    await coordinator.run('gpu-0', comfyRuntimeSignature(profile), async () => undefined, cleanup);
    await coordinator.run(
      'gpu-0',
      comfyRuntimeSignature({ ...profile, workflowPath: '/comfy/i2v.json', workflowSha256: 'b'.repeat(64) }),
      async () => undefined,
      cleanup
    );
    expect(cleanup).not.toHaveBeenCalled();
    await coordinator.run(
      'gpu-0',
      comfyRuntimeSignature({ ...profile, components: [{ ...profile.components[0], precision: 'int8' }] }),
      async () => undefined,
      cleanup
    );
    expect(cleanup).toHaveBeenCalledWith('component-switch', undefined);
  });

  it('serializes work on the same GPU across coordinator instances', async () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'comfy-coordinator-'));
    const first = new ComfyRuntimeCoordinator({ directory, idleTimeoutMs: 60_000 });
    const second = new ComfyRuntimeCoordinator({ directory, idleTimeoutMs: 60_000 });
    let active = 0;
    let peak = 0;
    const task = async (): Promise<void> => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 25));
      active--;
    };
    await Promise.all([
      first.run('gpu-0', 'bf16', task, async () => undefined),
      second.run('gpu-0', 'int8', task, async () => undefined),
    ]);
    expect(peak).toBe(1);
  });

  it('clears cached weights before a component switch and identifies one GPU across endpoints', async () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'comfy-coordinator-'));
    const coordinator = new ComfyRuntimeCoordinator({ directory, idleTimeoutMs: 60_000 });
    const cleanups: string[] = [];
    const cleanup = async (reason: 'component-switch' | 'idle' | 'terminal-error' | 'memory-pressure' | 'oom') => {
      cleanups.push(reason);
    };
    await coordinator.run('gpu-0', 'bf16', async () => undefined, cleanup);
    await coordinator.run('gpu-0', 'int8', async () => undefined, cleanup);
    expect(cleanups).toEqual(['component-switch']);
    expect(
      comfyRuntimeResourceKey('http://127.0.0.1:8188', {
        devices: [{ index: 0, name: 'GPU X', type: 'cuda', vram_total: 100 }],
      })
    ).toBe(
      comfyRuntimeResourceKey('http://127.0.0.1:8288', {
        devices: [{ index: 0, name: 'GPU X', type: 'cuda', vram_total: 100 }],
      })
    );
  });

  it('keeps an unknown submission blocked across instances and lets only its existing task recover', async () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'comfy-coordinator-'));
    const first = new ComfyRuntimeCoordinator({ directory });
    const cleanup = vi.fn(async () => undefined);
    await expect(
      first.run(
        'gpu-0',
        'bf16',
        async () => {
          throw new Error('UNKNOWN_SUBMISSION');
        },
        cleanup,
        undefined,
        { taskId: 'existing', context: { endpoint: 'old' }, isUncertain: () => true }
      )
    ).rejects.toThrow('UNKNOWN_SUBMISSION');
    const second = new ComfyRuntimeCoordinator({ directory });
    const task = vi.fn(async () => 'done');
    await expect(second.run('gpu-0', 'bf16', task, cleanup, undefined, { taskId: 'new' })).rejects.toThrow(
      'COMFY_REMOTE_STATE_UNCONFIRMED'
    );
    expect(task).not.toHaveBeenCalled();
    expect(cleanup).not.toHaveBeenCalled();
    await expect(
      second.run('gpu-0', 'bf16', task, cleanup, undefined, { taskId: 'existing', recover: true })
    ).resolves.toBe('done');
  });

  it('cleans the previous environment on a cross-process component switch', async () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'comfy-coordinator-'));
    const first = new ComfyRuntimeCoordinator({ directory });
    await first.run(
      'gpu-0',
      'bf16',
      async () => undefined,
      async () => undefined,
      undefined,
      { context: { endpoint: 'old' } }
    );
    const cleanup = vi.fn(async () => undefined);
    await new ComfyRuntimeCoordinator({ directory }).run('gpu-0', 'int8', async () => undefined, cleanup, undefined, {
      context: { endpoint: 'new' },
    });
    expect(cleanup).toHaveBeenCalledWith('component-switch', { endpoint: 'old' });
  });

  it('uses a machine barrier when GPU identity is unknown even if later callers know the GPU', async () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'comfy-coordinator-'));
    const coordinator = new ComfyRuntimeCoordinator({ directory });
    expect(comfyRuntimeResourceKey('http://127.0.0.1:8188', {})).toBe('machine');
    expect(comfyRuntimeResourceKey('http://127.0.0.1:8288', {})).toBe('machine');
    await expect(
      coordinator.run(
        'machine',
        'bf16',
        async () => {
          throw new Error('lost');
        },
        async () => undefined,
        undefined,
        { taskId: 'old', isUncertain: () => true }
      )
    ).rejects.toThrow('lost');
    await expect(
      new ComfyRuntimeCoordinator({ directory }).run(
        'gpu-0',
        'int8',
        async () => undefined,
        async () => undefined,
        undefined,
        { taskId: 'new' }
      )
    ).rejects.toThrow('COMFY_REMOTE_STATE_UNCONFIRMED');
  });

  it('uses physical UUID overlap rather than endpoint, device index, or telemetry shape for GPU leases', async () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'comfy-coordinator-'));
    const coordinator = new ComfyRuntimeCoordinator({ directory });
    const other = new ComfyRuntimeCoordinator({ directory });
    const first = comfyRuntimeResourceKey('http://localhost:8188', {
      devices: [{ index: 0, name: 'GPU', uuid: 'GPU-a', vram_free: 10 }],
    });
    const same = comfyRuntimeResourceKey('http://localhost:8288', {
      devices: [{ index: 5, name: 'Renamed', uuid: 'GPU-A', vram_free: 20 }],
    });
    expect(first).toBe(same);
    expect(comfyRuntimeResourceKey('http://localhost:8188', { devices: [{}] })).toBe('machine');
    let active = 0;
    let peak = 0;
    let entered!: () => void;
    let finish!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const finished = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const work = async () => {
      active++;
      peak = Math.max(peak, active);
      entered();
      await finished;
      active--;
    };
    const second = comfyRuntimeResourceKey('http://localhost:8288', { devices: [{ uuid: 'GPU-b' }] });
    const firstRun = coordinator.run(first, 'a', work, async () => undefined);
    await started;
    await other.run(
      second,
      'b',
      async () => {
        active++;
        peak = Math.max(peak, active);
        active--;
        finish();
      },
      async () => undefined
    );
    await firstRun;
    expect(peak).toBe(2);
    await expect(
      coordinator.run(
        first,
        'a',
        async () => {
          throw new Error('offline');
        },
        async () => undefined,
        undefined,
        { taskId: 'a', isUncertain: () => true }
      )
    ).rejects.toThrow('offline');
    const both = comfyRuntimeResourceKey('http://localhost:8388', { devices: [{ uuid: 'GPU-a' }, { uuid: 'GPU-b' }] });
    await expect(
      other.run(
        both,
        'c',
        async () => undefined,
        async () => undefined
      )
    ).rejects.toThrow('COMFY_REMOTE_STATE_UNCONFIRMED');
  });

  it('keeps same components cached and cleans after 120 seconds of idle', async () => {
    vi.useFakeTimers();
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'comfy-coordinator-'));
    const coordinator = new ComfyRuntimeCoordinator({ directory });
    const cleanup = vi.fn(async () => undefined);
    await coordinator.run('gpu-0', 'bf16', async () => undefined, cleanup);
    await vi.advanceTimersByTimeAsync(119_000);
    expect(cleanup).not.toHaveBeenCalled();
    await coordinator.run('gpu-0', 'bf16', async () => undefined, cleanup);
    await vi.advanceTimersByTimeAsync(119_000);
    expect(cleanup).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(cleanup).toHaveBeenCalledWith('idle', undefined);
  });

  it('does not let a nested task expand a lease to an additional GPU or the entire machine', async () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'comfy-coordinator-'));
    const coordinator = new ComfyRuntimeCoordinator({ directory });
    const cleanup = vi.fn(async () => undefined);
    const task = vi.fn(async () => undefined);
    const gpu = 'gpu:["a"]';
    for (const expanded of ['gpu:["a","b"]', 'machine']) {
      await coordinator.run(
        gpu,
        'same',
        async () => {
          await expect(coordinator.run(expanded, 'same', task, cleanup)).rejects.toThrow(
            'COMFY_NESTED_DEVICE_LEASE_MISMATCH'
          );
        },
        cleanup
      );
    }
    expect(task).not.toHaveBeenCalled();
    await coordinator.run('machine', 'same', () => coordinator.run(gpu, 'same', task, cleanup), cleanup);
    expect(task).toHaveBeenCalledOnce();
  });

  it('retains cache for ten warm runs and cleans exactly at each of five model-switch rounds', async () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'comfy-coordinator-'));
    const coordinator = new ComfyRuntimeCoordinator({ directory });
    let cached = '';
    const events: string[] = [];
    const cleanup = vi.fn(async (reason: string) => {
      events.push(`free:${reason}:${cached}`);
      cached = '';
    });
    const run = async (component: string): Promise<void> => {
      await coordinator.run(
        'gpu:["a"]',
        component,
        async () => {
          expect(cached === '' || cached === component).toBe(true);
          cached = component;
          events.push(`run:${component}`);
        },
        cleanup
      );
    };
    for (let index = 0; index < 10; index++) await run('model-a');
    expect(cleanup).not.toHaveBeenCalled();
    for (let round = 0; round < 5; round++) {
      await run('model-b');
      await run('model-a');
    }
    expect(cleanup).toHaveBeenCalledTimes(10);
    expect(events.slice(10, 14)).toEqual([
      'free:component-switch:model-a',
      'run:model-b',
      'free:component-switch:model-b',
      'run:model-a',
    ]);
  });

  it('reacquires the device lease for async descendants after their original run has released it', async () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'comfy-coordinator-'));
    const coordinator = new ComfyRuntimeCoordinator({ directory });
    const other = new ComfyRuntimeCoordinator({ directory });
    const cleanup = async (): Promise<void> => undefined;
    let releaseDescendant!: () => void;
    const descendantGate = new Promise<void>((resolve) => {
      releaseDescendant = resolve;
    });
    const work = vi.fn(async () => undefined);
    let descendant: Promise<void> | undefined;
    await coordinator.run(
      'gpu:["a"]',
      'same',
      async () => {
        descendant = (async () => {
          await descendantGate;
          await coordinator.run('gpu:["a"]', 'same', work, cleanup);
        })();
      },
      cleanup
    );
    let entered!: () => void;
    let releaseOther!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const pending = new Promise<void>((resolve) => {
      releaseOther = resolve;
    });
    const held = other.run(
      'gpu:["a"]',
      'same',
      async () => {
        entered();
        await pending;
      },
      cleanup
    );
    await started;
    releaseDescendant();
    try {
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(work).not.toHaveBeenCalled();
    } finally {
      releaseOther();
      await held;
      await descendant;
    }
    expect(work).toHaveBeenCalledOnce();
  });

  it('cancels pending idle eviction when another run arrives and only evicts after its new idle period', async () => {
    vi.useFakeTimers();
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'comfy-coordinator-'));
    const coordinator = new ComfyRuntimeCoordinator({ directory });
    const cleanup = vi.fn(async () => undefined);
    await coordinator.run('gpu:["a"]', 'same', async () => undefined, cleanup);
    await vi.advanceTimersByTimeAsync(119_999);
    let started!: () => void;
    let finish!: () => void;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const running = coordinator.run(
      'gpu:["a"]',
      'same',
      async () => {
        started();
        await pending;
      },
      cleanup
    );
    await entered;
    await vi.advanceTimersByTimeAsync(240_000);
    expect(cleanup).not.toHaveBeenCalled();
    finish();
    await running;
    await vi.advanceTimersByTimeAsync(119_999);
    expect(cleanup).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(cleanup).toHaveBeenCalledExactlyOnceWith('idle', undefined);
  });

  it('cleans a confirmed terminal failure but retains an uncertain cancellation fence', async () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'comfy-coordinator-'));
    const coordinator = new ComfyRuntimeCoordinator({ directory });
    const cleanup = vi.fn(async () => undefined);
    await expect(
      coordinator.run(
        'machine',
        'a',
        async () => {
          throw new Error('terminal');
        },
        cleanup
      )
    ).rejects.toThrow('terminal');
    expect(cleanup).toHaveBeenCalledExactlyOnceWith('terminal-error', undefined);
    cleanup.mockClear();
    await expect(
      coordinator.run(
        'machine',
        'a',
        async () => {
          throw new Error('cancel unconfirmed');
        },
        cleanup,
        undefined,
        { taskId: 'old', isUncertain: () => true }
      )
    ).rejects.toThrow('cancel unconfirmed');
    expect(cleanup).not.toHaveBeenCalled();
    const replacement = vi.fn(async () => undefined);
    await expect(
      new ComfyRuntimeCoordinator({ directory }).run('gpu:["a"]', 'b', replacement, cleanup)
    ).rejects.toThrow('COMFY_REMOTE_STATE_UNCONFIRMED');
    expect(replacement).not.toHaveBeenCalled();
  });

  it('serializes overlapping physical GPUs in actual separate Node processes', async () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'comfy-coordinator-'));
    const events = path.join(directory, 'events.log');
    const moduleUrl = pathToFileURL(
      path.resolve('packages/desktop/src/process/services/media/comfy/runtimeCoordinator.ts')
    ).href;
    const start = (label: string, resource: string, held: boolean) => {
      const script = `
        import fs from 'node:fs';
        import * as runtime from ${JSON.stringify(moduleUrl)};
        const { ComfyRuntimeCoordinator } = runtime.default ?? runtime;
        const coordinator = new ComfyRuntimeCoordinator({ directory: process.env.COMFY_TEST_LEASE_DIR });
        const event = (name) => fs.appendFileSync(process.env.COMFY_TEST_EVENTS, name + '\\n');
        process.send('ready');
        await coordinator.run(${JSON.stringify(resource)}, 'same', async () => {
          event(${JSON.stringify(`enter:${label}`)});
          process.send('entered');
          if (${held}) await new Promise((resolve) => process.once('message', resolve));
          event(${JSON.stringify(`exit:${label}`)});
        }, async () => undefined);
        process.disconnect();
      `;
      const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', script], {
        cwd: process.cwd(),
        env: { ...process.env, COMFY_TEST_LEASE_DIR: directory, COMFY_TEST_EVENTS: events },
        stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      });
      let stderr = '';
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      const finished = new Promise<void>((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', (code) => (code === 0 ? resolve() : reject(new Error(`worker ${code}: ${stderr}`))));
      });
      const ready = new Promise<void>((resolve) =>
        child.on('message', (message) => {
          if (message === 'ready') resolve();
        })
      );
      const entered = new Promise<void>((resolve) =>
        child.on('message', (message) => {
          if (message === 'entered') resolve();
        })
      );
      return { child, ready, entered, finished };
    };
    const first = start('first', 'gpu:["a","b"]', true);
    let second: ReturnType<typeof start> | undefined;
    try {
      await Promise.race([first.entered, first.finished]);
      second = start('second', 'gpu:["b"]', false);
      await Promise.race([second.ready, second.finished]);
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(fs.readFileSync(events, 'utf8').trim().split('\n')).toEqual(['enter:first']);
      first.child.send('release');
      await Promise.all([first.finished, second.finished]);
      expect(fs.readFileSync(events, 'utf8').trim().split('\n')).toEqual([
        'enter:first',
        'exit:first',
        'enter:second',
        'exit:second',
      ]);
    } finally {
      first.child.kill();
      second?.child.kill();
      await Promise.allSettled([first.finished, ...(second ? [second.finished] : [])]);
    }
  });
});
