import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { comfyFamilyKind, comfyFamilySchema, type ComfyFamily } from '@/common/chat/document/creation/comfy';
import { readComfyModelGuide } from '@/process/services/media/comfy/planning/modelGuide';
import { loadComfyInstallCatalog, record, records } from '@/process/services/media/comfy/planning/catalog';
import { COMFY_FAMILIES } from '@/renderer/pages/guid/Creation/comfyDraft';

const resources = path.resolve('resources');
const catalog = loadComfyInstallCatalog(resources);
const expectedFamilyReferences = {
  h3: 'h3.md',
  'fasth3-omni': 'fasth3-omni.md',
  'qwen-edit': 'qwen-edit.md',
  'z-image': 'z-image.md',
  'flux-3-image-klein': 'z-image.md',
  'moss-image-base': 'z-image.md',
  'moss-image-sft': 'z-image.md',
  krea2: 'z-image.md',
} satisfies Record<ComfyFamily, string>;

describe('model-card knowledge without a predetermined install', () => {
  it('registers exactly one correctly typed card for every supported family', () => {
    expect(COMFY_FAMILIES.map(({ family }) => family).toSorted()).toEqual(comfyFamilySchema.options.toSorted());
    for (const card of COMFY_FAMILIES) expect(card.kind, card.family).toBe(comfyFamilyKind(card.family));
  });

  it('keeps all packaged candidate families aligned with the supported schema', () => {
    expect([...new Set(catalog.candidates.map(({ family }) => family))].toSorted()).toEqual(
      comfyFamilySchema.options.toSorted()
    );
  });

  it.each(comfyFamilySchema.options)('supplies matching component and workflow knowledge for %s', (family) => {
    const summary = readComfyModelGuide(family, undefined, path.resolve('resources'));
    expect(summary.family).toBe(family);
    expect(summary.execution).toBe('agent');
    expect(summary.candidates.length).toBeGreaterThan(0);
    const familyReference = path.join(resources, 'skills/comfyui-local/references', expectedFamilyReferences[family]);
    expect(fs.statSync(familyReference).isFile(), familyReference).toBe(true);
    expect(summary.references).toContain(familyReference);
    const candidate = summary.candidates.find((item) => item.workflowAvailable);
    expect(candidate).toBeDefined();
    const recipe = readComfyModelGuide(family, candidate!.id, path.resolve('resources')).recipe!;
    expect(recipe.candidate.family).toBe(family);
    expect(recipe.candidate.components.length).toBeGreaterThan(0);
    expect(recipe.workflow.candidateId).toBe(candidate!.id);
    if (family === 'h3') {
      expect(recipe.workflow.url).toBeTruthy();
      expect(recipe.workflow.apiConversionRequired).toBe(true);
    } else expect(recipe.workflow.graph).toBeTruthy();
    expect(recipe.verifiedOnThisMachine).toBe(false);
    expect('commands' in recipe).toBe(false);
  });

  // Check every advertised recipe, including additional precisions, without promoting
  // discovery-only candidates or UI templates to verified executable workflows.
  for (const family of comfyFamilySchema.options) {
    const available = readComfyModelGuide(family, undefined, resources).candidates.filter(
      (candidate) => candidate.workflowAvailable
    );
    it.each(available)('keeps $id knowledge consistent with the packaged recipe', ({ id }) => {
      const recipe = readComfyModelGuide(family, id, resources).recipe!;
      const candidate = recipe.candidate;
      const workflow = recipe.workflow;
      expect(candidate.family).toBe(family);
      expect(workflow.candidateId).toBe(id);
      expect(candidate.components.length).toBeGreaterThan(0);
      for (const component of candidate.components) {
        expect(component.revision, String(component.name)).toMatch(/^[a-f0-9]{40}$/i);
        expect(component.sha256, String(component.name)).toMatch(/^[a-f0-9]{64}$/i);
        expect(component.sizeBytes, String(component.name)).toBeGreaterThan(0);
      }
      const source = record(candidate.workflow);
      if (source.url) {
        expect(source.revision).toMatch(/^[a-f0-9]{40}$/i);
        expect(source.sha256).toMatch(/^[a-f0-9]{64}$/i);
        expect(source.url).toContain(source.revision);
      }
      if (!candidate.apiBaselineId) {
        expect(workflow.apiConversionRequired).toBe(true);
        expect(workflow.url).toBe(source.url);
        return;
      }

      // A broken declared baseline must not be hidden by the guide's UI-template fallback.
      const baseline = catalog.baselines.find((entry) => entry.id === candidate.apiBaselineId);
      expect(baseline, String(candidate.apiBaselineId)).toBeDefined();
      expect(workflow.id).toBe(candidate.apiBaselineId);
      expect(workflow.family).toBe(family);
      expect(workflow.verifiedOnThisMachine).toBe(false);
      const nodes = records(workflow.requiredNodes);
      expect(nodes.length).toBeGreaterThan(0);
      for (const node of nodes) {
        expect(node.id).toBeTruthy();
        expect(node.version).toMatch(/^(?:[a-f0-9]{40}|v\d+\.\d+\.\d+)$/i);
      }
      const corePin =
        record(candidate.runtimePins).comfyCore ?? record(candidate.nodeRequirements).researchHeadRevision;
      if (corePin) expect(nodes.find((node) => node.id === 'comfyui-core')?.version).toBe(corePin);
      const graph = record(workflow.graph);
      expect(Object.keys(graph).length).toBeGreaterThan(0);
      expect(
        crypto
          .createHash('sha256')
          .update(`${JSON.stringify(graph, null, 2)}\n`)
          .digest('hex')
      ).toBe(workflow.graphSha256);
      const bindings = record(workflow.bindings);
      expect(Object.keys(bindings).length).toBeGreaterThan(0);
      for (const [parameter, destinations] of Object.entries(bindings)) {
        expect(records(destinations).length, parameter).toBeGreaterThan(0);
        const destinationKeys = records(destinations).map(({ nodeId, input }) => JSON.stringify([nodeId, input]));
        expect(new Set(destinationKeys).size, `${id}:${parameter}:duplicate destination`).toBe(destinationKeys.length);
        for (const binding of records(destinations)) {
          const node = record(graph[String(binding.nodeId)]);
          expect(node.class_type, `${parameter}:${binding.nodeId}`).toBeTruthy();
          expect(Object.hasOwn(record(node.inputs), String(binding.input)), `${parameter}:${binding.input}`).toBe(true);
        }
      }
      for (const component of records(workflow.components)) {
        expect(candidate.components).toContainEqual(
          expect.objectContaining({
            role: component.role,
            revision: component.revision,
            sha256: component.sha256,
          })
        );
      }
      expect(workflow.capabilities).toEqual(expect.arrayContaining([expect.any(String)]));
      for (const capability of workflow.capabilities as string[]) {
        if (capability.endsWith('-to-video')) expect(comfyFamilyKind(family)).toBe('video');
        if (capability.endsWith('-to-image') || capability === 'image-edit')
          expect(comfyFamilyKind(family)).toBe('image');
      }
    });
  }

  it('rejects a different model family instead of silently substituting its recipe', () => {
    const qwen = readComfyModelGuide('qwen-edit', undefined, path.resolve('resources')).candidates[0];
    expect(() => readComfyModelGuide('moss-image-sft', qwen.id, path.resolve('resources'))).toThrow(
      'COMFY_GUIDE_CANDIDATE_NOT_FOUND'
    );
  });
});
