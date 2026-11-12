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
import { findBootstrapPython, prepareComfyRuntime } from '@/process/services/media/comfy/planning/runtimePreparation';
import { H3_PORTABLE_INSTALL_EVIDENCE } from '@/process/services/media/comfy/planning/legacyInstallPlan';
import { assertComfyInstallPlan } from '@/process/services/media/comfy/installExecutor';
import type {
  ComfyEnvironmentProbeOptions,
  ComfyEnvironmentReport,
} from '@/process/services/media/comfy/discovery/environment';
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
      runCommand: async () =>
        JSON.stringify({ executable: python, version: '3.12.9', packages: {}, venv: true, pip: true }),
      selectTransports: async (component) => approvedComfyTransports(component),
      ...overrides,
    }),
  };
}

describe('shipped catalog and automatic installation', () => {
  it.each(['fresh', 'existing-runtime', 'h3'] as const)(
    'uses the selected directory for new downloads and disk planning with %s',
    async (scenario) => {
      const installDirectory = path.join(root, 'chosen-model-storage');
      const existingRoot = path.join(root, 'existing-ComfyUI');
      const reuseRuntime = scenario === 'existing-runtime';
      if (reuseRuntime) {
        fs.mkdirSync(existingRoot);
        fs.writeFileSync(path.join(existingRoot, 'main.py'), '# existing core');
      }
      const probe = vi.fn(async (input: ComfyEnvironmentProbeOptions) => {
        const report = hardware();
        if (reuseRuntime && input?.root === existingRoot) {
          report.comfy = {
            root: existingRoot,
            status: 'installed',
            customNodes: [],
            service: 'offline',
            revision: 'v0.35.0',
          };
          report.runtime = { status: 'available', executable: python, packages: {}, accelerator: 'cuda' };
        }
        return report;
      });
      const p = planner({
        roots: () => (reuseRuntime ? [existingRoot] : []),
        probe,
        fetchImpl: async () => new Response(null, { status: 503 }),
        probeKernels: async () => ({ bf16: true, fp8: true, attention: true }),
      });
      const plan = await p.build('request', {
        action: 'request',
        family: scenario === 'h3' ? 'h3' : 'z-image',
        intent: 'install',
        installContext: { installDirectory, checkedAt: new Date().toISOString(), candidateId: 'advisory-only' },
      });
      expect(plan.components.every((component) => component.path.startsWith(installDirectory + path.sep))).toBe(true);
      expect(plan.workflowPath.startsWith(installDirectory + path.sep)).toBe(true);
      expect(probe.mock.calls.every(([input]) => input?.installDirectory === installDirectory)).toBe(true);
      if (reuseRuntime) {
        expect(plan.environment.root).toBe(existingRoot);
        expect(plan.environment.launchArgs).toEqual(['--models-directory', path.join(installDirectory, 'models')]);
        expect(p.prepareRuntime).not.toHaveBeenCalled();
      } else expect(plan.environment.root.startsWith(installDirectory + path.sep)).toBe(true);
      expect(() => assertComfyInstallPlan(plan)).not.toThrow();
    }
  );
  it('resolves resources without relying on the child process working directory', () => {
    vi.stubEnv('OPENH3_RESOURCES_ROOT', resources);
    expect(resolveComfyResourcesRoot()).toBe(resources);
    expect(catalog.baselines.length).toBeGreaterThanOrEqual(19);
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
  it('applies a repair source override without mutating the registered profile or its artifact identity', async () => {
    const initial = await planner().build('initial', { action: 'request', family: 'z-image', intent: 'install' });
    const profile = asProfile(initial);
    const original = structuredClone(profile);
    const component = profile.components[0];
    const replacement =
      'https://modelscope.cn/models/Mirror/Equivalent/resolve/' + 'a'.repeat(40) + '/weights.safetensors';
    const selectTransports = vi.fn(
      async (_item: CatalogRecord, _fetcher?: typeof fetch, overrides: string[] = []) => overrides
    );
    const repaired = await planner({ selectTransports }).build(
      'repair',
      {
        action: 'request',
        family: 'z-image',
        intent: 'repair',
        profileId: profile.id,
        sourceOverrides: [{ component: component.name, urls: [replacement] }],
      },
      [profile]
    );
    expect(repaired.components[0]).toEqual({ ...component, url: replacement, sourceUrls: [replacement] });
    expect(repaired.workflowSha256).toBe(profile.workflowSha256);
    expect(profile).toEqual(original);
    expect(selectTransports).toHaveBeenCalledWith(
      expect.objectContaining({ sha256: component.sha256, sizeBytes: component.sizeBytes }),
      undefined,
      [replacement]
    );
  });
  it.each(['install', 'repair'] as const)(
    'rejects unknown source components and untrusted sources during %s',
    async (intent) => {
      const initial = await planner().build('initial', { action: 'request', family: 'z-image', intent: 'install' });
      const profile = asProfile(initial);
      const profiles = intent === 'repair' ? [profile] : [];
      const request = { action: 'request' as const, family: 'z-image' as const, intent };
      await expect(
        planner().build(
          'bad-component',
          {
            ...request,
            sourceOverrides: [
              { component: 'not-in-plan', urls: ['https://huggingface.co/Mirror/Model/resolve/main/model'] },
            ],
          },
          profiles
        )
      ).rejects.toThrow('COMFY_SOURCE_COMPONENT_UNKNOWN');
      await expect(
        planner().build(
          'bad-source',
          {
            ...request,
            sourceOverrides: [{ component: profile.components[0].name, urls: ['https://example.org/weights'] }],
          },
          profiles
        )
      ).rejects.toThrow('COMFY_SOURCE_CANDIDATE_NOT_TRUSTED');
    }
  );
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
  it('retains hash-verified MOSS domestic transports with catalog integrity evidence', () => {
    const component = (
      catalog.candidates.find((entry) => entry.family === 'moss-image-sft')!.components as CatalogRecord[]
    )[0];
    expect(approvedComfyTransports(component).some((url) => url.includes('modelscope.cn'))).toBe(true);
  });
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
  it('accepts discovered exact-file URLs only from product-approved hosts', () => {
    const component = (
      catalog.candidates.find((entry) => entry.family === 'moss-image-sft')!.components as CatalogRecord[]
    )[0];
    const discovered = [
      'https://huggingface.co/Comfy-Org/MOSS-Image/resolve/pinned/file.safetensors',
      'https://example.invalid/model.safetensors',
    ];

    const transports = approvedComfyTransports(component, discovered);

    expect(transports).toContain(discovered[0]);
    expect(transports).not.toContain(discovered[1]);
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
  it('uses a one-byte range request when a source rejects HEAD', async () => {
    const component = (
      catalog.candidates.find((entry) => entry.family === 'z-image')!.components as CatalogRecord[]
    )[0];
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === 'HEAD') return new Response(null, { status: 405 });
      return new Response(new Uint8Array([0]), {
        status: 206,
        headers: { 'content-range': `bytes 0-0/${component.sizeBytes}`, 'content-length': '1' },
      });
    }) as unknown as typeof fetch;

    const sources = await selectComfyTransports(component, fetcher);

    expect(sources).toContain(String(component.url));
    expect(fetcher).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ method: 'GET', headers: { range: 'bytes=0-0' } })
    );
  });
  it('reports inaccessible sources as a source error, not a missing tool', async () => {
    const component = (
      catalog.candidates.find((entry) => entry.family === 'z-image')!.components as CatalogRecord[]
    )[0];
    await expect(selectComfyTransports(component, async () => new Response(null, { status: 503 }))).rejects.toThrow(
      'COMFY_SOURCE_UNREACHABLE'
    );
  });
});

describe('actual-interpreter binary runtime resolution', () => {
  const requirements = `comfyui-frontend-package==1.55.17\ncomfyui-workflow-templates==0.11.82\ncomfyui-embedded-docs==0.5.14\ntorch\ntorchsde\ntorchvision\nnumpy>=1.25.0\neinops\ntransformers>=4.50.3\ntokenizers>=0.13.3\nsentencepiece\nsafetensors>=0.4.2\naiohttp>=3.11.8\nyarl>=1.18.0\npyyaml\nPillow\nscipy\ntqdm\npsutil\nalembic\nSQLAlchemy>=2.0.0\nfilelock\nav>=17.0.0\ncomfy-kitchen==0.2.37\ncomfy-aimdo==0.5.6\nrequests\nsimpleeval>=1.0.0\nblake3\n\n#non essential dependencies:\nkornia>=0.7.1\nspandrel\npydantic~=2.0\npydantic-settings~=2.0\nPyOpenGL>=3.1.8\ncomfy-angle\n`;
  it('repairs a registered custom-root sibling venv after the new-install directory changes', async () => {
    const initial = await planner().build('initial', {
      action: 'request',
      family: 'z-image',
      intent: 'install',
      installContext: { checkedAt: new Date().toISOString(), installDirectory: path.join(root, 'old-models') },
    });
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
        : JSON.stringify({ executable: python, version: '3.12.9', packages: {}, venv: true, pip: true })
    );
    const p = planner({ prepareRuntime: prepareComfyRuntime, fetchImpl: fetcher, runCommand: run });
    const repaired = await p.build(
      'repair',
      {
        action: 'request',
        family: 'z-image',
        intent: 'repair',
        profileId: profile.id,
        installContext: { checkedAt: new Date().toISOString(), installDirectory: path.join(root, 'new-models') },
      },
      [profile]
    );
    expect(repaired.targetRoot).toBe(initial.targetRoot);
    expect(repaired.environment).toEqual(profile.environment);
    expect(repaired.commands.find((command) => command.label === 'bootstrap:python-venv')).toMatchObject({
      cwd: initial.targetRoot,
      args: ['-m', 'venv', path.join(initial.targetRoot, '.venv-py312')],
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
  it('reports a resolver timeout without reading error constants from the exec command text', async () => {
    const failure = Object.assign(new Error('python -c raise RuntimeError(COMFY_METADATA_ONLY_WHEEL_BODY_FORBIDDEN)'), {
      cmd: 'python -c ...',
      killed: true,
      stderr: 'WARNING: fast-deps is experimental',
    });
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
        { runCommand: vi.fn().mockRejectedValue(failure), fetchImpl: async () => new Response(requirements) }
      )
    ).rejects.toThrow('BINARY_DEPENDENCY_METADATA_RESOLUTION:PACKAGE_SOURCE_TIMEOUT,PACKAGE_SOURCE_TIMEOUT');
  });
});

describe('reuse across model families', () => {
  it.each<ComfyFamily>([
    'fasth3-omni',
    'qwen-edit',
    'z-image',
    'flux-3-image-klein',
    'moss-image-base',
    'moss-image-sft',
    'krea2',
  ])('inspects later environments and preserves an existing portable core for %s', async (family) => {
    const bad = path.join(root, 'old');
    const good = path.join(root, 'portable', 'ComfyUI');
    const embedded = path.join(root, 'portable', 'python_embeded', 'python.exe');
    for (const folder of [bad, good, path.dirname(embedded)]) fs.mkdirSync(folder, { recursive: true });
    for (const folder of [bad, good]) fs.writeFileSync(path.join(folder, 'main.py'), '# fixture');
    fs.writeFileSync(embedded, 'python');
    const probe = vi.fn(async (input) => {
      const report = hardware();
      if (input.root === good) {
        report.comfy = { root: good, status: 'installed', customNodes: [], service: 'offline', revision: 'v0.35.0' };
        report.runtime = {
          status: 'available',
          executable: embedded,
          version: '3.12.9',
          packages: {},
          accelerator: 'cuda',
        };
      }
      return report;
    });
    const p = planner({
      roots: () => [bad, good],
      probe,
      fetchImpl: async () => {
        throw new Error('offline');
      },
      probeKernels: async () => ({ bf16: true, fp8: true, attention: true }),
    });
    const plan = await p.build('request', { action: 'request', family, intent: 'install' });
    expect(plan.environment.root).toBe(good);
    expect(plan.environment.python).toBe(embedded);
    expect(plan.nodes.find((node) => ['ComfyUI', 'comfyui-core'].includes(node.id))?.version).toBe('v0.35.0');
    expect(plan.commands).toEqual([]);
    expect(plan.evidence).toContain('runtime:reused:SCHEMA_PENDING_AUTHORIZED_START');
    expect(p.prepareRuntime).not.toHaveBeenCalled();
    expect(() => assertComfyInstallPlan(plan)).not.toThrow();
  });
  it.each<ComfyFamily>([
    'fasth3-omni',
    'qwen-edit',
    'z-image',
    'flux-3-image-klein',
    'moss-image-base',
    'moss-image-sft',
    'krea2',
  ])(
    'isolates %s after a proven workflow failure without letting another unknown runtime block recovery',
    async (family) => {
      const existing = path.join(root, 'existing');
      const failed = path.join(root, 'schema-failed');
      fs.mkdirSync(existing);
      fs.mkdirSync(failed);
      fs.writeFileSync(path.join(existing, 'main.py'), '# fixture');
      fs.writeFileSync(path.join(failed, 'main.py'), '# incompatible workflow');
      const p = planner({
        roots: () => [failed, existing],
        fetchImpl: async () => {
          throw new Error('offline');
        },
      });
      const plan = await p.build('request', { action: 'request', family, intent: 'install' }, [], {
        excludedEnvironmentRoots: [failed],
      });
      expect(plan.environment.root).toContain(path.join('comfy-runtimes', ''));
      expect(plan.environment.root).not.toBe(existing);
      expect(plan.evidence).toEqual(
        expect.arrayContaining([expect.stringContaining(`environment:${existing}:unknown:`)])
      );
      expect(p.prepareRuntime).toHaveBeenCalledOnce();
      expect(fs.readdirSync(existing)).toEqual(['main.py']);
    }
  );

  it('requires Agent diagnosis rather than treating an unknown environment alone as permission to reinstall', async () => {
    fs.writeFileSync(path.join(root, 'main.py'), '# unknown original');
    const p = planner({
      roots: () => [root],
      fetchImpl: async () => {
        throw new Error('offline');
      },
    });
    await expect(p.build('request', { action: 'request', family: 'z-image', intent: 'install' })).rejects.toThrow(
      'COMFY_EXISTING_ENVIRONMENT_NEEDS_DIAGNOSIS'
    );
    expect(p.prepareRuntime).not.toHaveBeenCalled();
  });

  it('does not target an unidentified installation occupying the normal isolated runtime path', async () => {
    const initial = await planner().build('initial', { action: 'request', family: 'z-image', intent: 'install' });
    fs.mkdirSync(initial.environment.root, { recursive: true });
    fs.writeFileSync(path.join(initial.environment.root, 'main.py'), '# existing unknown runtime');
    const p = planner({
      fetchImpl: async () => {
        throw new Error('offline');
      },
    });
    const plan = await p.build('request', { action: 'request', family: 'z-image', intent: 'install' }, [], {
      excludedEnvironmentRoots: [initial.environment.root],
    });
    expect(plan.environment.root).not.toBe(initial.environment.root);
    expect(path.dirname(plan.targetRoot)).toBe(path.dirname(initial.targetRoot));
    expect(plan.components.map((component) => [component.name, component.sha256])).toEqual(
      initial.components.map((component) => [component.name, component.sha256])
    );
    expect(fs.readdirSync(initial.environment.root)).toEqual(['main.py']);
    const repaired = await p.build(
      'repair',
      { action: 'request', family: 'z-image', intent: 'repair', profileId: plan.id },
      [asProfile(plan)]
    );
    expect(repaired.targetRoot).toBe(plan.targetRoot);
    expect(repaired.environment).toEqual(plan.environment);
  });

  it('does not reuse a stopped environment whose workflow already failed in this operation', async () => {
    const existing = path.join(root, 'existing');
    fs.mkdirSync(existing);
    fs.writeFileSync(path.join(existing, 'main.py'), '# older compatible-looking core');
    const embedded = path.join(existing, 'python.exe');
    fs.writeFileSync(embedded, 'python');
    const p = planner({
      roots: () => [existing],
      fetchImpl: async () => {
        throw new Error('offline');
      },
      probe: async (input) => {
        const report = hardware();
        if (input.root === existing) {
          report.comfy = {
            root: existing,
            status: 'installed',
            revision: 'v0.35.0',
            customNodes: [],
            service: 'offline',
          };
          report.runtime = { status: 'available', executable: embedded, packages: {}, accelerator: 'cuda' };
        }
        return report;
      },
      probeKernels: async () => ({ bf16: true, attention: true, fp8: true }),
    });
    const plan = await p.build('request', { action: 'request', family: 'fasth3-omni', intent: 'install' }, [], {
      excludedEnvironmentRoots: [existing],
    });
    expect(plan.environment.root).not.toBe(existing);
    expect(p.prepareRuntime).toHaveBeenCalledOnce();
    expect(plan.evidence).toContain(`environment:${existing}:incompatible:PREVIOUS_WORKFLOW_SCHEMA_FAILURE`);
  });

  it('keeps an explicitly selected profile pinned when runtime compatibility is unknown', async () => {
    const initial = await planner().build('initial', {
      action: 'request',
      family: 'z-image',
      intent: 'install',
    });
    const selected = asProfile(initial);
    fs.writeFileSync(path.join(root, 'main.py'), '# fixture');
    const p = planner({
      roots: () => [root],
      probe: async () => {
        const report = hardware();
        report.runtime = {
          status: 'available',
          executable: selected.environment.python,
          packages: { torch: '2.9' },
          accelerator: 'cuda',
        };
        report.comfy = {
          root: selected.environment.root,
          status: 'installed',
          revision: selected.nodes.find((node) => ['ComfyUI', 'comfyui-core'].includes(node.id))?.version,
          customNodes: [],
          service: 'offline',
        };
        return report;
      },
      fetchImpl: async () => {
        throw new Error('offline');
      },
    });
    const plan = await p.build(
      'request',
      { action: 'request', family: 'z-image', intent: 'install', profileId: selected.id },
      [selected]
    );
    expect(plan.environment).toEqual(selected.environment);
    expect(plan.components).toEqual(selected.components);
    expect(p.prepareRuntime).not.toHaveBeenCalled();
  });
});

it('reuses hash-verified local weights without probing download sources', async () => {
  const selected = structuredClone(catalog.candidates.find((entry) => entry.family === 'z-image')!);
  const contents = Buffer.from('already installed exact bytes');
  for (const component of selected.components as CatalogRecord[]) {
    component.sizeBytes = contents.length;
    component.sha256 = crypto.createHash('sha256').update(contents).digest('hex');
    const file = path.join(root, 'models', String(component.directory), String(component.name));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, contents);
  }
  fs.writeFileSync(path.join(root, 'main.py'), '# fixture');
  const runtime = path.join(root, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  fs.mkdirSync(path.dirname(runtime), { recursive: true });
  fs.writeFileSync(runtime, 'python');
  const report = hardware();
  report.runtime = { status: 'available', executable: runtime, packages: {}, accelerator: 'cuda' };
  report.comfy = { status: 'installed', root, customNodes: [], service: 'offline', revision: 'v0.35.0' };
  const sources = vi.fn(async () => {
    throw new Error('No network');
  });
  const p = planner({
    roots: () => [root],
    probe: async () => report,
    loadCatalog: () => ({ ...catalog, candidates: [selected] }),
    selectTransports: sources,
    fetchImpl: async () => {
      throw new Error('offline');
    },
    probeKernels: async () => ({ bf16: true, fp8: true, attention: true }),
  });
  const result = await p.build('request', { action: 'request', family: 'z-image', intent: 'install' });
  expect(result.downloadBytes).toBe(0);
  expect(sources).not.toHaveBeenCalled();
  expect(p.prepareRuntime).not.toHaveBeenCalled();
});

it('rejects an embeddable Python without venv and selects a complete interpreter before locking wheels', async () => {
  const embedded = path.join(root, 'portable', 'python.exe');
  const complete = path.join(root, 'standard', 'python.exe');
  for (const file of [embedded, complete]) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'fixture');
  }
  const run = vi.fn(async (file: string, args: string[]) => {
    if (args.join(' ').includes('import venv')) {
      if (file === embedded) throw new Error('No module named venv');
      return JSON.stringify({ executable: complete, version: '3.12.9', venv: true, pip: true });
    }
    return JSON.stringify({ executable: file, version: file === embedded ? '3.13.14' : '3.12.9', packages: {} });
  });
  expect(await findBootstrapPython({ bootstrapPythons: [embedded, complete], runCommand: run }, embedded)).toBe(
    complete
  );
});
