import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { importLegacyH3, startLegacyH3Runtime } from '@/process/services/media/comfy/discovery/legacyH3';
import embedded from '@/process/services/runtime/h3EmbeddedWorkflows.json';
import { matlowaiCompleteOfflineBundle } from '@/process/services/runtime/h3OfflineBundle';
import type { H3PortableInstallStatus } from '@/process/services/runtime/H3PortableInstaller';

let root: string;
let install: H3PortableInstallStatus;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'comfy-legacy-'));
  install = {
    bundleRoot: root,
    runtimeRoot: path.join(root, 'runtime', 'portable'),
    modelsDirectory: path.join(root, 'models'),
    runtimePresent: true,
    bundleVerified: true,
    missingAssets: [],
    missingCustomNodes: [],
  };
  for (const [relative, content] of Object.entries(embedded)) {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, Buffer.from(content, 'base64'));
  }
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
describe('legacy H3 discovery', () => {
  it('starts matching legacy profiles with the existing portable acceleration launcher', async () => {
    const ensureStarted = vi.fn(async () => ({}));
    const profile = importLegacyH3(install, 'http://127.0.0.1:8188')[0];
    expect(
      await startLegacyH3Runtime(profile, { installStatus: () => install, ensureStarted }, profile.environment.baseUrl)
    ).toBe(true);
    expect(ensureStarted).toHaveBeenCalledExactlyOnceWith({ allowInstall: false });
  });
  it.each(['root', 'python', 'baseUrl', 'launchArgs', 'family'] as const)(
    'does not redirect a different %s selection to the legacy runtime',
    async (field) => {
      const ensureStarted = vi.fn(async () => ({}));
      const profile = importLegacyH3(install, 'http://127.0.0.1:8188')[0];
      if (field === 'family') profile.family = 'fasth3-omni';
      else if (field === 'launchArgs') profile.environment.launchArgs = ['--cpu'];
      else profile.environment[field] += '-other';
      expect(
        await startLegacyH3Runtime(profile, { installStatus: () => install, ensureStarted }, 'http://127.0.0.1:8188')
      ).toBe(false);
      expect(ensureStarted).not.toHaveBeenCalled();
    }
  );
  it('imports pinned per-task recipes as unverified and preserves every existing workflow', () => {
    const before = Object.keys(embedded).map((file) => ({
      file,
      content: fs.readFileSync(path.join(root, file)),
      mtime: fs.statSync(path.join(root, file)).mtimeMs,
    }));
    const profiles = importLegacyH3(install, 'http://127.0.0.1:8188');
    expect(profiles).toHaveLength(3);
    expect(new Set(profiles.map((profile) => profile.id)).size).toBe(3);
    const manifest = matlowaiCompleteOfflineBundle();
    for (const profile of profiles) {
      expect(profile.state).toBe('downloaded');
      expect(profile.capabilities).toContain('native-audio');
      expect(profile.validation).toMatchObject({ error: 'COMFY_LEGACY_REVALIDATION_REQUIRED' });
      expect(profile.validation?.promptId).toBeUndefined();
      expect(profile.environment.launchArgs).toContain(install.modelsDirectory);
      expect(profile.bindings.durationSeconds).toEqual([{ nodeId: '133', input: 'value' }]);
      const graph = JSON.parse(fs.readFileSync(profile.workflowPath, 'utf8'));
      for (const bindings of Object.values(profile.bindings))
        for (const binding of bindings) expect(graph[binding.nodeId].inputs).toHaveProperty(binding.input);
      for (const component of profile.components) {
        const pinned = manifest.files.find((file) => path.join(root, file.relativePath) === component.path);
        expect(component.sha256).toBe(pinned?.sha256);
        expect(component.version).not.toMatch(/^(latest|main)$/);
      }
    }
    expect(profiles.find((profile) => profile.capabilities.includes('text-to-video'))?.bindings.image).toBeUndefined();
    expect(
      profiles
        .filter((profile) => profile.capabilities.includes('image-to-video'))
        .every((profile) => profile.bindings.image)
    ).toBe(true);
    for (const file of before) {
      expect(fs.readFileSync(path.join(root, file.file))).toEqual(file.content);
      expect(fs.statSync(path.join(root, file.file)).mtimeMs).toBe(file.mtime);
    }
  });
  it('does not report altered workflows or incomplete legacy files as verified', () => {
    const file = path.join(root, Object.keys(embedded)[0]);
    fs.appendFileSync(file, '\n');
    const profiles = importLegacyH3(install, 'http://127.0.0.1:8188');
    expect(profiles.find((profile) => profile.workflowPath === file)).toMatchObject({
      state: 'invalid',
      validation: { error: 'COMFY_WORKFLOW_HASH_MISMATCH' },
    });
    expect(importLegacyH3({ ...install, runtimePresent: false }, 'http://127.0.0.1:8188')).toEqual([]);
    expect(importLegacyH3({ ...install, missingAssets: ['model'] }, 'http://127.0.0.1:8188')).toEqual([]);
  });
});
