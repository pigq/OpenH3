import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import {
  installationEnvironments,
  runtimeCompatibility,
  validateInstallationSchema,
} from '@/process/services/media/comfy/planning/environmentSelection';
import {
  discoverComfyEnvironmentCandidates,
  resolveComfyGit,
  type ComfyEnvironmentReport,
} from '@/process/services/media/comfy/discovery/environment';

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'comfy-env-selection-'));
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
const baseline = {
  graph: { '1': { class_type: 'Loader', inputs: { model: 'model.safetensors', type: 'moss_image' } } },
  bindings: {},
};
const candidate = { components: [{ name: 'model.safetensors' }] };
const registry = {
  Loader: { input: { required: { model: [[], {}], type: [['moss_image'], {}] } }, output: ['MODEL'] },
};

it('waives only missing asset filenames, preserving model type and required-node checks', () => {
  expect(() => validateInstallationSchema(baseline, candidate, registry)).not.toThrow();
  expect(() => validateInstallationSchema(baseline, candidate, {})).toThrow();
  expect(() =>
    validateInstallationSchema(baseline, candidate, {
      Loader: { input: { required: { model: [[], {}], type: [['other_model'], {}] } } },
    })
  ).toThrow();
  expect(registry.Loader.input.required.model[0]).toEqual([]);
});
it('finds interrupted managed runtimes and their sibling interpreter', () => {
  const managed = path.join(root, 'comfy-runtimes', 'revision');
  const comfy = path.join(managed, 'ComfyUI');
  const python = path.join(managed, '.venv', 'Scripts', 'python.exe');
  fs.mkdirSync(comfy, { recursive: true });
  fs.writeFileSync(path.join(comfy, 'main.py'), '# fixture');
  fs.mkdirSync(path.dirname(python), { recursive: true });
  fs.writeFileSync(python, 'python');
  expect(discoverComfyEnvironmentCandidates({ roots: [root], homeDirectory: root, environment: {} })).toContainEqual(
    expect.objectContaining({ root: comfy, python })
  );
});
it('discovers a running unregistered installation from a verified local endpoint', async () => {
  fs.writeFileSync(path.join(root, 'main.py'), '# fixture');
  const python = path.join(root, 'python.exe');
  const found = await installationEnvironments(
    [],
    [],
    async () => Response.json({ system: { comfyui_root: root, python_executable: python } }),
    ['http://127.0.0.1:8199']
  );
  expect(found).toContainEqual(expect.objectContaining({ root, python, baseUrl: 'http://127.0.0.1:8199' }));
});
it('prefers bundled Git even with an empty PATH', () => {
  const git = path.join(root, 'bundled-git', 'cmd', 'git.exe');
  fs.mkdirSync(path.dirname(git), { recursive: true });
  fs.writeFileSync(git, 'fixture');
  expect(resolveComfyGit('win32', { OPENH3_RESOURCES_ROOT: root, PATH: '' })).toBe(git);
});
it.each([
  ['v0.35.0', 'compatible'],
  ['a'.repeat(40), 'compatible'],
])('uses actual schema and records actual revision %s', async (revision, status) => {
  const python = path.join(root, 'python.exe');
  const report = {
    runtime: { status: 'available', accelerator: 'cuda' },
    comfy: {
      status: 'installed',
      revision,
      service: 'online',
      systemStats: { system: { comfyui_root: root, python_executable: python } },
    },
  } as unknown as ComfyEnvironmentReport;
  const environment = { root, python, baseUrl: 'http://127.0.0.1:8188', reason: 'configured' as const };
  expect(
    await runtimeCompatibility(environment, report, baseline, candidate, 'b'.repeat(40), async () =>
      Response.json(registry)
    )
  ).toMatchObject({ status, revision, reason: 'LIVE_WORKFLOW_SCHEMA' });
  expect(
    await runtimeCompatibility(environment, report, baseline, candidate, revision, async () =>
      Response.json({ Other: {} })
    )
  ).toMatchObject({ status: 'incompatible' });
  const wrong = structuredClone(report);
  wrong.comfy.systemStats = { system: { comfyui_root: root + '-other', python_executable: python } };
  expect(
    await runtimeCompatibility(environment, wrong, baseline, candidate, revision, async () => Response.json(registry))
  ).toMatchObject({ status: 'unknown', reason: 'EXISTING_RUNTIME_IDENTITY_UNCONFIRMED' });
});
