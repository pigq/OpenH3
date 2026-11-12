import { describe, expect, it } from 'vitest';
import type { ComfyProfile } from '@/common/chat/document/creation/comfy';
import {
  assertSameComfyModel,
  comfyWorkflowStatus,
  getComfyModelSetId,
  groupComfyModels,
  sameComfyModel,
} from '@/common/chat/document/creation/workflows/identity';

const base: ComfyProfile = {
  id: 'base',
  family: 'z-image',
  name: 'Base',
  kind: 'image',
  version: 'r1',
  quantization: 'BF16',
  capabilities: ['text-to-image'],
  state: 'verified',
  environment: { root: 'D:/ComfyUI', python: 'D:/python.exe', baseUrl: 'http://127.0.0.1:8188' },
  components: [
    {
      role: 'diffusion',
      name: 'base',
      path: 'D:/models/base.safetensors',
      version: 'r1',
      precision: 'BF16',
      sha256: 'a'.repeat(64),
    },
  ],
  nodes: [{ id: 'ComfyUI', version: 'r1' }],
  workflowPath: 'D:/workflows/base.json',
  bindings: {},
  defaults: {},
};

describe('model identity across workflow variants', () => {
  it('allows base to patch to base without sharing validation or changing precision', () => {
    const patch: ComfyProfile = {
      ...base,
      id: 'patch',
      state: 'downloaded',
      components: [
        ...base.components,
        {
          role: 'control',
          identityRole: 'workflow',
          name: 'patch',
          path: 'D:/models/patch.safetensors',
          version: 'r2',
          precision: 'FP16',
          sha256: 'b'.repeat(64),
        },
      ],
    };
    expect(() => assertSameComfyModel(base, patch)).not.toThrow();
    expect(() => assertSameComfyModel(patch, base)).not.toThrow();
    expect(groupComfyModels([base, patch])).toEqual([
      { modelSetId: getComfyModelSetId(base), profiles: [base, patch] },
    ]);
    expect(() =>
      assertSameComfyModel(base, {
        ...patch,
        components: [{ ...base.components[0], precision: 'FP8', sha256: 'c'.repeat(64) }, patch.components[1]],
      })
    ).toThrow('COMFY_REPAIR_MODEL_CHANGED');
    expect(
      sameComfyModel(base, {
        ...patch,
        components: patch.components.map(({ identityRole: _scope, ...component }) => component),
      })
    ).toBe(false);
    for (const changed of [
      { ...base, family: 'moss-image-base' as const },
      { ...base, quantization: 'FP8' },
    ]) {
      expect(sameComfyModel(base, changed)).toBe(false);
      expect(getComfyModelSetId(base)).not.toBe(getComfyModelSetId(changed));
    }
  });

  it('accepts metadata completion without accepting contradictory model evidence', () => {
    const unrecorded = { ...base, components: [{ ...base.components[0], sha256: undefined }] };
    const completed = { ...base, components: [{ ...base.components[0], sizeBytes: 123 }] };
    expect(sameComfyModel(unrecorded, completed)).toBe(true);
    expect(sameComfyModel(base, completed)).toBe(true);
    expect(sameComfyModel(completed, base)).toBe(true);
    expect(
      sameComfyModel(completed, {
        ...completed,
        components: [{ ...completed.components[0], sha256: 'b'.repeat(64) }],
      })
    ).toBe(false);
    expect(
      sameComfyModel(completed, {
        ...completed,
        components: [{ ...completed.components[0], sizeBytes: 456 }],
      })
    ).toBe(false);
    expect(
      sameComfyModel(unrecorded, {
        ...completed,
        components: [{ ...completed.components[0], path: 'E:/other.safetensors' }],
      })
    ).toBe(false);
  });

  it('uses immutable source evidence across local paths while leaving mutable sources isolated', () => {
    const source = `https://huggingface.co/vendor/model/resolve/${'d'.repeat(40)}/base.safetensors`;
    const pinned = { ...base, components: [{ ...base.components[0], sha256: undefined, url: source }] };
    const relocated = {
      ...pinned,
      id: 'relocated',
      name: 'Different label',
      components: [{ ...pinned.components[0], path: 'E:/base.safetensors' }],
    };
    expect(sameComfyModel(pinned, relocated)).toBe(true);
    const unknown = {
      ...pinned,
      components: [{ ...pinned.components[0], url: source.replace('d'.repeat(40), 'main') }],
    };
    expect(getComfyModelSetId(unknown)).toBe('profile:base');
    expect(sameComfyModel(unknown, { ...unknown, id: 'another' })).toBe(true);
    expect(
      sameComfyModel(unknown, {
        ...unknown,
        components: [{ ...unknown.components[0], path: 'E:/another.safetensors' }],
      })
    ).toBe(false);
    expect(groupComfyModels([unknown, { ...unknown, id: 'another' }])).toHaveLength(2);
    expect(getComfyModelSetId({ id: 'summary', kind: 'image' })).toBe('profile:summary');
  });

  it('requires this workflow execution evidence and exposes preparation failures', () => {
    const profile: ComfyProfile = {
      ...base,
      workflowSha256: 'a'.repeat(64),
      workflowMetadata: {
        id: 'base',
        revision: 'r1',
        tasks: ['text-to-image'],
        inputs: [],
        adapter: 'native',
        preparation: 'ready',
        evidence: [{ kind: 'execution', checkedAt: '2026-11-10', workflowHash: 'b'.repeat(64) }],
      },
    };
    expect(comfyWorkflowStatus(base)).toBe('verified');
    expect(comfyWorkflowStatus(profile)).toBe('pending-validation');
    profile.workflowMetadata!.evidence![0].workflowHash = 'a'.repeat(64);
    expect(comfyWorkflowStatus(profile)).toBe('verified');
    profile.workflowMetadata!.preparation = 'pending';
    expect(comfyWorkflowStatus(profile)).toBe('needs-preparation');
    profile.state = 'invalid';
    expect(comfyWorkflowStatus(profile)).toBe('needs-repair');
  });
});
