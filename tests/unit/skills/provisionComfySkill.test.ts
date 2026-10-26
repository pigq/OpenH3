import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  COMFY_LOCAL_SKILL_NAME,
  COMFY_LOCAL_SKILL_PREFERENCE,
  provisionComfySkill,
  resolveComfySkillResourcePath,
} from '@/process/services/skills/provisionComfySkill';

type Skill = { name: string; location: string; source: string; is_custom: boolean };

describe('ComfyUI skill provisioning', () => {
  it('avoids the recorded multi-name ToolSearch false negative before starting installation scans', async () => {
    const entry = await fs.readFile(path.resolve('resources/skills/comfyui-local/SKILL.md'), 'utf8');
    expect(entry).toContain('"query":"openh3_comfy"');
    expect(entry).toContain('literal substring');
    expect(entry).toContain('before reading references or scanning');
    expect(entry).toContain('No deferred tools');
    expect(entry).toContain('do not prove');
  });

  let sandbox: string;
  let bundleRoot: string;
  let userRoot: string;
  let preferences: Record<string, unknown>;
  let skills: Skill[];
  let request: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'openh3-comfy-skill-'));
    bundleRoot = path.join(sandbox, 'app-resources', COMFY_LOCAL_SKILL_NAME);
    userRoot = path.join(sandbox, 'user-skills', COMFY_LOCAL_SKILL_NAME);
    preferences = {};
    skills = [];
    await fs.mkdir(path.join(bundleRoot, 'references'), { recursive: true });
    await fs.writeFile(
      path.join(bundleRoot, 'manifest.json'),
      JSON.stringify({ name: COMFY_LOCAL_SKILL_NAME, version: '1.0.0' })
    );
    await fs.writeFile(
      path.join(bundleRoot, 'SKILL.md'),
      '---\nname: comfyui-local\ndescription: Local ComfyUI\n---\nRun locally.'
    );
    await fs.writeFile(path.join(bundleRoot, 'references', 'h3.md'), 'Atomic component sets.');
    await fs.writeFile(
      path.join(bundleRoot, 'references', 'network-and-downloads.md'),
      '# Network and downloads\n\nUse a pinned source and verify its hash.'
    );
    request = vi.fn(async (method: string, endpoint: string, body?: unknown) => {
      if (method === 'GET' && endpoint === '/api/settings/client') return preferences;
      if (method === 'GET' && endpoint === '/api/skills') return skills;
      if (method === 'PUT' && endpoint === '/api/settings/client') {
        Object.assign(preferences, body);
        return;
      }
      if (method === 'POST' && endpoint === '/api/skills/import') {
        await fs.cp((body as { skill_path: string }).skill_path, userRoot, { recursive: true });
        skills = [
          {
            name: COMFY_LOCAL_SKILL_NAME,
            location: path.join(userRoot, 'SKILL.md'),
            source: 'custom',
            is_custom: true,
          },
        ];
        return { skill_name: COMFY_LOCAL_SKILL_NAME };
      }
      throw new Error(`Unexpected request: ${method} ${endpoint}`);
    });
  });

  afterEach(async () => {
    await fs.rm(sandbox, { recursive: true, force: true });
  });

  it('resolves app-controlled development and unpacked production paths', () => {
    const developmentPath = resolveComfySkillResourcePath({
      isPackaged: false,
      appPath: path.join(sandbox, 'repository'),
    });
    const packagedPath = resolveComfySkillResourcePath({
      isPackaged: true,
      appPath: path.join(sandbox, 'installation', 'resources', 'app.asar'),
      resourcesPath: path.join(sandbox, 'installation', 'resources'),
    });
    expect(developmentPath).toBe(path.join(sandbox, 'repository', 'resources', 'skills', COMFY_LOCAL_SKILL_NAME));
    expect(packagedPath).toBe(path.join(sandbox, 'installation', 'resources', 'skills', COMFY_LOCAL_SKILL_NAME));
    expect(packagedPath).not.toContain('app.asar');
    expect(() => resolveComfySkillResourcePath({ isPackaged: false, appPath: null })).toThrow('application root');
    expect(
      resolveComfySkillResourcePath({
        isPackaged: true,
        appPath: path.join(sandbox, 'installation', 'resources', 'app.asar'),
      })
    ).toBe(packagedPath);
  });

  it('packages the complete skill at the production resource path', async () => {
    const builderFile = path.resolve('packages/desktop/electron-builder.yml');
    const { load } = await import('js-yaml');
    const config = load(await fs.readFile(builderFile, 'utf8')) as {
      extraResources: Array<{ from: string; to: string }>;
    };
    expect(config.extraResources).toContainEqual({
      from: 'resources/skills/comfyui-local',
      to: 'skills/comfyui-local',
    });
    const repositoryBundle = path.resolve('resources/skills/comfyui-local');
    const entry = await fs.readFile(path.join(repositoryBundle, 'SKILL.md'), 'utf8');
    const networkReference = await fs.readFile(
      path.join(repositoryBundle, 'references', 'network-and-downloads.md'),
      'utf8'
    );
    expect(networkReference).toMatch(/ModelScope|魔搭/);
    expect(networkReference).toMatch(/SHA-256|sha256/i);
    expect(networkReference).toMatch(/resume|断点/i);
    expect(networkReference).toMatch(/12/);
    expect(networkReference).toMatch(/batch|分批/i);
    expect(networkReference).toMatch(/reachability|可达性/i);
    expect(networkReference).toMatch(/identity|身份/i);
    const sourceResolution = await fs.readFile(
      path.join(repositoryBundle, 'references', 'source-resolution.md'),
      'utf8'
    );
    expect(sourceResolution).toMatch(/ModelScope|魔搭/);
    expect(sourceResolution).toMatch(/SHA-256|sha256/i);
    expect(sourceResolution).toMatch(/receipt|收据/i);
    expect(sourceResolution).toMatch(/12/);
    expect(sourceResolution).toMatch(/batch|分批/i);
    const sourceCatalog = await fs.readFile(path.join(repositoryBundle, 'references', 'source-catalog.md'), 'utf8');
    expect(sourceCatalog).toContain('hf-mirror.com');
    const toolingReference = await fs.readFile(
      path.join(repositoryBundle, 'references', 'tooling-adapters.md'),
      'utf8'
    );
    expect(toolingReference).toContain('comfy-debug');
    expect(toolingReference).toContain('workflow_templates');
    expect(toolingReference).toContain('comfy-custom-nodes');
    expect(toolingReference).toContain('comfy-build');
    const evidenceReference = await fs.readFile(
      path.join(repositoryBundle, 'references', 'install-evidence.md'),
      'utf8'
    );
    expect(evidenceReference).toMatch(/downloaded|loadable|verified/i);
    expect(evidenceReference).toMatch(/stop|停止/i);
    const links = [...entry.matchAll(/\]\((references\/[^)]+)\)/g)].map((match) => match[1]);
    expect(links.length).toBeGreaterThan(0);
    await Promise.all(links.map((link) => fs.access(path.join(repositoryBundle, link))));
    const manifest = JSON.parse(await fs.readFile(path.join(repositoryBundle, 'manifest.json'), 'utf8')) as {
      name: string;
    };
    expect(manifest.name).toBe(COMFY_LOCAL_SKILL_NAME);
  });

  it('packages traceable candidates without claiming local verification or mixing the legacy H3 set', async () => {
    const catalog = JSON.parse(
      await fs.readFile(path.resolve('resources/skills/comfyui-local/references/candidates.json'), 'utf8')
    ) as {
      offlineApiPreparation: {
        status: string;
        conversionPerformed: boolean;
        liveRuntimeVerified: boolean;
        converter: { revision: string; sha256: string; entrypoint: string };
        coreSchemaSources: Array<{ path: string; sha256: string; sizeBytes: number }>;
      };
      candidates: Array<{
        id: string;
        family: string;
        status: string;
        verifiedOnThisMachine: boolean;
        workflow?: { revision: string; sha256: string; apiConversionRequired: boolean };
        components: Array<{
          role: string;
          name?: string;
          path?: string;
          revision: string;
          sizeBytes: number;
          sha256: string;
          url: string;
        }>;
      }>;
    };
    expect(new Set(catalog.candidates.map((candidate) => candidate.family))).toEqual(
      new Set([
        'h3',
        'fasth3-omni',
        'qwen-edit',
        'z-image',
        'flux-3-image-klein',
        'moss-image-base',
        'moss-image-sft',
        'krea2',
      ])
    );
    expect(catalog.offlineApiPreparation).toMatchObject({
      status: 'source-derived-api-baselines-discovery-only',
      conversionPerformed: true,
      liveRuntimeVerified: false,
      converter: {
        revision: expect.stringMatching(/^[a-f0-9]{40}$/),
        sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        entrypoint: 'convert_ui_to_api(workflow, object_info)',
      },
    });
    expect(catalog.offlineApiPreparation.coreSchemaSources.length).toBeGreaterThan(0);
    for (const source of catalog.offlineApiPreparation.coreSchemaSources) {
      expect(source.path).toMatch(/^(?:nodes\.py|comfy_extras\/)/);
      expect(source.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(source.sizeBytes).toBeGreaterThan(0);
    }
    for (const candidate of catalog.candidates) {
      expect(candidate.status).toBe('discovery-only');
      expect(candidate.verifiedOnThisMachine).toBe(false);
      if (candidate.workflow) {
        expect(candidate.workflow.revision).toMatch(/^[a-f0-9]{40}$/);
        expect(candidate.workflow.sha256).toMatch(/^[a-f0-9]{64}$/);
        expect(candidate.workflow.apiConversionRequired).toBe(true);
      }
      for (const component of candidate.components) {
        expect(component.revision).toMatch(/^[a-f0-9]{40}$/);
        expect(component.sha256).toMatch(/^[a-f0-9]{64}$/);
        expect(component.sizeBytes).toBeGreaterThan(0);
        expect(component.url).toContain(`/resolve/${component.revision}/`);
      }
    }
    const legacy = catalog.candidates.find((candidate) => candidate.id === 'h3-matlowai-existing-bundle-discovery')!;
    const { buildH3DownloadPlan } = await import('@/process/services/runtime/h3DownloadPlan');
    const bundle = buildH3DownloadPlan();
    for (const component of legacy.components) {
      const asset = bundle.files.find((file) => file.relativePath === component.path);
      expect(asset).toMatchObject({ sizeBytes: component.sizeBytes, sha256: component.sha256, url: component.url });
    }
    const official = catalog.candidates.find((candidate) => candidate.id === 'h3-official-int8-turbo8-discovery')!;
    expect(official.components.find((component) => component.role === 'video-vae')?.sha256).not.toBe(
      legacy.components.find((component) => component.role === 'video-vae')?.sha256
    );
  });

  it('imports the complete bundle once and records its verified content version and hash', async () => {
    await expect(provisionComfySkill(request, bundleRoot)).resolves.toBe('imported');
    expect(request).toHaveBeenCalledWith('POST', '/api/skills/import', { skill_path: bundleRoot });
    expect(preferences[COMFY_LOCAL_SKILL_PREFERENCE]).toEqual({
      version: '1.0.0',
      contentHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      location: path.join(userRoot, 'SKILL.md'),
    });
    expect(await fs.readFile(path.join(userRoot, 'references', 'h3.md'), 'utf8')).toBe('Atomic component sets.');
    expect(await fs.readFile(path.join(userRoot, 'references', 'network-and-downloads.md'), 'utf8')).toContain(
      'pinned source'
    );
    request.mockClear();
    await expect(provisionComfySkill(request, bundleRoot)).resolves.toBe('current');
    expect(request).not.toHaveBeenCalledWith('POST', expect.anything(), expect.anything());
    expect(request).not.toHaveBeenCalledWith('PUT', expect.anything(), expect.anything());
  });

  it('updates only unchanged app-owned content when bundle references change', async () => {
    await provisionComfySkill(request, bundleRoot);
    const firstStamp = preferences[COMFY_LOCAL_SKILL_PREFERENCE];
    await fs.writeFile(path.join(bundleRoot, 'references', 'h3.md'), 'New repair guidance.');
    request.mockClear();
    await expect(provisionComfySkill(request, bundleRoot)).resolves.toBe('updated');
    expect(preferences[COMFY_LOCAL_SKILL_PREFERENCE]).not.toEqual(firstStamp);
    expect(await fs.readFile(path.join(userRoot, 'references', 'h3.md'), 'utf8')).toBe('New repair guidance.');
  });

  it('upgrades an unchanged owned skill to the complete Omni bundle and does not reimport it again', async () => {
    await provisionComfySkill(request, bundleRoot);
    const repositoryBundle = path.resolve('resources/skills/comfyui-local');
    await expect(provisionComfySkill(request, repositoryBundle)).resolves.toBe('updated');
    expect(preferences[COMFY_LOCAL_SKILL_PREFERENCE]).toMatchObject({ version: '1.7.0' });
    expect(await fs.readFile(path.join(userRoot, 'references/fasth3-omni.md'), 'utf8')).toBe(
      await fs.readFile(path.join(repositoryBundle, 'references/fasth3-omni.md'), 'utf8')
    );
    const imageGuide = await fs.readFile(path.join(userRoot, 'references/z-image.md'), 'utf8');
    for (const family of ['FLUX 3 Image Klein', 'MOSS-Image-Base', 'Krea2']) expect(imageGuide).toContain(family);
    const catalog = JSON.parse(await fs.readFile(path.join(userRoot, 'references/candidates.json'), 'utf8')) as {
      candidates: Array<{ family: string }>;
    };
    expect(catalog.candidates.filter(({ family }) => family === 'fasth3-omni')).toHaveLength(4);
    request.mockClear();
    await expect(provisionComfySkill(request, repositoryBundle)).resolves.toBe('current');
    expect(request).not.toHaveBeenCalledWith('POST', expect.anything(), expect.anything());
  });

  it('recognizes a backend inventory that returns the installed directory', async () => {
    await provisionComfySkill(request, bundleRoot);
    const stamped = preferences[COMFY_LOCAL_SKILL_PREFERENCE] as { location: string };
    stamped.location = userRoot;
    skills[0].location = userRoot;
    request.mockClear();
    await expect(provisionComfySkill(request, bundleRoot)).resolves.toBe('current');
    expect(request).not.toHaveBeenCalledWith('POST', expect.anything(), expect.anything());
  });

  it('preserves a user-owned same-name skill without taking ownership', async () => {
    await fs.mkdir(userRoot, { recursive: true });
    await fs.writeFile(path.join(userRoot, 'SKILL.md'), 'User instructions');
    skills = [{ name: COMFY_LOCAL_SKILL_NAME, location: userRoot, source: 'custom', is_custom: true }];
    await expect(provisionComfySkill(request, bundleRoot)).resolves.toBe('preserved');
    expect(preferences).toEqual({});
    expect(request).not.toHaveBeenCalledWith('POST', expect.anything(), expect.anything());
    expect(await fs.readFile(path.join(userRoot, 'SKILL.md'), 'utf8')).toBe('User instructions');
  });

  it('preserves user edits to reference files even with a valid ownership stamp', async () => {
    await provisionComfySkill(request, bundleRoot);
    await fs.writeFile(path.join(userRoot, 'references', 'h3.md'), 'User component set.');
    await fs.writeFile(path.join(bundleRoot, 'SKILL.md'), 'Upgraded bundle.');
    request.mockClear();
    await expect(provisionComfySkill(request, bundleRoot)).resolves.toBe('preserved');
    expect(request).not.toHaveBeenCalledWith('POST', expect.anything(), expect.anything());
    expect(await fs.readFile(path.join(userRoot, 'references', 'h3.md'), 'utf8')).toBe('User component set.');
  });

  it('preserves replacements and extension or builtin name collisions', async () => {
    await provisionComfySkill(request, bundleRoot);
    skills[0].source = 'extension';
    request.mockClear();
    await expect(provisionComfySkill(request, bundleRoot)).resolves.toBe('preserved');
    skills[0].source = 'custom';
    skills[0].location = path.join(sandbox, 'replacement', 'SKILL.md');
    await expect(provisionComfySkill(request, bundleRoot)).resolves.toBe('preserved');
    expect(request).not.toHaveBeenCalledWith('POST', expect.anything(), expect.anything());
  });

  it('does not import or stamp content when the backend inventory is unavailable', async () => {
    request.mockImplementation(async (method: string, endpoint: string) => {
      if (endpoint === '/api/skills') throw new Error('Backend unavailable');
      if (method === 'GET') return {};
    });
    await expect(provisionComfySkill(request, bundleRoot)).rejects.toThrow('Backend unavailable');
    expect(request).not.toHaveBeenCalledWith('POST', expect.anything(), expect.anything());
    expect(preferences).toEqual({});
  });

  it('leaves failed or unverifiable imports unstamped so they cannot overwrite a future user skill', async () => {
    request.mockImplementation(async (method: string, endpoint: string) => {
      if (method === 'GET' && endpoint === '/api/settings/client') return {};
      if (method === 'GET' && endpoint === '/api/skills') return [];
      if (method === 'POST') return { skill_name: COMFY_LOCAL_SKILL_NAME };
    });
    await expect(provisionComfySkill(request, bundleRoot)).rejects.toThrow('could not be verified');
    expect(request).not.toHaveBeenCalledWith('PUT', expect.anything(), expect.anything());
  });

  it('recovers a removed app skill by importing the bundled instructions again', async () => {
    await provisionComfySkill(request, bundleRoot);
    skills = [];
    await fs.rm(userRoot, { recursive: true, force: true });
    await expect(provisionComfySkill(request, bundleRoot)).resolves.toBe('imported');
    expect(skills[0].name).toBe(COMFY_LOCAL_SKILL_NAME);
  });
});
