import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import {
  comfyInstallPlanSchema,
  comfyProfileSchema,
  type ComfyInstallPlan,
  type ComfyProfile,
} from '@/common/chat/document/creation/comfy';
import { downloadH3FromSources } from '@/process/services/runtime/h3Downloader';
import type { ComfyWorkflowEngine, ComfyGenerationResult } from './workflowEngine';
import { verifyComfySmokeArtifact, type ComfySmokeContext } from './mediaValidation';
import { runComfyInstallSmoke, type ComfySmokeReceipt as SmokeReceipt } from './smokeRunner';
import type { ComfyRuntimeCoordinator } from './runtimeCoordinator';

export type ComfyInstallCommandOptions = {
  cwd: string;
  signal: AbortSignal;
  windowsHide: true;
  shell: false;
  onOutput?: (text: string) => void;
};
export type ComfyInstallCommandResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
  stdoutTruncated?: boolean;
  stderrTruncated?: boolean;
};
export type ComfyInstallCommandRunner = (
  executable: string,
  args: string[],
  options: ComfyInstallCommandOptions
) => Promise<ComfyInstallCommandResult>;
export type ComfyInstallExecutorOptions = {
  engine: Pick<ComfyWorkflowEngine, 'validate' | 'generate' | 'snapshotFingerprint'> &
    Partial<
      Pick<ComfyWorkflowEngine, 'assertInstallable' | 'stopOwned' | 'resume' | 'clearMemory' | 'runtimeResourceKey'>
    >;
  runtimeCoordinator?: ComfyRuntimeCoordinator;
  download?: typeof downloadH3FromSources;
  /** Independent component transfers share a bounded pool; each retains its own resume receipt. */
  downloadConcurrency?: number;
  runCommand?: ComfyInstallCommandRunner;
  freeBytes?: (file: string) => Promise<number | { freeBytes: number; volume: string }>;
  snapshotRoot?: string;
  snapshotFiles?: string[];
  onProfile?: (profile: ComfyProfile) => void;
  /** Authorized runtime bootstrap, after repair snapshots and before component writes. */
  prepareRuntime?: (
    plan: ComfyInstallPlan,
    signal: AbortSignal,
    onProgress?: (message: string) => void
  ) => Promise<void>;
  verifyArtifact?: (
    artifact: { path: string; mimeType: string },
    kind: ComfyProfile['kind'],
    signal: AbortSignal,
    context?: ComfySmokeContext
  ) => Promise<void>;
};
export class ComfyInstallError extends Error {
  constructor(
    message: string,
    readonly snapshotDirectory: string,
    cause?: unknown
  ) {
    super(message, { cause });
    this.name = 'ComfyInstallError';
  }
}
const MAX_LOG_BYTES = 64 * 1024;
export { verifyComfySmokeArtifact } from './mediaValidation';
function checkedAbort(signal: AbortSignal): void {
  if (signal.aborted) throw new Error('COMFY_INSTALL_CANCELLED');
}
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`)
      .join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
type VenvEvidence = { executable: string; version: string; prefix: string; baseExecutable: string };
type VenvReceipt = {
  evidence: VenvEvidence;
  python: ReturnType<typeof fileIdentity>;
  configHash: string;
  source: ReturnType<typeof fileIdentity>;
};
function profileFromPlan(plan: ComfyInstallPlan): ComfyProfile {
  const {
    targetRoot: _targetRoot,
    downloadBytes: _downloadBytes,
    requiredBytes: _requiredBytes,
    reason: _reason,
    evidence: _evidence,
    workflow: _workflow,
    workflowSource: _workflowSource,
    reuseOnlyPaths: _reuseOnlyPaths,
    commands: _commands,
    smokeInput: _smokeInput,
    repair: _repair,
    ...fields
  } = plan;
  const workflowSha256 = crypto.createHash('sha256').update(workflowBytes(plan)).digest('hex');
  return { ...fields, workflowSha256, state: 'downloaded' };
}
function recipe(profile: ComfyProfile): string {
  const { validation: _validation, state: _state, ...fields } = profile;
  return stable(fields);
}
function workflowBytes(plan: ComfyInstallPlan): string {
  if (plan.workflowSource) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(plan.workflowSource);
    } catch {
      throw new Error('COMFY_WORKFLOW_SOURCE_INVALID');
    }
    const source =
      parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
    const executionGraph = Object.fromEntries(
      Object.entries(source).map(([id, value]) => {
        const node =
          value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
        return [id, { class_type: node.class_type, inputs: node.inputs }];
      })
    );
    if (stable(executionGraph) !== stable(plan.workflow)) throw new Error('COMFY_WORKFLOW_SOURCE_GRAPH_MISMATCH');
    return plan.workflowSource;
  }
  return JSON.stringify(plan.workflow, null, 2) + '\n';
}
/** Preserve source files without depending on a package that the repair itself may install. */
function snapshotNativeSources(plan: ComfyInstallPlan, directory: string, signal: AbortSignal): void {
  const root = path.join(directory, 'native');
  fs.mkdirSync(root);
  const copied: Array<{ source: string; copy: string }> = [];
  let total = 0;
  const sourceRoot = fs.realpathSync(plan.environment.root);
  const visit = (source: string, target: string, core: boolean): void => {
    checkedAbort(signal);
    const info = fs.lstatSync(source);
    if (info.isSymbolicLink()) {
      if (!within(sourceRoot, fs.realpathSync(source))) throw new Error('COMFY_SNAPSHOT_SOURCE_ESCAPE');
      throw new Error('COMFY_SNAPSHOT_SYMLINK_UNSUPPORTED');
    }
    if (info.isDirectory()) {
      fs.mkdirSync(target, { recursive: true });
      for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
        if (['__pycache__', 'node_modules', '.venv', 'venv', '.git'].includes(entry.name)) continue;
        if (core && ['models', 'input', 'output', 'temp', 'user', 'custom_nodes'].includes(entry.name)) continue;
        visit(path.join(source, entry.name), path.join(target, entry.name), core);
      }
    } else if (info.isFile()) {
      total += info.size;
      if (total > 1024 * 1024 * 1024) throw new Error('COMFY_SNAPSHOT_OUTPUT_TOO_LARGE');
      fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
      copied.push({ source, copy: target });
    }
  };
  visit(plan.environment.root, path.join(root, 'core'), true);
  const nodesRoot = path.join(plan.environment.root, 'custom_nodes');
  if (fs.existsSync(nodesRoot)) visit(nodesRoot, path.join(root, 'custom_nodes'), false);
  fs.writeFileSync(path.join(directory, 'native-nodes.json'), JSON.stringify(copied, null, 2));
}
function fixed(value: string): boolean {
  return Boolean(value.trim()) && !/^(?:latest|main|master|HEAD|stable|nightly)$/i.test(value);
}
function pinnedSource(component: ComfyProfile['components'][number]): boolean {
  if (!component.url) return Boolean(component.sha256);
  const url = new URL(component.url);
  if (url.protocol !== 'https:' || url.username || url.password || /(?:^|\/)latest(?:\/|$)/i.test(url.pathname))
    return false;
  if (component.sha256) return true;
  if (!component.sizeBytes) return false;
  const segments = decodeURIComponent(url.pathname).split('/');
  const resolve = segments.indexOf('resolve');
  if (resolve >= 0) return fixed(segments[resolve + 1] ?? '') && segments[resolve + 1] === component.version;
  const download = segments.indexOf('download');
  return download >= 0 && fixed(segments[download + 1] ?? '') && segments[download + 1] === component.version;
}
async function checksum(file: string, signal: AbortSignal): Promise<string> {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file, { signal })) {
    checkedAbort(signal);
    hash.update(chunk as Buffer);
  }
  return hash.digest('hex');
}
function fileIdentity(file: string): { size: number; mtimeMs: number; ctimeMs: number } {
  const stats = fs.statSync(file);
  return { size: stats.size, mtimeMs: stats.mtimeMs, ctimeMs: stats.ctimeMs };
}
function receiptPath(file: string): string {
  return `${file}.comfy-source.json`;
}
async function existingComponent(component: ComfyProfile['components'][number], signal: AbortSignal): Promise<boolean> {
  if (!fs.existsSync(component.path)) return false;
  const stats = fs.statSync(component.path);
  if (!stats.isFile() || !stats.size || (component.sizeBytes !== undefined && stats.size !== component.sizeBytes))
    throw new Error('COMFY_EXISTING_COMPONENT_INVALID');
  if (component.sha256) {
    if ((await checksum(component.path, signal)) !== component.sha256.toLowerCase())
      throw new Error('COMFY_EXISTING_COMPONENT_INVALID');
    return true;
  }
  try {
    const receipt = JSON.parse(fs.readFileSync(receiptPath(component.path), 'utf8')) as {
      url?: string;
      version?: string;
      file?: ReturnType<typeof fileIdentity>;
    };
    if (
      receipt.url === component.url &&
      receipt.version === component.version &&
      JSON.stringify(receipt.file) === JSON.stringify(fileIdentity(component.path))
    )
      return true;
  } catch {
    /* A matching size alone does not establish which pinned source produced the file. */
  }
  throw new Error('COMFY_EXISTING_COMPONENT_SOURCE_UNCONFIRMED');
}
type ComfyResourceRoot = { path: string; realPath: string };
type ComfyResourceScope = ComfyResourceRoot[];

function within(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}
function invalidPathCharacters(file: string): boolean {
  return ['\0', '\r', '\n'].some((character) => file.includes(character));
}
function normalizedPath(file: string): string {
  if (!path.isAbsolute(file) || invalidPathCharacters(file)) throw new Error('COMFY_PATH_INVALID');
  const normalized = path.resolve(file);
  if (process.platform === 'win32' && /[:]/.test(normalized.slice(path.parse(normalized).root.length)))
    throw new Error('COMFY_PATH_INVALID');
  return normalized;
}
/** Resolve the nearest existing ancestor, including dangling links, before appending missing children. */
function resolvedFuturePath(file: string): string {
  let ancestor = normalizedPath(file);
  const children: string[] = [];
  for (;;) {
    try {
      fs.lstatSync(ancestor);
      return path.resolve(fs.realpathSync(ancestor), ...children);
    } catch (cause) {
      const code = (cause as NodeJS.ErrnoException).code;
      // An existing dangling link must fail closed rather than look like a missing directory.
      if (code !== 'ENOENT' || fs.existsSync(ancestor)) throw new Error('COMFY_PATH_RESOLUTION_FAILED', { cause });
      try {
        if (fs.lstatSync(ancestor).isSymbolicLink()) throw new Error('COMFY_PATH_RESOLUTION_FAILED', { cause });
      } catch (error) {
        if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
      }
      const parent = path.dirname(ancestor);
      if (parent === ancestor) throw new Error('COMFY_PATH_RESOLUTION_FAILED', { cause });
      children.unshift(path.basename(ancestor));
      ancestor = parent;
    }
  }
}
function resourceScope(plan: ComfyInstallPlan): ComfyResourceScope {
  const roots = [plan.targetRoot, plan.environment.root];
  const args = plan.environment.launchArgs ?? [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--models-directory') roots.push(args[++index] ?? '');
    else if (arg.startsWith('--models-directory=')) roots.push(arg.slice('--models-directory='.length));
  }
  return [...new Set(roots)].map((root) => {
    if (!path.isAbsolute(root) || invalidPathCharacters(root)) throw new Error('COMFY_RESOURCE_ROOT_INVALID');
    const target = normalizedPath(root);
    const actual = resolvedFuturePath(target);
    if (target === path.parse(target).root || actual === path.parse(actual).root)
      throw new Error('COMFY_RESOURCE_ROOT_INVALID');
    if (fs.existsSync(target) && !fs.statSync(target).isDirectory()) throw new Error('COMFY_RESOURCE_ROOT_INVALID');
    return { path: target, realPath: actual };
  });
}
function assertScopedPath(file: string, scope: ComfyResourceScope, cwd = false): void {
  const target = normalizedPath(file);
  const candidates = scope.filter((root) => within(root.path, target));
  if (!candidates.length) throw new Error(cwd ? 'COMFY_COMMAND_CWD_OUTSIDE_ROOT' : 'COMFY_WRITE_PATH_OUTSIDE_ROOT');
  const actual = resolvedFuturePath(target);
  if (!candidates.some((root) => within(root.realPath, actual))) throw new Error('COMFY_PATH_REALPATH_OUTSIDE_ROOT');
}
function assertPlanWrites(plan: ComfyInstallPlan, scope: ComfyResourceScope): void {
  assertScopedPath(plan.targetRoot, scope);
  assertScopedPath(plan.environment.root, scope);
  assertScopedPath(plan.workflowPath, scope);
  for (const component of plan.components) {
    if (plan.reuseOnlyPaths?.includes(component.path)) {
      if (!component.sha256 || !component.sizeBytes) throw new Error('COMFY_REUSE_ONLY_INTEGRITY_REQUIRED');
      const stats = fs.existsSync(component.path) ? fs.statSync(component.path) : undefined;
      if (!stats?.isFile() || stats.size !== component.sizeBytes)
        throw new Error('COMFY_REUSE_ONLY_COMPONENT_MISSING_OR_INVALID');
      continue;
    }
    for (const suffix of ['', '.part', '.resume.json', '.comfy-source.json'])
      assertScopedPath(component.path + suffix, scope);
  }
  if (plan.reuseOnlyPaths?.some((file) => !plan.components.some((component) => component.path === file)))
    throw new Error('COMFY_REUSE_ONLY_COMPONENT_NOT_DECLARED');
  for (const node of plan.nodes) assertScopedPath(path.join(plan.environment.root, 'custom_nodes', node.id), scope);
}
function argumentPath(value: string | undefined, cwd: string, scope: ComfyResourceScope): string {
  if (!value || value.startsWith('-') || invalidPathCharacters(value)) throw new Error('COMFY_COMMAND_PATH_REQUIRED');
  const target = path.resolve(cwd, value);
  assertScopedPath(target, scope);
  return target;
}
function selectedPython(value: string | undefined, plan: ComfyInstallPlan): boolean {
  return Boolean(value && path.isAbsolute(value) && path.relative(plan.environment.python, value) === '');
}
function bootstrapForCommand(
  command: ComfyInstallPlan['commands'][number],
  plan: ComfyInstallPlan
): string | undefined {
  if (selectedPython(command.executable, plan)) return undefined;
  if (bootstrapPython(command.executable) && command.args[0] === '-m' && command.args[1] === 'venv')
    return command.executable;
  if (/^uv(?:\.exe)?$/i.test(path.basename(command.executable)) && command.args[0] === 'venv') {
    const option = command.args.find((arg) => arg.startsWith('--python='))?.slice('--python='.length);
    const index = command.args.findIndex((arg) => arg === '--python' || arg === '-p');
    const source = option ?? (index >= 0 ? command.args[index + 1] : undefined);
    if (source && !selectedPython(source, plan)) return source;
  }
  return undefined;
}
function bootstrapPython(value: string | undefined): value is string {
  return Boolean(
    value &&
    path.isAbsolute(value) &&
    /^python(?:\d(?:\.\d+)?)?(?:\.exe)?$/i.test(path.basename(value)) &&
    fs.existsSync(value) &&
    fs.statSync(value).isFile()
  );
}
function commandParts(
  args: string[],
  valueOptions: Set<string>,
  flags: Set<string>
): { values: Map<string, string>; positional: string[] } {
  const values = new Map<string, string>();
  const positional: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const token = args[index];
    if (token === '--') {
      positional.push(...args.slice(index + 1));
      break;
    }
    if (!token.startsWith('-')) {
      positional.push(token);
      continue;
    }
    const equal = token.indexOf('=');
    const name = equal >= 0 ? token.slice(0, equal) : token;
    if (valueOptions.has(name)) {
      const value = equal >= 0 ? token.slice(equal + 1) : args[++index];
      if (!value || value.startsWith('-')) throw new Error('COMFY_COMMAND_ARGUMENT_INVALID');
      if (values.has(name)) throw new Error('COMFY_COMMAND_ARGUMENT_DUPLICATE');
      values.set(name, value);
    } else if (!flags.has(token)) throw new Error('COMFY_COMMAND_ARGUMENT_FORBIDDEN');
  }
  return { values, positional };
}
function validatePip(args: string[], cwd: string, plan: ComfyInstallPlan, scope: ComfyResourceScope, uv = false): void {
  const actionIndex = args.findIndex((arg) => !arg.startsWith('-'));
  const action = args[actionIndex];
  if (
    !['install', 'check', 'show', 'freeze', 'list'].includes(action) ||
    args.slice(0, actionIndex).some((arg) => !['--isolated', '--disable-pip-version-check', '--no-input'].includes(arg))
  )
    throw new Error('COMFY_COMMAND_ACTION_FORBIDDEN');
  const { values, positional } = commandParts(
    args.slice(actionIndex + 1),
    new Set([
      '-r',
      '--requirement',
      '-c',
      '--constraint',
      '--index-url',
      '-i',
      '--extra-index-url',
      '--find-links',
      '-f',
      '--target',
      '-t',
      '--prefix',
      '--cache-dir',
      '--log',
      '--report',
      '--python',
      '--only-binary',
      '--no-binary',
      '--config-settings',
      '-C',
      '--trusted-host',
      '--timeout',
      '--retries',
    ]),
    new Set([
      '--upgrade',
      '-U',
      '--no-deps',
      '--no-index',
      '--no-cache-dir',
      '--force-reinstall',
      '--ignore-installed',
      '--pre',
      '--prefer-binary',
      '--require-hashes',
      '--no-build-isolation',
      '--disable-pip-version-check',
      '--no-input',
      '--no-warn-script-location',
      '--all',
      '--local',
      '--quiet',
      '-q',
      '--verbose',
      '-v',
      '--dry-run',
      '--break-system-packages',
      '--no-progress',
      '--strict',
    ])
  );
  if (uv && !selectedPython(values.get('--python'), plan)) throw new Error('COMFY_COMMAND_INTERPRETER_MISMATCH');
  if (values.has('--python') && !selectedPython(values.get('--python'), plan))
    throw new Error('COMFY_COMMAND_INTERPRETER_MISMATCH');
  for (const option of [
    '-r',
    '--requirement',
    '-c',
    '--constraint',
    '--target',
    '-t',
    '--prefix',
    '--cache-dir',
    '--log',
    '--report',
  ])
    if (values.has(option)) argumentPath(values.get(option), cwd, scope);
  for (const option of ['--find-links', '-f']) {
    const value = values.get(option);
    if (value && !/^https:\/\//i.test(value)) argumentPath(value, cwd, scope);
  }
  if (action !== 'install') return;
  if (!positional.length && !values.has('-r') && !values.has('--requirement'))
    throw new Error('COMFY_COMMAND_PACKAGE_REQUIRED');
  for (const token of positional) {
    const version = /^[\w.-]+(?:\[[\w,.-]+\])?==([^*<>]+)$/i.exec(token)?.[1];
    if ((version && fixed(version)) || /^git\+https:\/\/.+@[a-f\d]{7,64}$/i.test(token)) continue;
    if (
      token === '.' ||
      path.isAbsolute(token) ||
      token.startsWith('./') ||
      token.startsWith('../') ||
      token.startsWith('.\\')
    ) {
      argumentPath(token, cwd, scope);
      continue;
    }
    throw new Error('COMFY_COMMAND_PACKAGE_UNPINNED');
  }
}
function validateVenv(
  args: string[],
  cwd: string,
  plan: ComfyInstallPlan,
  scope: ComfyResourceScope,
  uv = false,
  interpreter?: string
): void {
  const { values, positional } = commandParts(
    args,
    new Set(['--prompt', ...(uv ? ['--python', '-p'] : [])]),
    new Set([
      '--system-site-packages',
      '--symlinks',
      '--copies',
      '--clear',
      '--upgrade',
      '--without-pip',
      '--allow-existing',
      '--no-project',
    ])
  );
  if (positional.length !== 1) throw new Error('COMFY_COMMAND_ACTION_FORBIDDEN');
  const destination = argumentPath(positional[0], cwd, scope);
  const source = uv ? (values.get('--python') ?? values.get('-p')) : (interpreter ?? plan.environment.python);
  if (!selectedPython(source, plan)) {
    if (!bootstrapPython(source) || !within(destination, plan.environment.python))
      throw new Error('COMFY_COMMAND_INTERPRETER_MISMATCH');
  }
  if ([plan.targetRoot, plan.environment.root].some((root) => path.relative(root, destination) === ''))
    throw new Error('COMFY_COMMAND_VENV_ROOT_FORBIDDEN');
}
function validateGit(
  args: string[],
  cwd: string,
  plan: ComfyInstallPlan,
  revision: string,
  scope: ComfyResourceScope
): void {
  let index = 0;
  while (index < args.length && args[index].startsWith('-')) {
    if (args[index] === '-C') {
      cwd = argumentPath(args[index + 1], cwd, scope);
      index += 2;
    } else if (args[index] === '--no-pager') index++;
    else throw new Error('COMFY_COMMAND_ARGUMENT_FORBIDDEN');
  }
  const action = args[index++];
  const rest = args.slice(index);
  if (action === 'pull') throw new Error('COMFY_COMMAND_GIT_UNPINNED');
  if (!['clone', 'checkout', 'switch', 'reset', 'fetch', 'rev-parse', 'describe', 'status'].includes(action))
    throw new Error('COMFY_COMMAND_ACTION_FORBIDDEN');
  if (action === 'clone') {
    const { values, positional } = commandParts(
      rest,
      new Set(['--branch', '-b', '--depth', '--origin', '-o']),
      new Set([
        '--single-branch',
        '--no-checkout',
        '-n',
        '--recursive',
        '--recurse-submodules',
        '--shallow-submodules',
        '--quiet',
        '-q',
      ])
    );
    if (positional.length !== 2 || !/^https:\/\//i.test(positional[0]))
      throw new Error('COMFY_COMMAND_GIT_SOURCE_INVALID');
    const destination = argumentPath(positional[1], cwd, scope);
    const branch = values.get('--branch') ?? values.get('-b');
    const laterCheckout = plan.commands.some(
      (candidate) =>
        /^(?:git|git\.exe)$/i.test(path.basename(candidate.executable)) &&
        ['checkout', 'switch', 'reset'].some((verb) => candidate.args.includes(verb)) &&
        candidate.args.includes(candidate.revision) &&
        fixed(candidate.revision) &&
        (path.relative(candidate.cwd, destination) === '' || candidate.args.includes(destination))
    );
    if (branch ? !fixed(branch) || branch !== revision : !laterCheckout) throw new Error('COMFY_COMMAND_GIT_UNPINNED');
  } else if (['checkout', 'switch', 'reset', 'fetch'].includes(action)) {
    const { positional } = commandParts(
      rest,
      new Set(['--depth']),
      new Set(['--detach', '--force', '-f', '--hard', '--keep', '--merge', '--no-tags', '--quiet', '-q'])
    );
    if (
      !positional.includes(revision) ||
      positional.some((arg) => arg !== revision && arg !== 'origin' && !/^https:\/\//i.test(arg))
    )
      throw new Error('COMFY_COMMAND_GIT_UNPINNED');
  } else if (rest.some((arg) => arg.startsWith('--output') || arg.startsWith('--exec')))
    throw new Error('COMFY_COMMAND_ARGUMENT_FORBIDDEN');
}
function validateComfy(
  args: string[],
  cwd: string,
  plan: ComfyInstallPlan,
  revision: string,
  scope: ComfyResourceScope
): void {
  const { values, positional } = commandParts(
    args,
    new Set([
      '--workspace',
      '--where',
      '--version',
      '--commit',
      '--comfyui-version',
      '--workflow',
      '--input',
      '--output',
      '--deps',
      '--file',
      '--snapshot',
      '--channel',
      '--mode',
      '--python',
      '--path',
    ]),
    new Set([
      '--skip-prompt',
      '--yes',
      '-y',
      '--json',
      '--help',
      '--cpu',
      '--nvidia',
      '--amd',
      '--fast',
      '--restore',
      '--no-deps',
    ])
  );
  if (
    !values.get('--workspace') ||
    path.relative(plan.environment.root, path.resolve(cwd, values.get('--workspace')!)) !== ''
  )
    throw new Error('COMFY_COMMAND_WORKSPACE_REQUIRED');
  if (values.has('--where') && values.get('--where') !== 'local') throw new Error('COMFY_COMMAND_REMOTE_FORBIDDEN');
  if (values.has('--mode') && !['local', 'cache'].includes(values.get('--mode')!))
    throw new Error('COMFY_COMMAND_REMOTE_FORBIDDEN');
  if (values.has('--python') && !selectedPython(values.get('--python'), plan))
    throw new Error('COMFY_COMMAND_INTERPRETER_MISMATCH');
  for (const option of ['--workspace', '--workflow', '--input', '--output', '--deps', '--file', '--snapshot', '--path'])
    if (values.has(option)) argumentPath(values.get(option), cwd, scope);
  const [group, action, ...targets] = positional;
  if (group === 'install') {
    if (![values.get('--version'), values.get('--commit'), values.get('--comfyui-version')].includes(revision))
      throw new Error('COMFY_COMMAND_GIT_UNPINNED');
    return;
  }
  if (group === 'workflow' && ['validate', 'print'].includes(action)) return;
  if (
    group !== 'node' ||
    !['install', 'reinstall', 'install-deps', 'restore-snapshot', 'save-snapshot', 'show', 'simple-show'].includes(
      action
    )
  )
    throw new Error('COMFY_COMMAND_ACTION_FORBIDDEN');
  if (
    ['install', 'reinstall'].includes(action) &&
    (!targets.length || targets.some((target) => !target.endsWith(`@${revision}`)))
  )
    throw new Error('COMFY_COMMAND_NODE_UNPINNED');
}
function validateCommands(plan: ComfyInstallPlan, scope: ComfyResourceScope): void {
  for (const command of plan.commands) {
    const executable = path.basename(command.executable).toLowerCase();
    if (
      /^(?:cmd(?:\.exe)?|powershell(?:\.exe)?|pwsh(?:\.exe)?|bash(?:\.exe)?|sh(?:\.exe)?|zsh(?:\.exe)?|fish(?:\.exe)?|wscript(?:\.exe)?|cscript(?:\.exe)?)$/.test(
        executable
      ) ||
      /\.(?:bat|cmd|ps1|sh)$/i.test(command.executable)
    )
      throw new Error('COMFY_COMMAND_SHELL_FORBIDDEN');
    if (
      !fixed(command.revision) ||
      command.args.some((arg) => arg.includes('\0') || arg.includes('\r') || arg.includes('\n')) ||
      command.executable.includes('\0') ||
      command.executable.includes('\r') ||
      command.executable.includes('\n')
    )
      throw new Error('COMFY_COMMAND_REVISION_INVALID');
    if (!path.isAbsolute(command.cwd)) throw new Error('COMFY_COMMAND_CWD_INVALID');
    assertScopedPath(command.cwd, scope, true);
    if (
      /^(?:python(?:\d(?:\.\d+)?)?(?:\.exe)?|pip(?:\d(?:\.\d+)?)?(?:\.exe)?)$/.test(executable) &&
      !path.isAbsolute(command.executable)
    )
      throw new Error('COMFY_COMMAND_INTERPRETER_ABSOLUTE_REQUIRED');
    if (!path.isAbsolute(command.executable) && command.executable !== path.basename(command.executable))
      throw new Error('COMFY_COMMAND_EXECUTABLE_FORBIDDEN');
    const samePip =
      /^pip(?:\d(?:\.\d+)?)?(?:\.exe)?$/.test(executable) &&
      path.isAbsolute(command.executable) &&
      path.relative(path.dirname(plan.environment.python), path.dirname(command.executable)) === '';
    if (selectedPython(command.executable, plan)) {
      const [flag, module, ...args] = command.args;
      if (flag !== '-m' || !['pip', 'venv', 'comfy_cli'].includes(module))
        throw new Error('COMFY_COMMAND_ACTION_FORBIDDEN');
      if (module === 'pip') validatePip(args, command.cwd, plan, scope);
      if (module === 'venv') validateVenv(args, command.cwd, plan, scope);
      if (module === 'comfy_cli') validateComfy(args, command.cwd, plan, command.revision, scope);
    } else if (bootstrapPython(command.executable) && command.args[0] === '-m' && command.args[1] === 'venv')
      validateVenv(command.args.slice(2), command.cwd, plan, scope, false, command.executable);
    else if (samePip) validatePip(command.args, command.cwd, plan, scope);
    else if (/^git(?:\.exe)?$/.test(executable)) validateGit(command.args, command.cwd, plan, command.revision, scope);
    else if (/^comfy(?:\.exe)?$/.test(executable))
      validateComfy(command.args, command.cwd, plan, command.revision, scope);
    else if (/^uv(?:\.exe)?$/.test(executable)) {
      const [action, ...args] = command.args;
      if (action === 'venv') validateVenv(args, command.cwd, plan, scope, true);
      else if (action === 'pip') validatePip(args, command.cwd, plan, scope, true);
      else throw new Error('COMFY_COMMAND_ACTION_FORBIDDEN');
    } else throw new Error('COMFY_COMMAND_EXECUTABLE_FORBIDDEN');
  }
}
/** Reject unusable plans read-only before presenting them for user confirmation. */
export function assertComfyInstallPlan(plan: ComfyInstallPlan): void {
  const parsed = comfyInstallPlanSchema.safeParse(plan);
  if (!parsed.success) throw new Error('COMFY_PLAN_INVALID', { cause: parsed.error });
  const frozen = parsed.data;
  const workflow = workflowBytes(frozen);
  if (frozen.workflowSha256 && crypto.createHash('sha256').update(workflow).digest('hex') !== frozen.workflowSha256)
    throw new Error('COMFY_WORKFLOW_HASH_MISMATCH');
  if (!path.isAbsolute(frozen.environment.python)) throw new Error('COMFY_PYTHON_ABSOLUTE_PATH_REQUIRED');
  if (!frozen.nodes.every((node) => /^[\w.-]+$/.test(node.id) && node.id !== '.' && node.id !== '..'))
    throw new Error('COMFY_NODE_ID_INVALID');
  const scope = resourceScope(frozen);
  assertPlanWrites(frozen, scope);
  validateCommands(frozen, scope);
  for (const component of frozen.components) {
    if (component.sourceUrls && (!component.sha256 || !component.sizeBytes || !component.url))
      throw new Error('COMFY_COMPONENT_SOURCES_INTEGRITY_REQUIRED');
    if (!pinnedSource(component) || component.sourceUrls?.some((url) => !pinnedSource({ ...component, url })))
      throw new Error('COMFY_COMPONENT_SOURCE_UNPINNED');
  }
  // Existence is sufficient only for this read-only lower bound. The executor below
  // verifies every reusable file before accepting the final download budget.
  const bytes = frozen.components.reduce(
    (sum, component) => sum + (fs.existsSync(component.path) ? 0 : (component.sizeBytes ?? 0)),
    0
  );
  if (!Number.isSafeInteger(frozen.downloadBytes) || frozen.downloadBytes < bytes)
    throw new Error('COMFY_PLAN_DOWNLOAD_BUDGET_INVALID');
  if (!Number.isSafeInteger(frozen.requiredBytes) || frozen.requiredBytes < frozen.downloadBytes)
    throw new Error('COMFY_PLAN_REQUIRED_BUDGET_INVALID');
  if (
    new Set(frozen.components.map((component) => path.resolve(component.path).toLowerCase())).size !==
    frozen.components.length
  )
    throw new Error('COMFY_COMPONENT_DESTINATION_DUPLICATE');
  if (!path.isAbsolute(frozen.workflowPath)) throw new Error('COMFY_WORKFLOW_ABSOLUTE_PATH_REQUIRED');
}
function nearestExisting(file: string): string {
  let target = path.resolve(file);
  while (!fs.existsSync(target) && path.dirname(target) !== target) target = path.dirname(target);
  return target;
}
async function defaultFreeBytes(file: string): Promise<{ freeBytes: number; volume: string }> {
  const target = nearestExisting(file);
  const stats = fs.statfsSync(target);
  return { freeBytes: stats.bavail * stats.bsize, volume: String(fs.statSync(target).dev) };
}
async function checkSpace(
  plan: ComfyInstallPlan,
  reusable: Set<string>,
  probe: NonNullable<ComfyInstallExecutorOptions['freeBytes']>
): Promise<void> {
  const reservations = [
    { path: plan.targetRoot, bytes: Math.max(0, plan.requiredBytes - plan.downloadBytes) },
    ...plan.components
      .filter((component) => !reusable.has(component.path))
      .map((component) => ({ path: component.path, bytes: component.sizeBytes ?? plan.downloadBytes })),
  ];
  const volumes = new Map<string, { required: number; free: number }>();
  for (const reservation of reservations) {
    const result = await probe(reservation.path);
    const volume = typeof result === 'number' ? path.parse(reservation.path).root : result.volume;
    const free = typeof result === 'number' ? result : result.freeBytes;
    if (!Number.isFinite(free) || free < 0) throw new Error('COMFY_DISK_PROBE_UNAVAILABLE');
    const previous = volumes.get(volume);
    volumes.set(volume, {
      required: (previous?.required ?? 0) + reservation.bytes,
      free: Math.min(previous?.free ?? free, free),
    });
  }
  if ([...volumes.values()].some((volume) => volume.free < volume.required))
    throw new Error('COMFY_DISK_SPACE_INSUFFICIENT');
}

/** Run an approved executable and argument vector without a shell, retaining only bounded output. */
export const runComfyInstallCommand: ComfyInstallCommandRunner = async (executable, args, options) =>
  new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: options.cwd,
      signal: options.signal,
      windowsHide: true,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '',
      stderr = '',
      stdoutTruncated = false,
      stderrTruncated = false;
    const capture = (which: 'stdout' | 'stderr', chunk: Buffer): void => {
      const text = chunk.toString();
      options.onOutput?.(text);
      if (which === 'stdout') {
        const bytes = Buffer.from(stdout + text);
        stdoutTruncated ||= bytes.length > MAX_LOG_BYTES;
        stdout = bytes.subarray(-MAX_LOG_BYTES).toString();
      } else {
        const bytes = Buffer.from(stderr + text);
        stderrTruncated ||= bytes.length > MAX_LOG_BYTES;
        stderr = bytes.subarray(-MAX_LOG_BYTES).toString();
      }
    };
    child.stdout?.on('data', (chunk: Buffer) => capture('stdout', chunk));
    child.stderr?.on('data', (chunk: Buffer) => capture('stderr', chunk));
    child.once('error', reject);
    child.once('close', (code) => resolve({ stdout, stderr, exitCode: code ?? 1, stdoutTruncated, stderrTruncated }));
  });

/** Execute an already-authorized pinned installation plan, then verify it through the smallest configured generation. */
export async function executeComfyInstall(
  plan: ComfyInstallPlan,
  signal: AbortSignal,
  onProgress: ((progress: string) => void) | undefined,
  options: ComfyInstallExecutorOptions
): Promise<ComfyProfile> {
  checkedAbort(signal);
  assertComfyInstallPlan(plan);
  const parsed = comfyInstallPlanSchema.safeParse(plan);
  if (!parsed.success) throw new Error('COMFY_PLAN_INVALID', { cause: parsed.error });
  const frozen = parsed.data;
  const scope = resourceScope(frozen);
  const snapshotRoot = options.snapshotRoot ?? path.join(path.dirname(frozen.targetRoot), '.comfy-snapshots');
  if (!path.isAbsolute(snapshotRoot)) throw new Error('COMFY_SNAPSHOT_ABSOLUTE_PATH_REQUIRED');
  fs.mkdirSync(snapshotRoot, { recursive: true });
  const snapshotScope = [{ path: path.resolve(snapshotRoot), realPath: fs.realpathSync(snapshotRoot) }];
  const planHash = crypto.createHash('sha256').update(stable(frozen)).digest('hex');
  const smokePath = path.join(snapshotRoot, 'smoke-receipts', `${frozen.id}-${planHash}.json`);
  const saveSmoke = (value: SmokeReceipt): void => {
    assertScopedPath(smokePath, snapshotScope);
    const temp = `${smokePath}.tmp`;
    assertScopedPath(temp, snapshotScope);
    fs.mkdirSync(path.dirname(smokePath), { recursive: true });
    const fd = fs.openSync(temp, 'w');
    try {
      fs.writeFileSync(fd, JSON.stringify(value, null, 2));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(temp, smokePath);
  };
  const finishSmoke = async (
    profile: ComfyProfile,
    result: ComfyGenerationResult,
    expectedFingerprint: string
  ): Promise<ComfyProfile> => {
    checkedAbort(signal);
    if (
      !result.artifacts.length ||
      !result.artifacts.every(
        (artifact) =>
          path.isAbsolute(artifact.path) &&
          fs.existsSync(artifact.path) &&
          fs.statSync(artifact.path).isFile() &&
          fs.statSync(artifact.path).size > 0
      )
    )
      throw new Error('COMFY_SMOKE_ARTIFACT_REQUIRED');
    const visual = result.artifacts.filter((artifact) =>
      artifact.mimeType.startsWith(profile.kind === 'video' ? 'video/' : 'image/')
    );
    if (!visual.length) throw new Error('COMFY_SMOKE_MEDIA_KIND_MISMATCH');
    for (const artifact of visual)
      await (options.verifyArtifact ?? verifyComfySmokeArtifact)(artifact, profile.kind, signal, {
        profile,
        input: frozen.smokeInput,
      });
    const fingerprint = await options.engine.snapshotFingerprint(profile);
    if (fingerprint !== expectedFingerprint) throw new Error('COMFY_PROFILE_CHANGED_DURING_SMOKE');
    return {
      ...profile,
      state: 'verified',
      validation: {
        fingerprint,
        checkedAt: new Date().toISOString(),
        promptId: result.promptId,
        artifacts: result.artifacts.map((artifact) => artifact.path),
        runtime: profile.validation?.runtime,
      },
    };
  };
  assertScopedPath(smokePath, snapshotScope);
  if (fs.existsSync(smokePath)) {
    let receipt: SmokeReceipt;
    try {
      if (fs.statSync(smokePath).size > 4 * 1024 * 1024) throw new Error('receipt too large');
      receipt = JSON.parse(fs.readFileSync(smokePath, 'utf8')) as SmokeReceipt;
      receipt.profile = comfyProfileSchema.parse(receipt.profile);
      if (
        receipt.planHash !== planHash ||
        recipe(receipt.profile) !== recipe(profileFromPlan(frozen)) ||
        !['pending', 'submitted', 'succeeded', 'retry-ready', 'failed'].includes(receipt.status) ||
        (receipt.oomRetryCount !== undefined && ![0, 1].includes(receipt.oomRetryCount)) ||
        !receipt.profile.validation?.fingerprint
      )
        throw new Error('receipt mismatch');
      assertScopedPath(receipt.snapshotDirectory, snapshotScope);
    } catch (cause) {
      throw new Error('COMFY_SMOKE_RECEIPT_INVALID', { cause });
    }
    try {
      // Do this before prepare, repair snapshots or stopOwned: the existing prompt owns its runtime.
      if (!receipt.promptId && !['retry-ready', 'failed'].includes(receipt.status))
        throw new Error('COMFY_SUBMISSION_STATE_UNKNOWN');
      for (const component of frozen.components)
        if (!(await existingComponent(component, signal))) throw new Error('COMFY_PROFILE_CHANGED');
      const fingerprint = await options.engine.snapshotFingerprint(receipt.profile);
      if (fingerprint !== receipt.profile.validation!.fingerprint) throw new Error('COMFY_PROFILE_CHANGED');
      options.onProfile?.(structuredClone({ ...receipt.profile, state: 'loadable' }));
      onProgress?.('smoke:resume');
      const resumed = await runComfyInstallSmoke(receipt, frozen.smokeInput, signal, {
        engine: options.engine,
        coordinator: options.runtimeCoordinator,
        save: saveSmoke,
        progress: (progress) => onProgress?.(`smoke:${progress}`),
      });
      receipt = resumed.receipt;
      const result = resumed.result;
      const verified = await finishSmoke(receipt.profile, result, fingerprint);
      saveSmoke({ ...receipt, profile: verified, status: 'succeeded', result });
      fs.writeFileSync(
        path.join(receipt.snapshotDirectory, 'verified-profile.json'),
        JSON.stringify(verified, null, 2)
      );
      onProgress?.('completed');
      return verified;
    } catch (cause) {
      throw new ComfyInstallError(
        cause instanceof Error ? cause.message : 'COMFY_INSTALL_FAILED',
        receipt.snapshotDirectory,
        cause
      );
    }
  }
  const reusable = new Set<string>();
  const damaged: ComfyProfile['components'] = [];
  for (const component of frozen.components) {
    try {
      if (await existingComponent(component, signal)) reusable.add(component.path);
    } catch (error) {
      if (
        frozen.reuseOnlyPaths?.includes(component.path) ||
        !frozen.repair ||
        !component.sha256 ||
        !component.url ||
        !fs.existsSync(component.path) ||
        !fs.statSync(component.path).isFile() ||
        !(error instanceof Error) ||
        !/^COMFY_EXISTING_COMPONENT_(?:INVALID|SOURCE_UNCONFIRMED)$/.test(error.message)
      )
        throw error;
      damaged.push(component);
    }
  }
  const downloadBytes = frozen.components
    .filter((component) => !reusable.has(component.path))
    .reduce((sum, component) => sum + (component.sizeBytes ?? frozen.downloadBytes), 0);
  if (
    downloadBytes > frozen.downloadBytes ||
    frozen.components.some(
      (component) => !reusable.has(component.path) && !component.sizeBytes && frozen.downloadBytes === 0
    )
  )
    throw new Error('COMFY_PLAN_DOWNLOAD_BUDGET_INVALID');
  await checkSpace(frozen, reusable, options.freeBytes ?? defaultFreeBytes);
  checkedAbort(signal);
  const snapshotDirectory = fs.mkdtempSync(path.join(snapshotRoot, `${frozen.id}-`));
  let log = Buffer.alloc(0);
  const output = (text: string): void => {
    log = Buffer.concat([log, Buffer.from(text)]).subarray(-MAX_LOG_BYTES);
    fs.writeFileSync(path.join(snapshotDirectory, 'commands.log'), log);
  };
  fs.writeFileSync(path.join(snapshotDirectory, 'plan.json'), JSON.stringify(frozen, null, 2));
  const run = options.runCommand ?? runComfyInstallCommand;
  const command = async (
    executable: string,
    args: string[],
    cwd: string,
    label: string,
    readOnlyProbe = false
  ): Promise<ComfyInstallCommandResult> => {
    checkedAbort(signal);
    assertPlanWrites(frozen, scope);
    if (!readOnlyProbe) assertScopedPath(cwd, scope, true);
    onProgress?.(label);
    output(`\n${label}\n`);
    const result = await run(executable, args, { cwd, signal, windowsHide: true, shell: false, onOutput: output });
    checkedAbort(signal);
    if (result.stdout) output(result.stdout);
    if (result.stderr) output(result.stderr);
    if (result.exitCode !== 0) throw new Error(`COMFY_COMMAND_FAILED:${label}:exit=${result.exitCode}`);
    return result;
  };
  try {
    const {
      targetRoot: _checkTargetRoot,
      downloadBytes: _checkDownloadBytes,
      requiredBytes: _checkRequiredBytes,
      reason: _checkReason,
      evidence: _checkEvidence,
      workflow: _checkWorkflow,
      workflowSource: _checkWorkflowSource,
      reuseOnlyPaths: _checkReuseOnlyPaths,
      commands: _checkCommands,
      smokeInput: _checkSmokeInput,
      repair: _checkRepair,
      ...checkProfileFields
    } = frozen;
    const checkProfile: ComfyProfile = { ...checkProfileFields, state: 'downloaded' };
    await options.engine.assertInstallable?.(checkProfile);
    for (const bootstrap of new Set(
      frozen.commands
        .map((step) => bootstrapForCommand(step, frozen))
        .filter((value): value is string => Boolean(value))
    )) {
      const result = await command(
        bootstrap,
        ['-c', 'import sys,json;print(json.dumps({"executable":sys.executable,"version":sys.version.split()[0]}))'],
        path.dirname(bootstrap),
        'probe-bootstrap-python',
        true
      );
      let evidence: { executable?: string; version?: string };
      try {
        evidence = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1) ?? '') as typeof evidence;
      } catch (cause) {
        throw new Error('COMFY_BOOTSTRAP_PYTHON_UNCONFIRMED', { cause });
      }
      if (
        !evidence.executable ||
        !evidence.version ||
        path.relative(fs.realpathSync(bootstrap), fs.realpathSync(evidence.executable)) !== ''
      )
        throw new Error('COMFY_BOOTSTRAP_PYTHON_UNCONFIRMED');
    }
    if (frozen.repair) {
      // Every snapshot step must succeed before any approved installation command runs.
      const files = [frozen.workflowPath, ...(options.snapshotFiles ?? [])];
      fs.mkdirSync(path.join(snapshotDirectory, 'files'));
      const copied: Array<{ source: string; copy?: string; missing?: boolean }> = [];
      const totalSnapshotBytes = files.reduce((sum, file) => {
        try {
          return sum + fs.statSync(file).size;
        } catch {
          return sum;
        }
      }, 0);
      if (totalSnapshotBytes > Math.min(frozen.requiredBytes, 1024 * 1024 * 1024))
        throw new Error('COMFY_SNAPSHOT_OUTPUT_TOO_LARGE');
      for (let index = 0; index < files.length; index++) {
        checkedAbort(signal);
        const source = files[index];
        if (!path.isAbsolute(source)) throw new Error('COMFY_SNAPSHOT_FILE_ABSOLUTE_REQUIRED');
        if (!fs.existsSync(source)) {
          copied.push({ source, missing: true });
          continue;
        }
        const destination = path.join(snapshotDirectory, 'files', `${index}-${path.basename(source)}`);
        fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
        copied.push({ source, copy: destination });
      }
      fs.writeFileSync(path.join(snapshotDirectory, 'files.json'), JSON.stringify(copied, null, 2));
      snapshotNativeSources(frozen, snapshotDirectory, signal);
      if (fs.existsSync(frozen.environment.python)) {
        const pip = await command(
          frozen.environment.python,
          ['-m', 'pip', 'freeze', '--all'],
          frozen.environment.root,
          'snapshot-python'
        );
        if (pip.stdoutTruncated || Buffer.byteLength(pip.stdout) > MAX_LOG_BYTES)
          throw new Error('COMFY_SNAPSHOT_OUTPUT_TOO_LARGE');
        fs.writeFileSync(path.join(snapshotDirectory, 'pip-freeze.txt'), pip.stdout);
      } else
        fs.writeFileSync(
          path.join(snapshotDirectory, 'python-missing.json'),
          JSON.stringify({ executable: frozen.environment.python, missing: true })
        );
      const refs: Array<{ path: string; revision: string }> = [];
      const repositories = [
        frozen.environment.root,
        ...frozen.nodes.map((node) => path.join(frozen.environment.root, 'custom_nodes', node.id)),
      ];
      for (const repository of repositories) {
        if (!fs.existsSync(path.join(repository, '.git'))) continue;
        const result = await command(
          'git',
          ['-C', repository, 'rev-parse', 'HEAD'],
          frozen.environment.root,
          'snapshot-git'
        );
        if (!/^[a-f\d]{7,64}$/i.test(result.stdout.trim())) throw new Error('COMFY_GIT_SNAPSHOT_INVALID');
        refs.push({ path: repository, revision: result.stdout.trim() });
      }
      fs.writeFileSync(path.join(snapshotDirectory, 'git-refs.json'), JSON.stringify(refs, null, 2));
      if (fs.existsSync(frozen.environment.python)) {
        const cli = await command(
          frozen.environment.python,
          [
            '-c',
            'import importlib.util,json;print(json.dumps({"available":importlib.util.find_spec("comfy_cli") is not None}))',
          ],
          frozen.environment.root,
          'probe-existing-comfy-cli'
        );
        let available: boolean;
        try {
          const evidence = JSON.parse(cli.stdout.trim().split(/\r?\n/).at(-1) ?? '') as { available?: boolean };
          if (typeof evidence.available !== 'boolean') throw new Error('missing evidence');
          available = evidence.available;
        } catch (cause) {
          throw new Error('COMFY_CLI_PROBE_UNCONFIRMED', { cause });
        }
        if (available) {
          const nodeSnapshot = path.join(snapshotDirectory, 'nodes.json');
          await command(
            frozen.environment.python,
            [
              '-m',
              'comfy_cli',
              '--workspace',
              frozen.environment.root,
              'node',
              'save-snapshot',
              '--output',
              nodeSnapshot,
            ],
            frozen.environment.root,
            'snapshot-nodes'
          );
          if (!fs.existsSync(nodeSnapshot) || !fs.statSync(nodeSnapshot).size)
            throw new Error('COMFY_NODE_SNAPSHOT_MISSING');
          JSON.parse(fs.readFileSync(nodeSnapshot, 'utf8'));
        }
      }
      fs.writeFileSync(path.join(snapshotDirectory, 'snapshot.complete'), new Date().toISOString());
    }
    await options.engine.stopOwned?.(checkProfile);
    assertPlanWrites(frozen, scope);
    fs.mkdirSync(frozen.targetRoot, { recursive: true });
    const quarantined: Array<{ original: string; quarantine: string; receipt?: string }> = [];
    for (const component of damaged) {
      checkedAbort(signal);
      const quarantine = `${component.path}.comfy-repair-${path.basename(snapshotDirectory)}`;
      if (fs.existsSync(quarantine)) throw new Error('COMFY_QUARANTINE_DESTINATION_EXISTS');
      const mapping = {
        original: component.path,
        quarantine,
        receipt: fs.existsSync(receiptPath(component.path))
          ? `${receiptPath(component.path)}.comfy-repair-${path.basename(snapshotDirectory)}`
          : undefined,
      };
      assertScopedPath(quarantine, scope);
      if (mapping.receipt) assertScopedPath(mapping.receipt, scope);
      quarantined.push(mapping);
      // Persist the restoration mapping before the same-volume rename can occur.
      fs.writeFileSync(path.join(snapshotDirectory, 'quarantine.json'), JSON.stringify(quarantined, null, 2));
      fs.renameSync(component.path, quarantine);
      if (mapping.receipt) fs.renameSync(receiptPath(component.path), mapping.receipt);
      output(`quarantined:${component.name}:${quarantine}\n`);
    }
    await options.prepareRuntime?.(frozen, signal, onProgress);
    checkedAbort(signal);
    for (const step of frozen.commands.filter((step) => step.stage === 'prepare')) {
      validateCommands(frozen, scope);
      const uvVenv = /^uv(?:\.exe)?$/i.test(path.basename(step.executable)) && step.args[0] === 'venv';
      const pythonVenv = step.args[0] === '-m' && step.args[1] === 'venv';
      let venv:
        | { destination: string; executable: string; source: string; config: string; receipt: string }
        | undefined;
      const probeVenv = async (): Promise<VenvEvidence> => {
        if (!venv) throw new Error('COMFY_PREPARE_STATE_MISMATCH');
        const result = await command(
          venv.executable,
          [
            '-c',
            'import sys,json;print(json.dumps({"executable":sys.executable,"version":sys.version.split()[0],"prefix":sys.prefix,"baseExecutable":getattr(sys,"_base_executable",sys.executable)}))',
          ],
          step.cwd,
          `verify-existing:${step.label}`
        );
        try {
          const evidence = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1) ?? '') as VenvEvidence;
          if (
            !evidence.executable ||
            !evidence.version ||
            !evidence.prefix ||
            !evidence.baseExecutable ||
            path.relative(fs.realpathSync(evidence.executable), fs.realpathSync(venv.executable)) !== '' ||
            path.relative(fs.realpathSync(evidence.prefix), fs.realpathSync(venv.destination)) !== ''
          )
            throw new Error('invalid venv evidence');
          return evidence;
        } catch (cause) {
          throw new Error('COMFY_PREPARE_STATE_MISMATCH', { cause });
        }
      };
      if (uvVenv || pythonVenv) {
        const { values, positional } = commandParts(
          step.args.slice(uvVenv ? 1 : 2),
          new Set(['--prompt', ...(uvVenv ? ['--python', '-p'] : [])]),
          new Set([
            '--system-site-packages',
            '--symlinks',
            '--copies',
            '--clear',
            '--upgrade',
            '--without-pip',
            '--allow-existing',
            '--no-project',
          ])
        );
        const destination = path.resolve(step.cwd, positional[0]);
        const executable = path.join(destination, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
        const source = uvVenv
          ? (values.get('--python') ?? values.get('-p') ?? frozen.environment.python)
          : step.executable;
        const stepHash = crypto.createHash('sha256').update(stable(step)).digest('hex');
        venv = {
          destination,
          executable,
          source,
          config: path.join(destination, 'pyvenv.cfg'),
          receipt: path.join(snapshotRoot, 'command-receipts', `${planHash}-${stepHash}.json`),
        };
        assertScopedPath(venv.receipt, snapshotScope);
        if (fs.existsSync(venv.config) && fs.existsSync(venv.executable)) {
          const evidence = await probeVenv();
          const sourceResult = await command(
            venv.source,
            ['-c', 'import sys,json;print(json.dumps({"executable":sys.executable,"version":sys.version.split()[0]}))'],
            step.cwd,
            `verify-source:${step.label}`
          );
          let sourceEvidence: { executable?: string; version?: string };
          try {
            sourceEvidence = JSON.parse(
              sourceResult.stdout.trim().split(/\r?\n/).at(-1) ?? ''
            ) as typeof sourceEvidence;
          } catch (cause) {
            throw new Error('COMFY_PREPARE_STATE_MISMATCH', { cause });
          }
          if (
            !sourceEvidence.executable ||
            !sourceEvidence.version ||
            path.relative(fs.realpathSync(sourceEvidence.executable), fs.realpathSync(venv.source)) !== '' ||
            path.relative(fs.realpathSync(evidence.baseExecutable), fs.realpathSync(venv.source)) !== '' ||
            evidence.version !== sourceEvidence.version
          )
            throw new Error('COMFY_PREPARE_STATE_MISMATCH');
          const receipt: VenvReceipt = {
            evidence,
            python: fileIdentity(executable),
            source: fileIdentity(venv.source),
            configHash: crypto.createHash('sha256').update(fs.readFileSync(venv.config)).digest('hex'),
          };
          if (fs.existsSync(venv.receipt)) {
            const saved = JSON.parse(fs.readFileSync(venv.receipt, 'utf8')) as VenvReceipt;
            if (
              stable(evidence) !== stable(saved.evidence) ||
              stable(receipt.python) !== stable(saved.python) ||
              stable(receipt.source) !== stable(saved.source) ||
              receipt.configHash !== saved.configHash
            )
              throw new Error('COMFY_PREPARE_STATE_MISMATCH');
          } else {
            assertScopedPath(venv.receipt, snapshotScope);
            fs.mkdirSync(path.dirname(venv.receipt), { recursive: true });
            fs.writeFileSync(venv.receipt, JSON.stringify(receipt));
          }
          output(`reuse-command:${step.label}:venv:${evidence.version}\n`);
          onProgress?.(`reuse-command:${step.label}`);
          continue;
        }
      }
      if (/^git(?:\.exe)?$/i.test(path.basename(step.executable)) && step.args.includes('clone')) {
        const clone = step.args.indexOf('clone');
        const destination = path.resolve(step.cwd, step.args.at(-1)!);
        const intentPath = path.join(
          snapshotRoot,
          'command-receipts',
          `clone-${crypto
            .createHash('sha256')
            .update(`${planHash}:${stable(step)}`)
            .digest('hex')}.json`
        );
        const cloneIntent = {
          planHash,
          destination: resolvedFuturePath(destination),
          source: step.args.at(-2),
          revision: step.revision,
          noCheckout: step.args.includes('--no-checkout') || step.args.includes('-n'),
        };
        if (fs.existsSync(path.join(destination, '.git'))) {
          const read = async (args: string[]): Promise<string> =>
            (
              await command(step.executable, ['-C', destination, ...args], step.cwd, `verify-existing:${step.label}`)
            ).stdout.trim();
          const actual = await read(['rev-parse', '--verify', 'HEAD^{commit}']);
          const expected = await read(['rev-parse', '--verify', `${step.revision}^{commit}`]);
          const originIndex = step.args.findIndex((arg) => arg === '--origin' || arg === '-o');
          const origin = originIndex >= 0 ? step.args[originIndex + 1] : 'origin';
          const source = step.args.at(-2);
          const remote = await read(['remote', 'get-url', origin]);
          const dirty = await read(['status', '--porcelain', '--untracked-files=no']);
          let stagedClone = false;
          if (cloneIntent.noCheckout && fs.existsSync(intentPath)) {
            const saved: unknown = JSON.parse(fs.readFileSync(intentPath, 'utf8'));
            // Only this operation's recorded --no-checkout clone may continue
            // with an empty worktree. Never reset/overwrite an existing checkout.
            stagedClone =
              stable(saved) === stable(cloneIntent) &&
              fs.readdirSync(destination).every((name) => name === '.git') &&
              frozen.commands.some(
                (candidate) =>
                  candidate.cwd === destination &&
                  candidate.args[0] === 'checkout' &&
                  candidate.args.includes(step.revision)
              );
          }
          if (
            !/^[a-f\d]{40,64}$/i.test(actual) ||
            !/^[a-f\d]{40,64}$/i.test(expected) ||
            source !== remote ||
            (!stagedClone && (actual !== expected || dirty))
          )
            throw new Error('COMFY_PREPARE_STATE_MISMATCH');
          output(`reuse-command:${step.label}:git:${actual}\n`);
          onProgress?.(`reuse-command:${step.label}`);
          continue;
        }
        if (clone >= 0 && fs.existsSync(destination) && fs.readdirSync(destination).length)
          throw new Error('COMFY_PREPARE_STATE_MISMATCH');
        if (cloneIntent.noCheckout) {
          assertScopedPath(intentPath, snapshotScope);
          fs.mkdirSync(path.dirname(intentPath), { recursive: true });
          fs.writeFileSync(intentPath, JSON.stringify(cloneIntent));
        }
      }
      await command(step.executable, step.args, step.cwd, step.label);
      if (venv && fs.existsSync(venv.config) && fs.existsSync(venv.executable)) {
        const evidence = await probeVenv();
        const receipt: VenvReceipt = {
          evidence,
          python: fileIdentity(venv.executable),
          source: fileIdentity(venv.source),
          configHash: crypto.createHash('sha256').update(fs.readFileSync(venv.config)).digest('hex'),
        };
        assertScopedPath(venv.receipt, snapshotScope);
        fs.mkdirSync(path.dirname(venv.receipt), { recursive: true });
        fs.writeFileSync(venv.receipt, JSON.stringify(receipt));
      }
    }
    if (fs.existsSync(frozen.environment.root)) {
      for (const node of frozen.nodes) {
        if (!/^[\w.-]+$/.test(node.id)) throw new Error('COMFY_NODE_ID_INVALID');
        const nodePath = path.join(frozen.environment.root, 'custom_nodes', node.id);
        if (fs.existsSync(nodePath) && !fs.statSync(nodePath).isDirectory())
          throw new Error('COMFY_NODE_DIRECTORY_INVALID');
      }
    }
    const downloadController = new AbortController();
    const downloadSignal = AbortSignal.any([signal, downloadController.signal]);
    const transferComponent = async (component: ComfyProfile['components'][number]): Promise<void> => {
      checkedAbort(downloadSignal);
      assertPlanWrites(frozen, scope);
      if (reusable.has(component.path)) {
        onProgress?.(`reuse:${component.name}`);
        return;
      }
      if (!component.url) throw new Error('COMFY_COMPONENT_SOURCE_REQUIRED');
      fs.mkdirSync(path.dirname(component.path), { recursive: true });
      onProgress?.(`download:${component.name}`);
      const result = await (options.download ?? downloadH3FromSources)(
        {
          url: component.url,
          ...(component.sourceUrls ? { urls: [...new Set([...component.sourceUrls, component.url])] } : {}),
          destination: component.path,
          sizeBytes: component.sizeBytes,
          sha256: component.sha256,
        },
        {
          signal: downloadSignal,
          maxAttempts: 1,
          onSource: (host) => onProgress?.(`download:${component.name}:${host}`),
          onProgress: (bytes, total) =>
            onProgress?.(`download:${component.name}:${bytes}/${total ?? component.sizeBytes ?? '?'}`),
        }
      );
      checkedAbort(downloadSignal);
      if (result.status === 'dry-run' || !fs.existsSync(component.path))
        throw new Error('COMFY_COMPONENT_DOWNLOAD_INCOMPLETE');
      const file = fileIdentity(component.path);
      if ((component.sizeBytes !== undefined && file.size !== component.sizeBytes) || !file.size)
        throw new Error('COMFY_COMPONENT_DOWNLOAD_SIZE_MISMATCH');
      if (component.sha256 && (await checksum(component.path, downloadSignal)) !== component.sha256.toLowerCase())
        throw new Error('COMFY_COMPONENT_DOWNLOAD_HASH_MISMATCH');
      fs.writeFileSync(
        receiptPath(component.path),
        JSON.stringify({ url: component.url, sourceUrls: component.sourceUrls, version: component.version, file })
      );
    };
    let nextComponent = 0;
    const requestedConcurrency = options.downloadConcurrency;
    const concurrency = Math.max(
      1,
      Math.min(
        3,
        Number.isFinite(requestedConcurrency) ? Math.floor(requestedConcurrency!) : 3,
        frozen.components.length
      )
    );
    let transferFailure: unknown;
    const worker = async (): Promise<void> => {
      while (!downloadSignal.aborted && nextComponent < frozen.components.length) {
        const component = frozen.components[nextComponent++];
        try {
          await transferComponent(component);
        } catch (error) {
          transferFailure ??= error;
          downloadController.abort();
          return;
        }
      }
    };
    // Settle every worker before returning or running install commands. A failed
    // component cancels peers; completed verified receipts remain resumable.
    await Promise.all(Array.from({ length: concurrency }, () => worker()));
    if (transferFailure) throw transferFailure;
    checkedAbort(signal);
    for (const step of frozen.commands.filter((step) => step.stage === 'finish')) {
      validateCommands(frozen, scope);
      await command(step.executable, step.args, step.cwd, step.label);
    }
    checkedAbort(signal);
    assertPlanWrites(frozen, scope);
    fs.mkdirSync(frozen.targetRoot, { recursive: true });
    fs.mkdirSync(path.dirname(frozen.workflowPath), { recursive: true });
    const workflow = workflowBytes(frozen);
    const workflowSha256 = crypto.createHash('sha256').update(workflow).digest('hex');
    if (frozen.workflowSha256 && frozen.workflowSha256.toLowerCase() !== workflowSha256)
      throw new Error('COMFY_WORKFLOW_HASH_MISMATCH');
    if (
      fs.existsSync(frozen.workflowPath) &&
      fs.readFileSync(frozen.workflowPath, 'utf8') !== workflow &&
      !frozen.repair
    )
      throw new Error('COMFY_EXISTING_WORKFLOW_CONFLICT');
    fs.writeFileSync(frozen.workflowPath, workflow);
    const {
      targetRoot: _targetRoot,
      downloadBytes: _downloadBytes,
      requiredBytes: _requiredBytes,
      reason: _reason,
      evidence: _evidence,
      workflow: _workflow,
      workflowSource: _workflowSource,
      reuseOnlyPaths: _reuseOnlyPaths,
      commands: _commands,
      smokeInput: _smokeInput,
      repair: _repair,
      ...profileFields
    } = frozen;
    const profile: ComfyProfile = { ...profileFields, workflowSha256, state: 'downloaded' };
    options.onProfile?.(structuredClone(profile));
    onProgress?.('validate');
    const validation = await options.engine.validate(structuredClone(profile), signal);
    checkedAbort(signal);
    profile.state = 'loadable';
    profile.validation = {
      fingerprint: validation.fingerprint,
      checkedAt: new Date().toISOString(),
      runtime: validation.runtime,
    };
    options.onProfile?.(structuredClone(profile));
    onProgress?.('smoke');
    const { receipt, result: smoke } = await runComfyInstallSmoke(
      { planHash, profile: structuredClone(profile), snapshotDirectory, status: 'pending' },
      frozen.smokeInput,
      signal,
      {
        engine: options.engine,
        coordinator: options.runtimeCoordinator,
        save: saveSmoke,
        progress: (progress) => onProgress?.(`smoke:${progress}`),
      }
    );
    const verified = await finishSmoke(profile, smoke, validation.fingerprint);
    saveSmoke({ ...receipt, status: 'succeeded', profile: verified, result: smoke });
    fs.writeFileSync(path.join(snapshotDirectory, 'verified-profile.json'), JSON.stringify(verified, null, 2));
    onProgress?.('completed');
    return verified;
  } catch (cause) {
    const message = signal.aborted
      ? 'COMFY_INSTALL_CANCELLED'
      : cause instanceof Error
        ? cause.message
        : 'COMFY_INSTALL_FAILED';
    fs.writeFileSync(
      path.join(snapshotDirectory, 'failure.json'),
      JSON.stringify({
        message,
        failedAt: new Date().toISOString(),
        diagnosticLogPath: cause instanceof Error && 'diagnosticLogPath' in cause ? cause.diagnosticLogPath : undefined,
      })
    );
    throw new ComfyInstallError(message, snapshotDirectory, cause);
  }
}
