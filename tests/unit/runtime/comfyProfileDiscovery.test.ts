import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type http from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createComfyProfileDiscovery } from '@/process/services/media/comfy/discovery';
import { comfyFamilySchema, type ComfyProfile } from '@/common/chat/document/creation/comfy';
import { loadComfyInstallCatalog } from '@/process/services/media/comfy/planning/catalog';
import { ComfyService } from '@/process/services/media/comfy/ComfyService';
import { handleComfyRoute } from '@/process/services/media/comfy/routes';

let temporary: string;
let root: string;
let python: string;
beforeEach(() => {
  temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'comfy-discovery-'));
  root = path.join(temporary, 'ComfyUI');
  python = path.join(root, '.venv', 'Scripts', 'python.exe');
  fs.mkdirSync(path.dirname(python), { recursive: true });
  fs.writeFileSync(python, 'python');
  fs.writeFileSync(path.join(root, 'main.py'), 'comfy');
});
afterEach(() => fs.rmSync(temporary, { recursive: true, force: true }));

function catalog() {
  const graph = { '1': { class_type: 'SaveImage', inputs: { text: 'smoke' } } };
  const graphSha256 = crypto
    .createHash('sha256')
    .update(`${JSON.stringify(graph, null, 2)}\n`)
    .digest('hex');
  const candidates = comfyFamilySchema.options.map((family) => ({
    id: `${family}-bf16-discovery`,
    family,
    quantization: 'BF16',
    workflow: { revision: 'abcdef0123456789' },
    components: [
      {
        role: 'diffusion',
        name: `${family}.safetensors`,
        directory: 'diffusion_models',
        revision: 'abcdef0123456789',
        precision: 'BF16',
        sizeBytes: 4,
        sha256: 'a'.repeat(64),
      },
    ],
  }));
  const baselines = candidates.map((candidate) => ({
    id: `${candidate.id}-api`,
    candidateId: candidate.id,
    graph,
    graphSha256,
    capabilities: [
      candidate.family === 'h3' || candidate.family === 'fasth3-omni' ? 'reference-to-video' : 'text-to-image',
    ],
    requiredNodes: [{ id: 'comfyui-core', version: 'abcdef0123456789' }],
    bindings: { prompt: [{ nodeId: '1', input: 'text' }] },
    defaults: { seed: 42 },
  }));
  return { candidates, baselines };
}
function writeModels() {
  const directory = path.join(root, 'models', 'diffusion_models');
  fs.mkdirSync(directory, { recursive: true });
  for (const family of comfyFamilySchema.options)
    fs.writeFileSync(path.join(directory, `${family}.safetensors`), 'data');
}
function setup(overrides: Partial<Parameters<typeof createComfyProfileDiscovery>[0]> = {}) {
  return createComfyProfileDiscovery({
    cacheFile: path.join(temporary, 'cache.json'),
    workflowDirectory: path.join(temporary, 'workflows'),
    roots: () => [root],
    loadCatalog: catalog,
    fetchImpl: vi.fn(async () => {
      throw new Error('offline');
    }) as typeof fetch,
    ...overrides,
  });
}

describe('incremental local Comfy profile discovery', () => {
  it('constructs profiles for the shipped Qwen, Z-Image, Omni, FLUX, MOSS and Krea baselines', async () => {
    const shipped = loadComfyInstallCatalog(path.resolve('resources'));
    const candidates = shipped.candidates.map((candidate) => ({
      ...candidate,
      components: (candidate.components as Array<Record<string, unknown>>).map((component) => ({
        ...component,
        sizeBytes: 4,
      })),
    }));
    for (const candidate of candidates) {
      for (const component of candidate.components) {
        if (typeof component.name !== 'string' || typeof component.directory !== 'string') continue;
        const file = path.join(root, 'models', component.directory, component.name);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, 'data');
      }
    }
    const profiles = await setup({ loadCatalog: () => ({ candidates, baselines: shipped.baselines }) })([]);
    expect(profiles).toHaveLength(shipped.baselines.length);
    expect(new Set(profiles.map((profile) => profile.family))).toEqual(
      new Set(comfyFamilySchema.options.filter((family) => family !== 'h3'))
    );
    expect(profiles.every((profile) => profile.state === 'downloaded')).toBe(true);
  });

  it('exposes discovered profiles through the real profiles HTTP route without starting or generating', async () => {
    writeModels();
    const generate = vi.fn();
    const ensureStarted = vi.fn();
    const service = new ComfyService({
      filename: path.join(temporary, 'service.json'),
      discover: setup(),
      install: vi.fn(),
      engine: {
        validate: vi.fn(),
        snapshotFingerprint: vi.fn(),
        generate,
        ensureStarted,
        resume: vi.fn(),
        cancel: vi.fn(),
        stopOwned: vi.fn(),
      },
    });
    const json = vi.fn();
    await handleComfyRoute(
      { method: 'GET', headers: {} } as http.IncomingMessage,
      {} as http.ServerResponse,
      new URL('http://127.0.0.1/api/comfy/profiles'),
      { service, json, body: vi.fn() }
    );
    expect(json).toHaveBeenCalledWith(
      expect.anything(),
      200,
      expect.arrayContaining([expect.objectContaining({ family: 'qwen-edit', state: 'downloaded' })])
    );
    expect(service.profiles()).toHaveLength(comfyFamilySchema.options.length);
    expect(generate).not.toHaveBeenCalled();
    expect(ensureStarted).not.toHaveBeenCalled();
    await service.close();
  });

  it('discovers every model family from complete fixed sets without marking any verified', async () => {
    writeModels();
    const discovered = await setup()([]);
    expect(discovered.map((profile) => profile.family).toSorted()).toEqual([...comfyFamilySchema.options].toSorted());
    expect(discovered.every((profile) => profile.state === 'downloaded' && !profile.validation?.promptId)).toBe(true);
    for (const profile of discovered) {
      expect(profile.environment.root).toBe(root);
      expect(profile.environment.python).toBe(python);
      expect(profile.workflowPath.startsWith(path.join(temporary, 'workflows'))).toBe(true);
      expect(crypto.createHash('sha256').update(fs.readFileSync(profile.workflowPath)).digest('hex')).toBe(
        profile.workflowSha256
      );
    }
  });

  it('uses cached file metadata and notices a changed or missing component after restart', async () => {
    writeModels();
    const discover = setup();
    const initial = await discover([]);
    const cacheTime = fs.statSync(path.join(temporary, 'cache.json')).mtimeMs;
    const workflowTimes = initial.map((profile) => fs.statSync(profile.workflowPath).mtimeMs);
    expect(await discover([])).toEqual(initial);
    expect(fs.statSync(path.join(temporary, 'cache.json')).mtimeMs).toBe(cacheTime);
    expect(initial.map((profile) => fs.statSync(profile.workflowPath).mtimeMs)).toEqual(workflowTimes);
    fs.writeFileSync(path.join(root, 'models', 'diffusion_models', 'qwen-edit.safetensors'), 'partial');
    fs.rmSync(path.join(root, 'models', 'diffusion_models', 'z-image.safetensors'));
    const restarted = await setup()([]);
    expect(restarted.some((profile) => profile.family === 'qwen-edit' || profile.family === 'z-image')).toBe(false);
    expect(restarted).toHaveLength(initial.length - 2);
  });

  it('assigns a new unverified identity when models move to configured external paths', async () => {
    writeModels();
    const discover = setup();
    const before = await discover([]);
    const prior = { ...before.find((profile) => profile.family === 'qwen-edit')!, state: 'verified' as const };
    const external = path.join(temporary, 'moved-models');
    fs.renameSync(path.join(root, 'models'), external);
    fs.writeFileSync(
      path.join(root, 'extra_model_paths.yaml'),
      `moved:\n  base_path: ${JSON.stringify(external)}\n  diffusion_models: diffusion_models\n`
    );

    const after = await discover([prior]);
    const moved = after.find((profile) => profile.family === 'qwen-edit')!;
    expect(moved.id).not.toBe(prior.id);
    expect(moved.state).toBe('downloaded');
    expect(moved.components[0].path).toBe(path.join(external, 'diffusion_models', 'qwen-edit.safetensors'));
    expect(prior.state).toBe('verified');
    expect(prior.components[0].path).toBe(path.join(root, 'models', 'diffusion_models', 'qwen-edit.safetensors'));
    const service = new ComfyService({
      filename: path.join(temporary, 'identity-service.json'),
      install: vi.fn(),
      engine: {
        validate: vi.fn(),
        snapshotFingerprint: vi.fn(),
        generate: vi.fn(),
        ensureStarted: vi.fn(),
        resume: vi.fn(),
        cancel: vi.fn(),
        stopOwned: vi.fn(),
      },
    });
    service.register(prior);
    expect(() => service.register(moved)).not.toThrow();
    expect(service.profiles()).toHaveLength(2);
    await service.close();
  });

  it('keeps registered profiles and external model-directory selection without duplicate discovery', async () => {
    writeModels();
    const [registered] = await setup()([]);
    const externalModels = path.join(temporary, 'shared-models');
    fs.renameSync(path.join(root, 'models'), externalModels);
    const verified: ComfyProfile = {
      ...registered,
      state: 'verified',
      environment: {
        ...registered.environment,
        baseUrl: 'http://127.0.0.1:9999',
        launchArgs: ['--models-directory', externalModels],
      },
      components: registered.components.map((component) => ({
        ...component,
        path: path.join(externalModels, 'diffusion_models', component.name),
      })),
    };
    const result = await setup()([verified]);
    expect(result.some((profile) => profile.family === verified.family)).toBe(false);
    expect(result).toHaveLength(comfyFamilySchema.options.length - 1);
    expect(result.every((profile) => profile.environment.baseUrl === verified.environment.baseUrl)).toBe(true);
    expect(verified.state).toBe('verified');
  });

  it('discovers a running local instance once per interval and never probes remote addresses', async () => {
    writeModels();
    let time = 1000;
    const fetchImpl = vi.fn(async () =>
      Response.json({ system: { python_executable: python, comfyui_root: root } })
    ) as unknown as typeof fetch;
    const inspectIdentity = vi.fn(async () => ({ executable: python, root }));
    const discover = setup({
      roots: () => [],
      now: () => time,
      fetchImpl,
      inspectIdentity,
      endpoints: () => ['https://example.com:8188', 'http://127.0.0.1:8765'],
    });
    const result = await discover([]);
    expect(result).toHaveLength(comfyFamilySchema.options.length);
    expect(result.every((profile) => profile.environment.baseUrl === 'http://127.0.0.1:8765')).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(inspectIdentity).toHaveBeenCalledTimes(2);
    await discover([]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    time += 30_001;
    await discover([]);
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it('returns one shared scan for overlapping profile refreshes and rejects an altered packaged graph', async () => {
    writeModels();
    const loadCatalog = vi.fn(() => {
      const value = catalog();
      value.baselines[0].graphSha256 = '0'.repeat(64);
      return value;
    });
    const discover = setup({ loadCatalog });
    const first = discover([]);
    expect(discover([])).toBe(first);
    const result = await first;
    expect(loadCatalog).toHaveBeenCalledTimes(1);
    expect(result).toHaveLength(comfyFamilySchema.options.length - 1);
  });

  it('finds catalog basenames in shallow subfolders and explicit extra model paths without disk-wide traversal', async () => {
    const external = path.join(temporary, 'external');
    const nested = path.join(root, 'models', 'diffusion_models', 'model-family');
    fs.mkdirSync(external, { recursive: true });
    fs.mkdirSync(nested, { recursive: true });
    fs.writeFileSync(path.join(nested, 'qwen-edit.safetensors'), 'data');
    fs.writeFileSync(path.join(external, 'moss-image-sft.safetensors'), 'data');
    fs.writeFileSync(
      path.join(root, 'extra_model_paths.yaml'),
      `shared:\n  base_path: ${JSON.stringify(external)}\n  diffusion_models: .\n`
    );
    const profiles = await setup()([]);
    expect(profiles.map((profile) => profile.family).toSorted()).toEqual(['moss-image-sft', 'qwen-edit']);
    expect(profiles.find((profile) => profile.family === 'moss-image-sft')?.components[0].path).toBe(
      path.join(external, 'moss-image-sft.safetensors')
    );

    const deep = path.join(nested, 'too', 'deep');
    fs.mkdirSync(deep, { recursive: true });
    fs.writeFileSync(path.join(deep, 'z-image.safetensors'), 'data');
    expect((await setup()([])).some((profile) => profile.family === 'z-image')).toBe(false);
  });

  it('does not follow directory links encountered inside a configured model tree', async () => {
    const outside = path.join(temporary, 'outside');
    const directory = path.join(root, 'models', 'diffusion_models');
    fs.mkdirSync(outside, { recursive: true });
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(outside, 'z-image.safetensors'), 'data');
    fs.symlinkSync(outside, path.join(directory, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
    expect(await setup()([])).toEqual([]);
  });
});
