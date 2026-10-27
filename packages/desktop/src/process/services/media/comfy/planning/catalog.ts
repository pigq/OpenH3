import fs from 'node:fs';
import path from 'node:path';

export type CatalogRecord = Record<string, unknown>;
export const record = (value: unknown): CatalogRecord =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as CatalogRecord) : {};
export const records = (value: unknown): CatalogRecord[] => (Array.isArray(value) ? value.map(record) : []);
export const stringValue = (value: unknown, fallback = ''): string =>
  typeof value === 'string' && value.trim() ? value : fallback;

export type ComfyInstallCatalog = { root: string; candidates: CatalogRecord[]; baselines: CatalogRecord[] };

/** Resolve application-owned resources independently of the chat/current directory. */
export function resolveComfyResourcesRoot(explicit?: string): string {
  const processRoot = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  const starts = [
    explicit,
    process.env.OPENH3_RESOURCES_ROOT,
    processRoot,
    path.join(path.dirname(process.execPath), 'resources'),
    __dirname,
  ];
  for (const start of starts) {
    if (!start) continue;
    let parent = path.resolve(start);
    for (let level = 0; level < 12; level++) {
      for (const candidate of [parent, path.join(parent, 'resources')]) {
        if (fs.existsSync(path.join(candidate, 'skills', 'comfyui-local', 'references', 'candidates.json')))
          return candidate;
      }
      const next = path.dirname(parent);
      if (next === parent) break;
      parent = next;
    }
  }
  throw new Error('COMFY_TOOL_NOT_READY:APPLICATION_MODEL_CATALOG_MISSING');
}

/** Flatten all shipped baseline collections, including the original workflows array. */
export function loadComfyInstallCatalog(resourcesRoot?: string): ComfyInstallCatalog {
  const root = resolveComfyResourcesRoot(resourcesRoot);
  const directory = path.join(root, 'skills', 'comfyui-local', 'references');
  const candidates = record(JSON.parse(fs.readFileSync(path.join(directory, 'candidates.json'), 'utf8')));
  const workflows = record(JSON.parse(fs.readFileSync(path.join(directory, 'workflows.json'), 'utf8')));
  return {
    root,
    candidates: records(candidates.candidates),
    baselines: [
      ...records(workflows.workflows),
      ...records(record(workflows.omni).baselines),
      ...records(record(workflows.imageModels).baselines),
    ],
  };
}
