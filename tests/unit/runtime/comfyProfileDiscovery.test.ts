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
  it('keeps complete internal weights when an external duplicate is only partially downloaded', async () => {
    fs.writeFileSync(path.join(root, 'folder_paths.py'), '# source');
    fs.mkdirSync(path.join(root, 'comfy'));
    const internal = path.join(root, 'models', 'diffusion_models', 'nested');
    const external = path.join(temporary, 'external');
    fs.mkdirSync(internal, { recursive: true });
    fs.mkdirSync(external);
    fs.writeFileSync(path.join(internal, 'moss-image-sft.safetensors'), 'data');
    const discover = setup({ roots: () => [], applicationRoots: () => [root] });
    expect((await discover([])).some((profile) => profile.family === 'moss-image-sft')).toBe(true);
    fs.writeFileSync(path.join(external, 'moss-image-sft.safetensors'), 'partial');
    fs.writeFileSync(
      path.join(root, 'extra_model_paths.yaml'),
      `extra:\n  base_path: ${JSON.stringify(external)}\n  diffusion_models: .\n`
    );
    const profiles = await discover([]);
    expect(profiles.some((profile) => profile.family === 'moss-image-sft')).toBe(true);
    expect(profiles[0].components[0].path).toBe(path.join(internal, 'moss-image-sft.safetensors'));
  });

  it('isolates invalid extra model paths in one checkout from another valid checkout', async () => {
    writeModels();
    fs.writeFileSync(path.join(root, 'folder_paths.py'), '# source');
    fs.mkdirSync(path.join(root, 'comfy'));
    const bad = path.join(temporary, 'broken-config');
    fs.mkdirSync(path.join(bad, '.venv', 'Scripts'), { recursive: true });
    fs.mkdirSync(path.join(bad, 'comfy'));
    fs.writeFileSync(path.join(bad, 'main.py'), '# source');
    fs.writeFileSync(path.join(bad, 'folder_paths.py'), '# source');
    fs.writeFileSync(path.join(bad, '.venv', 'Scripts', 'python.exe'), 'python');
    fs.writeFileSync(path.join(bad, 'extra_model_paths.yaml'), '{invalid');
    const discover = setup({ roots: () => [], applicationRoots: () => [temporary] });
    const profiles = await discover([]);
    expect(profiles.some((profile) => profile.family === 'moss-image-sft' && profile.environment.root === root)).toBe(
      true
    );
    expect(discover.diagnostics()).toContainEqual({ code: 'COMFY_INVENTORY_MODEL_PATHS_INCOMPLETE', path: bad });
  });
  it('keeps a complete MOSS environment visible beside an unrelated checkout without Python', async () => {
    writeModels();
    fs.writeFileSync(path.join(root, 'folder_paths.py'), '# paths');
    fs.mkdirSync(path.join(root, 'comfy'));
    const broken = path.join(temporary, 'old-incomplete-checkout');
    fs.mkdirSync(path.join(broken, 'comfy'), { recursive: true });
    fs.writeFileSync(path.join(broken, 'main.py'), '# ComfyUI');
    fs.writeFileSync(path.join(broken, 'folder_paths.py'), '# paths');
    const discover = setup({ roots: () => [], applicationRoots: () => [temporary] });
    const profiles = await discover([]);
    expect(profiles.some((profile) => profile.family === 'moss-image-sft' && profile.environment.root === root)).toBe(
      true
    );
    expect(profiles.every((profile) => profile.environment.root !== broken)).toBe(true);
    expect(discover.diagnostics()).toContainEqual(
      expect.objectContaining({ code: 'COMFY_INVENTORY_INTERPRETER_UNCONFIRMED', path: broken })
    );
  });
  it.each(comfyFamilySchema.options)(
    'finds complete %s files under deep arbitrarily named application task and weight directories',
    async (family) => {
      const application = path.join(temporary, 'OpenH3');
      const installed = path.join(application, 'aionui', 'projects', 'previous', 'tasks', 'generation', 'checkout');
      fs.mkdirSync(path.dirname(installed), { recursive: true });
      fs.renameSync(root, installed);
      fs.writeFileSync(path.join(installed, 'folder_paths.py'), '# ComfyUI source marker');
      fs.mkdirSync(path.join(installed, 'comfy'));
      const weights = path.join(
        installed,
        'models',
        'diffusion_models',
        'archives',
        '2026',
        'november',
        'moss',
        'bf16'
      );
      fs.mkdirSync(weights, { recursive: true });
      fs.writeFileSync(path.join(weights, `${family}.safetensors`), 'data');
      const create = () => setup({ roots: () => [], applicationRoots: () => [application] });
      const profiles = await create()([]);
      expect(profiles.map((profile) => profile.family)).toEqual([family]);
      expect(profiles[0].environment.root).toBe(installed);
      expect(profiles[0].state).toBe('downloaded');
      expect(await create()([])).toEqual(profiles);
    }
  );

  it('finds catalog model sets stored outside ComfyUI but under OpenH3 data', async () => {
    const application = path.join(temporary, 'OpenH3');
    const installed = path.join(application, 'aionui', 'moss-sft', 'ComfyUI-' + 'd'.repeat(40));
    fs.mkdirSync(path.join(installed, 'comfy'), { recursive: true });
    fs.writeFileSync(path.join(installed, 'main.py'), '# ComfyUI');
    fs.writeFileSync(path.join(installed, 'folder_paths.py'), '# source');
    fs.mkdirSync(path.join(installed, '.venv', 'Scripts'), { recursive: true });
    fs.writeFileSync(path.join(installed, '.venv', 'Scripts', 'python.exe'), 'python');
    const sharedModels = path.join(application, 'aionui', 'models', 'shared', 'moss-sft', 'bf16');
    fs.mkdirSync(sharedModels, { recursive: true });
    fs.writeFileSync(path.join(sharedModels, 'moss-image-sft.safetensors'), 'data');
    const profiles = await setup({ roots: () => [], applicationRoots: () => [application] })([]);
    expect(profiles.map((profile) => profile.family)).toEqual(['moss-image-sft']);
    expect(profiles[0].components[0].path).toBe(path.join(sharedModels, 'moss-image-sft.safetensors'));
  });

  it('finds catalog weights stored elsewhere under the same application-owned data root', async () => {
    const application = path.join(temporary, 'OpenH3');
    const installed = path.join(application, 'aionui', 'moss-sft', 'ComfyUI-' + 'd'.repeat(40));
    fs.mkdirSync(path.join(installed, 'comfy'), { recursive: true });
    fs.writeFileSync(path.join(installed, 'main.py'), '# ComfyUI');
    fs.writeFileSync(path.join(installed, 'folder_paths.py'), '# source');
    fs.mkdirSync(path.join(installed, '.venv', 'Scripts'), { recursive: true });
    fs.writeFileSync(path.join(installed, '.venv', 'Scripts', 'python.exe'), 'python');
    const sharedModels = path.join(application, 'aionui', 'models', 'shared', 'moss-sft', 'bf16');
    fs.mkdirSync(sharedModels, { recursive: true });
    fs.writeFileSync(path.join(sharedModels, 'moss-image-sft.safetensors'), 'data');
    const profiles = await setup({ roots: () => [], applicationRoots: () => [application] })([]);
    expect(profiles.map((profile) => profile.family)).toEqual(['moss-image-sft']);
    expect(profiles[0].components[0].path).toBe(path.join(sharedModels, 'moss-image-sft.safetensors'));
  });

  it('discovers and persists all application environments beyond the old candidate limit', async () => {
    const application = path.join(temporary, 'OpenH3');
    for (let i = 0; i < 40; i++) {
      const installed = path.join(application, `task-${String(i).padStart(2, '0')}`, 'runtime');
      fs.mkdirSync(path.join(installed, '.venv', 'Scripts'), { recursive: true });
      fs.writeFileSync(path.join(installed, 'main.py'), '# ComfyUI');
      fs.writeFileSync(path.join(installed, 'folder_paths.py'), '# source');
      fs.mkdirSync(path.join(installed, 'comfy'));
      fs.writeFileSync(path.join(installed, '.venv', 'Scripts', 'python.exe'), 'python');
      const models = path.join(installed, 'models', 'diffusion_models');
      fs.mkdirSync(models, { recursive: true });
      fs.writeFileSync(path.join(models, 'moss-image-sft.safetensors'), 'data');
    }
    const create = () => setup({ roots: () => [], applicationRoots: () => [application] });
    expect(await create()([])).toHaveLength(40);
    expect(Object.keys(JSON.parse(fs.readFileSync(path.join(temporary, 'cache.json'), 'utf8')).roots)).toHaveLength(40);
    expect(await create()([])).toHaveLength(40);
  }, 30_000);

  it('reports complete application model files with an unknown interpreter as incomplete inventory', async () => {
    const installed = path.join(temporary, 'OpenH3', 'task', 'checkout');
    fs.mkdirSync(path.join(installed, 'comfy'), { recursive: true });
    fs.writeFileSync(path.join(installed, 'main.py'), '# ComfyUI');
    fs.writeFileSync(path.join(installed, 'folder_paths.py'), '# paths');
    const models = path.join(installed, 'models', 'diffusion_models');
    fs.mkdirSync(models, { recursive: true });
    fs.writeFileSync(path.join(models, 'moss-image-sft.safetensors'), 'data');
    const discover = setup({ roots: () => [], applicationRoots: () => [path.join(temporary, 'OpenH3')] });
    expect(await discover([])).toEqual([]);
    expect(discover.diagnostics()).toContainEqual({ code: 'COMFY_INVENTORY_INTERPRETER_UNCONFIRMED', path: installed });
  });

  it('checks every configured model path within an application installation', async () => {
    fs.writeFileSync(path.join(root, 'folder_paths.py'), '# paths');
    fs.mkdirSync(path.join(root, 'comfy'));
    const group = path.join(temporary, 'shared');
    const folders = Array.from({ length: 20 }, (_, index) => `set-${index}`);
    fs.mkdirSync(path.join(group, folders[19]), { recursive: true });
    fs.writeFileSync(path.join(group, folders[19], 'moss-image-sft.safetensors'), 'data');
    fs.writeFileSync(
      path.join(root, 'extra_model_paths.yaml'),
      `shared:\n  base_path: ${JSON.stringify(group)}\n  diffusion_models: |\n${folders.map((folder) => `    ${folder}`).join('\n')}\n`
    );
    const profiles = await setup({ applicationRoots: () => [temporary] })([]);
    expect(profiles.some((profile) => profile.family === 'moss-image-sft')).toBe(true);
  });
  it('rediscovers an Agent-installed versioned checkout under application data after restart', async () => {
    writeModels();
    const parent = path.join(temporary, 'moss-sft');
    const installed = path.join(parent, 'ComfyUI-' + 'a'.repeat(40));
    fs.mkdirSync(parent);
    fs.renameSync(root, installed);
    fs.renameSync(path.join(installed, '.venv'), path.join(parent, '.venv'));
    const create = () => setup({ roots: () => [temporary] });
    for (const discover of [create(), create()]) {
      const profiles = await discover([]);
      expect(profiles.some((profile) => profile.family === 'moss-image-sft')).toBe(true);
      expect(profiles.every((profile) => profile.environment.root === installed)).toBe(true);
      expect(
        profiles.every((profile) => profile.environment.python === path.join(parent, '.venv', 'Scripts', 'python.exe'))
      ).toBe(true);
      expect(profiles.every((profile) => profile.state === 'downloaded')).toBe(true);
      expect(profiles.every((profile) => profile.environment.baseUrl !== 'http://127.0.0.1:8188')).toBe(true);
    }
  });

  it('does not follow linked task directories or inspect output trees for ComfyUI installations', async () => {
    const linked = path.join(temporary, 'linked-task');
    const hidden = path.join(temporary, 'output', 'ComfyUI-' + 'b'.repeat(40));
    fs.mkdirSync(hidden, { recursive: true });
    fs.writeFileSync(path.join(hidden, 'main.py'), 'not an installation');
    fs.symlinkSync(root, linked, process.platform === 'win32' ? 'junction' : 'dir');
    writeModels();
    const parent = path.join(temporary, 'application-data');
    fs.mkdirSync(parent);
    fs.symlinkSync(root, path.join(parent, 'linked-task'), process.platform === 'win32' ? 'junction' : 'dir');
    fs.renameSync(path.join(temporary, 'output'), path.join(parent, 'output'));
    expect(await setup({ roots: () => [parent] })([])).toEqual([]);
  });

  it('keeps a busy unrelated recent root from exhausting discovery of the application-data root', async () => {
    writeModels();
    const unrelated = path.join(temporary, 'unrelated');
    fs.mkdirSync(unrelated);
    for (let i = 0; i < 260; i++) fs.mkdirSync(path.join(unrelated, `folder-${i}`));
    const parent = path.join(temporary, 'app-data');
    const destination = path.join(parent, 'moss-sft', 'ComfyUI-' + 'c'.repeat(40));
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.renameSync(root, destination);
    const profiles = await setup({ roots: () => [unrelated, parent] })([]);
    expect(profiles.some((profile) => profile.family === 'moss-image-sft')).toBe(true);
  });
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

  it('uses the registered endpoint interpreter only to inspect its actual socket owner', async () => {
    writeModels();
    const [registered] = await setup()([]);
    const inspectIdentity = vi.fn(async () => ({ executable: python, root }));
    const discover = setup({
      fetchImpl: (async () => Response.json({ system: { python_version: '3.12' } })) as typeof fetch,
      inspectIdentity,
    });
    await discover([registered]);
    expect(inspectIdentity).toHaveBeenCalledWith(registered.environment.baseUrl, expect.any(Object), python);
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
