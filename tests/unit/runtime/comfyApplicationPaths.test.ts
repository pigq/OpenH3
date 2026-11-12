import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  applicationComfyRoots,
  discoverApplicationComfyEnvironments,
  scanApplicationComfyInventory,
} from '@/process/services/media/comfy/discovery/applicationPaths';
import { installationEnvironments } from '@/process/services/media/comfy/planning/environmentSelection';

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'comfy-application-paths-'));
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});
const checkout = (directory: string) => {
  fs.mkdirSync(path.join(directory, 'comfy'), { recursive: true });
  fs.writeFileSync(path.join(directory, 'main.py'), '# ComfyUI');
  fs.writeFileSync(path.join(directory, 'folder_paths.py'), '# source');
};

it('includes old and new inner data layouts and the actual packaged installation', () => {
  const profile = path.join(root, 'OpenH3');
  const resources = path.join(root, 'installed', 'resources');
  fs.mkdirSync(resources, { recursive: true });
  fs.writeFileSync(path.join(resources, 'app.asar'), 'app');
  for (const name of ['aionui', 'OpenH3']) {
    const data = path.join(profile, name);
    expect(applicationComfyRoots(data, resources)).toEqual([profile, data]);
  }
  expect(applicationComfyRoots(path.join(root, 'custom-data'))).toEqual([path.join(root, 'custom-data')]);
});

it('recognizes a named sibling virtual environment without guessing an unrelated interpreter', async () => {
  const parent = path.join(root, 'models', 'task', 'previous', 'sessions');
  const installed = path.join(parent, 'checkout');
  const venv = path.join(parent, '.moss-environment');
  checkout(installed);
  fs.mkdirSync(path.join(venv, 'Scripts'), { recursive: true });
  fs.writeFileSync(path.join(venv, 'pyvenv.cfg'), 'home = fixture');
  const python = path.join(venv, 'Scripts', 'python.exe');
  fs.writeFileSync(python, 'python');
  expect(await discoverApplicationComfyEnvironments([root])).toEqual([
    expect.objectContaining({ root: installed, python }),
  ]);
});

it('handles application directory cycles once and keeps outside linked trees outside the scan', async () => {
  const application = path.join(root, 'OpenH3');
  const installed = path.join(application, 'task', 'runtime');
  const outside = path.join(root, 'outside');
  checkout(installed);
  checkout(outside);
  fs.symlinkSync(application, path.join(installed, 'cycle'), process.platform === 'win32' ? 'junction' : 'dir');
  fs.symlinkSync(outside, path.join(application, 'outside-link'), process.platform === 'win32' ? 'junction' : 'dir');
  const environments = await discoverApplicationComfyEnvironments([application]);
  expect(environments.map((environment) => environment.root)).toEqual([installed]);
});

it('reports unreadable application subtrees as incomplete instead of returning partial inventory', async () => {
  const denied = path.join(root, 'locked');
  checkout(path.join(root, 'good'));
  fs.mkdirSync(denied);
  const open = fs.promises.opendir.bind(fs.promises);
  vi.spyOn(fs.promises, 'opendir').mockImplementation((async (directory: fs.PathLike, options?: unknown) => {
    if (String(directory) === denied) throw Object.assign(new Error('denied'), { code: 'EACCES' });
    return open(directory, options as import('node:fs').OpenDirOptions);
  }) as typeof fs.promises.opendir);
  await expect(discoverApplicationComfyEnvironments([root])).rejects.toThrow('COMFY_INVENTORY_SCAN_INCOMPLETE');
});

it('retains good model paths and environments when the caller collects per-directory scan issues', async () => {
  const installed = path.join(root, 'good');
  checkout(installed);
  const weights = path.join(installed, 'models', 'moss.safetensors');
  fs.mkdirSync(path.dirname(weights));
  fs.writeFileSync(weights, 'data');
  const denied = path.join(root, 'locked');
  fs.mkdirSync(denied);
  const open = fs.promises.opendir.bind(fs.promises);
  vi.spyOn(fs.promises, 'opendir').mockImplementation((async (directory: fs.PathLike, options?: unknown) => {
    if (String(directory) === denied) throw Object.assign(new Error('denied'), { code: 'EACCES' });
    return open(directory, options as import('node:fs').OpenDirOptions);
  }) as typeof fs.promises.opendir);
  const issues: Array<{ code: string; path?: string }> = [];
  const scan = await scanApplicationComfyInventory([root], new Set(['moss.safetensors']), (issue) =>
    issues.push(issue)
  );
  expect(scan.environments.some((environment) => environment.root === installed)).toBe(true);
  expect(scan.modelFiles.get('moss.safetensors')).toEqual([weights]);
  expect(issues).toEqual([{ code: 'COMFY_INVENTORY_SCAN_INCOMPLETE', path: denied }]);
});

it('uses the same complete application environments during installation planning', async () => {
  const installed = path.join(root, 'OpenH3', 'aionui', 'old', 'tasks', 'project', 'checkout');
  checkout(installed);
  const result = await installationEnvironments(
    [],
    [],
    async () => {
      throw new Error('offline');
    },
    [],
    [root]
  );
  expect(result.some((environment) => environment.root === installed)).toBe(true);
});

it('finishes application directory discovery beyond the old per-root entry budget', async () => {
  for (let index = 0; index < 300; index++) fs.mkdirSync(path.join(root, `task-${index}`));
  const installed = path.join(root, 'zz-final-task', 'old', 'nested', 'runtime');
  checkout(installed);
  const environments = await discoverApplicationComfyEnvironments([root]);
  expect(environments.map((environment) => environment.root)).toEqual([installed]);
});

it('does not scan generated output, logs or conversation trees while discovering application models', async () => {
  const application = path.join(root, 'OpenH3');
  const installed = path.join(application, 'task', 'runtime');
  checkout(installed);
  fs.mkdirSync(path.join(application, 'output', 'deep', 'tree'), { recursive: true });
  fs.mkdirSync(path.join(application, 'conversations', 'deep', 'tree'), { recursive: true });
  fs.writeFileSync(path.join(application, 'output', 'deep', 'tree', 'main.py'), '# not a runtime');
  fs.writeFileSync(path.join(application, 'conversations', 'deep', 'tree', 'main.py'), '# not a runtime');
  expect((await discoverApplicationComfyEnvironments([application])).map((environment) => environment.root)).toEqual([
    installed,
  ]);
});

it('discovers environments and model files together in one application filesystem pass', async () => {
  const application = path.join(root, 'OpenH3');
  const installed = path.join(application, 'task', 'ComfyUI');
  checkout(installed);
  const model = path.join(application, 'shared', 'moss.safetensors');
  fs.mkdirSync(path.dirname(model), { recursive: true });
  fs.writeFileSync(model, 'weights');
  const result = await scanApplicationComfyInventory([application], new Set(['moss.safetensors']));
  expect(result.environments.map((environment) => environment.root)).toEqual([installed]);
  expect(result.modelFiles.get('moss.safetensors')).toEqual([model]);
  expect(result.filesInspected).toBeGreaterThan(0);
  expect(result.durationMs).toBeGreaterThanOrEqual(0);
});
