import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ComfyGenerationInput, ComfyProfile } from '@/common/chat/document/creation/comfy';
import { ComfyService, type ComfyServiceOptions } from '@process/services/media/comfy/ComfyService';

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function fixture(workflowMode: 'auto' | 'fixed' = 'auto', prepareWorkflows?: ComfyServiceOptions['prepareWorkflows']) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'comfy-routing-'));
  directories.push(root);
  const requestId = crypto.randomUUID();
  const componentPath = path.join(root, 'base.safetensors');
  fs.writeFileSync(componentPath, 'same base weights');
  const textGraph = JSON.stringify({ '1': { class_type: 'Text', inputs: { text: '' } } });
  const imageGraph = JSON.stringify({
    '1': { class_type: 'Text', inputs: { text: '' } },
    '2': { class_type: 'LoadImage', inputs: { image: '' } },
  });
  const textPath = path.join(root, 'text.json'),
    imagePath = path.join(root, 'image.json');
  fs.writeFileSync(textPath, textGraph);
  fs.writeFileSync(imagePath, imageGraph);
  const referencePath = path.join(root, 'source.png');
  fs.writeFileSync(referencePath, 'source pixels');
  const text: ComfyProfile = {
    id: 'text',
    family: 'z-image',
    name: 'Same model',
    kind: 'image',
    version: 'r1',
    quantization: 'BF16',
    capabilities: ['text-to-image'],
    state: 'downloaded',
    environment: { root, python: path.join(root, 'python.exe'), baseUrl: 'http://127.0.0.1:8188' },
    components: [
      {
        role: 'diffusion',
        name: 'base',
        path: componentPath,
        version: 'r1',
        precision: 'BF16',
        sha256: crypto.createHash('sha256').update('same base weights').digest('hex'),
      },
    ],
    nodes: [{ id: 'ComfyUI', version: 'r1' }],
    workflowPath: textPath,
    workflowSha256: crypto.createHash('sha256').update(textGraph).digest('hex'),
    bindings: { prompt: [{ nodeId: '1', input: 'text' }] },
    defaults: {},
    workflowMetadata: {
      id: 'text-workflow',
      revision: 'r1',
      tasks: ['text-to-image'],
      inputs: [],
      adapter: 'native',
      preparation: 'ready',
    },
  };
  const image: ComfyProfile = {
    ...text,
    id: 'image',
    capabilities: ['image-to-image'],
    workflowPath: imagePath,
    workflowSha256: crypto.createHash('sha256').update(imageGraph).digest('hex'),
    bindings: { ...text.bindings, image: [{ nodeId: '2', input: 'image' }] },
    workflowMetadata: {
      id: 'image-workflow',
      revision: 'r1',
      tasks: ['image-to-image'],
      inputs: [{ role: 'edit-source', type: 'image', minCount: 1, maxCount: 1, binding: 'image' }],
      adapter: 'native',
      preparation: 'ready',
    },
  };
  const engine = {
    validate: vi.fn(async () => ({ fingerprint: 'environment', loadable: true as const })),
    snapshotFingerprint: vi.fn(async () => 'environment'),
    ensureStarted: vi.fn(async () => undefined),
    generate: vi.fn(async () => ({
      promptId: crypto.randomUUID(),
      artifacts: [{ path: path.join(root, 'output.png'), mimeType: 'image/png' }],
    })),
    resume: vi.fn(),
    cancel: vi.fn(async () => undefined),
    stopOwned: vi.fn(),
  };
  const service = new ComfyService({
    filename: path.join(root, 'state.json'),
    engine,
    install: vi.fn(async () => text),
    verifyArtifact: async () => undefined,
    prepareWorkflows,
  });
  service.register(text);
  service.register(image);
  service.bind({
    requestId,
    conversationId: 'chat',
    profileId: text.id,
    family: text.family,
    source: 'local',
    kind: 'image',
    intent: 'generate',
    workflowMode,
    ...(workflowMode === 'fixed' ? { fixedWorkflowId: text.workflowMetadata!.id } : {}),
  });
  const textInput: ComfyGenerationInput = { prompt: 'A scene', requirements: { task: 'text-to-image' } };
  const imageInput: ComfyGenerationInput = {
    prompt: 'Edit this scene',
    requirements: { task: 'image-to-image' },
    references: [{ id: 'source', type: 'image', role: 'edit-source', path: referencePath }],
  };
  return { service, engine, requestId, text, image, textInput, imageInput, referencePath };
}

it('requests workflow preparation before submitting an unbound explicit dimension', () => {
  const { service, requestId } = fixture();
  const match = service.resolveWorkflow(requestId, { prompt: 'a landscape', width: 1280, height: 720 });
  expect(match.selectedProfileId).toBeUndefined();
  expect(match.candidates[0].reasons).toContain('COMFY_INPUT_UNSUPPORTED:width');
  expect(match.action).toBe('prepare-workflow');
});

describe('workflow routing and explicit task attempts', () => {
  it('does not select a verified legacy image workflow for a request without references', async () => {
    const { service, requestId, text, image, referencePath } = fixture();
    const legacy = service.register({
      ...image,
      id: 'legacy-both-caps',
      workflowMetadata: undefined,
      capabilities: ['text-to-image', 'image-to-image'],
    });
    const validation = service.verify(requestId, legacy.id, { prompt: 'Edit', imagePaths: [referencePath] });
    await service.idle();
    expect(service.job(validation.id, { requestId }).status).toBe('succeeded');
    const resolved = service.resolveWorkflow(requestId, { prompt: 'A new scene' });
    expect(resolved.selectedProfileId).toBe(text.id);
    expect(resolved.candidates.find((candidate) => candidate.profileId === legacy.id)?.reasons).toContain(
      'COMFY_INPUT_IMAGE_REQUIRED'
    );
  });

  it('makes a verified legacy route accept declared roles after preparation without contacting the runtime', async () => {
    let enrich = false;
    let metadata: ComfyProfile['workflowMetadata'];
    const { service, engine, requestId, image, imageInput, referencePath } = fixture('auto', (profile) => ({
      profiles: [],
      pending: [],
      matchedCandidateIds: [],
      reusedProfiles:
        enrich && profile.id === 'legacy-reuse'
          ? [{ ...profile, state: 'downloaded', validation: undefined, workflowMetadata: metadata }]
          : [],
    }));
    metadata = image.workflowMetadata;
    const legacy = service.register({ ...image, id: 'legacy-reuse', workflowMetadata: undefined });
    const validation = service.verify(requestId, legacy.id, { prompt: 'Edit', imagePaths: [referencePath] });
    await service.idle();
    const receipt = service.job(validation.id, { requestId });
    expect(service.profiles().find((profile) => profile.id === legacy.id)?.state).toBe('verified');
    service.bind({ requestId, conversationId: 'chat', profileId: legacy.id, intent: 'generate', workflowMode: 'auto' });
    engine.snapshotFingerprint.mockClear().mockRejectedValue(new Error('COMFY_SERVER_UNAVAILABLE'));
    engine.ensureStarted.mockClear();
    enrich = true;
    service.prepareWorkflows(legacy.id);
    expect(service.profiles().find((profile) => profile.id === legacy.id)).toMatchObject({
      state: 'downloaded',
      workflowMetadata: metadata,
    });
    expect(service.resolveWorkflow(requestId, imageInput).selectedProfileId).toBe(legacy.id);
    expect(service.job(validation.id, { requestId })).toEqual(receipt);
    expect(engine.snapshotFingerprint).not.toHaveBeenCalled();
    expect(engine.ensureStarted).not.toHaveBeenCalled();
  });

  it('routes text to image to text within one selected model and captures stable reference bytes', async () => {
    const { service, requestId, text, image, textInput, imageInput } = fixture();
    expect(service.resolveWorkflow(requestId, textInput).selectedProfileId).toBe(text.id);
    const first = service.generate(requestId, text.id, textInput, { taskId: 'text-one', attemptId: 'text-one-a' });
    await service.idle();
    expect(service.job(first.id, { requestId }).status).toBe('succeeded');
    expect(service.resolveWorkflow(requestId, imageInput).selectedProfileId).toBe(image.id);
    const edit = service.generate(requestId, text.id, imageInput, { taskId: 'edit', attemptId: 'edit-a' });
    await service.idle();
    const completed = service.job(edit.id, { requestId });
    expect(completed.profileId).toBe(image.id);
    expect(completed.status).toBe('succeeded');
    expect(fs.readFileSync(completed.snapshot!.references[0].path, 'utf8')).toBe('source pixels');
    expect(service.resolveWorkflow(requestId, textInput).selectedProfileId).toBe(text.id);
    const returned = service.generate(requestId, image.id, textInput, { taskId: 'text-two', attemptId: 'text-two-a' });
    await service.idle();
    expect(service.job(returned.id, { requestId })).toMatchObject({ profileId: text.id, status: 'succeeded' });
    expect(service.selection(requestId).profileId).toBe(text.id);
  });

  it('keeps a fixed text workflow fixed when the new input needs an image workflow', () => {
    const { service, engine, requestId, text, imageInput } = fixture('fixed');
    expect(service.resolveWorkflow(requestId, imageInput).selectedProfileId).toBeUndefined();
    expect(() => service.generate(requestId, text.id, imageInput, { taskId: 'edit', attemptId: 'edit-a' })).toThrow(
      'COMFY_WORKFLOW_PREPARATION_REQUIRED'
    );
    expect(engine.generate).not.toHaveBeenCalled();
  });

  it('accepts distinct tasks with identical input and deduplicates one attempt across profile arguments', async () => {
    const { service, engine, requestId, text, image, textInput } = fixture();
    const first = service.generate(requestId, text.id, textInput, { taskId: 'first', attemptId: 'first-a' });
    const repeat = service.generate(requestId, image.id, textInput, { taskId: 'first', attemptId: 'first-a' });
    const second = service.generate(requestId, text.id, textInput, { taskId: 'second', attemptId: 'second-a' });
    await service.idle();
    expect(repeat.id).toBe(first.id);
    expect(second.id).not.toBe(first.id);
    expect(service.job(second.id, { requestId }).identity?.taskId).toBe('second');
    expect(engine.generate).toHaveBeenCalledTimes(2);
  });

  it('blocks a new workflow attempt while the prior submission outcome is unknown', async () => {
    const { service, engine, requestId, text, image, textInput, imageInput } = fixture();
    engine.generate.mockRejectedValueOnce(new Error('COMFY_SUBMISSION_STATE_UNKNOWN'));
    const first = service.generate(requestId, text.id, textInput, { taskId: 'scene', attemptId: 'original' });
    await service.idle();
    expect(service.job(first.id, { requestId }).submissionUncertain).toBe(true);
    expect(() =>
      service.generate(requestId, image.id, imageInput, {
        taskId: 'scene',
        attemptId: 'changed-route',
        predecessorAttemptId: 'original',
      })
    ).toThrow(`COMFY_TASK_ACTIVE:${first.id}`);
    expect(service.generate(requestId, image.id, textInput, { taskId: 'scene', attemptId: 'original' }).id).toBe(
      first.id
    );
    expect(engine.generate).toHaveBeenCalledTimes(1);
  });

  it.each([
    { mode: 'fixed' as const, preparation: 'ready' as const, error: 'COMFY_WORKFLOW_FIXED' },
    { mode: 'auto' as const, preparation: 'pending' as const, error: 'COMFY_WORKFLOW_PREPARATION_REQUIRED' },
  ])('rejects a $mode predecessor repair when its route is $preparation', async ({ mode, preparation, error }) => {
    const { service, engine, requestId, text, textInput } = fixture(mode);
    engine.generate.mockRejectedValueOnce(new Error('COMFY_MISSING_MODEL'));
    const first = service.generate(requestId, text.id, textInput, { taskId: 'scene', attemptId: 'original' });
    await service.idle();
    expect(service.job(first.id, { requestId })).toMatchObject({ status: 'failed', submissionUncertain: false });
    const repaired = service.register({
      ...text,
      id: 'repaired-text',
      workflowMetadata: { ...text.workflowMetadata!, preparation },
    });
    expect(() =>
      service.generate(requestId, repaired.id, textInput, {
        taskId: 'scene',
        attemptId: 'repair',
        predecessorAttemptId: 'original',
      })
    ).toThrow(error);
    expect(service.activity('chat').jobs).toHaveLength(1);
    expect(engine.generate).toHaveBeenCalledTimes(1);
  });
});
