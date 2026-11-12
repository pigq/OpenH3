import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { ComfyProfile } from '@/common/chat/document/creation/comfy';
import { sameComfyModel } from '@/common/chat/document/creation/workflows/identity';

const shardIndexSchema = z.object({ weight_map: z.record(z.string(), z.string().min(1)) });
class ModelManifestError extends Error {}

/** Expand indexed weight directories into the exact files used by the loader. */
export function resolveComfyModelFiles(profile: ComfyProfile): ComfyProfile {
  return {
    ...profile,
    components: profile.components.flatMap((component) => {
      if (!fs.statSync(component.path, { throwIfNoEntry: false })?.isDirectory()) return [component];
      const entries = fs.readdirSync(component.path);
      const indexes = entries.filter((file) => /\.(safetensors|bin)\.index\.json$/.test(file));
      if (indexes.length !== 1) throw new ModelManifestError('COMFY_MODEL_SHARD_INDEX_REQUIRED');
      const indexPath = path.join(component.path, indexes[0]);
      let data: unknown;
      try {
        data = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
        throw new ModelManifestError('COMFY_MODEL_SHARD_INDEX_INVALID');
      }
      const index = shardIndexSchema.safeParse(data);
      if (!index.success || !Object.keys(index.data.weight_map).length)
        throw new ModelManifestError('COMFY_MODEL_SHARD_INDEX_INVALID');
      const shards = [...new Set(Object.values(index.data.weight_map))].sort();
      const files = shards.map((file) => {
        const absolute = path.resolve(component.path, file);
        const relative = path.relative(component.path, absolute);
        if (
          path.win32.isAbsolute(file) ||
          path.isAbsolute(file) ||
          !relative ||
          relative === '..' ||
          relative.startsWith(`..${path.sep}`) ||
          path.isAbsolute(relative)
        )
          throw new ModelManifestError('COMFY_MODEL_SHARD_PATH_INVALID');
        return absolute;
      });
      // File hashes, sizes and download URLs on an old directory record are not per-shard evidence.
      const { sha256: _hash, sizeBytes: _size, url: _url, sourceUrls: _sources, ...metadata } = component;
      const weights = files.map((file) => ({ ...metadata, name: path.basename(file), path: file }));
      const manifests = [
        indexPath,
        ...entries.filter((file) => file === 'config.json').map((file) => path.join(component.path, file)),
      ];
      return [
        ...weights,
        ...manifests.map((file) => ({
          ...metadata,
          role: file === indexPath ? 'model-index' : 'model-config',
          identityRole: 'workflow' as const,
          name: path.basename(file),
          path: file,
        })),
      ];
    }),
  };
}

/** Route legacy directory records and explicit shard registrations through the same model comparison. */
export function sameLocalComfyModel(left: ComfyProfile, right: ComfyProfile): boolean {
  if (left.family !== right.family || left.kind !== right.kind || left.quantization !== right.quantization)
    return false;
  try {
    return sameComfyModel(resolveComfyModelFiles(left), resolveComfyModelFiles(right));
  } catch (error) {
    // An invalid index cannot establish an equivalent route; validation reports its concrete error.
    if (error instanceof ModelManifestError) return false;
    throw error;
  }
}
