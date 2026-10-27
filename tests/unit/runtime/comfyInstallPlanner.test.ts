import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createComfyInstallPlanner } from '@/process/services/media/comfy/planning/installPlanner';
import {
  loadComfyInstallCatalog,
  resolveComfyResourcesRoot,
  type CatalogRecord,
} from '@/process/services/media/comfy/planning/catalog';
import {
  assertPlanningHardware,
  probePlanningKernels,
  selectComfyCandidate,
} from '@/process/services/media/comfy/planning/hardwareSelection';
import {
  approvedComfyTransports,
  selectComfyTransports,
} from '@/process/services/media/comfy/planning/transportSelection';
import { prepareComfyRuntime } from '@/process/services/media/comfy/planning/runtimePreparation';
import { H3_PORTABLE_INSTALL_EVIDENCE } from '@/process/services/media/comfy/planning/legacyInstallPlan';
import { assertComfyInstallPlan } from '@/process/services/media/comfy/installExecutor';
import type { ComfyEnvironmentReport } from '@/process/services/media/comfy/discovery/environment';
import type { ComfyFamily, ComfyInstallPlan, ComfyProfile } from '@/common/chat/document/creation/comfy';

let root: string;
let python: string;
const resources = path.resolve('resources');
const catalog = loadComfyInstallCatalog(resources);
const GiB = 2 ** 30;
function hardware(): ComfyEnvironmentReport {
  return {
    checkedAt: new Date().toISOString(),
    machine: {
      os: 'win32',
      arch: 'x64',
      totalMemoryBytes: 256 * GiB,
      freeMemoryBytes: 220 * GiB,
      disk: { path: root, totalBytes: 2e12, freeBytes: 1e12 },
      gpuStatus: 'available',
      gpus: [
        {
          vendor: 'nvidia',
          name: 'Fixture CUDA device',
          driver: '600.00',
          computeCapability: '12.0',
          totalMemoryBytes: 32 * GiB,
          freeMemoryBytes: 28 * GiB,
        },
      ],
    },
    runtime: { status: 'missing', executable: python, packages: {}, accelerator: 'unknown' },
    comfy: { root, status: 'missing', customNodes: [], service: 'offline' },
    network: {
      checkedAt: new Date().toISOString(),
      requested: false,
      proxy: { http: false, https: false, noProxy: false },
      sources: [],
    },
    issues: ['PYTHON_MISSING'],
  };
}
function asProfile(plan: ComfyInstallPlan): ComfyProfile {
  const {
    targetRoot: _root,
    downloadBytes: _download,
    requiredBytes: _required,
    reason: _reason,
    evidence: _evidence,
    workflow: _graph,
    commands: _commands,
    smokeInput: _input,
    repair: _repair,
    ...profile
  } = plan;
  return { ...profile, state: 'downloaded' };
}
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'comfy-planner-'));
  python = path.join(root, process.platform === 'win32' ? 'python.exe' : 'python3');
  fs.writeFileSync(python, 'fixture');
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
});
function planner(overrides: Partial<Parameters<typeof createComfyInstallPlanner>[0]> = {}) {
  const prepareRuntime = vi.fn(
    async (): Promise<Awaited<ReturnType<typeof prepareComfyRuntime>>> => ({
      commands: [],
      components: [],
      evidence: ['fixture:locked-runtime'],
    })
  );
  const probe = vi.fn(async () => hardware());
  return {
    prepareRuntime,
    probe,
    build: createComfyInstallPlanner({
      dataDir: root,
      resourcesRoot: resources,
      roots: () => [],
      h3BundleRoot: () => path.join(root, 'h3-bundle'),
      probe,
      prepareRuntime,
      bootstrapPythons: [python],
      runCommand: async () => JSON.stringify({ executable: python, version: '3.12.9', packages: {} }),
      selectTransports: async (component) => approvedComfyTransports(component),
      ...overrides,
    }),
  };
}

describe('shipped catalog and automatic installation', () => {
  it('resolves resources without relying on the child process working directory', () => {
    vi.stubEnv('OPENH3_RESOURCES_ROOT', resources);
    expect(resolveComfyResourcesRoot()).toBe(resources);
    expect(catalog.baselines).toHaveLength(19);
    expect(catalog.baselines.some((entry) => entry.family === 'qwen-edit')).toBe(true);
    expect(catalog.baselines.some((entry) => entry.family === 'fasth3-omni')).toBe(true);
  });
  it.each<ComfyFamily>([
    'h3',
    'fasth3-omni',
    'qwen-edit',
    'z-image',
    'flux-3-image-klein',
    'moss-image-base',
    'moss-image-sft',
    'krea2',
  ])('constructs an executable, fixed workflow plan for %s from the real shipped catalog', async (family) => {
    const { build, prepareRuntime } = planner();
    const plan = await build('request', { action: 'request', family, intent: 'install' });
    expect(() => assertComfyInstallPlan(plan)).not.toThrow();
    expect(plan.family).toBe(family);
    expect(plan.components.every((component) => component.sha256 && component.sizeBytes && component.url)).toBe(true);
    expect(plan.evidence).toContain(
      family === 'h3' ? H3_PORTABLE_INSTALL_EVIDENCE : 'registration:requires-real-generation-and-artifact-validation'
    );
    if (family !== 'h3') expect(prepareRuntime).toHaveBeenCalledOnce();
    if (family === 'qwen-edit' || family === 'fasth3-omni') {
      expect(plan.smokeInput.references).toHaveLength(1);
      expect(fs.readFileSync(plan.smokeInput.references![0].path).subarray(0, 8).toString('hex')).toBe(
        '89504e470d0a1a0a'
      );
    }
    expect('state' in plan).toBe(false);
  });
  it('accepts discovered profile IDs and preserves the profile recipe for validation-only installation', async () => {
    const initial = await planner().build('request', { action: 'request', family: 'qwen-edit', intent: 'install' });
    fs.mkdirSync(path.dirname(initial.workflowPath), { recursive: true });
    fs.writeFileSync(initial.workflowPath, `${JSON.stringify(initial.workflow, null, 2)}\n`);
    const profile = asProfile(initial);
    profile.id = 'found-qwen-edit-existing-device';
    const report = hardware();
    report.runtime = {
      status: 'available',
      executable: profile.environment.python,
      packages: { torch: '2.9.1' },
      accelerator: 'cuda',
    };
    report.comfy.status = 'installed';
    const p = planner({ probe: async () => report });
    const plan = await p.build(
      'request',
      { action: 'request', family: 'qwen-edit', intent: 'install', profileId: profile.id },
      [profile]
    );
    expect(plan.id).toBe(profile.id);
    expect(plan.repair).toBe(false);
    expect(plan.environment).toEqual(profile.environment);
    expect(plan.components).toEqual(profile.components);
    expect(plan.workflowSha256).toBe(profile.workflowSha256);
    expect(plan.nodes).toEqual(profile.nodes);
    expect(p.prepareRuntime).not.toHaveBeenCalled();
    expect(() => assertComfyInstallPlan(plan)).not.toThrow();
  });
  it('repairs a registered profile without changing its weights, ID, defaults or bindings', async () => {
    const initial = await planner().build('request', { action: 'request', family: 'z-image', intent: 'install' });
    fs.mkdirSync(path.dirname(initial.workflowPath), { recursive: true });
    fs.writeFileSync(initial.workflowPath, `${JSON.stringify(initial.workflow, null, 2)}\n`);
    const profile = asProfile(initial);
    profile.id = 'external-z-custom-name';
    profile.defaults.seed = 812;
    const plan = await planner().build(
      'repair',
      { action: 'request', family: 'z-image', intent: 'repair', profileId: profile.id },
      [profile]
    );
    expect(plan.id).toBe(profile.id);
    expect(plan.repair).toBe(true);
    expect(plan.components).toEqual(profile.components);
    expect(plan.defaults).toEqual(profile.defaults);
    expect(plan.bindings).toEqual(profile.bindings);
    expect(plan.environment).toEqual(profile.environment);
  });
  it('does not conflate failed hardware detection with a confirmed unsupported device', async () => {
    const failed = hardware();
    failed.machine.gpuStatus = 'unknown';
    failed.machine.gpus = [];
    expect(() => assertPlanningHardware(failed)).toThrow('COMFY_DETECTION_INCOMPLETE:GPU_PROBE');
    failed.machine.gpuStatus = 'available';
    expect(() => assertPlanningHardware(failed)).toThrow(
      'COMFY_DEVICE_CONDITIONS_INSUFFICIENT:PINNED_CUDA_RECIPE_REQUIRES_NVIDIA'
    );
  });
  it('reports the exact pinned H3 architecture constraint instead of pretending the API baseline is absent', async () => {
    const report = hardware();
    report.machine.gpus[0].computeCapability = '8.9';
    await expect(
      planner({ probe: async () => report }).build('request', { action: 'request', family: 'h3', intent: 'install' })
    ).rejects.toThrow('H3_PINNED_NVFP4_RECIPE_REQUIRES_BLACKWELL');
  });
});

describe('candidate device and kernel selection', () => {
  it('requires actual architecture for NVFP4 even if the GPU name contains Blackwell', () => {
    const report = hardware();
    report.machine.gpus[0].name = 'Blackwell RTX 5090';
    report.machine.gpus[0].computeCapability = '8.9';
    expect(() =>
      selectComfyCandidate(
        catalog.candidates.filter((entry) => entry.family === 'fasth3-omni'),
        report,
        undefined,
        'fasth3-omni-nvfp4-qad-discovery'
      )
    ).toThrow('NVFP4_REQUIRES_BLACKWELL');
  });
  it('does not treat an installed native package as an executing quantized kernel', () => {
    const report = hardware();
    report.runtime.packages['comfy-kitchen'] = '0.2.39';
    expect(() =>
      selectComfyCandidate(
        catalog.candidates.filter((entry) => entry.family === 'moss-image-sft'),
        report,
        undefined,
        'moss-image-sft-int8-t2i-discovery'
      )
    ).toThrow('NATIVE_QUANTIZATION_KERNEL_EVIDENCE_REQUIRED');
  });
  it('uses measured combined memory and a component-based reserve rather than a model-family VRAM table', () => {
    const report = hardware();
    report.machine.freeMemoryBytes = GiB;
    report.machine.gpus[0].freeMemoryBytes = GiB;
    expect(() =>
      selectComfyCandidate(
        catalog.candidates.filter((entry) => entry.family === 'z-image'),
        report
      )
    ).toThrow('AVAILABLE_RAM_AND_VRAM');
  });
  it('executes attention and dtype probes on CUDA and reports failed execution', async () => {
    const run = vi.fn(async () => JSON.stringify({ bf16: true, attention: false, fp8: true, error: 'RuntimeError' }));
    expect(await probePlanningKernels(python, run)).toMatchObject({ attention: false, error: 'RuntimeError' });
    expect(run.mock.calls[0]?.[1]).toEqual(['-c', expect.stringContaining('scaled_dot_product_attention')]);
  });
});

describe('download transports and integrity', () => {
  it('selects only size/hash-equivalent documented domestic transports', () => {
    const item = structuredClone(catalog.candidates.find((entry) => entry.family === 'fasth3-omni')!) as CatalogRecord;
    const component = (item.components as CatalogRecord[])[0];
    const transports = component.transports as CatalogRecord[];
    transports[0].sha256 = '0'.repeat(64);
    expect(approvedComfyTransports(component)[0]).toContain('hf-mirror.com');
    expect(approvedComfyTransports(component).some((url) => url.includes('modelscope.cn'))).toBe(false);
  });
  it('provides verified fixed-revision domestic mirrors for every Qwen/Z component', () => {
    for (const family of ['qwen-edit', 'z-image'])
      for (const component of catalog.candidates.find((entry) => entry.family === family)!
        .components as CatalogRecord[])
        expect(approvedComfyTransports(component)[0]).toContain('hf-mirror.com');
  });
  it('falls back to the actual upstream file when the domestic endpoint is unavailable', async () => {
    const component = (
      catalog.candidates.find((entry) => entry.family === 'z-image')!.components as CatalogRecord[]
    )[0];
    const fetcher = vi.fn(
      async (url: string | URL | Request) =>
        new Response(null, {
          status: String(url).includes('hf-mirror.com') ? 503 : 200,
          headers: { 'content-length': String(component.sizeBytes) },
        })
    ) as unknown as typeof fetch;
    const sources = await selectComfyTransports(component, fetcher);
    expect(sources[0]).toContain('huggingface.co');
    expect(sources[1]).toContain('hf-mirror.com');
  });
  it('does not classify source authentication failures as device incompatibility', async () => {
    const component = (
      catalog.candidates.find((entry) => entry.family === 'z-image')!.components as CatalogRecord[]
    )[0];
    await expect(selectComfyTransports(component, async () => new Response(null, { status: 403 }))).rejects.toThrow(
      'COMFY_SOURCE_AUTHORIZATION_REQUIRED'
    );
  });
});

describe('actual-interpreter binary runtime resolution', () => {
  const requirements = `comfyui-frontend-package==1.55.17\ncomfyui-workflow-templates==0.11.82\ncomfyui-embedded-docs==0.5.14\ntorch\ntorchsde\ntorchvision\nnumpy>=1.25.0\neinops\ntransformers>=4.50.3\ntokenizers>=0.13.3\nsentencepiece\nsafetensors>=0.4.2\naiohttp>=3.11.8\nyarl>=1.18.0\npyyaml\nPillow\nscipy\ntqdm\npsutil\nalembic\nSQLAlchemy>=2.0.0\nfilelock\nav>=17.0.0\ncomfy-kitchen==0.2.37\ncomfy-aimdo==0.5.6\nrequests\nsimpleeval>=1.0.0\nblake3\n\n#non essential dependencies:\nkornia>=0.7.1\nspandrel\npydantic~=2.0\npydantic-settings~=2.0\nPyOpenGL>=3.1.8\ncomfy-angle\n`;
  it('repairs the real managed sibling-venv layout without widening scope to an arbitrary interpreter parent', async () => {
    const initial = await planner().build('initial', { action: 'request', family: 'z-image', intent: 'install' });
    fs.mkdirSync(initial.environment.root, { recursive: true });
    fs.writeFileSync(path.join(initial.environment.root, 'main.py'), '# existing core');
    fs.mkdirSync(path.dirname(initial.workflowPath), { recursive: true });
    fs.writeFileSync(initial.workflowPath, `${JSON.stringify(initial.workflow, null, 2)}\n`);
    const profile = asProfile(initial);
    const fetcher = vi.fn(async (url: string | URL | Request) =>
      String(url).endsWith('requirements.txt')
        ? new Response(requirements)
        : new Response(null, { headers: { 'content-length': '100' } })
    ) as unknown as typeof fetch;
    const run = vi.fn(async (_file: string, args: string[]) =>
      args[1]?.includes('metadata_only')
        ? JSON.stringify({
            install: [
              {
                download_info: {
                  url: 'https://files.pythonhosted.org/packages/fixture-1.0-py3-none-any.whl',
                  archive_info: { hashes: { sha256: 'a'.repeat(64) } },
                },
                metadata: { name: 'fixture', version: '1.0' },
              },
            ],
          })
        : JSON.stringify({ executable: python, version: '3.12.9', packages: {} })
    );
    const p = planner({ prepareRuntime: prepareComfyRuntime, fetchImpl: fetcher, runCommand: run });
    const repaired = await p.build(
      'repair',
      { action: 'request', family: 'z-image', intent: 'repair', profileId: profile.id },
      [profile]
    );
    expect(repaired.targetRoot).toBe(initial.targetRoot);
    expect(repaired.environment).toEqual(profile.environment);
    expect(repaired.commands.find((command) => command.label === 'bootstrap:python-venv')).toMatchObject({
      cwd: initial.targetRoot,
      args: ['-m', 'venv', path.join(initial.targetRoot, '.venv')],
    });
    expect(repaired.components.find((component) => component.role === 'runtime-wheel')?.path).toBe(
      path.join(initial.targetRoot, '.openh3-wheels', 'fixture-1.0-py3-none-any.whl')
    );
    expect(() => assertComfyInstallPlan(repaired)).not.toThrow();

    const externalProfile = structuredClone(profile);
    externalProfile.environment.root = path.join(root, 'external-ComfyUI');
    externalProfile.environment.python = path.join(root, 'unrelated-python', '.venv', 'Scripts', 'python.exe');
    await expect(
      p.build('external-repair', { action: 'request', family: 'z-image', intent: 'repair', profileId: profile.id }, [
        externalProfile,
      ])
    ).rejects.toThrow('COMFY_DETECTION_INCOMPLETE:EXTERNAL_PROFILE_PYTHON_REPAIR_LOCATION_REQUIRED');
  });
  it('builds clone, venv and offline-wheel commands from the actual pip report with locked digests', async () => {
    expect(crypto.createHash('sha256').update(requirements).digest('hex')).toBe(
      'daa5c581620080f44c894609b852b5fd82fa102975f5dd31abeef2ca0e5a3fff'
    );
    const run = vi.fn(async () =>
      JSON.stringify({
        install: [
          {
            download_info: {
              url: 'https://files.pythonhosted.org/packages/fixture-1.0-py3-none-any.whl',
              archive_info: { hashes: { sha256: 'a'.repeat(64) } },
            },
            metadata: { name: 'fixture', version: '1.0' },
          },
        ],
      })
    );
    const fetcher = vi.fn(async (url: string | URL | Request) =>
      String(url).endsWith('requirements.txt')
        ? new Response(requirements)
        : new Response(null, { headers: { 'content-length': '100' } })
    ) as unknown as typeof fetch;
    const environment = {
      root: path.join(root, 'ComfyUI'),
      python: path.join(root, '.venv', 'Scripts', 'python.exe'),
      baseUrl: 'http://127.0.0.1:8188',
    };
    const runtime = await prepareComfyRuntime(
      {
        coreRevision: 'e0a32bce84f4603f2b61b16b50f8958e68fd6171',
        environment,
        targetRoot: root,
        report: hardware(),
        bootstrapPython: python,
        existing: false,
        runtimePins: { comfyKitchen: '0.2.37', comfyAimdo: '0.5.6' },
      },
      { runCommand: run, fetchImpl: fetcher }
    );
    expect(runtime.commands.map((command) => command.label)).toEqual([
      'bootstrap:comfy-clone',
      'bootstrap:comfy-checkout',
      'bootstrap:python-venv',
      'runtime:install-locked-binary-wheels',
    ]);
    expect(runtime.components[0]).toMatchObject({ sha256: 'a'.repeat(64), sizeBytes: 100, role: 'runtime-wheel' });
    expect(runtime.commands.at(-1)!.args).toContain('--no-index');
    expect(run.mock.calls[0]?.[1]).toEqual(
      expect.arrayContaining([
        '-c',
        expect.stringContaining('COMFY_METADATA_ONLY_WHEEL_BODY_FORBIDDEN'),
        '--no-cache-dir',
      ])
    );
    expect(run.mock.calls[0]?.[1]).toEqual(
      expect.arrayContaining(['--only-binary=:all:', '--dry-run', 'comfy-kitchen==0.2.37', 'comfy-aimdo==0.5.6'])
    );
  });
  it('rejects changed requirements before resolving or installing dependencies', async () => {
    const run = vi.fn();
    await expect(
      prepareComfyRuntime(
        {
          coreRevision: 'e0a32bce84f4603f2b61b16b50f8958e68fd6171',
          environment: { root, python, baseUrl: 'http://127.0.0.1:8188' },
          targetRoot: root,
          report: hardware(),
          bootstrapPython: python,
          existing: false,
        },
        { runCommand: run, fetchImpl: async () => new Response('changed') }
      )
    ).rejects.toThrow('HASH_MISMATCH');
    expect(run).not.toHaveBeenCalled();
  });
});
