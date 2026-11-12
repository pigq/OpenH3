import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ComfyGenerationInput, ComfyProfile } from '@/common/chat/document/creation/comfy';
import { buildAttemptIdentity, captureGenerationSnapshot } from '@process/services/media/comfy/routing/attempts';

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function fixture(): { directory: string; profile: ComfyProfile } {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'comfy-attempt-'));
  directories.push(directory);
  const workflowPath = path.join(directory, 'graph.json');
  fs.writeFileSync(workflowPath, '{"1":{"class_type":"SaveImage","inputs":{}}}');
  return {
    directory,
    profile: {
      id: 'base',
      family: 'z-image',
      name: 'Base',
      kind: 'image',
      version: 'r1',
      quantization: 'BF16',
      capabilities: ['text-to-image'],
      state: 'verified',
      workflowPath,
      environment: { root: directory, python: path.join(directory, 'python.exe'), baseUrl: 'http://127.0.0.1:8188' },
      components: [
        {
          role: 'diffusion',
          name: 'base',
          path: path.join(directory, 'base.safetensors'),
          version: 'r1',
          precision: 'BF16',
          sha256: 'a'.repeat(64),
        },
      ],
      nodes: [{ id: 'ComfyUI', version: 'r1' }],
      bindings: {},
      defaults: { width: 1024 },
    },
  };
}

describe('generation attempt snapshots', () => {
  it('preserves ordered reference bytes and roles in stable storage for modern and legacy inputs', async () => {
    const { directory, profile } = fixture();
    const image = path.join(directory, 'first.png');
    const video = path.join(directory, 'last.mp4');
    const imageBytes = Buffer.from('first image bytes');
    const videoBytes = Buffer.alloc(1024 * 1024 + 17, 37);
    fs.writeFileSync(image, imageBytes);
    fs.writeFileSync(video, videoBytes);
    const input: ComfyGenerationInput = {
      prompt: 'Continue the scene',
      width: 768,
      references: [
        { id: 'first', type: 'image', role: 'first-frame', path: image },
        { id: 'clip', type: 'video', role: 'reference', path: video },
      ],
    };
    const identity = buildAttemptIdentity(profile, input, { taskId: '../../task', attemptId: '../attempt' }, 4);
    const root = path.join(directory, 'snapshots');
    const result = await captureGenerationSnapshot(
      profile,
      input,
      identity,
      root,
      'environment-v1',
      new AbortController().signal
    );
    expect(result.snapshot.identity).toEqual(identity);
    expect(result.snapshot.references.map(({ id, role }) => ({ id, role }))).toEqual([
      { id: 'first', role: 'first-frame' },
      { id: 'clip', role: 'reference' },
    ]);
    expect(result.snapshot.references.map(({ sha256 }) => sha256)).toEqual(
      [imageBytes, videoBytes].map((bytes) => crypto.createHash('sha256').update(bytes).digest('hex'))
    );
    expect(result.input.imagePaths).toBeUndefined();
    expect(result.input.references?.map(({ path: file }) => file)).toEqual(
      result.snapshot.references.map(({ path: file }) => file)
    );
    expect(result.snapshot.parameters.width).toBe(768);
    expect(fs.readFileSync(result.workflowPath)).toEqual(fs.readFileSync(profile.workflowPath));
    expect(
      result.snapshot.references.every(({ path: file }) => path.relative(root, file).split(path.sep).length === 3)
    ).toBe(true);

    const legacyInput = { prompt: 'Edit', imagePaths: [image] };
    const legacy = await captureGenerationSnapshot(
      profile,
      legacyInput,
      buildAttemptIdentity(profile, legacyInput, { taskId: 'legacy', attemptId: 'one' }, 4),
      root,
      'environment-v1',
      new AbortController().signal
    );
    expect(legacy.input.references).toBeUndefined();
    expect(legacy.input.imagePaths).toEqual([legacy.snapshot.references[0].path]);
    fs.writeFileSync(image, 'source replaced');
    expect(fs.readFileSync(result.snapshot.references[0].path)).toEqual(imageBytes);
  });

  it('rejects workflow edits after reservation before creating or submitting the snapshot', async () => {
    const { directory, profile } = fixture();
    const input = { prompt: 'One image' };
    const identity = buildAttemptIdentity(profile, input, { taskId: 'task', attemptId: 'one' }, 1);
    fs.writeFileSync(profile.workflowPath, '{"changed":true}');
    const root = path.join(directory, 'snapshots');
    await expect(
      captureGenerationSnapshot(profile, input, identity, root, 'environment-v1', new AbortController().signal)
    ).rejects.toThrow('COMFY_ATTEMPT_WORKFLOW_CHANGED');
    expect(fs.existsSync(root)).toBe(false);
  });
});
