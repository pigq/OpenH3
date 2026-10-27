import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import type { ComfyInstallPlan, ComfyProfile } from '@/common/chat/document/creation/comfy';
import type { ComfyGenerationResult } from '@/process/services/media/comfy/workflowEngine';
import { downloadH3FromSources } from '@/process/services/runtime/h3Downloader';
import { ComfyRuntimeCoordinator } from '@/process/services/media/comfy/runtimeCoordinator';
import embeddedH3Workflows from '@/process/services/runtime/h3EmbeddedWorkflows.json';
import {
  assertComfyInstallPlan,
  executeComfyInstall,
  runComfyInstallCommand,
  verifyComfySmokeArtifact,
  type ComfyInstallCommandRunner,
} from '@/process/services/media/comfy/installExecutor';

let root: string;
let plan: ComfyInstallPlan;
const content = 'pinned weights';
const checksum = crypto.createHash('sha256').update(content).digest('hex');
const validPng = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEUlEQVR4nGP4YBCAFTEMLQkAGuRcAUSlXwUAAAAASUVORK5CYII=',
  'base64'
);
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'comfy-installer-'));
  fs.mkdirSync(path.join(root, 'environment'));
  fs.writeFileSync(path.join(root, 'python.exe'), '');
  plan = {
    id: 'fixture',
    family: 'z-image',
    name: 'Z Image',
    kind: 'image',
    version: '1.0',
    quantization: 'fp16',
    capabilities: ['text-to-image'],
    environment: {
      root: path.join(root, 'environment'),
      python: path.join(root, 'python.exe'),
      baseUrl: 'http://127.0.0.1:8188',
      launchArgs: ['--models-directory', path.join(root, 'models')],
    },
    components: [
      {
        role: 'diffusion',
        name: 'weights',
        path: path.join(root, 'models', 'weights.safetensors'),
        version: 'abcdef123456',
        precision: 'fp16',
        url: 'https://huggingface.co/example/weights/resolve/abcdef123456/weights.safetensors',
        sha256: checksum,
        sizeBytes: content.length,
      },
    ],
    nodes: [{ id: 'example-node', version: '1.0' }],
    workflowPath: path.join(root, 'environment', 'workflow.json'),
    bindings: { prompt: [{ nodeId: '1', input: 'text' }] },
    defaults: { width: 512, height: 512 },
    targetRoot: root,
    downloadBytes: content.length,
    requiredBytes: 1024,
    reason: 'test recipe',
    evidence: ['fixed recipe'],
    workflow: { '1': { class_type: 'Text', inputs: { text: 'smoke' } } },
    commands: [
      {
        executable: 'git',
        args: ['clone', '--branch', 'v1.0', 'https://github.com/example/repo.git', path.join(root, 'environment')],
        cwd: root,
        revision: 'v1.0',
        label: 'prepare',
        stage: 'prepare',
      },
      {
        executable: planPython(),
        args: ['-m', 'pip', 'install', 'comfy-cli==1.6.0'],
        cwd: path.join(root, 'environment'),
        revision: '1.6.0',
        label: 'finish',
        stage: 'finish',
      },
    ],
    smokeInput: { prompt: 'small smoke', width: 256, height: 256 },
    repair: false,
  };
});
function planPython(): string {
  return path.join(root, 'python.exe');
}
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
function fixture() {
  const events: string[] = [];
  const runCommand = vi.fn<ComfyInstallCommandRunner>(async (_file, args, options) => {
    if (args.includes('rev-parse'))
      return { stdout: 'abcdef1234567890abcdef1234567890abcdef1234', stderr: '', exitCode: 0 };
    if (args.includes('get-url')) return { stdout: 'https://github.com/example/repo.git', stderr: '', exitCode: 0 };
    if (args.includes('status')) return { stdout: '', stderr: '', exitCode: 0 };
    if (args.includes('clone')) fs.mkdirSync(path.join(plan.environment.root, '.git'), { recursive: true });
    events.push(args.includes('clone') ? 'prepare' : 'finish');
    options.onOutput?.('command completed');
    return { stdout: '', stderr: '', exitCode: 0 };
  });
  const download = vi.fn(async (manifest: { destination: string }, _options: unknown) => {
    events.push('download');
    fs.mkdirSync(path.dirname(manifest.destination), { recursive: true });
    fs.writeFileSync(manifest.destination, content);
    return { status: 'verified' as const, destination: manifest.destination, resumedBytes: 0, bytes: content.length };
  });
  const engine = {
    validate: vi.fn(async () => {
      events.push('validate');
      return { fingerprint: 'fingerprint', loadable: true as const };
    }),
    generate: vi.fn(
      async (
        _profile: ComfyProfile,
        _input: ComfyInstallPlan['smokeInput'],
        _signal: AbortSignal,
        _progress?: (value: number) => void,
        onSubmitted?: (id: string) => void,
        onSubmitting?: () => void
      ) => {
        onSubmitting?.();
        onSubmitted?.('smoke-1');
        events.push('smoke');
        const artifact = path.join(root, 'smoke.png');
        fs.writeFileSync(artifact, 'image');
        return { promptId: 'smoke-1', artifacts: [{ path: artifact, mimeType: 'image/png' }] };
      }
    ),
    resume: vi.fn(
      async (_profile: ComfyProfile, promptId: string, _signal: AbortSignal): Promise<ComfyGenerationResult> => {
        const artifact = path.join(root, 'resumed.png');
        fs.writeFileSync(artifact, 'image');
        return { promptId, artifacts: [{ path: artifact, mimeType: 'image/png' }] };
      }
    ),
    snapshotFingerprint: vi.fn(async () => 'fingerprint'),
  };
  return {
    options: {
      engine,
      download,
      runCommand,
      verifyArtifact: async () => undefined,
      freeBytes: async () => Number.MAX_SAFE_INTEGER,
      snapshotRoot: path.join(root, 'snapshots'),
    },
    events,
    engine,
    download,
    runCommand,
  };
}

describe('generic ComfyUI install executor', () => {
  it('downloads independent components through a bounded pool before installing runtime packages', async () => {
    plan.components = Array.from({ length: 4 }, (_, index) => ({
      ...plan.components[0],
      name: `weights-${index}`,
      path: path.join(root, 'models', `weights-${index}.safetensors`),
    }));
    plan.downloadBytes = content.length * 4;
    const { options, events } = fixture();
    let active = 0;
    let peak = 0;
    let release!: () => void;
    const initialBatch = new Promise<void>((resolve) => {
      release = resolve;
    });
    const download: typeof downloadH3FromSources = async (manifest) => {
      active++;
      peak = Math.max(peak, active);
      if (active === 3) release();
      await initialBatch;
      expect(events).not.toContain('finish');
      fs.mkdirSync(path.dirname(manifest.destination), { recursive: true });
      fs.writeFileSync(manifest.destination, content);
      active--;
      return { status: 'verified', destination: manifest.destination, resumedBytes: 0, bytes: content.length };
    };
    await expect(
      executeComfyInstall(plan, new AbortController().signal, undefined, { ...options, download })
    ).resolves.toMatchObject({ state: 'verified' });
    expect(peak).toBe(3);
    expect(active).toBe(0);
    expect(events).toContain('finish');
  });

  it('cancels and settles peer transfers after a failed component without starting finish commands', async () => {
    plan.components = Array.from({ length: 3 }, (_, index) => ({
      ...plan.components[0],
      name: `weights-${index}`,
      path: path.join(root, 'models', `weights-${index}.safetensors`),
    }));
    plan.downloadBytes = content.length * 3;
    const { options, engine, events } = fixture();
    let started = 0;
    let settled = 0;
    let release!: () => void;
    const batch = new Promise<void>((resolve) => {
      release = resolve;
    });
    const download: typeof downloadH3FromSources = async (manifest, transferOptions) => {
      started++;
      if (started === 3) release();
      try {
        await batch;
        if (manifest.destination === plan.components[0].path) throw new Error('COMFY_COMPONENT_DOWNLOAD_HASH_MISMATCH');
        await new Promise<never>((_resolve, reject) => {
          if (transferOptions.signal?.aborted) reject(new Error('aborted'));
          else transferOptions.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        });
        throw new Error('unreachable');
      } finally {
        settled++;
      }
    };
    await expect(
      executeComfyInstall(plan, new AbortController().signal, undefined, { ...options, download })
    ).rejects.toThrow('COMFY_COMPONENT_DOWNLOAD_HASH_MISMATCH');
    expect(started).toBe(3);
    expect(settled).toBe(3);
    expect(events).not.toContain('finish');
    expect(engine.validate).not.toHaveBeenCalled();
  });

  it('clears memory before retrying a terminal smoke OOM once with the original recipe', async () => {
    const { options, engine } = fixture();
    const oom = Object.assign(new Error('COMFY_OOM'), {
      diagnosis: { category: 'OOM', nodeId: '7', retryable: true, action: 'clear-memory' },
    });
    engine.generate.mockRejectedValueOnce(oom);
    const clearMemory = vi.fn(async () => {
      expect(engine.generate).toHaveBeenCalledTimes(1);
      const file = path.join(options.snapshotRoot, 'smoke-receipts');
      const receipt = JSON.parse(fs.readFileSync(path.join(file, fs.readdirSync(file)[0]), 'utf8'));
      expect(receipt).toMatchObject({ oomRetryCount: 1, status: 'retry-ready' });
    });
    await expect(
      executeComfyInstall(plan, new AbortController().signal, undefined, {
        ...options,
        engine: { ...engine, clearMemory },
      })
    ).resolves.toMatchObject({ state: 'verified' });
    expect(clearMemory).toHaveBeenCalledOnce();
    expect(engine.generate).toHaveBeenCalledTimes(2);
    expect(engine.generate.mock.calls[1].slice(0, 2)).toEqual(engine.generate.mock.calls[0].slice(0, 2));
  });

  it('retains the exhausted smoke OOM allowance after restarting the installer', async () => {
    const first = fixture();
    const oom = Object.assign(new Error('COMFY_OOM'), {
      diagnosis: { category: 'OOM', nodeId: '7', retryable: true, action: 'clear-memory' },
    });
    first.engine.generate.mockRejectedValue(oom);
    await expect(
      executeComfyInstall(plan, new AbortController().signal, undefined, {
        ...first.options,
        engine: { ...first.engine, clearMemory: vi.fn(async () => undefined) },
      })
    ).rejects.toThrow('COMFY_OOM');
    expect(first.engine.generate).toHaveBeenCalledTimes(2);
    const second = fixture();
    await expect(executeComfyInstall(plan, new AbortController().signal, undefined, second.options)).rejects.toThrow(
      'COMFY_OOM'
    );
    expect(second.engine.generate).not.toHaveBeenCalled();
    expect(second.engine.resume).not.toHaveBeenCalled();
    expect(second.download).not.toHaveBeenCalled();
  });

  it('keeps other processes out of the device between smoke OOM cleanup and its retry', async () => {
    const { options, engine } = fixture();
    engine.generate.mockRejectedValueOnce(
      Object.assign(new Error('COMFY_OOM'), {
        diagnosis: { category: 'OOM', nodeId: '7', retryable: true, action: 'clear-memory' },
      })
    );
    const directory = path.join(root, 'leases');
    let startedCleanup!: () => void;
    let finishCleanup!: () => void;
    const cleaning = new Promise<void>((resolve) => (startedCleanup = resolve));
    const cleared = new Promise<void>((resolve) => (finishCleanup = resolve));
    const running = executeComfyInstall(plan, new AbortController().signal, undefined, {
      ...options,
      runtimeCoordinator: new ComfyRuntimeCoordinator({ directory }),
      engine: {
        ...engine,
        runtimeResourceKey: async () => 'gpu-0',
        clearMemory: async () => {
          startedCleanup();
          await cleared;
        },
      },
    });
    await cleaning;
    const otherTask = vi.fn(async () => undefined);
    const other = new ComfyRuntimeCoordinator({ directory }).run('gpu-0', 'other', otherTask, async () => undefined);
    try {
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(otherTask).not.toHaveBeenCalled();
    } finally {
      finishCleanup();
    }
    await expect(running).resolves.toMatchObject({ state: 'verified' });
    await other;
    expect(engine.generate).toHaveBeenCalledTimes(2);
    expect(otherTask).toHaveBeenCalledOnce();
  });

  it('recovers a reserved smoke retry after interrupted cleanup without granting a new allowance', async () => {
    const first = fixture();
    first.engine.generate.mockRejectedValueOnce(
      Object.assign(new Error('COMFY_OOM'), {
        diagnosis: { category: 'OOM', nodeId: '7', retryable: true, action: 'clear-memory' },
      })
    );
    await expect(
      executeComfyInstall(plan, new AbortController().signal, undefined, {
        ...first.options,
        engine: { ...first.engine, clearMemory: vi.fn().mockRejectedValue(new Error('offline')) },
      })
    ).rejects.toThrow('COMFY_MEMORY_CLEAR_UNCONFIRMED');
    expect(first.engine.generate).toHaveBeenCalledOnce();
    const second = fixture();
    const clearMemory = vi.fn(async () => undefined);
    await expect(
      executeComfyInstall(plan, new AbortController().signal, undefined, {
        ...second.options,
        engine: { ...second.engine, clearMemory },
      })
    ).resolves.toMatchObject({ state: 'verified' });
    expect(clearMemory).toHaveBeenCalledOnce();
    expect(second.engine.generate).toHaveBeenCalledOnce();
    expect(second.engine.resume).not.toHaveBeenCalled();
    expect(second.runCommand).not.toHaveBeenCalled();
    const receipts = path.join(second.options.snapshotRoot, 'smoke-receipts');
    expect(JSON.parse(fs.readFileSync(path.join(receipts, fs.readdirSync(receipts)[0]), 'utf8'))).toMatchObject({
      status: 'succeeded',
      oomRetryCount: 1,
    });
  });

  it('passes approved domestic-first byte-identical sources through resumable download fallback', async () => {
    const component = plan.components[0];
    component.sourceUrls = [
      'https://modelscope.cn/models/example/weights/resolve/abcdef123456/weights.safetensors',
      'https://hf-mirror.com/example/weights/resolve/abcdef123456/weights.safetensors',
      component.url!,
    ];
    const urls: string[] = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      urls.push(String(input));
      if (urls.length === 1) return new Response('offline', { status: 503 });
      return new Response(content, { headers: { 'content-length': String(content.length) } });
    }) as typeof fetch;
    const { options } = fixture();
    await executeComfyInstall(plan, new AbortController().signal, undefined, {
      ...options,
      download: (manifest, settings) => downloadH3FromSources(manifest, { ...settings, fetchImpl }),
    });
    expect(urls).toEqual(component.sourceUrls.slice(0, 2));
    expect(fs.readFileSync(component.path, 'utf8')).toBe(content);
  });

  it('rejects fallback URLs without shared checksum/size before changing files', () => {
    plan.components[0].sourceUrls = [plan.components[0].url!];
    delete plan.components[0].sha256;
    expect(() => assertComfyInstallPlan(plan)).toThrow('COMFY_COMPONENT_SOURCES_INTEGRITY_REQUIRED');
  });

  it('runs approved argv stages, downloads a pinned component and grants verified state only after a real smoke artifact', async () => {
    const { options, events, engine, runCommand } = fixture();
    const result = await executeComfyInstall(plan, new AbortController().signal, undefined, options);
    expect(events).toEqual(['prepare', 'download', 'finish', 'validate', 'smoke']);
    expect(result.state).toBe('verified');
    expect(result.validation).toMatchObject({
      fingerprint: 'fingerprint',
      promptId: 'smoke-1',
      artifacts: [path.join(root, 'smoke.png')],
    });
    expect(result.workflowSha256).toBe(
      crypto.createHash('sha256').update(fs.readFileSync(plan.workflowPath)).digest('hex')
    );
    expect(engine.generate).toHaveBeenCalledWith(
      expect.objectContaining({ state: 'loadable' }),
      plan.smokeInput,
      expect.any(AbortSignal),
      expect.any(Function),
      expect.any(Function),
      expect.any(Function)
    );
    expect(runCommand.mock.calls.every(([, , options]) => options.shell === false && options.windowsHide)).toBe(true);
  });

  it('reuses a matching existing component and refuses to replace a damaged one', async () => {
    fs.mkdirSync(path.dirname(plan.components[0].path));
    fs.writeFileSync(plan.components[0].path, content);
    const { options, download, runCommand } = fixture();
    await executeComfyInstall(plan, new AbortController().signal, undefined, options);
    expect(download).not.toHaveBeenCalled();
    fs.writeFileSync(plan.components[0].path, 'damaged');
    runCommand.mockClear();
    await expect(executeComfyInstall(plan, new AbortController().signal, undefined, options)).rejects.toThrow(
      'COMFY_EXISTING_COMPONENT_INVALID'
    );
    expect(runCommand).not.toHaveBeenCalled();
    expect(fs.readFileSync(plan.components[0].path, 'utf8')).toBe('damaged');
  });

  it('accepts a zero download budget when every existing component verifies', async () => {
    fs.mkdirSync(path.dirname(plan.components[0].path), { recursive: true });
    fs.writeFileSync(plan.components[0].path, content);
    plan.downloadBytes = 0;
    const { options, download } = fixture();
    expect(() => assertComfyInstallPlan(plan)).not.toThrow();
    await expect(executeComfyInstall(plan, new AbortController().signal, undefined, options)).resolves.toMatchObject({
      state: 'verified',
    });
    expect(download).not.toHaveBeenCalled();
  });

  it('resumes an interrupted authorization without recloning a verified pinned repository', async () => {
    const { options, engine } = fixture();
    const source = path.join(root, 'source');
    fs.mkdirSync(source);
    const git = (args: string[], cwd = source): string =>
      execFileSync('git', args, { cwd, windowsHide: true, encoding: 'utf8' });
    git(['init']);
    git(['config', 'user.name', 'Comfy Test']);
    git(['config', 'user.email', 'comfy@test.local']);
    fs.writeFileSync(path.join(source, 'main.py'), 'pinned content');
    git(['add', 'main.py']);
    git(['-c', 'commit.gpgsign=false', 'commit', '-m', 'fixture']);
    git(['tag', 'v1.0']);
    const calls: string[][] = [];
    const runCommand = vi.fn<ComfyInstallCommandRunner>(async (file, args, commandOptions) => {
      calls.push(args);
      if (file === 'git') {
        const result = await runComfyInstallCommand(
          file,
          args.map((arg) => (arg === 'https://github.com/example/repo.git' ? source : arg)),
          commandOptions
        );
        if (args.includes('clone'))
          git(['remote', 'set-url', 'origin', 'https://github.com/example/repo.git'], plan.environment.root);
        return result;
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    });
    let interrupted = true;
    const download = vi.fn(async (manifest: { destination: string }) => {
      const partial = `${manifest.destination}.part`;
      if (interrupted) {
        interrupted = false;
        fs.writeFileSync(partial, content.slice(0, 4));
        throw new Error('network disconnected');
      }
      expect(fs.readFileSync(partial, 'utf8')).toBe(content.slice(0, 4));
      fs.writeFileSync(partial, content);
      fs.renameSync(partial, manifest.destination);
      return { status: 'verified' as const, destination: manifest.destination, resumedBytes: 4, bytes: content.length };
    });
    await expect(
      executeComfyInstall(plan, new AbortController().signal, undefined, { ...options, runCommand, download })
    ).rejects.toThrow('network disconnected');
    const cloneCount = calls.filter((args) => args.includes('clone')).length;
    calls.length = 0;
    await executeComfyInstall(plan, new AbortController().signal, undefined, { ...options, runCommand, download });
    expect(calls.filter((args) => args.includes('clone'))).toHaveLength(0);
    expect(calls.some((args) => args.includes('rev-parse'))).toBe(true);
    expect(cloneCount).toBe(1);
    expect(download).toHaveBeenCalledTimes(2);
    expect(engine.generate).toHaveBeenCalledOnce();
  });

  it('does not skip a changed repository and never reclones over a dirty destination', async () => {
    const { options } = fixture();
    const runCommand = vi.fn<ComfyInstallCommandRunner>(async (_file, args) => {
      if (args.includes('clone')) fs.mkdirSync(path.join(plan.environment.root, '.git'), { recursive: true });
      if (args.includes('rev-parse'))
        return { stdout: 'abcdef1234567890abcdef1234567890abcdef1234\n', stderr: '', exitCode: 0 };
      if (args.includes('status')) return { stdout: ' M main.py\n', stderr: '', exitCode: 0 };
      if (args.includes('get-url')) return { stdout: 'https://github.com/example/repo.git', stderr: '', exitCode: 0 };
      return { stdout: '', stderr: '', exitCode: 0 };
    });
    const download = vi.fn(async () => {
      throw new Error('network disconnected');
    });
    await expect(
      executeComfyInstall(plan, new AbortController().signal, undefined, { ...options, runCommand, download })
    ).rejects.toThrow('network disconnected');
    runCommand.mockClear();
    await expect(
      executeComfyInstall(plan, new AbortController().signal, undefined, { ...options, runCommand })
    ).rejects.toThrow('COMFY_PREPARE_STATE_MISMATCH');
    expect(runCommand.mock.calls.some(([, args]) => args.includes('clone'))).toBe(false);
  });

  it('resumes its recorded no-checkout clone after cancellation before the pinned checkout', async () => {
    const { options, engine } = fixture();
    const source = path.join(root, 'source');
    fs.mkdirSync(source);
    const git = (args: string[], cwd = source): string =>
      execFileSync('git', args, { cwd, windowsHide: true, encoding: 'utf8' });
    git(['init']);
    git(['config', 'user.name', 'Comfy Test']);
    git(['config', 'user.email', 'comfy@test.local']);
    fs.writeFileSync(path.join(source, 'main.py'), 'pinned content');
    git(['add', 'main.py']);
    git(['-c', 'commit.gpgsign=false', 'commit', '-m', 'pin']);
    const pin = git(['rev-parse', 'HEAD']).trim();
    fs.writeFileSync(path.join(source, 'main.py'), 'new upstream content');
    git(['add', 'main.py']);
    git(['-c', 'commit.gpgsign=false', 'commit', '-m', 'later']);
    plan.commands = [
      {
        executable: 'git',
        args: ['clone', '--no-checkout', 'https://github.com/example/repo.git', plan.environment.root],
        cwd: root,
        revision: pin,
        label: 'clone',
        stage: 'prepare',
      },
      {
        executable: 'git',
        args: ['checkout', '--detach', pin],
        cwd: plan.environment.root,
        revision: pin,
        label: 'checkout',
        stage: 'prepare',
      },
    ];
    let cancelAfterClone = true;
    let controller = new AbortController();
    const runCommand = vi.fn<ComfyInstallCommandRunner>(async (file, args, commandOptions) => {
      const result = await runComfyInstallCommand(
        file,
        args.map((arg) => (arg === 'https://github.com/example/repo.git' ? source : arg)),
        commandOptions
      );
      if (args.includes('clone')) {
        git(['remote', 'set-url', 'origin', 'https://github.com/example/repo.git'], plan.environment.root);
        if (cancelAfterClone) {
          cancelAfterClone = false;
          controller.abort();
        }
      }
      return result;
    });
    await expect(executeComfyInstall(plan, controller.signal, undefined, { ...options, runCommand })).rejects.toThrow(
      'COMFY_INSTALL_CANCELLED'
    );
    expect(fs.readdirSync(plan.environment.root)).toEqual(['.git']);
    controller = new AbortController();
    runCommand.mockClear();
    await executeComfyInstall(plan, controller.signal, undefined, { ...options, runCommand });
    expect(runCommand.mock.calls.some(([, args]) => args.includes('clone'))).toBe(false);
    expect(fs.readFileSync(path.join(plan.environment.root, 'main.py'), 'utf8')).toBe('pinned content');
    expect(engine.generate).toHaveBeenCalledOnce();
  });

  it('repairs a git/pip runtime without optional comfy-cli after a native node source snapshot', async () => {
    plan.repair = true;
    plan.commands = [plan.commands[1]];
    const node = path.join(plan.environment.root, 'custom_nodes', plan.nodes[0].id);
    fs.mkdirSync(node, { recursive: true });
    fs.writeFileSync(path.join(node, 'node.py'), 'old nodes');
    const { options } = fixture();
    const runCommand = vi.fn<ComfyInstallCommandRunner>(async (_file, args) => {
      if (args.includes('save-snapshot')) return { stdout: '', stderr: 'No module named comfy_cli', exitCode: 1 };
      if (args.includes('-c')) return { stdout: '{"available":false}', stderr: '', exitCode: 0 };
      if (args.includes('freeze')) return { stdout: 'torch==2.9.0', stderr: '', exitCode: 0 };
      const snapshot = path.join(options.snapshotRoot, fs.readdirSync(options.snapshotRoot)[0]);
      const manifest = JSON.parse(fs.readFileSync(path.join(snapshot, 'native-nodes.json'), 'utf8'));
      expect(manifest).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ source: path.join(node, 'node.py'), copy: expect.any(String) }),
        ])
      );
      expect(
        fs.readFileSync(
          manifest.find((entry: { source: string }) => entry.source === path.join(node, 'node.py')).copy,
          'utf8'
        )
      ).toBe('old nodes');
      return { stdout: '', stderr: '', exitCode: 0 };
    });
    await expect(
      executeComfyInstall(plan, new AbortController().signal, undefined, { ...options, runCommand })
    ).resolves.toMatchObject({ state: 'verified' });
    expect(runCommand.mock.calls.some(([, args]) => args.includes('save-snapshot'))).toBe(false);
  });

  it('persists a known smoke prompt and resumes it after process restart without mutating or resubmitting', async () => {
    const first = fixture();
    first.engine.generate.mockImplementationOnce(async (profile, _input, _signal, _progress, submitted, submitting) => {
      expect(profile.state).toBe('loadable');
      submitting?.();
      submitted?.('accepted-smoke');
      throw new Error('COMFY_HISTORY_UNAVAILABLE');
    });
    await expect(executeComfyInstall(plan, new AbortController().signal, undefined, first.options)).rejects.toThrow(
      'COMFY_HISTORY_UNAVAILABLE'
    );
    const second = fixture();
    const stopOwned = vi.fn(async () => undefined);
    const result = await executeComfyInstall(plan, new AbortController().signal, undefined, {
      ...second.options,
      engine: { ...second.engine, stopOwned },
    });
    expect(result).toMatchObject({ state: 'verified', validation: { promptId: 'accepted-smoke' } });
    expect(second.engine.resume).toHaveBeenCalledWith(
      expect.objectContaining({ state: 'loadable' }),
      'accepted-smoke',
      expect.any(AbortSignal),
      expect.any(Function)
    );
    expect(second.engine.generate).not.toHaveBeenCalled();
    expect(second.runCommand).not.toHaveBeenCalled();
    expect(second.download).not.toHaveBeenCalled();
    expect(stopOwned).not.toHaveBeenCalled();
  });

  it('never repeats a smoke POST whose acceptance is unknown after restart', async () => {
    const first = fixture();
    first.engine.generate.mockImplementationOnce(
      async (_profile, _input, _signal, _progress, _submitted, submitting) => {
        submitting?.();
        throw new Error('COMFY_SUBMISSION_STATE_UNKNOWN');
      }
    );
    await expect(executeComfyInstall(plan, new AbortController().signal, undefined, first.options)).rejects.toThrow(
      'COMFY_SUBMISSION_STATE_UNKNOWN'
    );
    const second = fixture();
    await expect(executeComfyInstall(plan, new AbortController().signal, undefined, second.options)).rejects.toThrow(
      'COMFY_SUBMISSION_STATE_UNKNOWN'
    );
    expect(second.engine.generate).not.toHaveBeenCalled();
    expect(second.runCommand).not.toHaveBeenCalled();
    expect(second.engine.resume).not.toHaveBeenCalled();
  });

  it('reuses a confirmed target venv after download interruption and rejects a changed interpreter', async () => {
    const bootstrap = plan.environment.python;
    const venv = path.join(root, '.venv');
    plan.environment.python = path.join(venv, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
    plan.commands.unshift({
      executable: 'uv',
      args: ['venv', venv, '--python', bootstrap],
      cwd: root,
      revision: '0.8.0',
      label: 'venv',
      stage: 'prepare',
    });
    plan.commands[2].executable = plan.environment.python;
    const { options } = fixture();
    let version = '3.12.9';
    const runCommand = vi.fn<ComfyInstallCommandRunner>(async (file, args, commandOptions) => {
      if (args.includes('-c'))
        return {
          stdout: JSON.stringify({
            executable: file,
            version: file === bootstrap ? '3.12.9' : version,
            prefix: venv,
            baseExecutable: bootstrap,
          }),
          stderr: '',
          exitCode: 0,
        };
      if (args[0] === 'venv') {
        if (fs.existsSync(path.join(venv, 'pyvenv.cfg'))) return { stdout: '', stderr: 'already exists', exitCode: 2 };
        fs.mkdirSync(path.dirname(plan.environment.python), { recursive: true });
        fs.writeFileSync(plan.environment.python, 'target python');
        fs.writeFileSync(path.join(venv, 'pyvenv.cfg'), 'version = 3.12.9');
        return { stdout: '', stderr: '', exitCode: 0 };
      }
      return options.runCommand(file, args, commandOptions);
    });
    const download = vi.fn(async () => {
      throw new Error('download interrupted');
    });
    await expect(
      executeComfyInstall(plan, new AbortController().signal, undefined, { ...options, runCommand, download })
    ).rejects.toThrow('download interrupted');
    runCommand.mockClear();
    await expect(
      executeComfyInstall(plan, new AbortController().signal, undefined, { ...options, runCommand, download })
    ).rejects.toThrow('download interrupted');
    expect(runCommand.mock.calls.some(([, args]) => args[0] === 'venv')).toBe(false);
    // A crash immediately after creating the venv may leave no command receipt.
    fs.rmSync(path.join(options.snapshotRoot, 'command-receipts'), { recursive: true });
    runCommand.mockClear();
    await expect(
      executeComfyInstall(plan, new AbortController().signal, undefined, { ...options, runCommand, download })
    ).rejects.toThrow('download interrupted');
    expect(runCommand.mock.calls.some(([, args]) => args[0] === 'venv')).toBe(false);
    version = '3.13.1';
    await expect(
      executeComfyInstall(plan, new AbortController().signal, undefined, { ...options, runCommand, download })
    ).rejects.toThrow('COMFY_PREPARE_STATE_MISMATCH');
  });

  it('rejects a changed fingerprint before recovering a smoke prompt', async () => {
    const { options, engine } = fixture();
    engine.generate.mockImplementationOnce(async (_profile, _input, _signal, _progress, submitted, submitting) => {
      submitting?.();
      submitted?.('accepted-smoke');
      throw new Error('COMFY_HISTORY_UNAVAILABLE');
    });
    await expect(executeComfyInstall(plan, new AbortController().signal, undefined, options)).rejects.toThrow(
      'COMFY_HISTORY_UNAVAILABLE'
    );
    engine.snapshotFingerprint.mockResolvedValue('changed');
    engine.generate.mockClear();
    await expect(executeComfyInstall(plan, new AbortController().signal, undefined, options)).rejects.toThrow(
      'COMFY_PROFILE_CHANGED'
    );
    expect(engine.resume).not.toHaveBeenCalled();
    expect(engine.generate).not.toHaveBeenCalled();
  });

  it('budgets only the missing component while independently verifying reused files', async () => {
    const old = plan.components[0];
    fs.mkdirSync(path.dirname(old.path), { recursive: true });
    fs.writeFileSync(old.path, content);
    plan.components.push({ ...old, name: 'new weights', path: path.join(path.dirname(old.path), 'new.safetensors') });
    plan.downloadBytes = content.length;
    const { options, download } = fixture();
    await expect(executeComfyInstall(plan, new AbortController().signal, undefined, options)).resolves.toMatchObject({
      state: 'verified',
    });
    expect(download).toHaveBeenCalledOnce();
  });

  it('requires replacement download bytes for a corrupt repair file before mutation', async () => {
    fs.mkdirSync(path.dirname(plan.components[0].path), { recursive: true });
    fs.writeFileSync(plan.components[0].path, 'damaged');
    plan.repair = true;
    plan.downloadBytes = 0;
    const { options, download, runCommand } = fixture();
    await expect(executeComfyInstall(plan, new AbortController().signal, undefined, options)).rejects.toThrow(
      'COMFY_PLAN_DOWNLOAD_BUDGET_INVALID'
    );
    expect(download).not.toHaveBeenCalled();
    expect(runCommand).not.toHaveBeenCalled();
    expect(fs.readFileSync(plan.components[0].path, 'utf8')).toBe('damaged');
  });

  it('rejects unpinned sources, dynamic command revisions, and shell launchers before any mutation', async () => {
    const { options, runCommand, download } = fixture();
    delete plan.components[0].sha256;
    plan.components[0].url = 'https://huggingface.co/example/weights/resolve/main/weights.safetensors';
    await expect(executeComfyInstall(plan, new AbortController().signal, undefined, options)).rejects.toThrow(
      'COMFY_COMPONENT_SOURCE_UNPINNED'
    );
    plan.components[0].url = 'https://huggingface.co/example/weights/resolve/abcdef123456/weights.safetensors';
    plan.commands[0].revision = 'latest';
    await expect(executeComfyInstall(plan, new AbortController().signal, undefined, options)).rejects.toThrow(
      /fixed|revision|COMFY_PLAN/
    );
    plan.commands[0].revision = 'v1.0';
    plan.commands[0].executable = 'powershell.exe';
    plan.commands[0].args = ['-Command', 'echo unsafe'];
    await expect(executeComfyInstall(plan, new AbortController().signal, undefined, options)).rejects.toThrow(
      'COMFY_COMMAND_SHELL_FORBIDDEN'
    );
    expect(runCommand).not.toHaveBeenCalled();
    expect(download).not.toHaveBeenCalled();
  });

  it('checks disk room on component destination volume as well as environment volume', async () => {
    const { options, runCommand } = fixture();
    const freeBytes = vi.fn(async (target: string) =>
      target === plan.components[0].path
        ? { freeBytes: 1, volume: 'models' }
        : { freeBytes: 100000, volume: 'environment' }
    );
    await expect(
      executeComfyInstall(plan, new AbortController().signal, undefined, { ...options, freeBytes })
    ).rejects.toThrow('COMFY_DISK_SPACE_INSUFFICIENT');
    expect(freeBytes.mock.calls.map(([target]) => target)).toContain(plan.components[0].path);
    expect(runCommand).not.toHaveBeenCalled();
  });

  it('takes workflow, profile, node, pip and git snapshots before repair and never mutates after a failed snapshot', async () => {
    plan.repair = true;
    plan.commands[0] = { ...plan.commands[1], label: 'prepare', stage: 'prepare' };
    fs.writeFileSync(plan.workflowPath, 'previous workflow');
    const profiles = path.join(root, 'profiles.json');
    fs.writeFileSync(profiles, 'previous profiles');
    const { options, events } = fixture();
    const runCommand = vi.fn<ComfyInstallCommandRunner>(async (_file, args) => {
      if (args.includes('-c')) return { stdout: '{"available":true}', stderr: '', exitCode: 0 };
      if (args.includes('save-snapshot')) {
        fs.writeFileSync(args[args.indexOf('--output') + 1], '{}');
        events.push('snapshot');
        return { stdout: '', stderr: '', exitCode: 0 };
      }
      if (args.includes('freeze')) {
        events.push('freeze');
        return { stdout: 'torch==2.9.0', stderr: '', exitCode: 0 };
      }
      if (args.includes('rev-parse')) {
        events.push('git-refs');
        return { stdout: 'abcdef123456', stderr: '', exitCode: 0 };
      }
      events.push('prepare');
      return { stdout: '', stderr: '', exitCode: 0 };
    });
    await executeComfyInstall(plan, new AbortController().signal, undefined, {
      ...options,
      runCommand,
      snapshotFiles: [profiles],
    });
    expect(events.indexOf('prepare')).toBeGreaterThan(events.indexOf('snapshot'));
    expect(events.indexOf('prepare')).toBeGreaterThan(events.indexOf('freeze'));
    const directories = fs.readdirSync(options.snapshotRoot).filter((directory) => directory.startsWith('fixture-'));
    const snapshot = path.join(options.snapshotRoot, directories[0]);
    expect(fs.readFileSync(path.join(snapshot, 'files', '0-workflow.json'), 'utf8')).toBe('previous workflow');
    expect(fs.readFileSync(path.join(snapshot, 'files', '1-profiles.json'), 'utf8')).toBe('previous profiles');
    fs.writeFileSync(plan.workflowPath, 'untouched on failed snapshot');
    plan.smokeInput.prompt = 'explicit new repair smoke';
    const failed = vi.fn<ComfyInstallCommandRunner>(async () => {
      throw new Error('snapshot unavailable');
    });
    await expect(
      executeComfyInstall(plan, new AbortController().signal, undefined, { ...options, runCommand: failed })
    ).rejects.toMatchObject({ snapshotDirectory: expect.any(String) });
    expect(failed).toHaveBeenCalledOnce();
    expect(fs.readFileSync(plan.workflowPath, 'utf8')).toBe('untouched on failed snapshot');
  });

  it('preserves bounded command diagnostics and never retries a failed command', async () => {
    const { options } = fixture();
    const runCommand = vi.fn<ComfyInstallCommandRunner>(async (_file, _args, commandOptions) => {
      commandOptions.onOutput?.('x'.repeat(100000));
      return { stdout: '', stderr: 'failure', exitCode: 2 };
    });
    await expect(
      executeComfyInstall(plan, new AbortController().signal, undefined, { ...options, runCommand })
    ).rejects.toMatchObject({
      snapshotDirectory: expect.any(String),
      message: expect.stringContaining('COMFY_COMMAND_FAILED'),
    });
    expect(runCommand).toHaveBeenCalledOnce();
    const snapshot = path.join(options.snapshotRoot, fs.readdirSync(options.snapshotRoot)[0]);
    expect(fs.statSync(path.join(snapshot, 'commands.log')).size).toBeLessThanOrEqual(65536);
  });

  it('does not grant verified state for an empty or wrong-kind smoke result', async () => {
    const { options, engine } = fixture();
    engine.generate.mockResolvedValueOnce({ promptId: 'smoke', artifacts: [] });
    await expect(executeComfyInstall(plan, new AbortController().signal, undefined, options)).rejects.toThrow(
      'COMFY_SMOKE_ARTIFACT_REQUIRED'
    );
    const artifact = path.join(root, 'smoke.wav');
    fs.writeFileSync(artifact, 'audio');
    engine.generate.mockResolvedValueOnce({
      promptId: 'smoke',
      artifacts: [{ path: artifact, mimeType: 'audio/wav' }],
    });
    plan.smokeInput.prompt = 'explicit different smoke';
    await expect(executeComfyInstall(plan, new AbortController().signal, undefined, options)).rejects.toThrow(
      'COMFY_SMOKE_MEDIA_KIND_MISMATCH'
    );
  });

  it('stops before mutation when already cancelled', async () => {
    const { options, runCommand, download } = fixture();
    const controller = new AbortController();
    controller.abort();
    await expect(executeComfyInstall(plan, controller.signal, undefined, options)).rejects.toThrow(
      /ABORT|CANCEL|abort/i
    );
    expect(runCommand).not.toHaveBeenCalled();
    expect(download).not.toHaveBeenCalled();
  });

  it('requires actual command argv to pin package versions and git branches', async () => {
    const { options, runCommand } = fixture();
    plan.commands[0].args[2] = 'main';
    await expect(executeComfyInstall(plan, new AbortController().signal, undefined, options)).rejects.toThrow(
      'COMFY_COMMAND_GIT_UNPINNED'
    );
    plan.commands[0].args[2] = 'v1.0';
    plan.commands[1].args[3] = 'comfy-cli==latest';
    await expect(executeComfyInstall(plan, new AbortController().signal, undefined, options)).rejects.toThrow(
      'COMFY_COMMAND_PACKAGE_UNPINNED'
    );
    expect(runCommand).not.toHaveBeenCalled();
  });

  it('reuses only receipted fixed-source size-only downloads and rejects an unrelated same-size file', async () => {
    delete plan.components[0].sha256;
    const { options, download } = fixture();
    await executeComfyInstall(plan, new AbortController().signal, undefined, options);
    expect(download).toHaveBeenCalledOnce();
    await executeComfyInstall(plan, new AbortController().signal, undefined, options);
    expect(download).toHaveBeenCalledOnce();
    fs.rmSync(`${plan.components[0].path}.comfy-source.json`);
    await expect(executeComfyInstall(plan, new AbortController().signal, undefined, options)).rejects.toThrow(
      'COMFY_EXISTING_COMPONENT_SOURCE_UNCONFIRMED'
    );
    expect(download).toHaveBeenCalledOnce();
  });

  it('bounds read-only repair snapshot output separately from command diagnostics', async () => {
    plan.repair = true;
    const { options } = fixture();
    const runCommand = vi.fn<ComfyInstallCommandRunner>(async (_file, args) => {
      if (args.includes('save-snapshot')) fs.writeFileSync(args[args.indexOf('--output') + 1], '{}');
      return { stdout: args.includes('freeze') ? 'a'.repeat(100000) : '', stderr: '', exitCode: 0 };
    });
    await expect(
      executeComfyInstall(plan, new AbortController().signal, undefined, { ...options, runCommand })
    ).rejects.toThrow('COMFY_SNAPSHOT_OUTPUT_TOO_LARGE');
    expect(runCommand).toHaveBeenCalledOnce();
  });

  it('checks plan source and byte budgets read-only before requesting confirmation', () => {
    expect(() => assertComfyInstallPlan(plan)).not.toThrow();
    expect(fs.existsSync(plan.workflowPath)).toBe(false);
    plan.downloadBytes = 1;
    expect(() => assertComfyInstallPlan(plan)).toThrow('COMFY_PLAN_DOWNLOAD_BUDGET_INVALID');
    plan.downloadBytes = content.length;
    plan.requiredBytes = 1;
    expect(() => assertComfyInstallPlan(plan)).toThrow('COMFY_PLAN_REQUIRED_BUDGET_INVALID');
  });

  it.each(['component', 'workflow', 'cwd'])(
    'rejects an absolute %s path outside the declared resource roots before any command',
    async (field) => {
      const outside = path.join(os.tmpdir(), `${path.basename(root)}-outside`, 'destination');
      if (field === 'component') plan.components[0].path = outside;
      if (field === 'workflow') plan.workflowPath = outside;
      if (field === 'cwd') plan.commands[0].cwd = path.dirname(root);
      const { options, runCommand, download } = fixture();
      await expect(executeComfyInstall(plan, new AbortController().signal, undefined, options)).rejects.toThrow(
        field === 'cwd' ? 'COMFY_COMMAND_CWD_OUTSIDE_ROOT' : 'COMFY_WRITE_PATH_OUTSIDE_ROOT'
      );
      expect(runCommand).not.toHaveBeenCalled();
      expect(download).not.toHaveBeenCalled();
      expect(fs.existsSync(outside)).toBe(false);
    }
  );

  it.each(['targetRoot', 'environment.root', 'modelsRoot'])('rejects a volume root as %s', (field) => {
    const volume = path.parse(root).root;
    if (field === 'targetRoot') plan.targetRoot = volume;
    if (field === 'environment.root') plan.environment.root = volume;
    if (field === 'modelsRoot') plan.environment.launchArgs = ['--models-directory', volume];
    expect(() => assertComfyInstallPlan(plan)).toThrow('COMFY_RESOURCE_ROOT_INVALID');
  });

  it.each(['--models-directory', '--models-directory='])(
    'permits an explicitly declared external models resource root: %s',
    (flag) => {
      plan.targetRoot = plan.environment.root;
      plan.commands = [];
      const models = path.join(root, 'external-models');
      plan.components[0].path = path.join(models, 'diffusion_models', 'weights.safetensors');
      plan.environment.launchArgs = flag.endsWith('=') ? [flag + models] : [flag, models];
      expect(() => assertComfyInstallPlan(plan)).not.toThrow();
      plan.environment.launchArgs = [];
      expect(() => assertComfyInstallPlan(plan)).toThrow('COMFY_WRITE_PATH_OUTSIDE_ROOT');
    }
  );

  it.each(['component', 'workflow', 'receipt', 'partial', 'cwd'])(
    'rejects a junction or symlink escaping through a %s path',
    (field) => {
      const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'comfy-outside-'));
      try {
        if (field === 'receipt' || field === 'partial') {
          fs.mkdirSync(path.dirname(plan.components[0].path), { recursive: true });
          const destination = `${plan.components[0].path}${field === 'receipt' ? '.comfy-source.json' : '.part'}`;
          const externalFile = path.join(outside, 'external-file');
          fs.writeFileSync(externalFile, 'untouched');
          fs.symlinkSync(externalFile, destination, 'file');
        } else {
          const link = path.join(root, 'escape');
          fs.symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
          if (field === 'component') plan.components[0].path = path.join(link, 'weights.safetensors');
          if (field === 'workflow') plan.workflowPath = path.join(link, 'workflow.json');
          if (field === 'cwd') plan.commands[0].cwd = path.join(link, 'nested');
        }
        expect(() => assertComfyInstallPlan(plan)).toThrow('COMFY_PATH_REALPATH_OUTSIDE_ROOT');
      } finally {
        fs.rmSync(outside, { recursive: true, force: true });
      }
    }
  );

  it.each([
    ['unknown.exe', ['delete', 'files']],
    ['node', ['-e', 'process.exit(0)']],
    ['other-python.exe', ['-m', 'pip', 'install', 'comfy-cli==1.6.0']],
  ])('rejects an unapproved executable entry point: %s', (executable, args) => {
    plan.commands[1].executable = executable;
    plan.commands[1].args = args;
    expect(() => assertComfyInstallPlan(plan)).toThrow('COMFY_COMMAND_EXECUTABLE_FORBIDDEN');
  });

  it.each([[['-c', 'print(1)']], [['-m', 'http.server']], [['unreviewed.py']], [['-m', 'pip', 'uninstall', 'torch']]])(
    'rejects unrelated or executable Python arguments: %j',
    (args) => {
      plan.commands[1].args = args;
      expect(() => assertComfyInstallPlan(plan)).toThrow('COMFY_COMMAND_ACTION_FORBIDDEN');
    }
  );

  it('keeps selected Python venv/pip, same-environment pip, uv and pinned git cold install usable', async () => {
    const cold = path.join(root, 'cold');
    plan.targetRoot = cold;
    plan.environment.root = path.join(cold, 'ComfyUI');
    plan.workflowPath = path.join(plan.environment.root, 'workflow.json');
    plan.components[0].path = path.join(plan.environment.root, 'models', 'weights.safetensors');
    plan.environment.launchArgs = [];
    plan.commands[0].cwd = cold;
    plan.commands[0].args[4] = plan.environment.root;
    plan.commands[1].cwd = plan.environment.root;
    plan.commands.unshift({
      executable: 'uv',
      args: ['venv', path.join(cold, '.venv'), '--python', plan.environment.python],
      cwd: cold,
      label: 'venv',
      revision: '0.8.0',
      stage: 'prepare',
    });
    const { options } = fixture();
    const runCommand = vi.fn<ComfyInstallCommandRunner>(async (_file, _args, commandOptions) => {
      expect(fs.statSync(commandOptions.cwd).isDirectory()).toBe(true);
      fs.mkdirSync(plan.environment.root, { recursive: true });
      return { stdout: '', stderr: '', exitCode: 0 };
    });
    await expect(
      executeComfyInstall(plan, new AbortController().signal, undefined, { ...options, runCommand })
    ).resolves.toMatchObject({ state: 'verified' });
    plan.commands = [
      {
        executable: plan.environment.python,
        args: ['-m', 'venv', path.join(cold, 'second-venv')],
        cwd: cold,
        label: 'venv',
        revision: '3.12.0',
        stage: 'prepare',
      },
    ];
    expect(() => assertComfyInstallPlan(plan)).not.toThrow();
    plan.commands = [
      {
        executable: path.join(path.dirname(plan.environment.python), 'pip.exe'),
        args: ['install', 'comfy-cli==1.6.0'],
        cwd: cold,
        label: 'pip',
        revision: '1.6.0',
        stage: 'prepare',
      },
    ];
    expect(() => assertComfyInstallPlan(plan)).not.toThrow();
  });

  it('allows offline pinned wheel installation only within the selected resource roots', () => {
    const wheel = path.join(root, 'wheels', 'torch-2.9.1-py3-none-any.whl');
    plan.commands = [
      {
        executable: plan.environment.python,
        args: ['-m', 'pip', 'install', '--no-index', '--no-deps', wheel],
        cwd: root,
        label: 'Install verified wheels',
        revision: '2.9.1',
        stage: 'finish',
      },
    ];
    expect(() => assertComfyInstallPlan(plan)).not.toThrow();
    plan.commands[0].args[5] = path.join(os.tmpdir(), 'unowned-wheel.whl');
    expect(() => assertComfyInstallPlan(plan)).toThrow('COMFY_WRITE_PATH_OUTSIDE_ROOT');
  });

  it('checks command write destinations, not just cwd', () => {
    plan.commands[0].args[4] = path.join(os.tmpdir(), 'outside-clone');
    expect(() => assertComfyInstallPlan(plan)).toThrow('COMFY_WRITE_PATH_OUTSIDE_ROOT');
    plan.commands = [plan.commands[1]];
    plan.commands[0].args.push('--target', path.join(os.tmpdir(), 'outside-pip'));
    expect(() => assertComfyInstallPlan(plan)).toThrow('COMFY_WRITE_PATH_OUTSIDE_ROOT');
    plan.commands[0].args = ['-m', 'venv', path.join(os.tmpdir(), 'outside-venv')];
    expect(() => assertComfyInstallPlan(plan)).toThrow('COMFY_WRITE_PATH_OUTSIDE_ROOT');
  });

  it('rejects duplicate write options rather than relying on tool-specific precedence', () => {
    plan.commands = [plan.commands[1]];
    plan.commands[0].args.push(
      '--target',
      path.join(os.tmpdir(), 'outside-pip'),
      '--target',
      path.join(root, 'packages')
    );
    expect(() => assertComfyInstallPlan(plan)).toThrow('COMFY_COMMAND_ARGUMENT_DUPLICATE');
  });

  it.each(['python', 'uv'])(
    'creates an isolated target environment from a confirmed bootstrap Python via %s',
    async (entry) => {
      const bootstrap = path.join(root, 'python.exe');
      plan.targetRoot = path.join(root, 'cold-isolated');
      plan.environment.root = path.join(plan.targetRoot, 'ComfyUI');
      plan.workflowPath = path.join(plan.environment.root, 'workflow.json');
      plan.components[0].path = path.join(plan.environment.root, 'models', 'weights.safetensors');
      plan.environment.launchArgs = [];
      plan.environment.python = path.join(
        plan.targetRoot,
        '.venv',
        process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'
      );
      const destination = path.join(plan.targetRoot, '.venv');
      plan.commands[0].cwd = plan.targetRoot;
      plan.commands[0].args[4] = plan.environment.root;
      const original = plan.commands[1];
      original.executable = plan.environment.python;
      original.cwd = plan.environment.root;
      plan.commands.unshift({
        executable: entry === 'python' ? bootstrap : 'uv',
        args: entry === 'python' ? ['-m', 'venv', destination] : ['venv', destination, '--python', bootstrap],
        cwd: plan.targetRoot,
        label: 'create isolated runtime',
        revision: '3.12.9',
        stage: 'prepare',
      });
      const { options } = fixture();
      const runCommand = vi.fn<ComfyInstallCommandRunner>(async (file, args, commandOptions) => {
        expect(fs.statSync(commandOptions.cwd).isDirectory()).toBe(true);
        if (args.includes('-c'))
          return { stdout: JSON.stringify({ executable: bootstrap, version: '3.12.9' }), stderr: '', exitCode: 0 };
        fs.mkdirSync(path.dirname(plan.environment.python), { recursive: true });
        fs.mkdirSync(plan.environment.root, { recursive: true });
        fs.writeFileSync(plan.environment.python, 'selected target');
        return { stdout: '', stderr: '', exitCode: 0 };
      });
      await expect(
        executeComfyInstall(plan, new AbortController().signal, undefined, { ...options, runCommand })
      ).resolves.toMatchObject({ state: 'verified' });
      expect(runCommand.mock.calls.some(([file, args]) => file === bootstrap && args.includes('-c'))).toBe(true);
      plan.commands[0].args = ['-m', 'pip', 'install', 'torch==2.9.0'];
      plan.commands[0].executable = bootstrap;
      expect(() => assertComfyInstallPlan(plan)).toThrow('COMFY_COMMAND_EXECUTABLE_FORBIDDEN');
    }
  );

  it('rechecks write boundaries after approved commands before download and workflow writes', async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'comfy-outside-'));
    try {
      const { options, download } = fixture();
      const runCommand = vi.fn<ComfyInstallCommandRunner>(async () => {
        fs.symlinkSync(
          outside,
          path.dirname(plan.components[0].path),
          process.platform === 'win32' ? 'junction' : 'dir'
        );
        return { stdout: '', stderr: '', exitCode: 0 };
      });
      await expect(
        executeComfyInstall(plan, new AbortController().signal, undefined, { ...options, runCommand })
      ).rejects.toThrow('COMFY_PATH_REALPATH_OUTSIDE_ROOT');
      expect(download).not.toHaveBeenCalled();
      expect(fs.readdirSync(outside)).toEqual([]);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('quarantines a damaged pinned model only after all repair snapshots succeed', async () => {
    plan.repair = true;
    fs.mkdirSync(path.dirname(plan.components[0].path), { recursive: true });
    fs.writeFileSync(plan.components[0].path, 'broken original');
    const { options, download } = fixture();
    const runCommand = vi.fn<ComfyInstallCommandRunner>(async (_file, args) => {
      if (args.includes('-c')) return { stdout: '{"available":true}', stderr: '', exitCode: 0 };
      if (args.includes('save-snapshot')) fs.writeFileSync(args[args.indexOf('--output') + 1], '{}');
      return { stdout: args.includes('freeze') ? 'torch==2.9.0' : '', stderr: '', exitCode: 0 };
    });
    await executeComfyInstall(plan, new AbortController().signal, undefined, { ...options, runCommand });
    expect(download).toHaveBeenCalledOnce();
    const quarantine = fs
      .readdirSync(path.dirname(plan.components[0].path))
      .find((file) => file.includes('.comfy-repair-'));
    expect(quarantine).toBeDefined();
    expect(fs.readFileSync(path.join(path.dirname(plan.components[0].path), quarantine!), 'utf8')).toBe(
      'broken original'
    );
    expect(fs.readFileSync(plan.components[0].path, 'utf8')).toBe(content);
    const snapshot = path.join(
      options.snapshotRoot,
      fs.readdirSync(options.snapshotRoot).find((directory) => directory.startsWith('fixture-'))!
    );
    expect(JSON.parse(fs.readFileSync(path.join(snapshot, 'quarantine.json'), 'utf8'))).toEqual([
      expect.objectContaining({ original: plan.components[0].path, quarantine: expect.any(String) }),
    ]);
  });

  it('requires the smoke image to decode into real pixels before granting verified status', async () => {
    const { options } = fixture();
    await expect(
      executeComfyInstall(plan, new AbortController().signal, undefined, { ...options, verifyArtifact: undefined })
    ).rejects.toThrow('COMFY_SMOKE_IMAGE_INVALID');
    plan.smokeInput.prompt = 'explicit new smoke';
    options.engine.generate.mockImplementationOnce(async () => {
      const artifact = path.join(root, 'real-smoke.png');
      fs.writeFileSync(artifact, validPng);
      return { promptId: 'real-smoke', artifacts: [{ path: artifact, mimeType: 'image/png' }] };
    });
    await expect(
      executeComfyInstall(plan, new AbortController().signal, undefined, { ...options, verifyArtifact: undefined })
    ).resolves.toMatchObject({ state: 'verified' });
  });

  it('preserves the exact embedded H3 source bytes written by portable preparation through smoke verification', async () => {
    const source = Buffer.from(
      embeddedH3Workflows['workflows/lowvram/01_reference_4step_sla_lowvram.api.json'],
      'base64'
    ).toString('utf8');
    plan.workflow = JSON.parse(source) as ComfyInstallPlan['workflow'];
    plan.workflowSource = source;
    plan.workflowSha256 = crypto.createHash('sha256').update(source).digest('hex');
    plan.commands = [];
    plan.family = 'h3';
    plan.kind = 'video';
    plan.capabilities = ['text-to-video', 'native-audio'];
    const { options, engine } = fixture();
    engine.generate.mockImplementationOnce(async (_profile, _input, _signal, _progress, submitted, submitting) => {
      submitting?.();
      submitted?.('h3-source-smoke');
      const artifact = path.join(root, 'h3-source-smoke.mp4');
      fs.writeFileSync(artifact, 'fixture video');
      return { promptId: 'h3-source-smoke', artifacts: [{ path: artifact, mimeType: 'video/mp4' }] };
    });
    const result = await executeComfyInstall(plan, new AbortController().signal, undefined, {
      ...options,
      prepareRuntime: async () => {
        fs.writeFileSync(plan.workflowPath, source);
      },
    });
    expect(result.state).toBe('verified');
    expect(result.workflowSha256).toBe('f622f57e30056f45355079203e7d3fc6ea4db60451686293d1eda47c9f471487');
    expect(fs.readFileSync(plan.workflowPath, 'utf8')).toBe(source);
    expect(engine.generate).toHaveBeenCalledOnce();
  });

  it('reuses external checksum-pinned models read-only without granting their parent directory write access', async () => {
    const external = fs.mkdtempSync(path.join(os.tmpdir(), 'comfy-external-model-'));
    try {
      plan.components[0].path = path.join(external, 'weights.safetensors');
      plan.reuseOnlyPaths = [plan.components[0].path];
      fs.writeFileSync(plan.components[0].path, content);
      const { options, download } = fixture();
      await executeComfyInstall(plan, new AbortController().signal, undefined, options);
      expect(download).not.toHaveBeenCalled();
      expect(fs.readdirSync(external)).toEqual(['weights.safetensors']);
      plan.smokeInput.prompt = 'new request after external edit';
      fs.writeFileSync(plan.components[0].path, 'x'.repeat(content.length));
      await expect(executeComfyInstall(plan, new AbortController().signal, undefined, options)).rejects.toThrow(
        'COMFY_EXISTING_COMPONENT_INVALID'
      );
      expect(fs.readdirSync(external)).toEqual(['weights.safetensors']);
    } finally {
      fs.rmSync(external, { recursive: true, force: true });
    }
  });

  it('records a missing Python snapshot and allows authorized preparation to recreate it', async () => {
    plan.repair = true;
    fs.unlinkSync(plan.environment.python);
    plan.commands = [];
    const { options, runCommand, engine } = fixture();
    await executeComfyInstall(plan, new AbortController().signal, undefined, {
      ...options,
      prepareRuntime: async () => {
        const directory = fs.readdirSync(options.snapshotRoot).find((name) => name.startsWith('fixture-'))!;
        expect(
          JSON.parse(fs.readFileSync(path.join(options.snapshotRoot, directory, 'python-missing.json'), 'utf8'))
        ).toEqual({ executable: plan.environment.python, missing: true });
        expect(fs.existsSync(path.join(options.snapshotRoot, directory, 'snapshot.complete'))).toBe(true);
        fs.writeFileSync(plan.environment.python, 'recreated runtime');
      },
    });
    expect(runCommand).not.toHaveBeenCalled();
    expect(engine.generate).toHaveBeenCalledOnce();
  });

  it('bootstraps a pinned portable runtime only after repair snapshots and before prepare commands', async () => {
    plan.repair = true;
    const { options } = fixture();
    const order: string[] = [];
    const runCommand = vi.fn<ComfyInstallCommandRunner>(async (_file, args) => {
      if (args.includes('freeze')) {
        order.push('snapshot-python');
        return { stdout: 'torch==2.9.1', stderr: '', exitCode: 0 };
      }
      if (args.includes('-c')) return { stdout: '{"available":false}', stderr: '', exitCode: 0 };
      if (args.includes('clone')) order.push('prepare-command');
      return { stdout: '', stderr: '', exitCode: 0 };
    });
    const prepareRuntime = vi.fn(async () => {
      const directory = fs.readdirSync(options.snapshotRoot).find((name) => name.startsWith('fixture-'))!;
      expect(fs.existsSync(path.join(options.snapshotRoot, directory, 'snapshot.complete'))).toBe(true);
      order.push('portable-bootstrap');
    });
    await executeComfyInstall(plan, new AbortController().signal, undefined, {
      ...options,
      runCommand,
      prepareRuntime,
    });
    expect(prepareRuntime).toHaveBeenCalledOnce();
    expect(order).toEqual(['snapshot-python', 'portable-bootstrap', 'prepare-command']);
  });

  it('does not invoke portable bootstrap when the required repair snapshot cannot be completed', async () => {
    plan.repair = true;
    const { options } = fixture();
    const prepareRuntime = vi.fn();
    const runCommand = vi.fn<ComfyInstallCommandRunner>(async () => ({ stdout: '', stderr: '', exitCode: 1 }));
    await expect(
      executeComfyInstall(plan, new AbortController().signal, undefined, { ...options, runCommand, prepareRuntime })
    ).rejects.toThrow('COMFY_COMMAND_FAILED:snapshot-python');
    expect(prepareRuntime).not.toHaveBeenCalled();
  });

  it.each(['AIONUI_FFPROBE_PATH', 'AIONUI_FFMPEG_PATH'])(
    'reports a missing packaged validator explicitly: %s',
    async (variable) => {
      const artifact = path.join(root, 'valid.png');
      fs.writeFileSync(artifact, validPng);
      const previous = process.env[variable];
      process.env[variable] = path.join(root, 'missing-validator.exe');
      try {
        await expect(
          verifyComfySmokeArtifact({ path: artifact, mimeType: 'image/png' }, 'image', new AbortController().signal)
        ).rejects.toThrow('COMFY_MEDIA_VALIDATOR_UNAVAILABLE');
      } finally {
        if (previous === undefined) delete process.env[variable];
        else process.env[variable] = previous;
      }
    }
  );

  it.each([
    [
      'black',
      'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVR4nGNgGB4AAADIAAGtQHYiAAAAAElFTkSuQmCC',
    ],
    [
      'white',
      'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAD0lEQVR4nGP4jwMwDC0JALoev0Ewkwr8AAAAAElFTkSuQmCC',
    ],
  ])('rejects a decoded all-%s smoke image', async (_color, png) => {
    const artifact = path.join(root, 'blank.png');
    fs.writeFileSync(artifact, Buffer.from(png, 'base64'));
    await expect(
      verifyComfySmokeArtifact({ path: artifact, mimeType: 'image/png' }, 'image', new AbortController().signal)
    ).rejects.toThrow('COMFY_SMOKE_IMAGE_INVALID');
  });

  it('rejects a truncated PNG pixel payload despite a valid image header', async () => {
    const artifact = path.join(root, 'truncated.png');
    fs.writeFileSync(artifact, validPng.subarray(0, 62));
    await expect(
      verifyComfySmokeArtifact({ path: artifact, mimeType: 'image/png' }, 'image', new AbortController().signal)
    ).rejects.toThrow('COMFY_SMOKE_IMAGE_INVALID');
  });
});
