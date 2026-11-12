import { describe, expect, it } from 'vitest';
import {
  comfyFamilySchema,
  comfyFamilyKind,
  comfyGenerationInputSchema,
  validateComfyGenerationInputForFamily,
  comfyProfileSchema,
  comfyInstallPlanSchema,
  assertComfyReferenceBindings,
  comfyWorkflowRepairReason,
} from '@/common/chat/document/creation/comfy';

const profile = {
  id: 'z-image-balanced',
  family: 'z-image',
  name: 'Z-Image balanced',
  kind: 'image',
  version: 'abc123',
  quantization: 'BF16 + BF16 encoder',
  capabilities: ['text-to-image'],
  environment: { root: 'D:/ComfyUI', python: 'D:/venv/python.exe', baseUrl: 'http://127.0.0.1:8188' },
  components: [
    {
      role: 'diffusion',
      name: 'z.safetensors',
      path: 'D:/ComfyUI/models/z.safetensors',
      version: 'abc123',
      precision: 'BF16',
    },
  ],
  nodes: [{ id: 'ComfyUI', version: 'abc123' }],
  workflowPath: 'D:/workflows/z.api.json',
  bindings: { prompt: [{ nodeId: '1', input: 'text' }] },
  defaults: {},
  state: 'downloaded',
};

describe('custom model registration contract', () => {
  it.each(['image', 'video'] as const)(
    'accepts an explicit custom %s model without impersonating a built-in family',
    (kind) => {
      const custom = comfyProfileSchema.parse({ ...profile, family: `custom-${kind}`, kind, name: `Custom ${kind}` });
      expect(custom).toMatchObject({ family: `custom-${kind}`, kind, name: `Custom ${kind}` });
      expect(comfyFamilyKind(custom.family, kind)).toBe(kind);
      expect(() => comfyFamilyKind(custom.family)).toThrow('COMFY_MODEL_KIND_REQUIRED');
    }
  );
});

describe('workflow repair classification', () => {
  it.each([
    ['COMFY_IMAGE_BINDINGS_MISSING', undefined, 'reference-bindings'],
    ['COMFY_IMAGE_BINDINGS_DUPLICATE', undefined, 'reference-bindings'],
    ['COMFY_REFERENCE_INPUT_DISCONNECTED:4', undefined, 'reference-routing'],
    ['COMFY_REFERENCE_OUTPUT_UNCONFIRMED', undefined, 'reference-routing'],
    ['COMFY_MULTIMODAL_WORKFLOW_REQUIRED', undefined, 'input-adapter'],
    ['COMFY_OMNI_REFERENCE_BINDING_MISSING', undefined, 'input-adapter'],
    ['H3_WORKFLOW_PREFLIGHT', 'MISSING_NODE', 'missing-node'],
    ['H3_WORKFLOW_PREFLIGHT', 'INVALID_INPUT', 'workflow-schema'],
    ['COMFY_PROMPT_REJECTED', 'INVALID_INPUT', 'workflow-schema'],
    ['H3_COMFY_PROMPT_REJECTED:INVALID_INPUT:node=12', undefined, 'workflow-schema'],
    ['H3_COMFY_EXECUTION_FAILED:MISSING_NODE:node=4', undefined, 'missing-node'],
    ['COMFY_BINDING_INVALID:image', undefined, 'workflow-schema'],
    ['COMFY_INPUT_UNSUPPORTED:durationSeconds', undefined, 'workflow-schema'],
    ['COMFY_NODE_REVISION_UNCONFIRMED', undefined, 'runtime-revision'],
    ['COMFY_NODE_REVISION_MISMATCH', undefined, 'runtime-revision'],
    ['COMFY_EXISTING_RUNTIME_INCOMPATIBLE:WORKFLOW_NODE_OR_INPUT_UNSUPPORTED', undefined, 'workflow-schema'],
  ])('classifies %s with %s without depending on the selected model', (error, category, expected) => {
    expect(comfyWorkflowRepairReason({ error, diagnosis: { category } })).toBe(expected);
  });

  it.each([
    'COMFY_INPUT_IMAGE_REQUIRED',
    'COMFY_INPUT_IMAGE_MISSING',
    'COMFY_REFERENCE_FILE_MISSING',
    'COMFY_REFERENCE_TYPE_MISMATCH',
    'COMFY_INSTALL_INTENT_MISMATCH',
    'COMFY_JOB_SCOPE_MISMATCH',
    'COMFY_JOB_CANCELLED',
    'CUDA_OUT_OF_MEMORY',
    'COMFY_SERVER_ENVIRONMENT_MISMATCH',
    'UNKNOWN:COMFY_IMAGE_BINDINGS_MISSING',
    'COMFY_IMAGE_BINDINGS_MISSING_EXTRA',
    'H3_COMFY_EXECUTION_FAILED:OOM:node=3',
    'H3_COMFY_PROMPT_REJECTED:MISSING_MODEL',
  ])('does not misclassify %s as a workflow capability repair', (error) => {
    expect(comfyWorkflowRepairReason({ error })).toBeUndefined();
  });
  it('requires a workflow error before interpreting a generic invalid-input diagnosis', () => {
    expect(
      comfyWorkflowRepairReason({ error: 'COMFY_INPUT_IMAGE_REQUIRED', diagnosis: { category: 'INVALID_INPUT' } })
    ).toBeUndefined();
  });
});

describe('additional image model families', () => {
  it.each(['flux-3-image-klein', 'moss-image-base', 'moss-image-sft', 'krea2'] as const)(
    'accepts %s as a distinct image profile without requiring reference media',
    (family) => {
      expect(comfyFamilySchema.parse(family)).toBe(family);
      expect(comfyFamilyKind(family)).toBe('image');
      expect(comfyProfileSchema.parse({ ...profile, family, state: 'downloaded' }).family).toBe(family);
      expect(validateComfyGenerationInputForFamily(family, { prompt: 'A detailed studio photograph.' })).toEqual({
        prompt: 'A detailed studio photograph.',
      });
    }
  );
});
describe('Comfy profile contracts', () => {
  it.each(['image', 'images', 'imagePaths', 'inputImage'])(
    'rejects duplicate %s destinations instead of overwriting an earlier reference',
    (binding) => {
      const parsed = comfyProfileSchema.parse({
        ...profile,
        bindings: {
          [binding]: [
            { nodeId: '4', input: 'image' },
            { nodeId: '4', input: 'image' },
          ],
        },
      });
      expect(() =>
        assertComfyReferenceBindings(parsed, { prompt: 'Use both people', imagePaths: ['D:/one.png', 'D:/two.png'] })
      ).toThrow('COMFY_IMAGE_BINDINGS_DUPLICATE');
    }
  );

  it('accepts distinct reference destinations and ignores unused bindings', () => {
    const parsed = comfyProfileSchema.parse({
      ...profile,
      bindings: {
        image: [
          { nodeId: '4', input: 'image' },
          { nodeId: '5', input: 'image' },
          { nodeId: '4', input: 'image' },
        ],
      },
    });
    expect(() =>
      assertComfyReferenceBindings(parsed, {
        prompt: 'Use both people',
        references: [
          { type: 'image', path: 'D:/one.png' },
          { type: 'image', path: 'D:/two.png' },
        ],
      })
    ).not.toThrow();
    expect(() => assertComfyReferenceBindings(parsed, { prompt: 'No reference' })).not.toThrow();
  });

  it('accepts the FastH3-Omni family and preserves ordered multimodal references', () => {
    expect(comfyFamilySchema.parse('fasth3-omni')).toBe('fasth3-omni');
    expect(comfyFamilyKind('fasth3-omni')).toBe('video');
    expect(comfyFamilyKind('h3')).toBe('video');
    expect(comfyFamilyKind('z-image')).toBe('image');
    const references = [
      { type: 'image', path: 'D:/refs/one.png' },
      { type: 'video', path: 'D:/refs/clip.mp4' },
      { type: 'audio', path: 'D:/refs/voice.wav' },
    ] as const;
    expect(comfyGenerationInputSchema.parse({ prompt: 'scene', references }).references).toEqual(references);
  });

  it('rejects ambiguous legacy imagePaths alongside ordered references', () => {
    expect(
      comfyGenerationInputSchema.safeParse({
        prompt: 'scene',
        imagePaths: ['D:/refs/one.png'],
        references: [{ type: 'image', path: 'D:/refs/two.png' }],
      }).success
    ).toBe(false);
    expect(comfyGenerationInputSchema.safeParse({ prompt: 'scene', imagePaths: [], references: [] }).success).toBe(
      false
    );
  });

  it('limits ordered reference counts to 9 images, 3 videos, 3 audio files, and 12 total', () => {
    const image = { type: 'image', path: 'D:/refs/image.png' } as const;
    const video = { type: 'video', path: 'D:/refs/video.mp4' } as const;
    const audio = { type: 'audio', path: 'D:/refs/audio.wav' } as const;
    expect(comfyGenerationInputSchema.safeParse({ prompt: 'scene', references: Array(9).fill(image) }).success).toBe(
      true
    );
    expect(comfyGenerationInputSchema.safeParse({ prompt: 'scene', references: Array(10).fill(image) }).success).toBe(
      false
    );
    expect(comfyGenerationInputSchema.safeParse({ prompt: 'scene', references: Array(3).fill(video) }).success).toBe(
      true
    );
    expect(comfyGenerationInputSchema.safeParse({ prompt: 'scene', references: Array(4).fill(video) }).success).toBe(
      false
    );
    expect(comfyGenerationInputSchema.safeParse({ prompt: 'scene', references: Array(3).fill(audio) }).success).toBe(
      true
    );
    expect(comfyGenerationInputSchema.safeParse({ prompt: 'scene', references: Array(4).fill(audio) }).success).toBe(
      false
    );
    expect(
      comfyGenerationInputSchema.safeParse({
        prompt: 'scene',
        references: [...Array(9).fill(image), ...Array(3).fill(video)],
      }).success
    ).toBe(true);
    expect(
      comfyGenerationInputSchema.safeParse({
        prompt: 'scene',
        references: [...Array(9).fill(image), ...Array(3).fill(video), audio],
      }).success
    ).toBe(false);
  });

  it('keeps the legacy imagePaths contract for existing callers', () => {
    expect(comfyGenerationInputSchema.parse({ prompt: 'edit', imagePaths: ['D:/refs/old.png'] }).imagePaths).toEqual([
      'D:/refs/old.png',
    ]);
  });

  it('requires an image or video reference for FastH3-Omni but accepts legacy imagePaths', () => {
    expect(() => validateComfyGenerationInputForFamily('fasth3-omni', { prompt: 'scene' })).toThrow(
      'COMFY_OMNI_REFERENCE_REQUIRED'
    );
    expect(() =>
      validateComfyGenerationInputForFamily('fasth3-omni', {
        prompt: 'scene',
        references: [{ type: 'audio', path: 'D:/refs/voice.wav' }],
      })
    ).toThrow('COMFY_OMNI_REFERENCE_REQUIRED');
    expect(
      validateComfyGenerationInputForFamily('fasth3-omni', {
        prompt: 'scene',
        imagePaths: ['D:/refs/still.png'],
      }).imagePaths
    ).toEqual(['D:/refs/still.png']);
    expect(
      validateComfyGenerationInputForFamily('fasth3-omni', {
        prompt: 'scene',
        references: [{ type: 'video', path: 'D:/refs/clip.mp4' }],
      }).references
    ).toEqual([{ type: 'video', path: 'D:/refs/clip.mp4' }]);
  });

  it('restricts Omni output duration to the released 5-15 second range', () => {
    const input = { prompt: 'scene', imagePaths: ['D:/refs/still.png'] };
    for (const durationSeconds of [5, 15])
      expect(validateComfyGenerationInputForFamily('fasth3-omni', { ...input, durationSeconds }).durationSeconds).toBe(
        durationSeconds
      );
    for (const durationSeconds of [4.99, 15.01])
      expect(() => validateComfyGenerationInputForFamily('fasth3-omni', { ...input, durationSeconds })).toThrow(
        'COMFY_OMNI_DURATION_RANGE:5:15'
      );
  });

  it('keeps mixed component precisions and distinct versions in an atomic profile', () => {
    const parsed = comfyProfileSchema.parse({
      ...profile,
      components: [
        ...profile.components,
        {
          role: 'vae',
          name: 'ae.safetensors',
          path: 'D:/ComfyUI/models/ae.safetensors',
          version: 'def456',
          precision: 'FP32',
        },
      ],
    });
    expect(parsed.components.map((component) => component.precision)).toEqual(['BF16', 'FP32']);
  });
  it('rejects remote runtime endpoints and floating component versions', () => {
    expect(
      comfyProfileSchema.safeParse({
        ...profile,
        environment: { ...profile.environment, baseUrl: 'https://example.com' },
      }).success
    ).toBe(false);
    expect(
      comfyProfileSchema.safeParse({ ...profile, components: [{ ...profile.components[0], version: 'latest' }] })
        .success
    ).toBe(false);
  });
  it('requires explicit family and an API workflow for standalone installs', () => {
    const { state: _state, ...candidate } = profile;
    const plan = {
      ...candidate,
      targetRoot: 'D:/ComfyUI',
      downloadBytes: 12,
      requiredBytes: 24,
      reason: 'Compatible target interpreter; memory budget validated',
      evidence: ['upstream workflow'],
      workflow: { '1': { class_type: 'CLIPTextEncode', inputs: { text: '' } } },
      commands: [],
      smokeInput: { prompt: 'A red sphere', width: 256, height: 256 },
    };
    expect(comfyInstallPlanSchema.safeParse(plan).success).toBe(true);
    expect(comfyInstallPlanSchema.safeParse({ ...plan, workflow: { nodes: [] } }).success).toBe(false);
  });
});
