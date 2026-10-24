import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ComfyProfile } from '@/common/chat/document/creation/comfy';
import { ComfyWorkflowEngine } from '@/process/services/media/comfy/workflowEngine';
import { ComfyRuntimeCoordinator } from '@/process/services/media/comfy/runtimeCoordinator';

let root: string;
let profile: ComfyProfile;
const registry = {
  Text: { input: { required: { text: ['STRING'] } }, output: ['STRING'] },
  Model: { input: { required: { model: [['valid.safetensors']] } }, output: ['MODEL'] },
  Save: { input: { required: { text: ['STRING'], model: ['MODEL'] } }, output: [] },
  LoadImage: { input: { required: { image: ['STRING'] } }, output: ['IMAGE'] },
};
const stats = { system: { python_version: '3.12.9', pytorch_version: '2.9.0', comfyui_version: '0.3.60' } };
beforeEach(() => {
  // Match the engine's canonical paths when the OS temp directory is a symlink.
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'comfy-engine-')));
  fs.writeFileSync(path.join(root, 'main.py'), '');
  fs.writeFileSync(path.join(root, 'python.exe'), '');
  fs.writeFileSync(path.join(root, 'valid.safetensors'), 'weights');
  fs.writeFileSync(
    path.join(root, 'workflow.json'),
    JSON.stringify({
      '1': { class_type: 'Text', inputs: { text: 'default' } },
      '2': { class_type: 'Model', inputs: { model: 'valid.safetensors' } },
      '3': { class_type: 'Save', inputs: { text: ['1', 0], model: ['2', 0] } },
    })
  );
  profile = {
    id: 'fixture',
    family: 'z-image',
    name: 'Z Image',
    kind: 'image',
    version: '1',
    quantization: 'fp16',
    capabilities: ['text-to-image'],
    state: 'downloaded',
    environment: { root, python: path.join(root, 'python.exe'), baseUrl: 'http://127.0.0.1:8188' },
    components: [
      { role: 'diffusion', name: 'valid', path: path.join(root, 'valid.safetensors'), version: '1', precision: 'fp16' },
    ],
    nodes: [],
    workflowPath: path.join(root, 'workflow.json'),
    bindings: { prompt: [{ nodeId: '1', input: 'text' }] },
    defaults: {},
  };
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function fetchFixture(overrides: Record<string, unknown> = {}): typeof fetch {
  let queue = structuredClone(overrides['/queue'] ?? { queue_running: [], queue_pending: [] }) as {
    queue_running: unknown[][];
    queue_pending: unknown[][];
  };
  return vi.fn(async (url: string | URL | Request, options?: RequestInit) => {
    const suffix = new URL(String(url)).pathname;
    if (suffix === '/queue') {
      if (options?.method === 'POST') {
        const deleted = JSON.parse(String(options.body)).delete as string[];
        queue.queue_pending = queue.queue_pending.filter((entry) => !deleted.includes(String(entry[1])));
      }
      return Response.json(queue);
    }
    if (suffix === '/interrupt' && options?.method === 'POST') {
      const promptId = JSON.parse(String(options.body)).prompt_id;
      queue.queue_running = queue.queue_running.filter((entry) => entry[1] !== promptId);
    }
    if (suffix in overrides) return Response.json(overrides[suffix]);
    if (suffix === '/system_stats') return Response.json(stats);
    if (suffix === '/object_info') return Response.json(registry);
    if (suffix === '/prompt') return Response.json({ prompt_id: 'prompt-1' });
    if (suffix === '/history/prompt-1')
      return Response.json({
        'prompt-1': {
          status: { completed: true, status_str: 'success' },
          outputs: {
            '3': {
              images: [{ filename: '../escape.png', subfolder: 'nested', type: 'output' }],
              videos: [{ filename: 'result.mp4', type: 'output' }],
              audio: [{ filename: 'sound.flac', type: 'output' }],
            },
          },
        },
      });
    if (suffix === '/view') return new Response(new Uint8Array([1, 2, 3]));
    if (suffix === '/queue') return Response.json({ queue_running: [], queue_pending: [] });
    return Response.json({});
  }) as typeof fetch;
}
function engine(fetchImpl = fetchFixture(), options: Record<string, unknown> = {}): ComfyWorkflowEngine {
  return new ComfyWorkflowEngine({
    outputRoot: path.join(root, 'results'),
    runtimeCoordinator: new ComfyRuntimeCoordinator({ directory: path.join(root, `leases-${crypto.randomUUID()}`) }),
    fetchImpl,
    runtimeInspector: async () => ({ executable: profile.environment.python, root }),
    runtimeProbe: async () => ({
      executable: profile.environment.python,
      version: '3.12.9',
      packages: { torch: '2.9.0' },
      accelerator: 'cuda',
      status: 'available',
    }),
    hardwareProbe: async () => ({ os: 'win32', arch: 'x64', gpuDrivers: ['581.42'] }),
    sleep: async () => undefined,
    pollIntervalMs: 0,
    ...options,
  });
}

describe('generic ComfyUI workflow engine', () => {
  it('keeps a known prompt recoverable when the fingerprint system_stats read disconnects', async () => {
    const base = fetchFixture();
    let statsReads = 0;
    const fetchImpl = vi.fn(async (url, options) => {
      if (new URL(String(url)).pathname === '/system_stats' && ++statsReads > 3)
        throw new TypeError('second stats disconnected');
      return base(url, options);
    }) as typeof fetch;
    await expect(engine(fetchImpl).resume(profile, 'prompt-1', new AbortController().signal)).rejects.toMatchObject({
      message: 'COMFY_RESUME_SERVER_UNAVAILABLE',
      cause: expect.objectContaining({ message: 'COMFY_SERVER_UNAVAILABLE' }),
    });
    expect(vi.mocked(fetchImpl).mock.calls.some(([url]) => String(url).endsWith('/prompt'))).toBe(false);
  });

  it.each(['history', 'queue'])(
    'preserves a known prompt when the first resume %s read disconnects',
    async (endpoint) => {
      const base = fetchFixture();
      const fetchImpl = vi.fn(async (url, options) => {
        const suffix = new URL(String(url)).pathname;
        if ((endpoint === 'history' && suffix.startsWith('/history/')) || (endpoint === 'queue' && suffix === '/queue'))
          throw new TypeError('connection disconnected');
        if (endpoint === 'queue' && suffix.startsWith('/history/')) return Response.json({});
        return base(url, options);
      }) as typeof fetch;
      await expect(engine(fetchImpl).resume(profile, 'prompt-1', new AbortController().signal)).rejects.toMatchObject({
        message: 'COMFY_HISTORY_UNAVAILABLE',
        cause: expect.any(TypeError),
      });
      expect(vi.mocked(fetchImpl).mock.calls.some(([url]) => String(url).endsWith('/prompt'))).toBe(false);
    }
  );

  it('validates the graph and model dropdown without sampling; changed weights or workflow invalidate the fingerprint', async () => {
    const fetchImpl = fetchFixture();
    const runtime = engine(fetchImpl);
    const validated = await runtime.validate(profile);
    expect(validated.loadable).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalledWith(expect.stringContaining('/prompt'), expect.anything());
    expect(await runtime.snapshotFingerprint(profile)).toBe(validated.fingerprint);
    fs.appendFileSync(profile.components[0].path, 'changed');
    expect(await runtime.snapshotFingerprint(profile)).not.toBe(validated.fingerprint);
    fs.writeFileSync(
      profile.workflowPath,
      JSON.stringify({ '2': { class_type: 'Model', inputs: { model: 'not-installed.safetensors' } } })
    );
    await expect(runtime.validate(profile)).rejects.toThrow(/INVALID_INPUT|MISSING_MODEL/);
  });

  it('patches explicit bindings, keeps a frozen job profile, and materializes all media safely within outputRoot', async () => {
    const fetchImpl = fetchFixture();
    const runtime = engine(fetchImpl);
    const submitted = vi.fn(() => {
      profile.environment.baseUrl = 'http://127.0.0.1:9999';
      profile.bindings.prompt[0].input = 'mutated';
    });
    const result = await runtime.generate(
      profile,
      { prompt: 'a mountain' },
      new AbortController().signal,
      undefined,
      submitted
    );
    const request = vi.mocked(fetchImpl).mock.calls.find(([url]) => String(url).endsWith('/prompt'));
    expect(JSON.parse(String(request?.[1]?.body)).prompt['1'].inputs.text).toBe('a mountain');
    expect(result.promptId).toBe('prompt-1');
    expect(result.artifacts.map((item) => item.mimeType)).toEqual(['image/png', 'video/mp4', 'audio/flac']);
    expect(
      result.artifacts.every(
        (item) =>
          path.relative(path.join(root, 'results'), item.path).startsWith('..') === false && fs.existsSync(item.path)
      )
    ).toBe(true);
    expect(vi.mocked(fetchImpl).mock.calls.some(([url]) => String(url).includes(':9999'))).toBe(false);
  });

  it('reports submission beginning immediately before the single prompt POST', async () => {
    const events: string[] = [];
    const base = fetchFixture();
    const fetchImpl = vi.fn(async (url, options) => {
      if (String(url).endsWith('/prompt')) events.push('post');
      return base(url, options);
    }) as typeof fetch;
    await engine(fetchImpl).generate(
      profile,
      { prompt: 'a scene' },
      new AbortController().signal,
      undefined,
      () => events.push('submitted'),
      () => events.push('submitting')
    );
    expect(events).toEqual(['submitting', 'post', 'submitted']);
  });

  it('uploads required edit input before preflight and never submits missing reference images', async () => {
    profile.family = 'qwen-edit';
    profile.bindings.image = [{ nodeId: '4', input: 'image' }];
    const graph = JSON.parse(fs.readFileSync(profile.workflowPath, 'utf8'));
    graph['4'] = { class_type: 'LoadImage', inputs: { image: 'placeholder.png' } };
    fs.writeFileSync(profile.workflowPath, JSON.stringify(graph));
    const fetchImpl = fetchFixture({ '/upload/image': { name: 'uploaded.png', subfolder: 'images', type: 'input' } });
    const runtime = engine(fetchImpl);
    await expect(runtime.generate(profile, { prompt: 'edit' }, new AbortController().signal)).rejects.toThrow(
      'COMFY_INPUT_IMAGE_REQUIRED'
    );
    expect(vi.mocked(fetchImpl).mock.calls.some(([url]) => String(url).endsWith('/prompt'))).toBe(false);
    const imagePath = path.join(root, 'input.png');
    fs.writeFileSync(imagePath, 'image');
    await runtime.generate(profile, { prompt: 'edit', imagePaths: [imagePath] }, new AbortController().signal);
    const request = vi.mocked(fetchImpl).mock.calls.find(([url]) => String(url).endsWith('/prompt'));
    expect(JSON.parse(String(request?.[1]?.body)).prompt['4'].inputs.image).toBe('images/uploaded.png');
  });

  it('uploads ordered Omni references and binds image, video, embedded audio, and audio labels', async () => {
    profile.family = 'fasth3-omni';
    profile.kind = 'video';
    profile.capabilities = ['reference-to-video', 'audio-video'];
    profile.bindings.prompt = [{ nodeId: '1', input: 'text' }];
    const graph = JSON.parse(fs.readFileSync(profile.workflowPath, 'utf8'));
    graph['4'] = { class_type: 'MiniMaxH3ReferenceToVideo', inputs: { prompt: 'default' } };
    fs.writeFileSync(profile.workflowPath, JSON.stringify(graph));
    const imagePath = path.join(root, 'ref.png');
    const videoPath = path.join(root, 'ref.mp4');
    const audioPath = path.join(root, 'ref.wav');
    for (const file of [imagePath, videoPath, audioPath]) fs.writeFileSync(file, 'reference');
    const uploaded: string[] = [];
    const base = fetchFixture({
      '/object_info': {
        ...registry,
        MiniMaxH3ReferenceToVideo: {
          input: {
            required: { prompt: ['STRING'] },
            optional: {
              ref_images: ['AUTOGROW'],
              ref_videos: ['AUTOGROW'],
              ref_video_audios: ['AUTOGROW'],
              ref_audios: ['AUTOGROW'],
            },
          },
          output: ['CONDITIONING', 'LATENT'],
        },
        LoadVideo: { input: { required: { file: ['STRING'] } }, output: ['VIDEO'] },
        GetVideoComponents: { input: { required: { video: ['VIDEO'] } }, output: ['IMAGE', 'AUDIO', 'FLOAT'] },
        LoadAudio: { input: { required: { audio: ['STRING'] } }, output: ['AUDIO'] },
      },
    });
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (new URL(String(url)).pathname === '/upload/image') {
        const form = init?.body as FormData;
        uploaded.push(String(form.get('image') instanceof Blob ? (form.get('image') as File).name : ''));
        return Response.json({ name: `upload-${uploaded.length}.bin`, subfolder: 'input' });
      }
      return base(url, init);
    }) as typeof fetch;
    await engine(fetchImpl, {
      referencePreflight: {
        inspect: async () =>
          new Map([
            [videoPath, { duration: 3, audio: true, fps: 24 }],
            [audioPath, { duration: 3, audio: true }],
          ]),
      },
    }).generate(
      profile,
      {
        prompt: 'A moving scene',
        references: [
          { type: 'video', path: videoPath },
          { type: 'audio', path: audioPath },
          { type: 'image', path: imagePath },
        ],
      },
      new AbortController().signal
    );
    const request = vi.mocked(fetchImpl).mock.calls.find(([url]) => String(url).endsWith('/prompt'));
    const submitted = JSON.parse(String(request?.[1]?.body)).prompt;
    const refNode = submitted['4'];
    expect(uploaded.map((name) => name.replace(/^[a-f0-9-]{36}-/, ''))).toEqual(['ref.mp4', 'ref.wav', 'ref.png']);
    expect(submitted['1'].inputs.text).toContain('<Picture 1>');
    expect(submitted['1'].inputs.text).toContain('<Video 1>');
    expect(submitted['1'].inputs.text).toContain('<Audio 1>');
    expect(refNode.inputs['ref_images.ref_image_0']).toEqual(['8', 0]);
    expect(refNode.inputs['ref_videos.ref_video_0']).toEqual(['6', 0]);
    expect(refNode.inputs['ref_video_audios.ref_video_audio_0']).toEqual(['6', 1]);
    expect(refNode.inputs['ref_audios.ref_audio_0']).toEqual(['7', 0]);
    expect(submitted['1'].inputs.text).toContain('<Picture 1> <Audio 1> <Video 1> <Audio 2>');
  });

  it('requires an Omni image or video reference before starting ComfyUI', async () => {
    profile.family = 'fasth3-omni';
    profile.kind = 'video';
    const fetchImpl = fetchFixture();
    await expect(
      engine(fetchImpl).generate(
        profile,
        { prompt: 'A moving scene', references: [{ type: 'audio', path: path.join(root, 'audio.wav') }] },
        new AbortController().signal
      )
    ).rejects.toThrow('COMFY_OMNI_REFERENCE_REQUIRED');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    { images: 0, videos: 2, audios: 2, duration: 3, error: 'COMFY_REFERENCE_AUDIO_LIMIT_WITH_SOUNDTRACKS' },
    { images: 9, videos: 2, audios: 0, duration: 3, error: 'COMFY_REFERENCE_TOTAL_LIMIT_WITH_SOUNDTRACKS' },
    { images: 0, videos: 1, audios: 1, duration: 8, error: 'COMFY_REFERENCE_AUDIO_DURATION_WITH_SOUNDTRACKS' },
  ])('counts video soundtracks towards Omni limits: $error', async ({ images, videos, audios, duration, error }) => {
    profile.family = 'fasth3-omni';
    profile.kind = 'video';
    const references = [
      ...Array.from({ length: images }, (_, index) => ({
        type: 'image' as const,
        path: path.join(root, `${index}.png`),
      })),
      ...Array.from({ length: videos }, (_, index) => ({
        type: 'video' as const,
        path: path.join(root, `${index}.mp4`),
      })),
      ...Array.from({ length: audios }, (_, index) => ({
        type: 'audio' as const,
        path: path.join(root, `${index}.wav`),
      })),
    ];
    const fetchImpl = fetchFixture();
    const inspect = async () => new Map(references.map(({ path: file }) => [file, { duration, audio: true }]));
    await expect(
      engine(fetchImpl, { referencePreflight: { inspect } }).generate(
        profile,
        { prompt: 'A moving scene', references },
        new AbortController().signal
      )
    ).rejects.toThrow(error);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('confirms idle queue and observed VRAM recovery before resolving memory cleanup', async () => {
    const reads: number[] = [];
    let freeRequests = 0;
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const suffix = new URL(String(url)).pathname;
      if (suffix === '/system_stats') {
        reads.push(freeRequests ? 700 : 400);
        return Response.json({ ...stats, devices: [{ vram_free: reads.at(-1) }] });
      }
      if (suffix === '/queue') return Response.json({ queue_running: [], queue_pending: [] });
      if (suffix === '/free') {
        freeRequests++;
        expect(init?.method).toBe('POST');
        return Response.json({});
      }
      return fetchFixture()(url, init);
    }) as typeof fetch;
    await engine(fetchImpl, { sleep: async () => undefined }).clearMemory(profile, 'oom', new AbortController().signal);
    expect(freeRequests).toBe(1);
    expect(reads).toEqual([400, 700]);
  });

  it('does not confirm cleanup from /free HTTP 200 alone when the queue is busy', async () => {
    const fetchImpl = fetchFixture({
      '/queue': { queue_running: [['1', 'busy']], queue_pending: [] },
    });
    await expect(engine(fetchImpl).clearMemory(profile, 'oom', new AbortController().signal)).rejects.toThrow(
      'COMFY_MEMORY_CLEAR_QUEUE_BUSY'
    );
    expect(vi.mocked(fetchImpl).mock.calls.some(([url]) => String(url).endsWith('/free'))).toBe(false);
  });

  it('accepts an already empty allocator only after stable telemetry and rejects a replaced runtime', async () => {
    const fetchImpl = fetchFixture({
      '/system_stats': { ...stats, devices: [{ vram_free: 700, torch_vram_total: 0 }] },
    });
    await engine(fetchImpl).clearMemory(profile, 'idle', new AbortController().signal);
    expect(vi.mocked(fetchImpl).mock.calls.filter(([url]) => String(url).endsWith('/system_stats'))).toHaveLength(3);
    let reads = 0;
    const runtimeInspector = async () => ({ executable: profile.environment.python, root, pid: ++reads <= 2 ? 1 : 2 });
    await expect(
      engine(fetchImpl, { runtimeInspector }).clearMemory(profile, 'oom', new AbortController().signal)
    ).rejects.toThrow('COMFY_MEMORY_CLEAR_RUNTIME_CHANGED');
  });

  it('shares its generation fence across engine instances and recovers the accepted prompt without another POST', async () => {
    const directory = path.join(root, 'shared-leases');
    const coordinator = new ComfyRuntimeCoordinator({ directory });
    const base = fetchFixture();
    const offline = vi.fn(async (url, init) =>
      String(url).includes('/history/') ? new Response(null, { status: 503 }) : base(url, init)
    ) as typeof fetch;
    await expect(
      engine(offline, { runtimeCoordinator: coordinator, maxPollAttempts: 3 }).generate(
        profile,
        { prompt: 'keep this task' },
        new AbortController().signal
      )
    ).rejects.toThrow('COMFY_HISTORY_UNAVAILABLE');
    const recovered = engine(base, { runtimeCoordinator: new ComfyRuntimeCoordinator({ directory }) });
    await expect(recovered.generate(profile, { prompt: 'replacement' }, new AbortController().signal)).rejects.toThrow(
      'COMFY_REMOTE_STATE_UNCONFIRMED'
    );
    await expect(recovered.resume(profile, 'prompt-1', new AbortController().signal)).resolves.toHaveProperty(
      'promptId',
      'prompt-1'
    );
    expect(vi.mocked(offline).mock.calls.filter(([url]) => String(url).endsWith('/prompt'))).toHaveLength(1);
    expect(vi.mocked(base).mock.calls.filter(([url]) => String(url).endsWith('/prompt'))).toHaveLength(1);
  });

  it('keeps an unconfirmed cancellation blocked and does not treat a nonterminal history record as complete', async () => {
    const fetchImpl = vi.fn(async (url) => {
      const suffix = new URL(String(url)).pathname;
      if (suffix === '/queue') return Response.json({ queue_running: [[0, 'prompt-1']], queue_pending: [] });
      return fetchFixture()(url);
    }) as typeof fetch;
    fs.writeFileSync(path.join(root, 'server.py'), 'prompt_id = json_data.get("prompt_id")\n# targeted interruption\n');
    await expect(engine(fetchImpl).cancel(profile, 'prompt-1')).rejects.toThrow('COMFY_CANCEL_UNCONFIRMED');
    const incomplete = fetchFixture({
      '/history/prompt-1': { 'prompt-1': { status: { completed: false, status_str: 'running' } } },
    });
    await expect(engine(incomplete).cancel(profile, 'prompt-1', true)).rejects.toThrow('COMFY_CANCEL_UNCONFIRMED');
  });

  it('does not reuse or kill a server from another interpreter and rejects non-loopback servers', async () => {
    const spawnImpl = vi.fn();
    const runtime = engine(fetchFixture(), {
      spawnImpl,
      runtimeInspector: async () => ({ executable: path.join(root, 'other.exe'), root }),
    });
    await expect(runtime.ensureStarted(profile)).rejects.toThrow('COMFY_SERVER_ENVIRONMENT_MISMATCH');
    expect(spawnImpl).not.toHaveBeenCalled();
    await runtime.stopOwned();
    profile.environment.baseUrl = 'http://example.com:8188';
    await expect(runtime.ensureStarted(profile)).rejects.toThrow('COMFY_LOCAL_SERVER_REQUIRED');
  });

  it('starts only the selected interpreter with hidden localhost arguments and stops its owned child', async () => {
    let online = false;
    const fetchImpl = vi.fn(async () => {
      if (!online) throw new Error('offline');
      return Response.json(stats);
    }) as typeof fetch;
    const child = Object.assign(new EventEmitter(), {
      kill: vi.fn(() => {
        child.emit('exit', 0);
        return true;
      }),
      exitCode: null,
      stdout: null,
      stderr: null,
      pid: 42,
    });
    const spawnImpl = vi.fn((_file, _args, _options) => {
      online = true;
      return child as unknown as ChildProcess;
    });
    const runtime = engine(fetchImpl, { spawnImpl });
    await runtime.ensureStarted(profile);
    expect(spawnImpl).toHaveBeenCalledWith(
      profile.environment.python,
      expect.arrayContaining([path.join(root, 'main.py'), '--listen', '127.0.0.1', '--port', '8188']),
      expect.objectContaining({ cwd: root, windowsHide: true })
    );
    await runtime.stopOwned();
    expect(child.kill).toHaveBeenCalledOnce();
  });

  it('does not resubmit an ambiguous prompt POST and bounds failed history polling', async () => {
    const base = fetchFixture();
    const fetchImpl = vi.fn(async (url, options) => {
      if (String(url).endsWith('/prompt')) throw new Error('connection dropped');
      return base(url, options);
    }) as typeof fetch;
    await expect(engine(fetchImpl).generate(profile, { prompt: 'test' }, new AbortController().signal)).rejects.toThrow(
      'COMFY_SUBMISSION_STATE_UNKNOWN'
    );
    expect(vi.mocked(fetchImpl).mock.calls.filter(([url]) => String(url).endsWith('/prompt'))).toHaveLength(1);
    const historyFail = vi.fn(async (url, options) =>
      String(url).includes('/history/') ? new Response('', { status: 503 }) : base(url, options)
    ) as typeof fetch;
    await expect(
      engine(historyFail, { maxPollAttempts: 3 }).generate(profile, { prompt: 'test' }, new AbortController().signal)
    ).rejects.toThrow('COMFY_HISTORY_UNAVAILABLE');
  });

  it.each(['exit', 'timeout'])('retains bounded startup logs with safe diagnostics after %s', async (failure) => {
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    const child = Object.assign(new EventEmitter(), {
      kill: vi.fn(() => true),
      stdout,
      stderr,
      pid: 42,
    });
    let slept = false;
    const runtime = engine(
      vi.fn(async () => {
        throw new Error('offline');
      }) as typeof fetch,
      {
        spawnImpl: vi.fn(() => child as unknown as ChildProcess),
        startupTimeoutMs: 1000,
        sleep: async () => {
          stderr.emit(
            'data',
            Buffer.from('x'.repeat(100000) + '\nModuleNotFoundError: missing_node\nsecret-user-input')
          );
          if (failure === 'exit' && !slept) child.emit('exit', 1);
          slept = true;
        },
      }
    );
    const error = (await runtime.ensureStarted(profile).catch((cause: unknown) => cause)) as Error & {
      diagnosticLogPath: string;
      diagnosis: { category: string; action: string };
    };
    expect(error.message).toBe(failure === 'exit' ? 'COMFY_STARTUP_FAILED' : 'COMFY_STARTUP_TIMEOUT');
    expect(error.diagnosis).toMatchObject({ category: 'EXECUTION_FAILED', action: 'INSPECT_RUNTIME_LOG' });
    expect(error.message).not.toContain('secret-user-input');
    expect(path.relative(path.join(root, 'results', 'diagnostics'), error.diagnosticLogPath).startsWith('..')).toBe(
      false
    );
    expect(fs.readFileSync(error.diagnosticLogPath, 'utf8')).toContain('ModuleNotFoundError');
    expect(fs.statSync(error.diagnosticLogPath).size).toBeLessThanOrEqual(65536);
  });

  it('preserves execution error details locally while exposing only a safe diagnosis', async () => {
    const runtime = engine(
      fetchFixture({
        '/history/prompt-1': {
          'prompt-1': {
            status: {
              status_str: 'error',
              messages: [
                [
                  'execution_error',
                  {
                    node_id: '2',
                    exception_type: 'torch.OutOfMemoryError',
                    traceback: ['secret traceback input'],
                  },
                ],
              ],
            },
          },
        },
      })
    );
    const error = (await runtime
      .generate(profile, { prompt: 'private prompt' }, new AbortController().signal)
      .catch((cause: unknown) => cause)) as Error & { diagnosticLogPath: string; diagnosis: { category: string } };
    expect(error.diagnosis.category).toBe('OOM');
    expect(error.message).not.toContain('secret traceback input');
    expect(fs.readFileSync(error.diagnosticLogPath, 'utf8')).toContain('secret traceback input');
  });

  it('classifies view transport failure as recoverable retrieval and retains its log', async () => {
    const base = fetchFixture();
    const fetchImpl = vi.fn(async (url, options) => {
      if (new URL(String(url)).pathname === '/view') throw new TypeError('fetch failed');
      return base(url, options);
    }) as typeof fetch;
    const error = (await engine(fetchImpl)
      .generate(profile, { prompt: 'test' }, new AbortController().signal)
      .catch((cause: unknown) => cause)) as Error & { diagnosticLogPath: string };
    expect(error.message).toBe('COMFY_OUTPUT_RETRIEVAL_FAILED');
    expect(fs.readFileSync(error.diagnosticLogPath, 'utf8')).toContain('fetch failed');
  });

  it('diagnoses runtime OOM and cancels only the matching active prompt', async () => {
    const fetchImpl = fetchFixture({
      '/history/prompt-1': {
        'prompt-1': {
          status: {
            status_str: 'error',
            messages: [['execution_error', { node_id: '2', exception_type: 'torch.OutOfMemoryError' }]],
          },
        },
      },
      '/queue': { queue_running: [[0, 'somebody-else']], queue_pending: [[1, 'prompt-1']] },
    });
    const runtime = engine(fetchImpl);
    await expect(runtime.generate(profile, { prompt: 'test' }, new AbortController().signal)).rejects.toMatchObject({
      diagnosis: expect.objectContaining({ category: 'OOM' }),
    });
    await runtime.cancel(profile, 'prompt-1');
    expect(vi.mocked(fetchImpl).mock.calls.some(([url]) => String(url).endsWith('/interrupt'))).toBe(false);
    const queueRequest = vi
      .mocked(fetchImpl)
      .mock.calls.find(([url, options]) => String(url).endsWith('/queue') && options?.method === 'POST');
    expect(JSON.parse(String(queueRequest?.[1]?.body))).toEqual({ delete: ['prompt-1'] });
  });

  it('invalidates the validation when a pinned custom node source or Python package metadata changes', async () => {
    const nodeRoot = path.join(root, 'custom_nodes', 'fixture-node');
    fs.mkdirSync(path.join(nodeRoot, 'src'), { recursive: true });
    fs.mkdirSync(path.join(nodeRoot, '.git', 'refs', 'tags'), { recursive: true });
    fs.writeFileSync(path.join(nodeRoot, '.git', 'HEAD'), 'abcdef1234567890abcdef1234567890abcdef1234');
    fs.writeFileSync(path.join(nodeRoot, '.git', 'refs', 'tags', '1.0'), 'abcdef1234567890abcdef1234567890abcdef1234');
    fs.writeFileSync(path.join(nodeRoot, 'src', 'node.py'), 'original');
    const metadataFile = path.join(root, 'METADATA');
    fs.writeFileSync(metadataFile, 'Version: 2.9.0');
    profile.nodes = [{ id: 'fixture-node', version: '1.0' }];
    const runtimeProbe = vi.fn(async () => ({
      executable: profile.environment.python,
      version: '3.12.9',
      packages: { torch: '2.9.0' },
      packageMetadataFiles: [metadataFile],
      accelerator: 'cuda' as const,
      status: 'available' as const,
    }));
    const runtime = engine(fetchFixture(), { runtimeProbe });
    const validated = await runtime.validate(profile);
    expect(await runtime.snapshotFingerprint(profile)).toBe(validated.fingerprint);
    expect(runtimeProbe).toHaveBeenCalledTimes(1);
    fs.appendFileSync(path.join(nodeRoot, 'src', 'node.py'), 'changed');
    expect(await runtime.snapshotFingerprint(profile)).not.toBe(validated.fingerprint);
    const afterNode = await runtime.snapshotFingerprint(profile);
    fs.appendFileSync(metadataFile, 'new package');
    expect(await runtime.snapshotFingerprint(profile)).not.toBe(afterNode);
    expect(runtimeProbe).toHaveBeenCalledTimes(3);
  });

  it('rejects a mismatched declared component checksum during loadable validation', async () => {
    profile.components[0].sha256 = 'a'.repeat(64);
    await expect(engine().validate(profile)).rejects.toThrow('COMFY_MODEL_HASH_MISMATCH');
  });

  it('allows a declared external image placeholder during validation but requires an uploaded dropdown value during generation', async () => {
    profile.family = 'qwen-edit';
    profile.bindings.image = [{ nodeId: '4', input: 'image' }];
    const graph = JSON.parse(fs.readFileSync(profile.workflowPath, 'utf8'));
    graph['4'] = { class_type: 'LoadImage', inputs: { image: 'user-input-placeholder.png' } };
    fs.writeFileSync(profile.workflowPath, JSON.stringify(graph));
    const fetchImpl = fetchFixture({
      '/object_info': {
        ...registry,
        LoadImage: { input: { required: { image: [['existing.png', 'images/uploaded.png']] } }, output: ['IMAGE'] },
      },
      '/upload/image': { name: 'uploaded.png', subfolder: 'images', type: 'input' },
    });
    const runtime = engine(fetchImpl);
    await expect(runtime.validate(profile)).resolves.toMatchObject({ loadable: true });
    const imagePath = path.join(root, 'input.png');
    fs.writeFileSync(imagePath, 'image');
    await expect(
      runtime.generate(profile, { prompt: 'edit', imagePaths: [imagePath] }, new AbortController().signal)
    ).resolves.toHaveProperty('promptId', 'prompt-1');
  });

  it('refuses an unrelated listener that races the child process startup', async () => {
    let online = false;
    const child = Object.assign(new EventEmitter(), {
      kill: vi.fn(),
      exitCode: null,
      stdout: null,
      stderr: null,
      pid: 42,
    });
    const runtime = engine(
      vi.fn(async () => {
        if (!online) throw new Error('offline');
        return Response.json(stats);
      }) as typeof fetch,
      {
        spawnImpl: vi.fn(() => {
          online = true;
          return child;
        }),
        runtimeInspector: async () => ({ executable: profile.environment.python, root, pid: 77 }),
      }
    );
    await expect(runtime.ensureStarted(profile)).rejects.toThrow('COMFY_SERVER_ENVIRONMENT_MISMATCH');
    expect(child.kill).toHaveBeenCalledOnce();
  });

  it('accepts ComfyUI empty successful cancellation responses and keeps interruption prompt-scoped', async () => {
    const base = fetchFixture({ '/queue': { queue_running: [[0, 'prompt-1']], queue_pending: [] } });
    fs.writeFileSync(path.join(root, 'server.py'), 'prompt_id = json_data.get("prompt_id")\n# targeted interruption\n');
    const fetchImpl = vi.fn(async (url, options) => {
      const result = await base(url, options);
      return options?.method === 'POST' && String(url).endsWith('/interrupt')
        ? new Response(null, { status: 200 })
        : result;
    }) as typeof fetch;
    await expect(engine(fetchImpl).cancel(profile, 'prompt-1')).resolves.toBeUndefined();
    const request = vi.mocked(fetchImpl).mock.calls.find(([url]) => String(url).endsWith('/interrupt'));
    expect(JSON.parse(String(request?.[1]?.body))).toEqual({ prompt_id: 'prompt-1' });
  });

  it('does not invoke a legacy global interrupt endpoint', async () => {
    const fetchImpl = fetchFixture({ '/queue': { queue_running: [[0, 'prompt-1']], queue_pending: [] } });
    fs.writeFileSync(path.join(root, 'server.py'), 'interrupt_processing()');
    await expect(engine(fetchImpl).cancel(profile, 'prompt-1')).rejects.toThrow('COMFY_TARGETED_INTERRUPT_UNAVAILABLE');
    expect(vi.mocked(fetchImpl).mock.calls.some(([url]) => String(url).endsWith('/interrupt'))).toBe(false);
  });

  it('cancels a prompt when the submission callback aborts immediately', async () => {
    const controller = new AbortController();
    const fetchImpl = fetchFixture({ '/queue': { queue_running: [], queue_pending: [[0, 'prompt-1']] } });
    await expect(
      engine(fetchImpl).generate(profile, { prompt: 'test' }, controller.signal, undefined, () => controller.abort())
    ).rejects.toThrow('COMFY_JOB_CANCELLED');
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(
      vi
        .mocked(fetchImpl)
        .mock.calls.some(([url, options]) => String(url).endsWith('/queue') && options?.method === 'POST')
    ).toBe(true);
  });

  it('keeps dependency caches separate for profiles with different custom node sets in the same environment', async () => {
    const runtime = engine();
    await runtime.validate(profile);
    const second = structuredClone(profile);
    second.id = 'other-model';
    second.nodes = [{ id: 'new-node', version: '1.0' }];
    const nodeRoot = path.join(root, 'custom_nodes', 'new-node');
    fs.mkdirSync(nodeRoot, { recursive: true });
    fs.mkdirSync(path.join(nodeRoot, '.git', 'refs', 'tags'), { recursive: true });
    fs.writeFileSync(path.join(nodeRoot, '.git', 'HEAD'), 'abcdef1234567890abcdef1234567890abcdef1234');
    fs.writeFileSync(path.join(nodeRoot, '.git', 'refs', 'tags', '1.0'), 'abcdef1234567890abcdef1234567890abcdef1234');
    fs.writeFileSync(path.join(nodeRoot, '__init__.py'), 'original');
    const validated = await runtime.validate(second);
    fs.appendFileSync(path.join(nodeRoot, '__init__.py'), 'changed');
    expect(await runtime.snapshotFingerprint(second)).not.toBe(validated.fingerprint);
  });

  it('requires a matching live Python and Torch version after a target environment package change', async () => {
    const fetchImpl = fetchFixture({ '/system_stats': { system: { ...stats.system, pytorch_version: '2.8.0' } } });
    await expect(engine(fetchImpl).validate(profile)).rejects.toThrow('COMFY_SERVER_RUNTIME_MISMATCH');
  });

  it('converts duration to explicitly bound frames using fps, frameMultiple and frameOffset', async () => {
    profile.kind = 'video';
    profile.family = 'h3';
    profile.bindings.frames = [{ nodeId: '1', input: 'frames' }];
    profile.defaults = { fps: 24, frameMultiple: 4, frameOffset: 1 };
    const graph = JSON.parse(fs.readFileSync(profile.workflowPath, 'utf8'));
    graph['1'].inputs.frames = 1;
    fs.writeFileSync(profile.workflowPath, JSON.stringify(graph));
    const fetchImpl = fetchFixture({
      '/object_info': {
        ...registry,
        Text: { input: { required: { text: ['STRING'], frames: ['INT'] } }, output: ['STRING'] },
      },
    });
    await engine(fetchImpl).generate(profile, { prompt: 'video', durationSeconds: 2 }, new AbortController().signal);
    const request = vi.mocked(fetchImpl).mock.calls.find(([url]) => String(url).endsWith('/prompt'));
    expect(JSON.parse(String(request?.[1]?.body)).prompt['1'].inputs.frames).toBe(49);
    delete profile.defaults.fps;
    await expect(
      engine(fetchImpl).generate(profile, { prompt: 'video', durationSeconds: 2 }, new AbortController().signal)
    ).rejects.toThrow('COMFY_DURATION_FPS_REQUIRED');
  });

  it('preserves explicitly bound duration seconds without converting that field into frames', async () => {
    profile.bindings.durationSeconds = [{ nodeId: '1', input: 'duration' }];
    const graph = JSON.parse(fs.readFileSync(profile.workflowPath, 'utf8'));
    graph['1'].inputs.duration = 1;
    fs.writeFileSync(profile.workflowPath, JSON.stringify(graph));
    const fetchImpl = fetchFixture({
      '/object_info': {
        ...registry,
        Text: { input: { required: { text: ['STRING'], duration: ['FLOAT'] } }, output: ['STRING'] },
      },
    });
    await engine(fetchImpl).generate(profile, { prompt: 'video', durationSeconds: 2 }, new AbortController().signal);
    const request = vi.mocked(fetchImpl).mock.calls.find(([url]) => String(url).endsWith('/prompt'));
    expect(JSON.parse(String(request?.[1]?.body)).prompt['1'].inputs.duration).toBe(2);
  });

  it('fingerprints stable GPU properties but does not invalidate on free VRAM changes', async () => {
    let free = 100;
    let name = 'NVIDIA RTX 5080';
    const base = fetchFixture();
    const fetchImpl = vi.fn(async (url, options) =>
      String(url).endsWith('/system_stats')
        ? Response.json({ ...stats, devices: [{ name, type: 'cuda', index: 0, vram_total: 16000, vram_free: free }] })
        : base(url, options)
    ) as typeof fetch;
    const runtime = engine(fetchImpl);
    const fingerprint = await runtime.snapshotFingerprint(profile);
    free = 50;
    expect(await runtime.snapshotFingerprint(profile)).toBe(fingerprint);
    name = 'NVIDIA RTX 5090';
    expect(await runtime.snapshotFingerprint(profile)).not.toBe(fingerprint);
  });

  it.each(['comfy', 'comfy_extras'])(
    'fingerprints in-place %s source edits with cached source stats',
    async (directory) => {
      const coreSource = path.join(root, directory, 'sampler.py');
      fs.mkdirSync(path.dirname(coreSource), { recursive: true });
      fs.writeFileSync(coreSource, 'original');
      const runtime = engine();
      const fingerprint = await runtime.snapshotFingerprint(profile);
      fs.appendFileSync(coreSource, 'changed');
      expect(await runtime.snapshotFingerprint(profile)).not.toBe(fingerprint);
    }
  );

  it('includes stable machine driver/OS evidence in fingerprints and validation without repeating Python probes', async () => {
    let hardware = { os: 'win32', arch: 'x64', gpuDrivers: ['581.42'] };
    const runtimeProbe = vi.fn(async () => ({
      executable: profile.environment.python,
      version: '3.12.9',
      packages: { torch: '2.9.0' },
      accelerator: 'cuda',
      status: 'available',
    }));
    const runtime = engine(fetchFixture(), { hardwareProbe: async () => hardware, runtimeProbe });
    const validated = await runtime.validate(profile);
    expect(validated.runtime.hardware).toMatchObject(hardware);
    expect(await runtime.snapshotFingerprint(profile)).toBe(validated.fingerprint);
    hardware = { ...hardware, gpuDrivers: ['581.43'] };
    const driverChanged = await runtime.snapshotFingerprint(profile);
    expect(driverChanged).not.toBe(validated.fingerprint);
    hardware = { ...hardware, gpuDrivers: ['581.43'], os: 'linux' };
    expect(await runtime.snapshotFingerprint(profile)).not.toBe(driverChanged);
    expect(runtimeProbe).toHaveBeenCalledTimes(1);
  });

  it.each(['image-to-video', 'reference-to-video'])(
    'requires explicit images for an H3 %s-only workflow instead of using default references',
    async (capability) => {
      profile.family = 'h3';
      profile.kind = 'video';
      profile.capabilities = [capability];
      const fetchImpl = fetchFixture();
      const runtime = engine(fetchImpl);
      await expect(runtime.generate(profile, { prompt: 'animate' }, new AbortController().signal)).rejects.toThrow(
        'COMFY_INPUT_IMAGE_REQUIRED'
      );
      expect(fetchImpl).not.toHaveBeenCalled();
      profile.capabilities.push('text-to-video');
      await expect(
        runtime.generate(profile, { prompt: 'new scene' }, new AbortController().signal)
      ).resolves.toMatchObject({ promptId: 'prompt-1' });
    }
  );

  it('resumes a known prompt without ever posting a second workflow', async () => {
    const fetchImpl = fetchFixture();
    const result = await engine(fetchImpl).resume(profile, 'prompt-1', new AbortController().signal);
    expect(result.promptId).toBe('prompt-1');
    expect(vi.mocked(fetchImpl).mock.calls.some(([url]) => String(url).endsWith('/prompt'))).toBe(false);
  });

  it('does not start a new process to resume history on an offline server', async () => {
    const spawnImpl = vi.fn();
    const fetchImpl = vi.fn(async () => {
      throw new Error('offline');
    }) as typeof fetch;
    await expect(
      engine(fetchImpl, { spawnImpl }).resume(profile, 'prompt-1', new AbortController().signal)
    ).rejects.toThrow('COMFY_RESUME_SERVER_UNAVAILABLE');
    expect(spawnImpl).not.toHaveBeenCalled();
  });

  it('blocks installs against busy or external healthy runtimes without stopping them', async () => {
    const spawnImpl = vi.fn();
    await expect(
      engine(fetchFixture({ '/queue': { queue_running: [[0, 'other-job']], queue_pending: [] } }), {
        spawnImpl,
      }).assertInstallable(profile)
    ).rejects.toThrow('COMFY_RUNTIME_BUSY');
    await expect(engine(fetchFixture(), { spawnImpl }).assertInstallable(profile)).rejects.toThrow(
      'COMFY_EXTERNAL_RUNTIME_RUNNING'
    );
    expect(spawnImpl).not.toHaveBeenCalled();
    const offline = engine(
      vi.fn(async () => {
        throw new Error('offline');
      }) as typeof fetch
    );
    await expect(offline.assertInstallable(profile)).resolves.toBeUndefined();
  });

  it('confirms custom node HEAD against the pinned revision and records actual runtime versions', async () => {
    const nodeRoot = path.join(root, 'custom_nodes', 'versioned-node');
    fs.mkdirSync(path.join(nodeRoot, '.git', 'refs', 'tags'), { recursive: true });
    fs.writeFileSync(path.join(nodeRoot, '.git', 'HEAD'), 'abcdef1234567890abcdef1234567890abcdef1234');
    fs.writeFileSync(path.join(nodeRoot, '.git', 'refs', 'tags', 'v1.0'), 'abcdef1234567890abcdef1234567890abcdef1234');
    profile.nodes = [{ id: 'versioned-node', version: 'v1.0' }];
    const result = await engine().validate(profile);
    expect(result.runtime).toMatchObject({
      python: '3.12.9',
      packages: { torch: '2.9.0' },
      nodeRevisions: { 'versioned-node': 'abcdef1234567890abcdef1234567890abcdef1234' },
    });
    fs.writeFileSync(path.join(nodeRoot, '.git', 'HEAD'), 'ffffef1234567890abcdef1234567890abcdef1234');
    await expect(engine().validate(profile)).rejects.toThrow('COMFY_NODE_REVISION_MISMATCH');
    fs.rmSync(path.join(nodeRoot, '.git'), { recursive: true });
    await expect(engine().validate(profile)).rejects.toThrow('COMFY_NODE_REVISION_UNCONFIRMED');
  });

  it('checks portable core version from the target version file and never treats ComfyUI as a custom node folder', async () => {
    profile.nodes = [{ id: 'comfyui-core', version: 'v0.3.60' }];
    fs.writeFileSync(path.join(root, 'comfyui_version.py'), '__version__ = "0.3.60"');
    await expect(engine().validate(profile)).resolves.toMatchObject({
      runtime: { nodeRevisions: { 'comfyui-core': '0.3.60' } },
    });
    fs.writeFileSync(path.join(root, 'comfyui_version.py'), '__version__ = "0.3.61"');
    await expect(engine().validate(profile)).rejects.toThrow('COMFY_NODE_REVISION_MISMATCH');
  });

  it('waits for its owned process to exit before completing an installation shutdown', async () => {
    let online = false;
    const child = Object.assign(new EventEmitter(), {
      kill: vi.fn(() => true),
      exitCode: null,
      stdout: null,
      stderr: null,
      pid: 42,
    });
    let childExited = false;
    const runtime = engine(
      vi.fn(async () => {
        if (!online) throw new Error('offline');
        return Response.json(stats);
      }) as typeof fetch,
      {
        spawnImpl: vi.fn(() => {
          online = true;
          return child;
        }),
        sleep: async () => {
          childExited = true;
          child.emit('exit', 0);
        },
      }
    );
    await runtime.ensureStarted(profile);
    await runtime.stopOwned(profile);
    expect(childExited).toBe(true);
  });

  it('rejects explicit settings that the selected workflow cannot bind', async () => {
    const fetchImpl = fetchFixture();
    await expect(
      engine(fetchImpl).generate(profile, { prompt: 'small', width: 256 }, new AbortController().signal)
    ).rejects.toThrow('COMFY_INPUT_UNSUPPORTED:width');
    expect(vi.mocked(fetchImpl).mock.calls.some(([url]) => String(url).endsWith('/prompt'))).toBe(false);
  });

  it('checks that known model loader roles resolve the exact profiled file under the selected model directory', async () => {
    profile.components[0].path = path.join(root, 'models', 'diffusion_models', 'valid.safetensors');
    fs.mkdirSync(path.dirname(profile.components[0].path), { recursive: true });
    fs.writeFileSync(profile.components[0].path, 'weights');
    const graph = JSON.parse(fs.readFileSync(profile.workflowPath, 'utf8'));
    graph['2'] = { class_type: 'UNETLoader', inputs: { unet_name: 'other.safetensors', weight_dtype: 'default' } };
    fs.writeFileSync(profile.workflowPath, JSON.stringify(graph));
    const loaderRegistry = {
      ...registry,
      UNETLoader: {
        input: { required: { unet_name: [['valid.safetensors', 'other.safetensors']], weight_dtype: [['default']] } },
        output: ['MODEL'],
      },
    };
    await expect(engine(fetchFixture({ '/object_info': loaderRegistry })).validate(profile)).rejects.toThrow(
      'COMFY_PROFILE_MODEL_BINDING_MISMATCH'
    );
    graph['2'].inputs.unet_name = 'valid.safetensors';
    fs.writeFileSync(profile.workflowPath, JSON.stringify(graph));
    await expect(engine(fetchFixture({ '/object_info': loaderRegistry })).validate(profile)).resolves.toMatchObject({
      loadable: true,
    });
  });

  it('uses the explicitly configured models directory for profiled loaders', async () => {
    const models = path.join(root, 'shared-models');
    profile.environment.launchArgs = ['--models-directory', models];
    profile.components[0].path = path.join(models, 'diffusion_models', 'valid.safetensors');
    fs.mkdirSync(path.dirname(profile.components[0].path), { recursive: true });
    fs.writeFileSync(profile.components[0].path, 'weights');
    const graph = JSON.parse(fs.readFileSync(profile.workflowPath, 'utf8'));
    graph['2'] = { class_type: 'UNETLoader', inputs: { unet_name: 'valid.safetensors', weight_dtype: 'default' } };
    fs.writeFileSync(profile.workflowPath, JSON.stringify(graph));
    const loaderRegistry = {
      ...registry,
      UNETLoader: {
        input: { required: { unet_name: [['valid.safetensors']], weight_dtype: [['default']] } },
        output: ['MODEL'],
      },
    };
    await expect(engine(fetchFixture({ '/object_info': loaderRegistry })).validate(profile)).resolves.toMatchObject({
      loadable: true,
    });
  });
});
