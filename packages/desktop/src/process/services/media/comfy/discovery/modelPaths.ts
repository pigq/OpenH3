import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';

type JsonRecord = Record<string, unknown>;
function record(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonRecord) : {};
}
function within(root: string, file: string): boolean {
  const relative = path.relative(root, file);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/** Resolve only directories explicitly declared in the existing ComfyUI config. */
export function configuredModelDirectories(root: string, modelsRoot: string, categories: string[]): string[] {
  const directories = categories.map((category) => path.join(modelsRoot, category));
  const config = path.join(root, 'extra_model_paths.yaml');
  try {
    if (fs.statSync(config).size > 1024 * 1024) return directories;
    const groups = record(yaml.load(fs.readFileSync(config, 'utf8'), { schema: yaml.JSON_SCHEMA }));
    for (const group of Object.values(groups).map(record).slice(0, 32)) {
      const base = typeof group.base_path === 'string' ? path.resolve(root, group.base_path) : root;
      for (const category of categories) {
        const value = group[category];
        if (typeof value !== 'string') continue;
        for (const relative of value
          .split(/\r?\n/)
          .map((entry) => entry.trim())
          .filter(Boolean)
          .slice(0, 16))
          directories.push(path.resolve(base, relative));
      }
    }
  } catch {
    // Missing or invalid optional paths do not prevent discovering the default tree.
  }
  return [...new Set(directories)];
}

/** Find exact catalog basenames in configured model folders, with strictly bounded depth and entries. */
export function indexComfyModelFiles(
  directories: string[],
  names: Set<string>
): { files: Map<string, string[]>; directories: string[] } {
  const files = new Map<string, string[]>();
  const watched = new Set(directories);
  let visited = 0;
  let inspected = 0;
  const visit = (root: string, directory: string, depth: number): void => {
    if (visited >= 128 || inspected >= 4096 || depth > 2) return;
    visited++;
    watched.add(directory);
    let entries: fs.Dirent[];
    try {
      if (!within(root, fs.realpathSync(directory))) return;
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (inspected++ >= 4096) return;
      if (entry.isSymbolicLink()) continue;
      const file = path.join(directory, entry.name);
      if (entry.isFile() && names.has(entry.name)) files.set(entry.name, [...(files.get(entry.name) ?? []), file]);
      else if (entry.isDirectory() && !entry.name.startsWith('.')) visit(root, file, depth + 1);
    }
  };
  for (const directory of directories.slice(0, 128)) {
    try {
      const resolved = fs.realpathSync(directory);
      visit(resolved, resolved, 0);
    } catch {
      // Configured removable disks may be offline.
    }
  }
  return { files, directories: [...watched] };
}
