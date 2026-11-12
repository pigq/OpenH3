import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { describe, expect, it } from 'vitest';
import { readComfyModelGuide } from '@/process/services/media/comfy/planning/modelGuide';
import { loadComfyInstallCatalog } from '@/process/services/media/comfy/planning/catalog';
import { parseComfyWorkflowCatalog } from '@/process/services/media/comfy/routing/catalog';
import { validateComfyWorkflow } from '@/process/services/runtime/h3WorkflowPreflight';
import type { ComfyProfile } from '@/common/chat/document/creation/comfy';
import { prepareComfyWorkflowVariants } from '@/process/services/media/comfy/routing/preparation';
import { getComfyModelSetId } from '@/common/chat/document/creation/workflows/identity';

const resources = path.resolve('resources');
const catalog = loadComfyInstallCatalog(resources);
const bundle = JSON.parse(
  fs.readFileSync(path.join(resources, 'skills/comfyui-local/references/workflows.json'), 'utf8')
);

describe('same-model workflow catalog', () => {
  it('materializes reference and text routes from one installed model set, preserving the runtime and clearing verification', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'comfy-workflow-preparation-'));
    try {
      const candidate = catalog.candidates.find((entry) => entry.id === 'z-image-turbo-bf16-discovery')!;
      const components = (candidate.components as Array<Record<string, unknown>>).map((component) => {
        const file = path.join(root, 'models', String(component.directory), 'existing', `renamed-${component.name}`);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, 'existing fixture weights; identity is supplied by the registered profile');
        return {
          role: String(component.role),
          name: path.basename(file),
          path: file,
          version: String(component.revision),
          precision: String(component.precision),
          sha256: String(component.sha256),
        };
      });
      const profile: ComfyProfile = {
        id: 'installed-z-image',
        family: 'z-image',
        kind: 'image',
        name: 'Existing Z-Image Turbo',
        version: 'pinned-v1',
        quantization: 'BF16',
        capabilities: ['text-to-image'],
        state: 'verified',
        environment: { root, python: path.join(root, 'python.exe'), baseUrl: 'http://127.0.0.1:8188' },
        components,
        nodes: [{ id: 'ComfyUI', version: 'actual-existing-core' }],
        workflowPath: path.join(root, 'original.json'),
        bindings: {},
        defaults: {},
        validation: { checkedAt: '2026-11-10', fingerprint: 'original-only' },
      };
      const result = prepareComfyWorkflowVariants(profile, path.join(root, 'prepared'), catalog);
      expect(result.pending).toEqual([]);
      expect(result.profiles).toHaveLength(2);
      const image = result.profiles.find((entry) => entry.workflowMetadata?.tasks.includes('image-to-image'))!;
      const graph = JSON.parse(fs.readFileSync(image.workflowPath, 'utf8'));
      expect(graph['57:28'].inputs.unet_name).toBe(`existing/renamed-z_image_turbo_bf16.safetensors`);
      expect(graph['57:3'].inputs.latent_image).toEqual(['103', 0]);
      expect(image.components).toEqual(profile.components);
      expect(image.environment).toEqual(profile.environment);
      expect(image.nodes).toEqual(profile.nodes);
      expect(image.state).toBe('downloaded');
      expect(image.validation).toBeUndefined();
      expect(image.workflowMetadata).toMatchObject({ preparation: 'ready', revision: image.workflowSha256 });
      expect(crypto.createHash('sha256').update(fs.readFileSync(image.workflowPath)).digest('hex')).toBe(
        image.workflowSha256
      );
      expect(image.workflowMetadata?.evidence?.[0].workflowHash).toBe(image.workflowSha256);
      const reused = prepareComfyWorkflowVariants(image, path.join(root, 'prepared'), catalog);
      expect(reused.profiles).toHaveLength(1);
      expect(reused.reusedProfiles?.map((entry) => entry.id)).toEqual([image.id]);
      expect(reused.reusedProfiles?.[0].validation).toBeUndefined();
      const inventory = prepareComfyWorkflowVariants(image, path.join(root, 'prepared'), catalog, result.profiles);
      expect(inventory.profiles).toEqual([]);
      expect(inventory.reusedProfiles).toHaveLength(2);
      expect(
        prepareComfyWorkflowVariants(
          {
            ...profile,
            components: components.map((component) => Object.assign({}, component, { sha256: undefined })),
          },
          path.join(root, 'unknown'),
          catalog
        )
      ).toMatchObject({ profiles: [], unmatchedReason: 'COMFY_CATALOG_MODEL_IDENTITY_UNMATCHED' });
      const unavailable = prepareComfyWorkflowVariants(
        { ...profile, nodes: [{ id: 'unrelated-runtime', version: 'v1' }] },
        path.join(root, 'missing'),
        catalog
      );
      expect(unavailable.profiles).toEqual([]);
      expect(unavailable.pending.map((entry) => entry.reason)).toEqual([
        'COMFY_WORKFLOW_NODES_REQUIRED',
        'COMFY_WORKFLOW_NODES_REQUIRED',
      ]);
      const legacyCandidate = catalog.candidates.find((entry) => entry.id === 'h3-matlowai-existing-bundle-discovery')!;
      const legacyComponents = (legacyCandidate.components as Array<Record<string, unknown>>).map((component) => {
        const file = path.join(root, String(component.path));
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, 'existing legacy model fixture');
        return {
          role: component.role === 'text-encoder' ? 'encoder' : String(component.role),
          name: path.basename(file),
          path: file,
          version: String(component.revision),
          precision: component.role === 'text-encoder' ? 'NVFP4-AWQ' : 'INT8-ConvRot',
          sha256: String(component.sha256),
        };
      });
      const legacy: ComfyProfile = {
        ...profile,
        id: 'existing-legacy-h3',
        family: 'h3',
        kind: 'video',
        components: legacyComponents,
        nodes: [
          { id: 'ComfyUI', version: 'v0.35.0' },
          ...(legacyCandidate.nodes as Array<Record<string, unknown>>).map((node) => ({
            id: String(node.repository).split('/').at(-1)! + '-' + node.revision,
            version: String(node.revision),
          })),
        ],
      };
      const legacyPrepared = prepareComfyWorkflowVariants(legacy, path.join(root, 'legacy-prepared'), catalog);
      expect(legacyPrepared.pending).toEqual([]);
      expect(legacyPrepared.profiles).toHaveLength(3);
      expect(legacyPrepared.profiles[0].components.find((component) => component.role === 'encoder')).toBeDefined();
      const canonicalLegacy = {
        ...legacy,
        components: legacy.components.map((component) =>
          Object.assign({}, component, { role: component.role === 'encoder' ? 'text-encoder' : component.role })
        ),
      };
      expect(getComfyModelSetId(legacy)).toBe(getComfyModelSetId(canonicalLegacy));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('retains the baseline while preparing the evidenced reference route with no new weights', () => {
    const recipe = readComfyModelGuide('z-image', 'z-image-turbo-bf16-discovery', resources).recipe!;
    expect(recipe.workflow.id).toBe('z-image-turbo-bf16-api-discovery');
    expect(recipe.workflows.map((workflow) => workflow.id)).toEqual([
      'z-image-turbo-bf16-api-discovery',
      'z-image-turbo-bf16-img2img-api-v1',
    ]);
    const routes = parseComfyWorkflowCatalog(catalog).filter((entry) => entry.family === 'z-image');
    expect(routes[1].metadata.inputs).toEqual([
      { role: 'edit-source', type: 'image', minCount: 1, maxCount: 1, binding: 'image', bindingIndex: 0 },
    ]);
    expect(routes[1].preparation.additionalBytes).toBe(0);
    expect(routes[1].preparation.sharedComponents).toEqual(routes[0].preparation.sharedComponents);
    expect(routes[1].metadata.preparation).toBe('pending');
    expect(routes[1].metadata.evidence?.map((item) => item.kind)).toEqual(['recipe']);
    const graph = bundle.variants[0].graph;
    expect(graph['57:3'].inputs).toMatchObject({ denoise: 0.55, latent_image: ['103', 0] });
    expect(graph['102'].inputs).toEqual({ pixels: ['101', 0], vae: ['57:29', 0] });
    expect(graph['57:13']).toBeUndefined();
  });

  it('checks every shipped variant, binding and component identity across all eight families', () => {
    const entries = parseComfyWorkflowCatalog(catalog);
    expect(new Set(entries.map(({ family }) => family)).size).toBe(8);
    expect(entries).toHaveLength(catalog.baselines.length);
    expect(entries.every(({ metadata }) => !metadata.inputs.some(({ role }) => role === 'identity'))).toBe(true);
    const broken = structuredClone(catalog);
    broken.baselines[0].graphSha256 = '0'.repeat(64);
    expect(() => parseComfyWorkflowCatalog(broken)).toThrow('COMFY_CATALOG_GRAPH_MISMATCH');
    const wrongModel = structuredClone(catalog);
    const component = (wrongModel.baselines[0].components as Array<{ sha256: string }>)[0];
    component.sha256 = '0'.repeat(64);
    expect(() => parseComfyWorkflowCatalog(wrongModel)).toThrow('COMFY_CATALOG_COMPONENT_IDENTITY');
  });

  it('restores the source-backed Qwen second image without claiming local multi-image execution', () => {
    const route = bundle.variants.find((entry: { id: string }) => entry.id.includes('two-image'));
    validateComfyWorkflow(route.graph, bundle.workflows[1].conversion.sourceDerivedObjectInfo);
    expect(route.bindings.image).toEqual([
      { nodeId: '41', input: 'image' },
      { nodeId: '83', input: 'image' },
    ]);
    for (const node of ['170:149', '170:151']) {
      expect(route.graph[node].inputs.image2).toEqual(bundle.workflows[1].conversion.convertedApi[node].inputs.image2);
    }
    expect(route.workflowMetadata.inputs.map((input: { role: string }) => input.role)).toEqual([
      'edit-source',
      'reference',
    ]);
    expect(route.verifiedOnThisMachine).toBe(false);
  });

  it('keeps H3 embedded routes on the legacy fused set and does not advertise missing media adapters', () => {
    const entries = parseComfyWorkflowCatalog(catalog).filter(({ family }) => family === 'h3');
    expect(entries.map(({ metadata }) => metadata.tasks[0])).toEqual([
      'text-to-video',
      'image-to-video',
      'reference-to-video',
    ]);
    const embedded = JSON.parse(
      fs.readFileSync('packages/desktop/src/process/services/runtime/h3EmbeddedWorkflows.json', 'utf8')
    );
    for (const entry of entries) {
      const workflow = bundle.variants.find((item: { id: string }) => item.id === entry.metadata.id);
      const source = workflow.derivation.originalTemplate;
      expect(crypto.createHash('sha256').update(Buffer.from(embedded[source.path], 'base64')).digest('hex')).toBe(
        source.sha256
      );
      expect(entry.metadata.adapter).toBe('native');
      expect(entry.metadata.inputs.every(({ type }) => type === 'image')).toBe(true);
      expect(entry.preparation.additionalBytes).toBe(0);
    }
    expect(entries[0].metadata.inputs).toEqual([]);
    expect(entries[1].metadata.inputs[0].role).toBe('first-frame');
  });
});
