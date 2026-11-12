import fs from 'node:fs';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import type http from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ComfyProfile } from '@/common/chat/document/creation/comfy';
import type { LocalDeviceSnapshot } from '@/common/chat/document/creation/workflows/localModels';
import { comfyMemoryBudget } from '@/process/services/media/comfy/planning/hardwareSelection';
import { evaluateLocalModelCenter } from '@/process/services/media/comfy/planning/model-center/evaluator';
import { probeLocalDevice } from '@/process/services/media/comfy/discovery/environment';
import { createComfyProfileDiscovery } from '@/process/services/media/comfy/discovery/profileDiscovery';
import * as environment from '@/process/services/media/comfy/discovery/environment';
import { ComfyService } from '@/process/services/media/comfy/ComfyService';
import { handleComfyRoute } from '@/process/services/media/comfy/routes';
import type { CatalogRecord } from '@/process/services/media/comfy/planning/catalog';

const GB = 2 ** 30;
const temporary: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of temporary.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});
function root(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'local-center-'));
  temporary.push(directory);
  return directory;
}
function device(): LocalDeviceSnapshot {
  return {
    checkedAt: '2026-11-11T00:00:00Z',
    os: 'win32',
    osRelease: 'test',
    arch: 'x64',
    cpu: 'test',
    totalMemoryBytes: 16 * GB,
    freeMemoryBytes: 12 * GB,
    gpuStatus: 'available',
    installDirectory: 'C:\\models',
    disk: { path: 'C:\\', totalBytes: 1000 * GB, freeBytes: 500 * GB },
    gpus: [
      {
        name: 'RTX',
        vendor: 'nvidia',
        totalMemoryBytes: 12 * GB,
        freeMemoryBytes: 10 * GB,
        driver: '600',
        computeCapability: '8.9',
      },
    ],
  };
}
function candidate(id = 'image-model', bytes: number | undefined = 8 * GB): CatalogRecord {
  return {
    id,
    family: id,
    kind: 'image',
    quantization: 'BF16',
    apiBaselineId: `${id}-workflow`,
    components: [
      {
        name: 'weights',
        role: 'diffusion',
        precision: 'BF16',
        revision: 'fixed',
        sha256: 'a'.repeat(64),
        sizeBytes: bytes,
      },
    ],
  };
}
function evaluate(candidates: CatalogRecord[], profiles: ComfyProfile[] = [], hardware = device()) {
  return evaluateLocalModelCenter({
    device: hardware,
    inventory: { profiles, complete: true, diagnostics: [] },
    catalog: {
      root: '',
      candidates,
      baselines: candidates.map((item) => ({
        id: `${item.id}-workflow`,
        candidateId: item.id,
        graph: { '1': { class_type: 'SaveImage' } },
        capabilities: [
          item.kind === 'video' ? 'text-to-video' : item.family === 'editor' ? 'image-edit' : 'text-to-image',
        ],
      })),
    },
  });
}
function profile(directory: string): ComfyProfile {
  const file = path.join(directory, 'model.bin');
  fs.writeFileSync(file, 'abcd');
  const workflowPath = path.join(directory, 'workflow.json');
  fs.writeFileSync(workflowPath, '{}');
  return {
    id: 'custom',
    family: 'custom-family',
    name: 'Custom Image',
    kind: 'image',
    version: 'fixed',
    quantization: 'BF16',
    state: 'verified',
    capabilities: ['text-to-image'],
    environment: { root: directory, python: path.join(directory, 'python'), baseUrl: 'http://127.0.0.1:8188' },
    components: [
      {
        role: 'diffusion',
        name: 'model.bin',
        path: file,
        version: 'fixed',
        precision: 'BF16',
        sizeBytes: 4,
        sha256: 'a'.repeat(64),
      },
    ],
    nodes: [{ id: 'comfy', version: 'fixed' }],
    workflowPath,
    bindings: {},
    defaults: {},
    validation: {
      fingerprint: 'saved',
      checkedAt: '2026-11-11',
      promptId: 'test',
      artifacts: ['image.png'],
      runtime: {
        python: '3.12',
        packages: { torch: '2.9' },
        nodeRevisions: {},
        hardware: { os: 'win32', arch: 'x64', gpus: device().gpus },
      },
    },
  };
}

describe('local model center planning', () => {
  it('budgets complete weights once per GPU and never doubles unified memory', () => {
    const machine = { totalMemoryBytes: 8 * GB, freeMemoryBytes: 8 * GB };
    expect(
      comfyMemoryBudget([12 * GB], machine, { totalMemoryBytes: 4 * GB, freeMemoryBytes: 4 * GB })?.fitsTotal
    ).toBe(false);
    expect(
      comfyMemoryBudget([12 * GB], machine, { totalMemoryBytes: 8 * GB, freeMemoryBytes: 8 * GB, sharedMemory: true })
        ?.fitsTotal
    ).toBe(false);
    expect(comfyMemoryBudget([undefined, 4 * GB], machine, {})).toBeUndefined();
    const hardware = device();
    hardware.totalMemoryBytes = 8 * GB;
    hardware.gpus = [0, 1].map(() => ({ ...hardware.gpus[0], totalMemoryBytes: 4 * GB }));
    expect(evaluate([candidate('large', 12 * GB)], [], hardware).models[0].reasons).toContain('memory-insufficient');
  });

  it('treats runtime/native evidence as unknown and temporary occupation as a note', () => {
    const hardware = device();
    hardware.freeMemoryBytes = GB;
    hardware.gpus[0].freeMemoryBytes = 0;
    const result = evaluate([candidate()], [], hardware).models[0];
    expect(result.status).toBe('unknown');
    expect(result.reasons).toContain('temporary-memory-pressure');
    expect(result.reasons).not.toContain('memory-insufficient');
    expect(result.reasons).toContain('runtime-unverified');
    const native = candidate();
    native.quantization = 'INT8-ConvRot';
    expect(evaluate([native]).models[0]).toMatchObject({
      status: 'unknown',
      reasons: expect.arrayContaining(['native-kernel-unverified']),
    });
    const unknown = candidate();
    (unknown.components as CatalogRecord[])[0].sizeBytes = undefined;
    expect(evaluate([unknown]).models[0]).toMatchObject({
      totalBytes: undefined,
      downloadBytes: undefined,
      status: 'unknown',
    });
  });

  it('groups registered custom image and video workflows without losing verified priority', () => {
    const saved = profile(root());
    const video = {
      ...saved,
      id: 'video',
      family: 'custom-video',
      name: 'Video',
      kind: 'video' as const,
      capabilities: ['text-to-video'],
    };
    const result = evaluate([candidate()], [saved, { ...saved, id: 'other-workflow' }, video]);
    expect(result.models).toHaveLength(3);
    expect(result.models[0].status).toBe('verified');
    expect(result.models.find((item) => item.family === saved.family)?.profiles).toHaveLength(2);
    expect(result.models.find((item) => item.family === video.family)?.purposes).toEqual(['video']);
    const stale = structuredClone(saved);
    stale.id = 'aaa-stale';
    stale.validation!.runtime!.hardware!.os = 'linux';
    const current = evaluate([], [stale, saved]).models[0];
    expect(current.verifiedProfileId).toBe(saved.id);
    expect(current.profiles[0].id).toBe(saved.id);
    saved.validation!.runtime = {
      python: '3.12',
      packages: { torch: '2.9' },
      nodeRevisions: {},
      hardware: { os: 'linux' },
    };
    expect(evaluate([], [saved]).models[0].status).toBe('unknown');
    delete saved.validation!.runtime;
    expect(evaluate([], [saved]).models[0]).toMatchObject({ status: 'unknown', verifiedProfileId: undefined });
    expect(saved.state).toBe('verified');
    const unknownDevice = device();
    unknownDevice.gpuStatus = 'unknown';
    unknownDevice.gpus = [];
    expect(evaluate([], [profile(root())], unknownDevice).models[0].status).toBe('unknown');
  });

  it('deducts registered matching bytes, not filenames or missing files', () => {
    const saved = profile(root());
    const item = candidate('other-family', 4);
    expect(evaluate([item], [saved]).models.find((model) => model.candidateId === item.id)).toMatchObject({
      downloadBytes: 0,
      reusedBytes: 4,
    });
    expect(
      evaluate([item], [{ ...saved, state: 'downloaded', validation: undefined }]).models.find(
        (model) => model.candidateId === item.id
      )?.downloadBytes
    ).toBe(4);
    expect(
      evaluate([item], [{ ...saved, state: 'invalid' }]).models.find((model) => model.candidateId === item.id)
        ?.downloadBytes
    ).toBe(4);
    fs.writeFileSync(saved.components[0].path, 'wrong-size');
    expect(evaluate([item], [saved]).models.find((model) => model.candidateId === item.id)).toMatchObject({
      downloadBytes: 4,
      reusedBytes: 0,
    });
  });

  it('retains an existing installation conversation for progress navigation', () => {
    const saved = profile(root());
    const result = evaluateLocalModelCenter({
      inventory: { profiles: [saved], complete: true, diagnostics: [] },
      device: device(),
      catalog: { root: '', candidates: [], baselines: [] },
      activities: [
        {
          family: saved.family,
          profileId: saved.id,
          conversationId: 'existing-install-chat',
          state: 'running',
          updatedAt: '2026-11-11',
        },
      ],
    });
    expect(result.models[0].activity).toEqual({ conversationId: 'existing-install-chat', state: 'running' });
    for (const state of ['failed', 'interrupted', 'completed', 'cancelled']) {
      const terminal = evaluateLocalModelCenter({
        inventory: result.inventory,
        device: device(),
        catalog: { root: '', candidates: [], baselines: [] },
        activities: [{ family: saved.family, conversationId: 'old-chat', state, updatedAt: '2026-11-11' }],
      });
      expect(terminal.models[0].activity).toBeUndefined();
    }
  });

  it('offers at most one entry for each purpose and preserves installed candidate identity', () => {
    const saved = profile(root());
    const installed = candidate(saved.family, 4);
    const snapshot = evaluate(
      [installed, candidate(), candidate('editor'), { ...candidate('video'), kind: 'video' }],
      [saved]
    );
    expect(snapshot.models).toHaveLength(4);
    expect(snapshot.models[0]).toMatchObject({ installed: true, candidateId: saved.family });
    expect(snapshot.recommendations).toHaveLength(3);
    expect(new Set(snapshot.recommendations.flatMap((item) => item.purposes)).size).toBe(3);
    saved.name = 'Custom Image Reference Identity Grid v2';
    saved.capabilities.push('image-edit');
    const shorter = {
      ...saved,
      id: 'shorter-route',
      name: 'Custom Image',
      state: 'downloaded' as const,
      validation: undefined,
    };
    const covered = evaluate(
      [installed, candidate('editor'), { ...candidate('video'), kind: 'video' }],
      [saved, shorter]
    );
    expect(covered.recommendations).toHaveLength(2);
    expect(covered.recommendations.map((model) => model.family)).toEqual([saved.family, 'video']);
    expect(covered.models[0]).toMatchObject({ name: 'Custom Image', verifiedProfileId: saved.id });
    installed.name = 'Catalog Image';
    expect(evaluate([installed], [saved, shorter]).models[0]).toMatchObject({
      name: 'Catalog Image',
      verifiedProfileId: saved.id,
    });
    expect(evaluate([], [saved, shorter]).models[0]).toMatchObject({
      name: 'Custom Image',
      verifiedProfileId: saved.id,
    });
    const occupied = device();
    occupied.gpus[0].freeMemoryBytes = 0;
    expect(evaluate([candidate(), candidate('editor')], [], occupied).models.map((item) => item.id)).toEqual(
      evaluate([candidate(), candidate('editor')]).models.map((item) => item.id)
    );
  });

  it('reads hardware counters for a not-yet-created folder without Python or writes', async () => {
    const directory = path.join(root(), 'not-created', 'models');
    const runCommand = vi.fn(async (file: string) => {
      if (file !== 'nvidia-smi') throw new Error('unexpected command');
      return '0, NVIDIA RTX, 12288, 8192, 600, 8.9';
    });
    const result = await probeLocalDevice(directory, { runCommand });
    expect(result.installDirectory).toBe(directory);
    expect(result.disk?.path).toBe(path.dirname(path.dirname(directory)));
    expect(result.gpus[0].freeMemoryBytes).toBe(8 * GB);
    expect(runCommand).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(directory)).toBe(false);
  });

  it('uses filesystem discovery without live endpoint or Python identity inspection', async () => {
    const directory = root();
    fs.mkdirSync(path.join(directory, '.venv', 'Scripts'), { recursive: true });
    fs.writeFileSync(path.join(directory, '.venv', 'Scripts', 'python.exe'), '');
    fs.writeFileSync(path.join(directory, 'main.py'), '');
    fs.mkdirSync(path.join(directory, 'models', 'diffusion_models'), { recursive: true });
    fs.writeFileSync(path.join(directory, 'models', 'diffusion_models', 'weights'), 'abcd');
    const model = candidate('z-image', 4);
    (model.components as CatalogRecord[])[0].directory = 'diffusion_models';
    const graph = { '1': { class_type: 'SaveImage', inputs: {} } };
    const graphSha256 = crypto
      .createHash('sha256')
      .update(`${JSON.stringify(graph, null, 2)}\n`)
      .digest('hex');
    const fetchImpl = vi.fn();
    const inspectIdentity = vi.fn();
    const legacyProfiles = vi.fn();
    const discover = createComfyProfileDiscovery({
      cacheFile: path.join(directory, 'cache.json'),
      workflowDirectory: path.join(directory, 'workflows'),
      roots: () => [directory],
      endpoints: () => ['http://127.0.0.1:8188'],
      fetchImpl,
      inspectIdentity,
      legacyProfiles,
      loadCatalog: () => ({
        candidates: [model],
        baselines: [
          {
            id: 'z-image-workflow',
            candidateId: model.id,
            graph,
            graphSha256,
            capabilities: ['text-to-image'],
            requiredNodes: [{ id: 'comfy', version: 'fixed' }],
            bindings: {},
            defaults: {},
          },
        ],
      }),
    });
    const write = vi.spyOn(fs, 'writeFileSync');
    const mkdir = vi.spyOn(fs, 'mkdirSync');
    const found = await discover.lightweight([]);
    expect(found).toHaveLength(1);
    expect(fs.existsSync(found[0].workflowPath)).toBe(false);
    expect(write).not.toHaveBeenCalled();
    expect(mkdir).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(inspectIdentity).not.toHaveBeenCalled();
    expect(legacyProfiles).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(directory, 'cache.json'))).toBe(false);
    expect(fs.existsSync(path.join(directory, 'workflows'))).toBe(false);
  });

  it('serves registry state on partial discovery failure without invoking the runtime engine', async () => {
    const directory = root();
    const saved = profile(directory);
    const filename = path.join(directory, 'registry.json');
    fs.writeFileSync(filename, JSON.stringify({ profiles: [saved], bindings: [], operations: [], jobs: [] }));
    const engine = {
      validate: vi.fn(),
      snapshotFingerprint: vi.fn(),
      ensureStarted: vi.fn(),
      generate: vi.fn(),
      resume: vi.fn(),
      cancel: vi.fn(),
      stopOwned: vi.fn(),
    };
    const fullDiscovery = vi.fn(async () => [saved]);
    const lightweight = vi.fn(async (): Promise<ComfyProfile[]> => {
      throw new Error('COMFY_SCAN_PARTIAL');
    });
    const install = vi.fn();
    const prepareWorkflows = vi.fn(() => ({
      profiles: [],
      reusedProfiles: [{ ...saved, state: 'downloaded' as const, validation: undefined }],
      pending: [],
      matchedCandidateIds: [],
    }));
    const service = new ComfyService({
      filename,
      engine,
      install,
      prepareWorkflows,
      discover: Object.assign(fullDiscovery, { lightweight }),
    });
    vi.spyOn(environment, 'probeLocalDevice').mockResolvedValue({ ...device(), installDirectory: directory });
    const json = vi.fn();
    await handleComfyRoute(
      { method: 'GET' } as http.IncomingMessage,
      {} as http.ServerResponse,
      new URL('http://localhost/api/comfy/model-center'),
      { service, json, body: vi.fn() }
    );
    expect(json).toHaveBeenCalledWith(
      expect.anything(),
      200,
      expect.objectContaining({ inventory: expect.objectContaining({ complete: false, profiles: [saved] }) })
    );
    expect(fullDiscovery).not.toHaveBeenCalled();
    expect(lightweight).toHaveBeenCalledTimes(1);
    for (const method of Object.values(engine)) expect(method).not.toHaveBeenCalled();
    expect(install).not.toHaveBeenCalled();
    expect(prepareWorkflows).not.toHaveBeenCalled();
    const original = fs.readFileSync(filename, 'utf8');
    const discovered = { ...saved, id: 'unregistered', family: 'unregistered-family' };
    lightweight.mockImplementation(async () => [discovered]);
    const refreshed = await service.modelCenter();
    expect(refreshed.inventory.profiles).toHaveLength(2);
    expect(refreshed.models.find((model) => model.family === discovered.family)?.installed).toBe(false);
    expect(service.profiles()).toEqual([saved]);
    expect(fs.readFileSync(filename, 'utf8')).toBe(original);
    expect(prepareWorkflows).not.toHaveBeenCalled();
    await expect(service.modelCenter('../relative')).rejects.toThrow('COMFY_INSTALL_DIRECTORY_ABSOLUTE_REQUIRED');
  });
});
