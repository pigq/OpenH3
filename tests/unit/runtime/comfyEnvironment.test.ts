import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  discoverComfyEnvironmentCandidates,
  probeComfyEnvironment,
  readPythonRuntime,
  readComfyHardwareIdentity,
} from '@/process/services/media/comfy/discovery/environment';

const roots: string[] = [];
function temporaryRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'comfy-environment-'));
  roots.push(root);
  return root;
}
afterEach(() => roots.splice(0).forEach((root) => fs.rmSync(root, { recursive: true, force: true })));

describe('generic ComfyUI environment probe', () => {
  it('discovers configured and known ComfyUI roots with bounded shallow scanning', () => {
    const parent = temporaryRoot();
    const configured = path.join(parent, 'recent-install');
    const known = path.join(parent, 'known-install');
    fs.mkdirSync(path.join(configured, '.venv', 'Scripts'), { recursive: true });
    fs.writeFileSync(path.join(configured, 'main.py'), '');
    fs.writeFileSync(path.join(configured, '.venv', 'Scripts', 'python.exe'), '');
    fs.mkdirSync(known, { recursive: true });
    fs.writeFileSync(path.join(known, 'main.py'), '');
    // A directory that merely contains a model must not be treated as ComfyUI.
    fs.mkdirSync(path.join(parent, 'not-comfy', 'models'), { recursive: true });

    const result = discoverComfyEnvironmentCandidates({
      roots: [configured],
      knownRoots: [known, path.join(parent, 'not-comfy')],
      homeDirectory: parent,
      environment: {},
      platform: 'linux',
      maxCandidates: 8,
    });
    expect(result).toEqual([
      expect.objectContaining({
        root: configured,
        reason: 'recent-path',
        python: path.join(configured, '.venv', 'Scripts', 'python.exe'),
      }),
      expect.objectContaining({ root: known, reason: 'known-path' }),
    ]);
  });

  it('recognizes a ComfyUI checkout nested under a known launcher directory', () => {
    const parent = temporaryRoot();
    const launcher = path.join(parent, 'portable');
    const root = path.join(launcher, 'ComfyUI');
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, 'main.py'), '');
    expect(discoverComfyEnvironmentCandidates({ roots: [launcher], maxCandidates: 1 })).toEqual([
      expect.objectContaining({ root, reason: 'recent-path' }),
    ]);
  });

  it('reads stable driver hardware identity without scanning Python, nodes, RAM or free GPU memory', async () => {
    const runCommand = vi.fn(async (file: string) => {
      if (file === 'nvidia-smi') return '0, NVIDIA RTX 5080, 16376, 15100, 581.42, 12.0';
      throw new Error('unexpected probe');
    });
    const identity = await readComfyHardwareIdentity({
      accelerator: 'cuda',
      runCommand,
      platform: 'win32',
      arch: 'x64',
    });
    expect(identity).toMatchObject({ os: 'win32', arch: 'x64', gpus: [{ driver: '581.42', name: 'NVIDIA RTX 5080' }] });
    expect(identity.gpus[0]).not.toHaveProperty('freeMemoryBytes');
    expect(runCommand).toHaveBeenCalledTimes(1);
  });
  it('reports machine GPU and target interpreter acceleration independently without installing or starting anything', async () => {
    const root = temporaryRoot();
    fs.writeFileSync(path.join(root, 'main.py'), '');
    fs.mkdirSync(path.join(root, 'custom_nodes', 'example'), { recursive: true });
    const python = path.join(root, 'python.exe');
    fs.writeFileSync(python, '');
    const runCommand = vi.fn(async (file: string, args: string[]) => {
      if (file === 'nvidia-smi') return '0, NVIDIA RTX 5080, 16376, 15100, 581.42, 12.0';
      if (file === 'git') return 'abcd1234';
      if (file === python && args[0] === '-c')
        return JSON.stringify({
          executable: python,
          version: '3.12.9',
          packages: { torch: '2.9.0+cpu' },
          torch: { version: '2.9.0+cpu', cudaAvailable: false, mpsAvailable: false, devices: [] },
        });
      throw new Error('unavailable');
    });
    const result = await probeComfyEnvironment({
      root,
      python,
      baseUrl: 'http://127.0.0.1:8188',
      runCommand,
      fetchImpl: vi.fn(async () => {
        throw new Error('offline');
      }) as typeof fetch,
    });
    expect(result.machine.gpus[0]).toMatchObject({
      vendor: 'nvidia',
      name: 'NVIDIA RTX 5080',
      computeCapability: '12.0',
    });
    expect(result.runtime).toMatchObject({
      status: 'available',
      executable: python,
      accelerator: 'cpu',
      torchVersion: '2.9.0+cpu',
    });
    expect(result.comfy).toMatchObject({ root, status: 'installed', revision: 'abcd1234', service: 'offline' });
    expect(result.comfy.customNodes).toContainEqual(expect.objectContaining({ name: 'example' }));
    expect(runCommand.mock.calls.every(([, args]) => !args.includes('install'))).toBe(true);
  });

  it('keeps absent Python, ComfyUI, and hardware probes explicit instead of claiming CUDA availability', async () => {
    const root = temporaryRoot();
    const result = await probeComfyEnvironment({
      root,
      python: path.join(root, 'missing.exe'),
      runCommand: async () => {
        throw new Error('not found');
      },
      fetchImpl: vi.fn(async () => {
        throw new Error('offline');
      }) as typeof fetch,
    });
    expect(result.runtime.status).toBe('missing');
    expect(result.comfy.status).toBe('missing');
    expect(result.machine.gpuStatus).toBe('unknown');
    expect(result.issues).toEqual(
      expect.arrayContaining(['PYTHON_MISSING', 'COMFYUI_MISSING', 'GPU_PROBE_UNAVAILABLE'])
    );
  });

  it('uses the selected Python and tolerates diagnostic text preceding the JSON record', async () => {
    const root = temporaryRoot();
    const python = path.join(root, 'python');
    fs.writeFileSync(python, '');
    const runCommand = vi.fn(
      async () =>
        'torch warning\n' +
        JSON.stringify({
          executable: python,
          version: '3.11.5',
          packages: { torch: '2.8.0' },
          torch: {
            version: '2.8.0',
            hipVersion: '6.4',
            cudaAvailable: true,
            mpsAvailable: false,
            devices: [{ name: 'AMD Radeon', totalMemoryBytes: 24 * 2 ** 30 }],
          },
        })
    );
    const result = await readPythonRuntime(python, { runCommand });
    expect(result.accelerator).toBe('rocm');
    expect(result.executable).toBe(python);
    expect(runCommand).toHaveBeenCalledWith(
      python,
      expect.arrayContaining(['-c']),
      expect.objectContaining({ windowsHide: true })
    );
  });

  it('reports optional ROCm GPU memory and driver details when its read-only probe is available', async () => {
    const result = await probeComfyEnvironment({
      runCommand: async (file) => {
        if (file === 'rocm-smi')
          return JSON.stringify({
            card0: {
              'Card series': 'AMD Radeon RX 7900 XTX',
              'VRAM Total Memory (B)': '25753026560',
              'VRAM Total Used Memory (B)': '1073741824',
              'Driver version': '6.4.1',
            },
          });
        throw new Error('not installed');
      },
    });
    expect(result.machine.gpus[0]).toMatchObject({
      vendor: 'amd',
      name: 'AMD Radeon RX 7900 XTX',
      totalMemoryBytes: 25753026560,
      freeMemoryBytes: 24679284736,
      driver: '6.4.1',
    });
  });

  it('probes exact candidate sources without downloading them and reports Range support', async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'HEAD')
        return new Response(null, {
          status: 200,
          headers: { 'content-length': '42', 'accept-ranges': 'bytes' },
        });
      throw new Error('range probe should not run when HEAD advertises support');
    }) as typeof fetch;
    const result = await probeComfyEnvironment({
      sources: ['https://modelscope.cn/models/example/resolve/abc/model.safetensors?token=secret'],
      runCommand: async () => {
        throw new Error('not installed');
      },
      fetchImpl,
    });
    expect(result.network.requested).toBe(true);
    expect(result.network.sources).toEqual([
      expect.objectContaining({
        host: 'modelscope.cn',
        status: 'reachable',
        contentLengthBytes: 42,
        range: 'supported',
        url: 'https://modelscope.cn/models/example/resolve/abc/model.safetensors',
      }),
    ]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('keeps invalid or unreachable source evidence explicit', async () => {
    const result = await probeComfyEnvironment({
      sources: [
        'file:///private/model.safetensors?token=must-not-leak',
        'https://hf-mirror.com/models/example/model.safetensors',
        'not-a-valid-url?token=must-not-leak',
      ],
      runCommand: async () => {
        throw new Error('not installed');
      },
      fetchImpl: vi.fn(async () => {
        throw new Error('dns failed');
      }) as typeof fetch,
    });
    expect(result.issues).toContain('NETWORK_SOURCES_UNREACHABLE');
    expect(result.network.sources).toEqual([
      expect.objectContaining({ status: 'invalid', error: 'NETWORK_SOURCE_URL_UNSUPPORTED' }),
      expect.objectContaining({ status: 'unreachable', range: 'unknown' }),
      expect.objectContaining({ status: 'invalid', url: 'not-a-valid-url' }),
    ]);
    expect(JSON.stringify(result.network)).not.toContain('must-not-leak');
  });

  it('rejects non-HTTPS, untrusted, and private network sources before making a request', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 })) as typeof fetch;
    const result = await probeComfyEnvironment({
      sources: [
        'http://modelscope.cn/models/example/model.safetensors',
        'https://evil.example/model.safetensors?token=must-not-leak',
        'https://127.0.0.1:8443/model.safetensors',
        'https://localhost.modelscope.cn/models/example/model.safetensors',
        'https://modelscope.cn:444/model.safetensors',
      ],
      runCommand: async () => {
        throw new Error('not installed');
      },
      fetchImpl,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result.network.sources).toEqual([
      expect.objectContaining({ status: 'invalid', error: 'NETWORK_SOURCE_URL_UNSUPPORTED' }),
      expect.objectContaining({ status: 'invalid', error: 'NETWORK_SOURCE_HOST_UNTRUSTED' }),
      expect.objectContaining({ status: 'invalid', error: 'NETWORK_SOURCE_HOST_UNTRUSTED' }),
      expect.objectContaining({ status: 'invalid', error: 'NETWORK_SOURCE_HOST_UNTRUSTED' }),
      expect.objectContaining({ status: 'invalid', error: 'NETWORK_SOURCE_URL_UNSUPPORTED' }),
    ]);
    expect(JSON.stringify(result.network)).not.toContain('must-not-leak');
  });

  it('validates every redirect target and does not follow a redirect into a private or untrusted host', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(null, {
          status: 302,
          headers: { location: 'https://127.0.0.1:8443/private/model.safetensors?token=secret' },
        })
    ) as typeof fetch;
    const result = await probeComfyEnvironment({
      sources: ['https://modelscope.cn/models/example/model.safetensors'],
      runCommand: async () => {
        throw new Error('not installed');
      },
      fetchImpl,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result.network.sources).toEqual([
      expect.objectContaining({
        host: 'modelscope.cn',
        status: 'unreachable',
        error: 'NETWORK_SOURCE_HOST_UNTRUSTED',
      }),
    ]);
    expect(result.network.sources[0]).not.toHaveProperty('finalUrl');
  });

  it('follows only trusted redirects and redacts signed query strings from evidence', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: { location: 'https://hf-mirror.com/models/example/model.safetensors?token=secret' },
        })
      )
      .mockResolvedValueOnce(
        new Response(null, {
          status: 200,
          headers: { 'content-length': '42', 'accept-ranges': 'bytes' },
        })
      ) as unknown as typeof fetch;
    const result = await probeComfyEnvironment({
      sources: ['https://modelscope.cn/models/example/model.safetensors'],
      runCommand: async () => {
        throw new Error('not installed');
      },
      fetchImpl,
    });
    expect(result.network.sources).toEqual([
      expect.objectContaining({
        status: 'reachable',
        finalUrl: 'https://hf-mirror.com/models/example/model.safetensors',
        url: 'https://modelscope.cn/models/example/model.safetensors',
      }),
    ]);
    expect(JSON.stringify(result.network)).not.toContain('secret');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls.every(([, init]) => init?.redirect === 'manual')).toBe(true);
  });

  it('fails the source when the Range probe redirects to a private host', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 200, headers: { 'content-length': '42' } }))
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: { location: 'https://localhost:8188/model.safetensors' },
        })
      ) as unknown as typeof fetch;
    const result = await probeComfyEnvironment({
      sources: ['https://pypi.tuna.tsinghua.edu.cn/packages/example.whl'],
      runCommand: async () => {
        throw new Error('not installed');
      },
      fetchImpl,
    });
    expect(result.network.sources).toEqual([
      expect.objectContaining({ status: 'unreachable', error: 'NETWORK_SOURCE_HOST_UNTRUSTED' }),
    ]);
  });
});
