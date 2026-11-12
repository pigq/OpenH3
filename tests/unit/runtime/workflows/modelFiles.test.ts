import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, it, expect } from 'vitest';
import type { ComfyProfile } from '@/common/chat/document/creation/comfy';
import { resolveComfyModelFiles, sameLocalComfyModel } from '@/process/services/media/comfy/routing/modelFiles';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function fixture(): ComfyProfile {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'comfy-shards-'));
  roots.push(root);
  fs.writeFileSync(
    path.join(root, 'model.safetensors.index.json'),
    JSON.stringify({
      weight_map: {
        a: 'model-1.safetensors',
        b: 'model-2.safetensors',
        c: 'model-1.safetensors',
      },
    })
  );
  for (const file of ['model-1.safetensors', 'model-2.safetensors']) fs.writeFileSync(path.join(root, file), file);
  return {
    id: 'legacy',
    family: 'moss-image-base',
    kind: 'image',
    quantization: 'BF16',
    components: [{ path: root, role: 'diffusion', name: 'MOSS', version: 'r1', precision: 'BF16' }],
  } as ComfyProfile;
}
it('matches the complete indexed shard set, independent of names/order, without accepting missing or other weights', () => {
  const legacy = fixture();
  const expanded = resolveComfyModelFiles(legacy);
  const weights = expanded.components.filter((item) => item.identityRole !== 'workflow');
  expect(weights).toHaveLength(2);
  const repaired = {
    ...legacy,
    id: 'repair',
    components: weights.toReversed().map((item) => ({ ...item, name: 'renamed', sizeBytes: 19 })),
  };
  expect(sameLocalComfyModel(legacy, repaired)).toBe(true);
  expect(
    sameLocalComfyModel(
      { ...legacy, components: [{ ...legacy.components[0], sha256: 'a'.repeat(64), sizeBytes: 999 }] },
      repaired
    )
  ).toBe(true);
  expect(sameLocalComfyModel(legacy, { ...repaired, components: repaired.components.slice(1) })).toBe(false);
  expect(
    sameLocalComfyModel(legacy, {
      ...repaired,
      components: repaired.components.map((item) => ({ ...item, path: item.path + '.other' })),
    })
  ).toBe(false);
  expect(sameLocalComfyModel(legacy, { ...repaired, quantization: 'FP8' })).toBe(false);
});
it('requires an index and rejects shard paths outside the selected directory', () => {
  const legacy = fixture();
  const index = path.join(legacy.components[0].path, 'model.safetensors.index.json');
  fs.writeFileSync(index, JSON.stringify({ weight_map: { a: '../other.safetensors' } }));
  expect(() => resolveComfyModelFiles(legacy)).toThrow('COMFY_MODEL_SHARD_PATH_INVALID');
  expect(sameLocalComfyModel(legacy, legacy)).toBe(false);
  fs.unlinkSync(index);
  expect(() => resolveComfyModelFiles(legacy)).toThrow('COMFY_MODEL_SHARD_INDEX_REQUIRED');
});
