import fs from 'node:fs';
import path from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { candidatePython, type ComfyEnvironmentCandidate } from './environment';
import type { ComfyInventoryDiagnostic } from '@/common/chat/document/creation/comfy';

const key = (value: string): string => (process.platform === 'win32' ? value.toLowerCase() : value);
const within = (root: string, file: string): boolean => {
  const relative = path.relative(root, file);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};
const dependencyDirectories = new Set([
  '.git',
  'node_modules',
  '__pycache__',
  'site-packages',
  'output',
  'input',
  'temp',
  'logs',
  'conversations',
  'cache',
  'skills',
  'h3-artifacts',
  'cloud-video',
  'media-jobs',
  'comfy-snapshots',
  'comfy-discovered-workflows',
  'comfy-legacy-workflows',
  'comfy-observed-output',
  'bundled-python',
  'bundled-git',
  'bundled-openh3-core',
  'managed-resources',
  'ffmpeg',
  'pet-states',
  'scripts',
  'python_embeded',
  'gpuCache'.toLowerCase(),
  'code cache',
  'dawngraphitecache',
]);
const dependencyFiles = new Set(['sqlite', 'sqlite-wal', 'sqlite-shm', 'log', 'log.gz', 'zip', '7z', 'tar', 'tgz']);

/** Active profile layouts can contain both old aionui and new OpenH3 data folders. */
export function applicationComfyRoots(dataDir: string, _resourcesRoot?: string): string[] {
  const data = path.resolve(dataDir);
  const parent = path.dirname(data);
  const roots = [data];
  if (
    /^(?:aionui|openh3)$/i.test(path.basename(data)) &&
    /^(?:aionui|openh3)(?:-dev(?:-2)?)?$/i.test(path.basename(parent))
  )
    roots.unshift(parent);
  // The packaged installation directory contains runtime bundles and native
  // dependencies, not user model state. Scanning it makes inventory slow and
  // can turn unrelated resource permissions into a false unavailable result.
  return [...new Set(roots)];
}

export function isApplicationComfyPath(file: string, roots: string[]): boolean {
  try {
    const resolved = fs.realpathSync(file);
    return roots.some((root) => {
      try {
        return within(fs.realpathSync(root), resolved);
      } catch {
        return false;
      }
    });
  } catch {
    return false;
  }
}

/** Finish each declared application tree, yielding to the service between batches.
 * Never turn a budget cutoff or unreadable subtree into a completed empty scan. */
type WalkResult = { directories: string[]; filesInspected: number; durationMs: number };
async function walkApplicationFiles(
  roots: string[],
  onFile: (file: string) => void,
  onIssue?: (issue: ComfyInventoryDiagnostic) => void
): Promise<WalkResult> {
  const started = Date.now();
  const visited = new Set<string>();
  const directories: string[] = [];
  let entries = 0;
  let filesInspected = 0;
  const addFile = (file: string): void => {
    if (dependencyFiles.has(path.extname(file).slice(1).toLowerCase())) return;
    filesInspected++;
    onFile(file);
  };
  for (const root of roots) {
    let canonical: string;
    try {
      canonical = await fs.promises.realpath(root);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      if (!onIssue) throw new Error('COMFY_INVENTORY_SCAN_INCOMPLETE', { cause: error });
      onIssue({ code: 'COMFY_INVENTORY_SCAN_INCOMPLETE', path: root });
      continue;
    }
    if (canonical === path.parse(canonical).root) throw new Error('COMFY_APPLICATION_ROOT_REQUIRED');
    const queue = [canonical];
    for (let i = 0; i < queue.length; i++) {
      try {
        const directory = await fs.promises.realpath(queue[i]);
        if (!within(canonical, directory) || visited.has(key(directory))) continue;
        visited.add(key(directory));
        directories.push(directory);
        const handle = await fs.promises.opendir(directory);
        for await (const entry of handle) {
          if (++entries % 128 === 0) await setImmediate();
          const file = path.join(directory, entry.name);
          if (entry.isDirectory()) {
            if (!dependencyDirectories.has(entry.name.toLowerCase())) queue.push(file);
          } else if (entry.isSymbolicLink()) {
            let target: string;
            try {
              target = await fs.promises.realpath(file);
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
              throw error;
            }
            if (!within(canonical, target)) continue;
            const stat = await fs.promises.stat(target);
            if (stat.isDirectory() && !dependencyDirectories.has(entry.name.toLowerCase())) queue.push(target);
            else if (stat.isFile()) addFile(file);
          } else if (entry.isFile()) addFile(file);
        }
      } catch (error) {
        if (!onIssue) throw new Error('COMFY_INVENTORY_SCAN_INCOMPLETE', { cause: error });
        onIssue({ code: 'COMFY_INVENTORY_SCAN_INCOMPLETE', path: queue[i] });
      }
    }
  }
  return { directories, filesInspected, durationMs: Date.now() - started };
}

export type ApplicationComfyInventory = {
  environments: ComfyEnvironmentCandidate[];
  modelFiles: Map<string, string[]>;
  directories: string[];
  filesInspected: number;
  durationMs: number;
};

/** Recognize source markers and local virtual environments, independently of task names. */
export async function scanApplicationComfyInventory(
  roots: string[],
  names: Set<string>,
  onIssue?: (issue: ComfyInventoryDiagnostic) => void
): Promise<ApplicationComfyInventory> {
  const modelFiles = new Map<string, string[]>();
  const environments: ComfyEnvironmentCandidate[] = [];
  const interpreters: Array<{ root: string; python: string }> = [];
  const scan = await walkApplicationFiles(
    roots,
    (file) => {
      const directory = path.dirname(file);
      const filename = path.basename(file);
      if (names.has(filename)) modelFiles.set(filename, [...new Set([...(modelFiles.get(filename) ?? []), file])]);
      if (filename === 'pyvenv.cfg') {
        const python = [path.join(directory, 'Scripts', 'python.exe'), path.join(directory, 'bin', 'python')].find(
          (candidate) => fs.existsSync(candidate)
        );
        if (python) interpreters.push({ root: directory, python });
      }
      if (
        filename !== 'main.py' ||
        !fs.existsSync(path.join(directory, 'folder_paths.py')) ||
        !fs.existsSync(path.join(directory, 'comfy')) ||
        environments.some((environment) => key(environment.root) === key(directory))
      )
        return;
      environments.push({ root: directory, python: candidatePython(directory), reason: 'recent-path' });
    },
    onIssue
  );
  for (const environment of environments) {
    if (environment.python) continue;
    const nearby = interpreters.filter(
      (interpreter) =>
        key(path.dirname(interpreter.root)) === key(environment.root) ||
        key(path.dirname(interpreter.root)) === key(path.dirname(environment.root))
    );
    if (nearby.length === 1) environment.python = nearby[0].python;
  }
  return { environments, modelFiles, ...scan };
}

export async function discoverApplicationComfyEnvironments(roots: string[]): Promise<ComfyEnvironmentCandidate[]> {
  return (await scanApplicationComfyInventory(roots, new Set())).environments;
}

/** Index all configured model subdirectories for application-owned installations. */
export async function indexApplicationComfyModelFiles(
  directories: string[],
  names: Set<string>
): Promise<{
  files: Map<string, string[]>;
  directories: string[];
}> {
  const scan = await scanApplicationComfyInventory(directories, names);
  return { files: scan.modelFiles, directories: [...new Set([...directories, ...scan.directories])] };
}
