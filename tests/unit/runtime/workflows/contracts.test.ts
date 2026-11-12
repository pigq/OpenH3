import { describe, expect, it } from 'vitest';
import {
  comfyGenerationInputSchema,
  comfyInstallPlanSchema,
  comfyProfileSchema,
} from '@/common/chat/document/creation/comfy';
import { comfyWorkflowSchema } from '@/common/chat/document/creation/workflows/contracts';

const profile = {
  id: 'existing-z-image',
  family: 'z-image',
  name: 'Existing model',
  kind: 'image',
  version: 'r1',
  quantization: 'BF16',
  capabilities: ['text-to-image'],
  state: 'verified',
  environment: { root: 'D:/ComfyUI', python: 'D:/venv/python.exe', baseUrl: 'http://127.0.0.1:8188' },
  components: [
    { role: 'diffusion', name: 'base', path: 'D:/models/base.safetensors', version: 'r1', precision: 'BF16' },
  ],
  nodes: [{ id: 'ComfyUI', version: 'r1' }],
  workflowPath: 'D:/workflows/base.json',
  bindings: { prompt: [{ nodeId: '1', input: 'text' }] },
  defaults: {},
};

describe('structured workflow contracts', () => {
  it('preserves old profile identities and reference inputs without inventing roles', () => {
    expect(comfyProfileSchema.parse(profile)).toEqual(profile);
    const references = [{ type: 'image', path: 'D:/refs/old.png' }];
    expect(comfyGenerationInputSchema.parse({ prompt: 'Edit', references })).toEqual({ prompt: 'Edit', references });
    expect(comfyGenerationInputSchema.parse({ prompt: 'Edit', imagePaths: ['D:/refs/old.png'] }).imagePaths).toEqual([
      'D:/refs/old.png',
    ]);
  });

  it('keeps workflow capabilities separate from the install graph and enforces declared capacity', () => {
    const workflow = comfyWorkflowSchema.parse({
      id: 'z-image-img2img',
      revision: 'r1',
      tasks: ['image-to-image'],
      inputs: [{ role: 'edit-source', type: 'image', minCount: 1, maxCount: 1, binding: 'image' }],
      adapter: 'native',
      preparation: 'ready',
    });
    expect(comfyProfileSchema.parse({ ...profile, workflowMetadata: workflow }).workflowMetadata).toEqual(workflow);
    const graph = { '1': { class_type: 'CLIPTextEncode', inputs: { text: 'Test' } } };
    const plan = comfyInstallPlanSchema.parse({
      ...profile,
      workflow: graph,
      workflowMetadata: workflow,
      targetRoot: 'D:/ComfyUI',
      downloadBytes: 0,
      requiredBytes: 1,
      reason: 'Reuse model',
      evidence: ['Pinned graph'],
      commands: [],
      smokeInput: { prompt: 'Test' },
    });
    expect(plan.workflow).toEqual(graph);
    expect(plan.workflowMetadata).toEqual(workflow);
    expect(
      comfyWorkflowSchema.safeParse({ ...workflow, inputs: [{ ...workflow.inputs[0], maxCount: 0 }] }).success
    ).toBe(false);
  });

  it('binds each mask to a specific source with matching dimensions and orientation', () => {
    const references = [
      {
        id: 'source',
        type: 'image',
        role: 'edit-source',
        path: 'D:/source.png',
        width: 768,
        height: 512,
        orientation: 1,
      },
      {
        id: 'mask',
        type: 'image',
        role: 'mask',
        maskFor: 'source',
        path: 'D:/mask.png',
        width: 768,
        height: 512,
        orientation: 1,
      },
    ];
    expect(comfyGenerationInputSchema.parse({ prompt: 'Inpaint', references }).references).toEqual(references);
    for (const change of [{ maskFor: 'absent' }, { width: 512 }, { orientation: 6 }])
      expect(
        comfyGenerationInputSchema.safeParse({
          prompt: 'Inpaint',
          references: [references[0], { ...references[1], ...change }],
        }).success
      ).toBe(false);
  });
});
