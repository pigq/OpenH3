import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { spawn, type ChildProcess } from 'node:child_process';
import {
  validateComfyGenerationInputForFamily,
  type ComfyProfile,
  type ComfyGenerationInput,
  type ComfyDiagnosis,
} from '@/common/chat/document/creation/comfy';
import {
  validateComfyWorkflow,
  type ComfyGraph,
  type ComfyRegistry,
} from '@/process/services/runtime/h3WorkflowPreflight';
import { diagnoseComfyError } from '@/process/services/runtime/h3ComfyError';
import { MATLOWAI_CUSTOM_NODE_ARCHIVES } from '@/process/services/runtime/h3OfflineBundle';
import { H3ReferencePreflight } from '@/process/services/runtime/H3ReferencePreflight';
import { withComfyReferenceVideo } from './referenceVideo';
import {
  readPythonRuntime,
  readComfyHardwareIdentity,
  runComfyCommand,
  type ComfyPythonRuntime,
} from './discovery/environment';
import {
  comfyRuntimeResourceKey,
  sharedComfyRuntimeCoordinator,
  comfyRuntimeSignature,
  clearBoundComfyRuntime,
  type ComfyCleanupReason,
  type ComfyRuntimeCoordinator,
} from './runtimeCoordinator';

export type ComfyServiceIdentity = { executable: string; root: string; pid?: number };
export type ComfyGenerationResult = { promptId: string; artifacts: Array<{ path: string; mimeType: string }> };
export type ComfyWorkflowEngineOptions = {
  outputRoot: string;
  fetchImpl?: typeof fetch;
  spawnImpl?: typeof spawn;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => number;
  runtimeInspector?: (
    profile: ComfyProfile,
    stats: Record<string, unknown>
  ) => Promise<ComfyServiceIdentity | undefined>;
  runtimeProbe?: (python: string, root: string) => Promise<ComfyPythonRuntime>;
  hardwareProbe?: (runtime: ComfyPythonRuntime) => Promise<Record<string, unknown>>;
  requestTimeoutMs?: number;
  startupTimeoutMs?: number;
  maxWaitMs?: number;
  pollIntervalMs?: number;
  maxPollAttempts?: number;
  referencePreflight?: Pick<H3ReferencePreflight, 'inspect'>;
  runtimeCoordinator?: ComfyRuntimeCoordinator;
};
type RuntimeCache = { value: ComfyPythonRuntime; files: string[]; signature: string };
type OwnedProcess = {
  child: ChildProcess;
  environmentKey: string;
  error?: Error;
  exited: boolean;
  log: string;
  diagnosticLogPath: string;
};
type HistoryEntry = {
  status?: { completed?: boolean; status_str?: string; messages?: unknown[] };
  outputs?: Record<string, Record<string, unknown>>;
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stable(entry)}`)
      .join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
function hash(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}
function samePath(first: string, second: string): boolean {
  const resolve = (file: string): string => {
    try {
      return fs.realpathSync(file);
    } catch {
      return path.resolve(file);
    }
  };
  return process.platform === 'win32'
    ? resolve(first).toLowerCase() === resolve(second).toLowerCase()
    : resolve(first) === resolve(second);
}
function stat(file: string): unknown {
  try {
    const value = fs.statSync(file);
    return { path: path.resolve(file), size: value.size, mtime: value.mtimeMs, ctime: value.ctimeMs, ino: value.ino };
  } catch {
    return { path: path.resolve(file), missing: true };
  }
}
function nodeDependencyFiles(root: string): string[] {
  const files: string[] = [];
  const visit = (directory: string): void => {
    files.push(directory);
    if (!fs.existsSync(directory)) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (['.git', '__pycache__', 'node_modules', '.venv', 'venv'].includes(entry.name) || entry.isSymbolicLink())
        continue;
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(target);
      else if (entry.isFile() && /\.(?:py|toml|json|yaml|yml|txt)$/.test(entry.name)) files.push(target);
    }
  };
  visit(root);
  return files;
}
async function fileHash(file: string, signal?: AbortSignal): Promise<string> {
  const digest = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file, { signal })) digest.update(chunk as Buffer);
  return digest.digest('hex');
}
function revisionFiles(root: string): string[] {
  let gitRoot = path.join(root, '.git');
  try {
    if (fs.statSync(gitRoot).isFile()) {
      const match = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(gitRoot, 'utf8'));
      if (match) gitRoot = path.resolve(root, match[1].trim());
    }
    const head = fs.readFileSync(path.join(gitRoot, 'HEAD'), 'utf8').trim();
    const reference = /^ref:\s*(refs\/[\w/.-]+)$/.exec(head)?.[1];
    return [
      path.join(gitRoot, 'HEAD'),
      path.join(gitRoot, 'packed-refs'),
      ...(reference ? [path.join(gitRoot, reference)] : []),
    ];
  } catch {
    return [path.join(gitRoot, 'HEAD')];
  }
}
function nodeRoot(profile: ComfyProfile, id: string): string {
  return /^(?:ComfyUI|comfyui-core)$/i.test(id)
    ? profile.environment.root
    : path.join(profile.environment.root, 'custom_nodes', id);
}
function gitDirectory(root: string): string | undefined {
  const target = path.join(root, '.git');
  try {
    const stats = fs.statSync(target);
    if (stats.isDirectory()) return target;
    const git = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(target, 'utf8'));
    return git ? path.resolve(root, git[1].trim()) : undefined;
  } catch {
    return undefined;
  }
}
function directGitRevision(root: string, version: string): string | undefined {
  const git = gitDirectory(root);
  if (!git) return undefined;
  const refs = version === 'HEAD' ? ['HEAD'] : [`refs/tags/${version}`, `refs/heads/${version}`, version];
  for (const ref of refs) {
    try {
      const value = fs.readFileSync(path.join(git, ref), 'utf8').trim();
      if (/^[a-f\d]{40,64}$/i.test(value)) return value;
      const indirect = /^ref:\s*(refs\/[\w/.-]+)$/.exec(value)?.[1];
      if (indirect) return directGitRevision(root, indirect);
    } catch {
      /* Packed refs and annotated tags are resolved by git below. */
    }
  }
  try {
    const packed = fs.readFileSync(path.join(git, 'packed-refs'), 'utf8');
    for (const line of packed.split(/\r?\n/)) {
      const match = /^([a-f\d]{40,64})\s+(refs\/[^ ]+)$/.exec(line);
      if (match && refs.includes(match[2])) return match[1];
    }
  } catch {
    /* Missing packed refs is normal for loose-ref repositories. */
  }
  return undefined;
}
function loopbackUrl(profile: ComfyProfile): URL {
  let url: URL;
  try {
    url = new URL(profile.environment.baseUrl);
  } catch {
    throw new Error('COMFY_LOCAL_SERVER_REQUIRED');
  }
  if (
    url.protocol !== 'http:' ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
    url.username ||
    url.password ||
    (url.pathname !== '/' && url.pathname !== '') ||
    url.search ||
    url.hash
  )
    throw new Error('COMFY_LOCAL_SERVER_REQUIRED');
  return url;
}
function environmentKey(profile: ComfyProfile): string {
  return stable({
    root: path.resolve(profile.environment.root),
    python: path.resolve(profile.environment.python),
    baseUrl: loopbackUrl(profile).origin,
    args: profile.environment.launchArgs ?? [],
  });
}
function runtimeKey(profile: ComfyProfile): string {
  return stable({
    root: profile.environment.root,
    python: profile.environment.python,
    nodes: profile.nodes.map((node) => node.id).toSorted(),
  });
}
function assertEnvironment(profile: ComfyProfile): void {
  loopbackUrl(profile);
  if (!path.isAbsolute(profile.environment.root) || !path.isAbsolute(profile.environment.python))
    throw new Error('COMFY_ENVIRONMENT_ABSOLUTE_PATH_REQUIRED');
  if (!fs.existsSync(path.join(profile.environment.root, 'main.py'))) throw new Error('COMFYUI_MISSING');
  if (!fs.existsSync(profile.environment.python)) throw new Error('COMFY_PYTHON_MISSING');
}
function graphFromProfile(profile: ComfyProfile): ComfyGraph {
  let data: unknown;
  try {
    data = JSON.parse(fs.readFileSync(profile.workflowPath, 'utf8'));
  } catch {
    throw new Error('COMFY_WORKFLOW_INVALID_JSON');
  }
  const graph = record(data);
  if (
    !Object.keys(graph).length ||
    Array.isArray(graph.nodes) ||
    Object.hasOwn(graph, 'last_node_id') ||
    !Object.values(graph).every((node) => typeof record(node).class_type === 'string')
  )
    throw new Error('COMFY_API_WORKFLOW_REQUIRED');
  return graph as ComfyGraph;
}
function applyBindings(graph: ComfyGraph, profile: ComfyProfile, values: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) continue;
    for (const binding of profile.bindings[key] ?? []) {
      const node = graph[binding.nodeId];
      if (!node?.inputs || !Object.hasOwn(node.inputs, binding.input)) throw new Error(`COMFY_BINDING_INVALID:${key}`);
      node.inputs[binding.input] = value;
    }
  }
}
function generationValues(profile: ComfyProfile, input: ComfyGenerationInput): Record<string, unknown> {
  const { imagePaths: _imagePaths, references: _references, ...values } = input;
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) continue;
    if (!profile.bindings[key]?.length && !(key === 'durationSeconds' && profile.bindings.frames?.length))
      throw new Error(`COMFY_INPUT_UNSUPPORTED:${key}`);
  }
  const result: Record<string, unknown> = { ...profile.defaults, ...values };
  if (input.durationSeconds !== undefined && profile.bindings.frames?.length) {
    const fps = profile.defaults.fps;
    const multiple = profile.defaults.frameMultiple ?? 1;
    const offset = profile.defaults.frameOffset ?? 0;
    if (typeof fps !== 'number' || !Number.isFinite(fps) || fps <= 0) throw new Error('COMFY_DURATION_FPS_REQUIRED');
    if (
      typeof multiple !== 'number' ||
      !Number.isInteger(multiple) ||
      multiple <= 0 ||
      typeof offset !== 'number' ||
      !Number.isInteger(offset) ||
      offset < 0 ||
      offset >= multiple
    )
      throw new Error('COMFY_FRAME_ALIGNMENT_INVALID');
    const frames = Math.max(
      offset || multiple,
      Math.ceil((input.durationSeconds * fps - offset) / multiple) * multiple + offset
    );
    if (!Number.isSafeInteger(frames)) throw new Error('COMFY_DURATION_FRAMES_INVALID');
    result.frames = frames;
    // Explicit seconds bindings retain their semantics; frames are never written through them.
    if (!profile.bindings.durationSeconds?.length) delete result.durationSeconds;
  }
  return result;
}
function validateKnownModelBindings(profile: ComfyProfile, graph: ComfyGraph): void {
  const args = profile.environment.launchArgs ?? [];
  if (args.some((arg) => /^--extra-model-paths-config(?:=|$)/.test(arg)))
    throw new Error('COMFY_EXTRA_MODEL_PATHS_UNCONFIRMED');
  const index = args.indexOf('--models-directory');
  const configured =
    args.find((arg) => arg.startsWith('--models-directory='))?.slice('--models-directory='.length) ??
    (index >= 0 ? args[index + 1] : undefined);
  if (configured !== undefined && (!configured || !path.isAbsolute(configured)))
    throw new Error('COMFY_MODELS_DIRECTORY_INVALID');
  const modelsRoot = configured ?? path.join(profile.environment.root, 'models');
  const classes: Record<string, Record<string, string[]>> = {
    UNETLoader: { unet_name: ['diffusion_models', 'unet'] },
    CheckpointLoaderSimple: { ckpt_name: ['checkpoints'] },
    CheckpointLoader: { ckpt_name: ['checkpoints'] },
    VAELoader: { vae_name: ['vae'] },
    CLIPLoader: { clip_name: ['text_encoders', 'clip'] },
    DualCLIPLoader: { clip_name1: ['text_encoders', 'clip'], clip_name2: ['text_encoders', 'clip'] },
    TripleCLIPLoader: {
      clip_name1: ['text_encoders', 'clip'],
      clip_name2: ['text_encoders', 'clip'],
      clip_name3: ['text_encoders', 'clip'],
    },
    LoraLoader: { lora_name: ['loras'] },
    LoraLoaderModelOnly: { lora_name: ['loras'] },
  };
  for (const node of Object.values(graph)) {
    for (const [input, directories] of Object.entries(classes[node.class_type ?? ''] ?? {})) {
      const name = node.inputs?.[input];
      if (typeof name !== 'string' || !name) continue;
      const relativeName = name.replaceAll('\\', '/');
      if (relativeName.split('/').includes('..') || path.isAbsolute(name))
        throw new Error('COMFY_PROFILE_MODEL_BINDING_MISMATCH');
      const candidates = directories.map((directory) => path.join(modelsRoot, directory, relativeName));
      if (!profile.components.some((component) => candidates.some((candidate) => samePath(component.path, candidate))))
        throw new Error('COMFY_PROFILE_MODEL_BINDING_MISMATCH');
    }
  }
}
/** External image placeholders have no server-side file before generation; only waive their dynamic filename dropdown. */
function validationRegistry(graph: ComfyGraph, profile: ComfyProfile, registry: ComfyRegistry): ComfyRegistry {
  const result = structuredClone(registry);
  for (const key of ['image', 'images', 'imagePaths', 'inputImage']) {
    for (const binding of profile.bindings[key] ?? []) {
      const node = graph[binding.nodeId];
      const definition = result[node?.class_type ?? '']?.input;
      const input = definition?.required?.[binding.input] ?? definition?.optional?.[binding.input];
      if (!node?.inputs || !input || typeof node.inputs[binding.input] !== 'string') continue;
      const expected = input[0];
      if (Array.isArray(expected) || expected === 'COMBO') input[0] = 'STRING';
    }
  }
  return result;
}
function mimeType(filename: string): string {
  const extension = path.extname(filename).toLowerCase();
  const types: Record<string, string> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
    '.avif': 'image/avif',
    '.mp4': 'video/mp4',
    '.webm': 'video/webm',
    '.mov': 'video/quicktime',
    '.mkv': 'video/x-matroska',
    '.wav': 'audio/wav',
    '.mp3': 'audio/mpeg',
    '.flac': 'audio/flac',
    '.ogg': 'audio/ogg',
    '.m4a': 'audio/mp4',
  };
  return types[extension] ?? 'application/octet-stream';
}
function selectedIdentity(stats: Record<string, unknown>): ComfyServiceIdentity | undefined {
  const system = record(stats.system);
  const executable = system.python_executable ?? system.executable;
  const root = system.comfyui_root ?? system.base_directory;
  return typeof executable === 'string' && typeof root === 'string'
    ? { executable, root, ...(typeof system.pid === 'number' ? { pid: system.pid } : {}) }
    : undefined;
}

/** Resolve the process owning the local server socket; standard /system_stats often omits sys.executable. */
async function inspectService(
  profile: ComfyProfile,
  stats: Record<string, unknown>
): Promise<ComfyServiceIdentity | undefined> {
  return inspectComfyServiceIdentity(loopbackUrl(profile).href, stats);
}

export async function inspectComfyServiceIdentity(
  baseUrl: string,
  stats: Record<string, unknown>
): Promise<ComfyServiceIdentity | undefined> {
  const fromStats = selectedIdentity(stats);
  if (fromStats) return fromStats;
  const url = new URL(baseUrl);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) return undefined;
  const port = Number(url.port || 80);
  const options = { timeout: 5000, windowsHide: true, maxBuffer: 1024 * 1024 };
  try {
    if (process.platform === 'win32') {
      const command = `$owner = Get-NetTCPConnection -State Listen -LocalPort ${port} -ErrorAction Stop | Select-Object -First 1 -ExpandProperty OwningProcess; Get-CimInstance Win32_Process -Filter "ProcessId=$owner" | Select-Object ProcessId,ExecutablePath,CommandLine | ConvertTo-Json -Compress`;
      const processInfo = record(
        JSON.parse(
          await runComfyCommand('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], options)
        )
      );
      const executable = processInfo.ExecutablePath;
      const commandLine = processInfo.CommandLine;
      if (typeof executable !== 'string' || typeof commandLine !== 'string') return undefined;
      const main = /(?:"([^"]*main\.py)"|([^\s"]*main\.py))(?:\s|$)/i.exec(commandLine);
      if (!main || !path.isAbsolute(main[1] ?? main[2])) return undefined;
      return {
        executable,
        root: path.dirname(main[1] ?? main[2]),
        pid: typeof processInfo.ProcessId === 'number' ? processInfo.ProcessId : undefined,
      };
    }
    const pids = await runComfyCommand('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fp'], options);
    const pid = Number(/^p(\d+)$/m.exec(pids)?.[1]);
    if (!Number.isInteger(pid) || pid <= 0) return undefined;
    if (process.platform === 'linux') {
      const args = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0');
      const main = args.find((arg) => /(?:^|\/)main\.py$/.test(arg));
      if (!main) return undefined;
      return {
        executable: fs.realpathSync(`/proc/${pid}/exe`),
        root: path.dirname(path.resolve(fs.realpathSync(`/proc/${pid}/cwd`), main)),
        pid,
      };
    }
    const commandLine = await runComfyCommand('ps', ['-p', String(pid), '-o', 'command='], options);
    const main = /(?:"([^"]*\/main\.py)"|([^\s"]*\/main\.py))(?:\s|$)/.exec(commandLine);
    const executable = /^\s*(?:"([^"]+)"|(\S+))/.exec(commandLine);
    if (!main || !executable) return undefined;
    return { executable: executable[1] ?? executable[2], root: path.dirname(main[1] ?? main[2]), pid };
  } catch {
    return undefined;
  }
}

/** Execute manifest-bound API workflows against the selected local ComfyUI environment. */
export class ComfyWorkflowEngine {
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly owned = new Map<string, OwnedProcess>();
  private readonly starting = new Map<string, Promise<void>>();
  private readonly runtimes = new Map<string, RuntimeCache>();
  private outputRealRoot?: string;

  constructor(private readonly options: ComfyWorkflowEngineOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
    if (!path.isAbsolute(options.outputRoot)) throw new Error('COMFY_OUTPUT_ABSOLUTE_PATH_REQUIRED');
  }

  private outputDirectory(): string {
    fs.mkdirSync(this.options.outputRoot, { recursive: true });
    const actual = fs.realpathSync(this.options.outputRoot);
    if (this.outputRealRoot && !samePath(actual, this.outputRealRoot)) throw new Error('COMFY_OUTPUT_ROOT_CHANGED');
    this.outputRealRoot = actual;
    return actual;
  }
  private diagnosticFile(label: string): string {
    const root = this.outputDirectory();
    const directory = path.join(root, 'diagnostics');
    fs.mkdirSync(directory, { recursive: true });
    if (fs.realpathSync(directory) !== directory) throw new Error('COMFY_DIAGNOSTIC_PATH_ESCAPE');
    const file = path.join(directory, `${label}-${crypto.randomUUID()}.log`);
    fs.writeFileSync(file, '', { flag: 'wx' });
    return file;
  }
  private writeDiagnostic(file: string, payload: string): void {
    const root = this.outputDirectory();
    const relative = path.relative(root, file);
    if (relative.startsWith('..') || path.isAbsolute(relative) || fs.realpathSync(file) !== file)
      throw new Error('COMFY_DIAGNOSTIC_PATH_ESCAPE');
    fs.writeFileSync(file, Buffer.from(payload).subarray(-64 * 1024));
  }
  private diagnosed<T extends Error>(error: T, payload: unknown, label: string): T & { diagnosticLogPath: string } {
    const file = this.diagnosticFile(label);
    const detail =
      payload instanceof Error ? `${payload.name}: ${payload.message}\n${payload.stack ?? ''}` : stable(payload);
    this.writeDiagnostic(file, detail);
    return Object.assign(error, { diagnosticLogPath: file });
  }
  private startupError(
    message: string,
    owned: OwnedProcess
  ): Error & { diagnosticLogPath: string; diagnosis: ComfyDiagnosis } {
    this.writeDiagnostic(owned.diagnosticLogPath, `${owned.log}\n${owned.error?.stack ?? ''}`);
    return Object.assign(new Error(message, { cause: owned.error }), {
      diagnosticLogPath: owned.diagnosticLogPath,
      diagnosis: { category: 'EXECUTION_FAILED', retryable: false, action: 'INSPECT_RUNTIME_LOG' },
    });
  }

  private async request(
    profile: ComfyProfile,
    endpoint: string,
    init: RequestInit = {},
    signal?: AbortSignal
  ): Promise<Response> {
    const signals = [AbortSignal.timeout(this.options.requestTimeoutMs ?? 10_000), ...(signal ? [signal] : [])];
    return this.fetchImpl(`${loopbackUrl(profile).origin}${endpoint}`, {
      ...init,
      signal: AbortSignal.any(signals),
      redirect: 'error',
    });
  }
  private async json(
    profile: ComfyProfile,
    endpoint: string,
    init: RequestInit = {},
    signal?: AbortSignal
  ): Promise<Record<string, unknown>> {
    const response = await this.request(profile, endpoint, init, signal);
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`COMFY_HTTP_${response.status}:${endpoint.split('/')[1]}`);
    }
    const body = await response.text();
    return body.trim() ? record(JSON.parse(body)) : {};
  }
  private async stats(profile: ComfyProfile): Promise<Record<string, unknown> | undefined> {
    try {
      const result = await this.json(profile, '/system_stats');
      return Object.keys(record(result.system)).length ? result : undefined;
    } catch {
      return undefined;
    }
  }
  private async assertIdentity(profile: ComfyProfile, stats: Record<string, unknown>): Promise<void> {
    const owned = this.owned.get(loopbackUrl(profile).origin);
    if (owned && !owned.exited && owned.environmentKey === environmentKey(profile)) return;
    const identity = await (this.options.runtimeInspector ?? inspectService)(profile, stats);
    if (!identity) throw new Error('COMFY_SERVER_ENVIRONMENT_UNCONFIRMED');
    if (
      !samePath(identity.executable, profile.environment.python) ||
      !samePath(identity.root, profile.environment.root)
    )
      throw new Error('COMFY_SERVER_ENVIRONMENT_MISMATCH');
  }

  /** Reuse only a matching healthy process, or start this selected interpreter with loopback binding. */
  async ensureStarted(profile: ComfyProfile): Promise<void> {
    assertEnvironment(profile);
    const frozen = structuredClone(profile);
    const origin = loopbackUrl(frozen).origin;
    const existing = this.starting.get(origin);
    if (existing) {
      await existing;
      const result = await this.stats(frozen);
      if (!result) throw new Error('COMFY_STARTUP_FAILED');
      await this.assertIdentity(frozen, result);
      return;
    }
    const start = this.start(frozen);
    this.starting.set(origin, start);
    try {
      await start;
    } finally {
      this.starting.delete(origin);
    }
  }
  private async start(profile: ComfyProfile): Promise<void> {
    const existing = await this.stats(profile);
    if (existing) {
      await this.assertIdentity(profile, existing);
      return;
    }
    const url = loopbackUrl(profile);
    const previous = this.owned.get(url.origin);
    if (previous && !previous.exited) throw new Error('COMFY_OWNED_SERVER_UNHEALTHY');
    const args = profile.environment.launchArgs ?? [];
    if (
      args.some((arg) => /^--(?:listen|port|base-directory|output-directory|input-directory)(?:=|$)/.test(arg)) ||
      args.some((arg) => arg.includes('\0'))
    )
      throw new Error('COMFY_LAUNCH_ARGS_INVALID');
    const diagnosticLogPath = this.diagnosticFile('startup');
    const child = (this.options.spawnImpl ?? spawn)(
      profile.environment.python,
      [
        path.join(profile.environment.root, 'main.py'),
        ...args,
        '--listen',
        url.hostname === '[::1]' ? '::1' : '127.0.0.1',
        '--port',
        url.port || '80',
      ],
      { cwd: profile.environment.root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }
    );
    const owned: OwnedProcess = {
      child,
      environmentKey: environmentKey(profile),
      exited: false,
      log: '',
      diagnosticLogPath,
    };
    this.owned.set(url.origin, owned);
    child.once('error', (error) => {
      owned.error = error;
      owned.exited = true;
      this.writeDiagnostic(owned.diagnosticLogPath, `${owned.log}\n${error.stack ?? error.message}`);
    });
    child.once('exit', () => {
      owned.exited = true;
    });
    const collect = (chunk: Buffer): void => {
      owned.log = (owned.log + chunk.toString()).slice(-32_768);
      this.writeDiagnostic(owned.diagnosticLogPath, owned.log);
    };
    child.stdout?.on('data', collect);
    child.stderr?.on('data', collect);
    const started = this.now();
    const attempts = Math.max(1, Math.ceil((this.options.startupTimeoutMs ?? 180_000) / 500));
    for (
      let attempt = 0;
      attempt < attempts && this.now() - started < (this.options.startupTimeoutMs ?? 180_000);
      attempt++
    ) {
      if (owned.error || owned.exited) throw this.startupError('COMFY_STARTUP_FAILED', owned);
      const ready = await this.stats(profile);
      if (ready) {
        // Reject a racing, unrelated listener whenever identity can be inspected.
        const identity = await (this.options.runtimeInspector ?? inspectService)(profile, ready);
        if (!identity) {
          child.kill();
          throw new Error('COMFY_SERVER_ENVIRONMENT_UNCONFIRMED');
        }
        if (
          !samePath(identity.executable, profile.environment.python) ||
          !samePath(identity.root, profile.environment.root) ||
          (identity.pid !== undefined && child.pid !== undefined && identity.pid !== child.pid)
        ) {
          child.kill();
          throw new Error('COMFY_SERVER_ENVIRONMENT_MISMATCH');
        }
        return;
      }
      await this.pause(500);
    }
    child.kill();
    throw this.startupError('COMFY_STARTUP_TIMEOUT', owned);
  }

  private trackedFiles(profile: ComfyProfile, runtime: ComfyPythonRuntime): string[] {
    const root = profile.environment.root;
    const files = [
      profile.environment.python,
      path.join(root, 'main.py'),
      path.join(root, 'server.py'),
      path.join(root, 'nodes.py'),
      path.join(root, 'comfyui_version.py'),
      path.join(root, 'requirements.txt'),
      path.join(root, 'pyproject.toml'),
      root,
      ...['comfy', 'comfy_extras'].flatMap((directory) => nodeDependencyFiles(path.join(root, directory))),
      ...revisionFiles(root),
      ...(runtime.packageMetadataFiles ?? []),
      ...(runtime.packageDirectories ?? []),
    ];
    for (const node of profile.nodes) {
      if (!/^[\w.-]+$/.test(node.id) || node.id === '.' || node.id === '..') throw new Error('COMFY_NODE_ID_INVALID');
      const directory = nodeRoot(profile, node.id);
      files.push(
        ...(directory === root ? [directory] : nodeDependencyFiles(directory)),
        ...revisionFiles(directory),
        ...['__init__.py', 'pyproject.toml', 'requirements.txt', 'package.json'].map((name) =>
          path.join(directory, name)
        )
      );
      const git = gitDirectory(directory);
      if (git && /^[\w./-]+$/.test(node.version) && !node.version.includes('..'))
        files.push(path.join(git, 'refs', 'tags', node.version), path.join(git, 'refs', 'heads', node.version));
    }
    return [...new Set(files)];
  }
  private async runtime(profile: ComfyProfile): Promise<ComfyPythonRuntime> {
    const key = runtimeKey(profile);
    const cached = this.runtimes.get(key);
    if (cached && hash(stable(cached.files.map(stat))) === cached.signature) return cached.value;
    const value = await (this.options.runtimeProbe ?? ((python, root) => readPythonRuntime(python, { root })))(
      profile.environment.python,
      profile.environment.root
    );
    if (
      value.status !== 'available' ||
      value.error ||
      !value.packages.torch ||
      !value.executable ||
      !samePath(value.executable, profile.environment.python)
    )
      throw new Error('COMFY_PYTHON_RUNTIME_UNAVAILABLE');
    const files = this.trackedFiles(profile, value);
    this.runtimes.set(key, { value, files, signature: hash(stable(files.map(stat))) });
    return value;
  }

  private async hardware(runtime: ComfyPythonRuntime): Promise<Record<string, unknown>> {
    return this.options.hardwareProbe
      ? this.options.hardwareProbe(runtime)
      : readComfyHardwareIdentity({ accelerator: runtime.accelerator });
  }

  /** Hash recipe, actual workflow, model file identity, node revisions, Python packages, and service compatibility. */
  async snapshotFingerprint(profile: ComfyProfile): Promise<string> {
    assertEnvironment(profile);
    const runtime = await this.runtime(profile);
    const hardware = await this.hardware(runtime);
    const server = await this.stats(profile);
    if (!server) throw new Error('COMFY_SERVER_UNAVAILABLE');
    await this.assertIdentity(profile, server);
    const workflowSha256 = hash(fs.readFileSync(profile.workflowPath, 'utf8'));
    if (profile.workflowSha256 && profile.workflowSha256.toLowerCase() !== workflowSha256)
      throw new Error('COMFY_WORKFLOW_HASH_MISMATCH');
    const system = record(server.system);
    const targetTorch = runtime.torchVersion ?? runtime.packages.torch;
    if (
      (typeof system.pytorch_version === 'string' && targetTorch && system.pytorch_version !== targetTorch) ||
      (typeof system.python_version === 'string' &&
        runtime.version &&
        system.python_version.split(/\s/)[0] !== runtime.version)
    )
      throw new Error('COMFY_SERVER_RUNTIME_MISMATCH');
    return hash(
      stable({
        recipe: {
          id: profile.id,
          family: profile.family,
          kind: profile.kind,
          version: profile.version,
          quantization: profile.quantization,
          capabilities: profile.capabilities,
          environment: profile.environment,
          workflowPath: profile.workflowPath,
          workflowSha256,
          bindings: profile.bindings,
          defaults: profile.defaults,
          memoryPolicy: profile.memoryPolicy,
          nodes: profile.nodes,
        },
        components: profile.components.map((component) => ({ ...component, file: stat(component.path) })),
        dependencies: this.runtimes.get(runtimeKey(profile))!.files.map(stat),
        hardware,
        python: {
          executable: runtime.executable,
          version: runtime.version,
          packages: runtime.packages,
          torchVersion: runtime.torchVersion,
          cudaVersion: runtime.cudaVersion,
          hipVersion: runtime.hipVersion,
          accelerator: runtime.accelerator,
          devices: runtime.devices?.map((device) => ({
            name: device.name,
            totalMemoryBytes: device.totalMemoryBytes,
            computeCapability: device.computeCapability,
          })),
        },
        service: {
          pythonVersion: system.python_version,
          torchVersion: system.pytorch_version,
          comfyVersion: system.comfyui_version,
          comfyRevision: system.comfyui_revision,
          devices: Array.isArray(server.devices)
            ? server.devices.map((value) => {
                const device = record(value);
                return {
                  name: device.name,
                  type: device.type,
                  index: device.index,
                  totalMemoryBytes: device.vram_total,
                  computeCapability: device.compute_capability,
                };
              })
            : [],
        },
      })
    );
  }

  /** Check pinned files, current node registry and model dropdown compatibility, without sampling. */
  async validate(
    profile: ComfyProfile,
    signal?: AbortSignal
  ): Promise<{
    fingerprint: string;
    loadable: true;
    runtime: NonNullable<NonNullable<ComfyProfile['validation']>['runtime']>;
  }> {
    const frozen = structuredClone(profile);
    if (signal) this.throwAborted(signal);
    for (const component of frozen.components) {
      if (
        !path.isAbsolute(component.path) ||
        !fs.existsSync(component.path) ||
        !fs.statSync(component.path).isFile() ||
        !fs.statSync(component.path).size
      )
        throw new Error('COMFY_MISSING_MODEL');
      if (component.sizeBytes !== undefined && fs.statSync(component.path).size !== component.sizeBytes)
        throw new Error('COMFY_MODEL_SIZE_MISMATCH');
      if (component.sha256 && (await fileHash(component.path, signal)) !== component.sha256.toLowerCase())
        throw new Error('COMFY_MODEL_HASH_MISMATCH');
    }
    await this.ensureStarted(frozen);
    if (signal) this.throwAborted(signal);
    const runtime = await this.runtime(frozen);
    const stats = await this.stats(frozen);
    const system = record(stats?.system);
    const nodeRevisions: Record<string, string> = {};
    for (const node of frozen.nodes) nodeRevisions[node.id] = await this.checkNodeRevision(frozen, node, system);
    const graph = graphFromProfile(frozen);
    applyBindings(graph, frozen, frozen.defaults);
    validateKnownModelBindings(frozen, graph);
    const registry = (await this.json(frozen, '/object_info')) as ComfyRegistry;
    validateComfyWorkflow(graph, validationRegistry(graph, frozen, registry));
    return {
      fingerprint: await this.snapshotFingerprint(frozen),
      loadable: true,
      runtime: {
        python: runtime.version ?? '',
        packages: runtime.packages,
        comfyRevision:
          typeof system.comfyui_revision === 'string'
            ? system.comfyui_revision
            : (nodeRevisions['comfyui-core'] ?? nodeRevisions.ComfyUI),
        nodeRevisions,
        hardware: {
          ...(await this.hardware(runtime)),
          devices: runtime.devices ?? [],
          serviceDevices: Array.isArray(stats?.devices)
            ? stats.devices.map((value) => {
                const device = record(value);
                return { name: device.name, type: device.type, totalMemoryBytes: device.vram_total };
              })
            : [],
        },
      },
    };
  }

  private async checkNodeRevision(
    profile: ComfyProfile,
    node: ComfyProfile['nodes'][number],
    system: Record<string, unknown>
  ): Promise<string> {
    const directory = nodeRoot(profile, node.id);
    if (!fs.existsSync(directory)) throw new Error('COMFY_NODE_REVISION_UNCONFIRMED');
    if (gitDirectory(directory)) {
      const options = { timeout: 5000, windowsHide: true, maxBuffer: 1024 * 1024 };
      let actual = directGitRevision(directory, 'HEAD');
      const realRepository = fs.existsSync(path.join(gitDirectory(directory)!, 'objects'));
      if (!actual || realRepository)
        try {
          actual = (
            await runComfyCommand('git', ['-C', directory, 'rev-parse', '--verify', 'HEAD^{commit}'], options)
          ).trim();
        } catch {
          if (realRepository) actual = undefined;
        }
      if (!actual || !/^[a-f\d]{40,64}$/i.test(actual)) throw new Error('COMFY_NODE_REVISION_UNCONFIRMED');
      if (!/^[\w./-]+$/.test(node.version) || node.version.startsWith('-') || node.version.includes('..'))
        throw new Error('COMFY_NODE_REVISION_UNCONFIRMED');
      let expected = /^[a-f\d]{7,64}$/i.test(node.version) ? node.version : directGitRevision(directory, node.version);
      if (!expected || realRepository)
        try {
          expected = (
            await runComfyCommand(
              'git',
              ['-C', directory, 'rev-parse', '--verify', `${node.version}^{commit}`],
              options
            )
          ).trim();
        } catch {
          if (realRepository) expected = undefined;
        }
      if (!expected || !/^[a-f\d]{7,64}$/i.test(expected)) throw new Error('COMFY_NODE_REVISION_UNCONFIRMED');
      if (!actual.toLowerCase().startsWith(expected.toLowerCase())) throw new Error('COMFY_NODE_REVISION_MISMATCH');
      return actual;
    }
    if (directory === profile.environment.root) {
      let actual: string | undefined;
      try {
        actual = /__version__\s*=\s*['"]([^'"]+)['"]/.exec(
          fs.readFileSync(path.join(directory, 'comfyui_version.py'), 'utf8')
        )?.[1];
      } catch {
        /* Portable service version can establish the core release. */
      }
      actual ??= typeof system.comfyui_version === 'string' ? system.comfyui_version : undefined;
      if (!actual) throw new Error('COMFY_NODE_REVISION_UNCONFIRMED');
      if (actual.replace(/^v/, '') !== node.version.replace(/^v/, '')) throw new Error('COMFY_NODE_REVISION_MISMATCH');
      return actual;
    }
    const known = MATLOWAI_CUSTOM_NODE_ARCHIVES.find(
      (archive) => archive.targetDirectory === node.id && archive.revision === node.version
    );
    if (!known) throw new Error('COMFY_NODE_REVISION_UNCONFIRMED');
    let ancestor = profile.environment.root;
    for (let level = 0; level < 5; level++) {
      const archive = path.join(ancestor, known.relativePath);
      if (
        fs.existsSync(archive) &&
        fs.statSync(archive).size === known.sizeBytes &&
        (await fileHash(archive)) === known.sha256
      )
        return known.revision;
      const parent = path.dirname(ancestor);
      if (parent === ancestor) break;
      ancestor = parent;
    }
    throw new Error('COMFY_NODE_REVISION_UNCONFIRMED');
  }

  private async inputImages(
    profile: ComfyProfile,
    graph: ComfyGraph,
    imagePaths: string[],
    signal: AbortSignal
  ): Promise<void> {
    if (!imagePaths.length) return;
    const destinations =
      profile.bindings.image ??
      profile.bindings.images ??
      profile.bindings.imagePaths ??
      profile.bindings.inputImage ??
      [];
    if (!destinations.length || imagePaths.length > destinations.length)
      throw new Error('COMFY_IMAGE_BINDINGS_MISSING');
    for (let index = 0; index < imagePaths.length; index++) {
      const imagePath = imagePaths[index];
      if (!path.isAbsolute(imagePath) || !fs.existsSync(imagePath) || !fs.statSync(imagePath).isFile())
        throw new Error('COMFY_INPUT_IMAGE_MISSING');
      if (!mimeType(imagePath).startsWith('image/')) throw new Error('COMFY_INPUT_IMAGE_FORMAT');
      const data = new FormData();
      data.append(
        'image',
        new Blob([fs.readFileSync(imagePath)], { type: mimeType(imagePath) }),
        path.basename(imagePath)
      );
      data.append('type', 'input');
      data.append('overwrite', 'false');
      const uploaded = await this.json(profile, '/upload/image', { method: 'POST', body: data }, signal);
      if (typeof uploaded.name !== 'string' || !uploaded.name || /[\\/]/.test(uploaded.name))
        throw new Error('COMFY_UPLOAD_INVALID_RESPONSE');
      const subfolder = typeof uploaded.subfolder === 'string' ? uploaded.subfolder.replaceAll('\\', '/') : '';
      if (subfolder.split('/').some((segment) => segment === '..') || subfolder.startsWith('/'))
        throw new Error('COMFY_UPLOAD_INVALID_RESPONSE');
      const destination = destinations[index];
      const node = graph[destination.nodeId];
      if (!node?.inputs || !Object.hasOwn(node.inputs, destination.input))
        throw new Error('COMFY_BINDING_INVALID:image');
      node.inputs[destination.input] = [subfolder, uploaded.name].filter(Boolean).join('/');
    }
  }

  private async inputReferences(
    profile: ComfyProfile,
    graph: ComfyGraph,
    references: NonNullable<ComfyGenerationInput['references']>,
    media: Map<string, { duration: number; audio: boolean; fps?: number }>,
    signal: AbortSignal
  ): Promise<string> {
    const target = Object.values(graph).find((node) => node.class_type === 'MiniMaxH3ReferenceToVideo');
    if (!target?.inputs) throw new Error('COMFY_OMNI_REFERENCE_BINDING_MISSING');
    for (const key of Object.keys(target.inputs)) {
      if (/^ref_(images|videos|video_audios|audios)(?:\.|$)/.test(key)) delete target.inputs[key];
    }
    const add = (class_type: string, inputs: Record<string, unknown>): string => {
      const id = String(Math.max(0, ...Object.keys(graph).map(Number).filter(Number.isFinite)) + 1);
      graph[id] = { class_type, inputs };
      return id;
    };
    const counts = { image: 0, video: 0, audio: 0 };
    for (const reference of references) {
      this.throwAborted(signal);
      if (!path.isAbsolute(reference.path) || !fs.existsSync(reference.path) || !fs.statSync(reference.path).isFile())
        throw new Error('COMFY_REFERENCE_FILE_MISSING');
      if (!mimeType(reference.path).startsWith(`${reference.type}/`)) throw new Error('COMFY_REFERENCE_TYPE_MISMATCH');
      const upload = async (file: string): Promise<Record<string, unknown>> => {
        const data = new FormData();
        data.append(
          'image',
          new Blob([fs.readFileSync(file)], { type: mimeType(file) }),
          `${crypto.randomUUID()}-${path.basename(file)}`
        );
        data.append('type', 'input');
        data.append('overwrite', 'false');
        return this.json(profile, '/upload/image', { method: 'POST', body: data }, signal);
      };
      const uploaded =
        reference.type === 'video'
          ? await withComfyReferenceVideo(reference.path, media.get(reference.path)?.fps, signal, upload)
          : await upload(reference.path);
      if (typeof uploaded.name !== 'string' || !uploaded.name || /[\\/]/.test(uploaded.name))
        throw new Error('COMFY_UPLOAD_INVALID_RESPONSE');
      const subfolder = typeof uploaded.subfolder === 'string' ? uploaded.subfolder.replaceAll('\\', '/') : '';
      if (
        subfolder.split('/').some((segment) => segment === '..') ||
        subfolder.startsWith('/') ||
        /^[a-z]:/i.test(subfolder)
      )
        throw new Error('COMFY_UPLOAD_INVALID_RESPONSE');
      const filename = [subfolder, uploaded.name].filter(Boolean).join('/');
      const index = counts[reference.type]++;
      if (reference.type === 'image') {
        target.inputs[`ref_images.ref_image_${index}`] = [add('LoadImage', { image: filename }), 0];
      } else if (reference.type === 'video') {
        const loader = add('LoadVideo', { file: filename });
        const components = add('GetVideoComponents', { video: [loader, 0] });
        target.inputs[`ref_videos.ref_video_${index}`] = [components, 0];
        if (media.get(reference.path)?.audio)
          target.inputs[`ref_video_audios.ref_video_audio_${index}`] = [components, 1];
      } else {
        target.inputs[`ref_audios.ref_audio_${index}`] = [add('LoadAudio', { audio: filename }), 0];
      }
    }
    // The official node presents images, paired soundtrack/video, then standalone audio.
    const tags = Array.from({ length: counts.image }, (_, index) => `<Picture ${index + 1}>`);
    let audioIndex = 0;
    references
      .filter((reference) => reference.type === 'video')
      .forEach((reference, index) => {
        if (media.get(reference.path)?.audio) tags.push(`<Audio ${++audioIndex}>`);
        tags.push(`<Video ${index + 1}>`);
      });
    for (let index = 0; index < counts.audio; index++) tags.push(`<Audio ${++audioIndex}>`);
    return tags.join(' ');
  }

  /** Submit exactly once, poll bounded history, then copy ComfyUI artifacts into application-owned output storage. */
  async generate(
    profile: ComfyProfile,
    input: ComfyGenerationInput,
    signal: AbortSignal,
    onProgress?: (progress: number) => void,
    onSubmitted?: (promptId: string) => void,
    onSubmitting?: (promptId: string) => void
  ): Promise<ComfyGenerationResult> {
    const prepared = await this.prepareInput(profile, input, signal);
    let submitted = false;
    let uncertain = false;
    const reservedPromptId = crypto.randomUUID();
    const execute = async (): Promise<ComfyGenerationResult> => {
      try {
        return await this.generateUncoordinated(
          prepared,
          signal,
          onProgress,
          (promptId) => {
            submitted = true;
            (this.options.runtimeCoordinator ?? sharedComfyRuntimeCoordinator).adoptTaskId(reservedPromptId, promptId);
            onSubmitted?.(promptId);
          },
          (promptId) => {
            submitted = true;
            onSubmitting?.(promptId);
          },
          reservedPromptId
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        uncertain =
          submitted &&
          !(error && typeof error === 'object' && 'remoteTerminal' in error) &&
          !/COMFY_(?:EXECUTION_ERROR|PROMPT_REJECTED)/.test(message) &&
          !(error && typeof error === 'object' && 'diagnosis' in error);
        throw error;
      }
    };
    return this.coordinate(prepared.frozen, reservedPromptId, false, execute, () => uncertain, signal);
  }

  private async coordinate<T>(
    profile: ComfyProfile,
    taskId: string,
    recover: boolean,
    task: () => Promise<T>,
    isUncertain: () => boolean,
    signal: AbortSignal
  ): Promise<T> {
    const coordinator = this.options.runtimeCoordinator ?? sharedComfyRuntimeCoordinator;
    const resource = await this.runtimeResourceKey(profile).catch(() => 'machine');
    const binding = { kind: 'comfy' as const, profile, outputRoot: this.options.outputRoot };
    const memory = (stats: Record<string, unknown> | undefined) =>
      Array.isArray(stats?.devices)
        ? stats.devices.map((device) => {
            const value = record(device);
            return {
              index: value.index,
              total: value.vram_total,
              free: value.vram_free,
              torchTotal: value.torch_vram_total,
              torchFree: value.torch_vram_free,
            };
          })
        : [];
    const execute = async (): Promise<T> => {
      const before = memory(await this.stats(profile));
      try {
        if (
          !recover &&
          before.some(
            (device) =>
              typeof device.free === 'number' &&
              typeof device.total === 'number' &&
              device.free < Math.max(512 * 1024 * 1024, device.total * 0.05) &&
              typeof device.torchTotal === 'number' &&
              typeof device.torchFree === 'number' &&
              device.torchTotal > device.torchFree
          )
        )
          await this.clearMemory(profile, 'memory-pressure', signal);
        const result = await task();
        const after = memory(await this.stats(profile));
        this.writeTaskMemoryDiagnostic({
          taskId,
          resource,
          components: profile.components,
          before,
          after,
          failedNode: undefined,
        });
        return result;
      } catch (error) {
        const after = memory(await this.stats(profile));
        const diagnosis =
          error && typeof error === 'object' && 'diagnosis' in error
            ? (error as { diagnosis?: { nodeId?: string; category?: string } }).diagnosis
            : undefined;
        this.writeTaskMemoryDiagnostic({
          taskId,
          resource,
          components: profile.components,
          before,
          after,
          failure: error instanceof Error ? error.message : String(error),
          category: diagnosis?.category,
          failedNode: diagnosis?.nodeId,
        });
        throw error;
      }
    };
    return coordinator.run(
      resource,
      comfyRuntimeSignature(profile),
      execute,
      (reason, previous) => {
        const previousProfile = (previous as typeof binding | undefined)?.profile;
        if (
          !previous ||
          ((previous as typeof binding).kind === 'comfy' &&
            previousProfile?.environment.baseUrl === profile.environment.baseUrl)
        )
          return this.clearMemory(previousProfile ?? profile, reason, new AbortController().signal);
        return clearBoundComfyRuntime(previous, reason, new AbortController().signal, () =>
          this.clearMemory(profile, reason, new AbortController().signal)
        );
      },
      signal,
      { taskId, recover, isUncertain, context: binding }
    );
  }

  private writeTaskMemoryDiagnostic(payload: Record<string, unknown>): void {
    try {
      const file = this.diagnosticFile('task-memory');
      this.writeDiagnostic(file, stable({ at: new Date(this.now()).toISOString(), ...payload }));
    } catch {
      /* A diagnostic write must not change the job outcome. */
    }
  }

  private async prepareInput(profile: ComfyProfile, input: ComfyGenerationInput, signal: AbortSignal) {
    const frozen = structuredClone(profile);
    const requestInput = validateComfyGenerationInputForFamily(frozen.family, structuredClone(input));
    const references =
      requestInput.references ?? requestInput.imagePaths?.map((file) => ({ type: 'image' as const, path: file })) ?? [];
    this.throwAborted(signal);
    if (frozen.family !== 'fasth3-omni' && references.some((reference) => reference.type !== 'image'))
      throw new Error('COMFY_MULTIMODAL_WORKFLOW_REQUIRED');
    if (
      frozen.family !== 'fasth3-omni' &&
      (frozen.family === 'qwen-edit' ||
        frozen.capabilities.includes('image-edit') ||
        frozen.capabilities.includes('image-to-image') ||
        (!frozen.capabilities.includes('text-to-video') &&
          (frozen.capabilities.includes('image-to-video') || frozen.capabilities.includes('reference-to-video')))) &&
      !references.length
    )
      throw new Error('COMFY_INPUT_IMAGE_REQUIRED');
    if (typeof requestInput.prompt !== 'string' || !requestInput.prompt.trim())
      throw new Error('COMFY_PROMPT_REQUIRED');
    if (!frozen.bindings.prompt?.length) throw new Error('COMFY_PROMPT_BINDING_MISSING');
    const media =
      frozen.family === 'fasth3-omni'
        ? await (this.options.referencePreflight ?? new H3ReferencePreflight()).inspect(references)
        : new Map<string, { duration: number; audio: boolean }>();
    if (frozen.family === 'fasth3-omni') {
      const soundtracks = references.filter(
        (reference) => reference.type === 'video' && media.get(reference.path)?.audio
      );
      const audio = references.filter((reference) => reference.type === 'audio');
      if (soundtracks.length + audio.length > 3) throw new Error('COMFY_REFERENCE_AUDIO_LIMIT_WITH_SOUNDTRACKS');
      if (references.length + soundtracks.length > 12) throw new Error('COMFY_REFERENCE_TOTAL_LIMIT_WITH_SOUNDTRACKS');
      if (
        [...soundtracks, ...audio].reduce((sum, reference) => sum + (media.get(reference.path)?.duration ?? 0), 0) >
        15.001
      )
        throw new Error('COMFY_REFERENCE_AUDIO_DURATION_WITH_SOUNDTRACKS');
    }
    return { frozen, requestInput, references, media };
  }

  private async generateUncoordinated(
    prepared: Awaited<ReturnType<ComfyWorkflowEngine['prepareInput']>>,
    signal: AbortSignal,
    onProgress?: (progress: number) => void,
    onSubmitted?: (promptId: string) => void,
    onSubmitting?: (promptId: string) => void,
    reservedPromptId = crypto.randomUUID()
  ): Promise<ComfyGenerationResult> {
    const { frozen, requestInput, references, media } = prepared;
    await this.ensureStarted(frozen);
    const current = await this.snapshotFingerprint(frozen);
    if (frozen.validation && frozen.validation.fingerprint !== current) throw new Error('COMFY_PROFILE_CHANGED');
    const graph = graphFromProfile(frozen);
    applyBindings(graph, frozen, generationValues(frozen, requestInput));
    validateKnownModelBindings(frozen, graph);
    if (frozen.family === 'fasth3-omni') {
      const tags = await this.inputReferences(frozen, graph, references, media, signal);
      const missing = tags
        .split('> ')
        .map((tag) => (tag.endsWith('>') ? tag : `${tag}>`))
        .filter((tag) => !requestInput.prompt.includes(tag));
      if (missing.length) applyBindings(graph, frozen, { prompt: `${requestInput.prompt}\n${missing.join(' ')}` });
    } else
      await this.inputImages(
        frozen,
        graph,
        references.map((reference) => reference.path),
        signal
      );
    const registry = (await this.json(frozen, '/object_info', {}, signal)) as ComfyRegistry;
    validateComfyWorkflow(graph, registry);
    this.throwAborted(signal);
    onProgress?.(0);
    let response: Response;
    this.throwAborted(signal);
    onSubmitting?.(reservedPromptId);
    try {
      response = await this.request(
        frozen,
        '/prompt',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ prompt: graph, client_id: crypto.randomUUID(), prompt_id: reservedPromptId }),
        },
        signal
      );
    } catch (cause) {
      throw new Error('COMFY_SUBMISSION_STATE_UNKNOWN', { cause });
    }
    let submission: Record<string, unknown>;
    try {
      submission = record(await response.json());
    } catch (cause) {
      throw new Error('COMFY_SUBMISSION_STATE_UNKNOWN', { cause });
    }
    if (
      !response.ok ||
      Object.keys(record(submission.error)).length ||
      Object.keys(record(submission.node_errors)).length
    )
      throw this.diagnosed(diagnoseComfyError(submission, true), submission, 'submission');
    if (typeof submission.prompt_id !== 'string' || !submission.prompt_id)
      throw new Error('COMFY_SUBMISSION_STATE_UNKNOWN');
    const promptId = submission.prompt_id;
    onSubmitted?.(promptId);
    let cancellation: Promise<void> | undefined;
    const abort = (): void => {
      cancellation = this.cancel(frozen, promptId);
      void cancellation.catch((): void => undefined);
    };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    let remoteTerminal = false;
    try {
      const history = await this.wait(frozen, promptId, signal);
      remoteTerminal = true;
      this.throwAborted(signal);
      const artifacts = await this.download(frozen, promptId, history, signal);
      onProgress?.(100);
      return { promptId, artifacts };
    } catch (error) {
      if (remoteTerminal && error instanceof Error) Object.assign(error, { remoteTerminal: true });
      if (cancellation) {
        try {
          await cancellation;
          if (error instanceof Error) Object.assign(error, { remoteTerminal: true });
        } catch {
          /* Keep the remote uncertainty when cancellation was not confirmed. */
        }
      }
      throw error;
    } finally {
      signal.removeEventListener('abort', abort);
    }
  }

  private async wait(profile: ComfyProfile, promptId: string, signal: AbortSignal): Promise<HistoryEntry> {
    const started = this.now();
    let failures = 0;
    const attempts = this.options.maxPollAttempts ?? 7200;
    for (let attempt = 0; attempt < attempts; attempt++) {
      this.throwAborted(signal);
      let entry: HistoryEntry | undefined;
      try {
        const history = await this.json(profile, `/history/${encodeURIComponent(promptId)}`, {}, signal);
        entry = history[promptId] as HistoryEntry | undefined;
        failures = 0;
      } catch (cause) {
        this.throwAborted(signal);
        if (++failures >= 3 || attempt === attempts - 1) throw new Error('COMFY_HISTORY_UNAVAILABLE', { cause });
      }
      if (entry?.status?.messages?.some((message) => Array.isArray(message) && message[0] === 'execution_interrupted'))
        throw Object.assign(new Error('COMFY_JOB_CANCELLED'), { remoteTerminal: true });
      if (entry?.status?.status_str === 'error') throw this.diagnosed(diagnoseComfyError(entry), entry, 'execution');
      if (entry?.status?.completed) return entry;
      if (this.now() - started >= (this.options.maxWaitMs ?? 2 * 60 * 60 * 1000))
        throw new Error('COMFY_HISTORY_TIMEOUT');
      await this.pause(this.options.pollIntervalMs ?? 1000, signal);
    }
    throw new Error('COMFY_HISTORY_TIMEOUT');
  }
  /** Recover a known prompt on its existing healthy server without starting a new process or resubmitting. */
  async resume(
    profile: ComfyProfile,
    promptId: string,
    signal: AbortSignal,
    onProgress?: (progress: number) => void
  ): Promise<ComfyGenerationResult> {
    profile = structuredClone(profile);
    let uncertain = true;
    return this.coordinate(
      profile,
      promptId,
      true,
      async () => {
        try {
          const result = await this.resumeUncoordinated(profile, promptId, signal, onProgress);
          uncertain = false;
          return result;
        } catch (error) {
          if (error && typeof error === 'object' && ('diagnosis' in error || 'remoteTerminal' in error))
            uncertain = false;
          throw error;
        }
      },
      () => uncertain,
      signal
    );
  }

  private async resumeUncoordinated(
    profile: ComfyProfile,
    promptId: string,
    signal: AbortSignal,
    onProgress?: (progress: number) => void
  ): Promise<ComfyGenerationResult> {
    const frozen = structuredClone(profile);
    this.throwAborted(signal);
    assertEnvironment(frozen);
    const stats = await this.stats(frozen);
    if (!stats) throw new Error('COMFY_RESUME_SERVER_UNAVAILABLE');
    await this.assertIdentity(frozen, stats);
    let fingerprint: string;
    try {
      fingerprint = await this.snapshotFingerprint(frozen);
    } catch (cause) {
      if (cause instanceof Error && cause.message === 'COMFY_SERVER_UNAVAILABLE')
        throw new Error('COMFY_RESUME_SERVER_UNAVAILABLE', { cause });
      throw cause;
    }
    if (frozen.validation && frozen.validation.fingerprint !== fingerprint) throw new Error('COMFY_PROFILE_CHANGED');
    const readRecovery = async (endpoint: string): Promise<Record<string, unknown>> => {
      try {
        return await this.json(frozen, endpoint, {}, signal);
      } catch (cause) {
        this.throwAborted(signal);
        throw new Error('COMFY_HISTORY_UNAVAILABLE', { cause });
      }
    };
    const history = await readRecovery(`/history/${encodeURIComponent(promptId)}`);
    if (!Object.hasOwn(history, promptId)) {
      const queue = await readRecovery('/queue');
      const present = [queue.queue_running, queue.queue_pending].some(
        (entries) => Array.isArray(entries) && entries.some((entry) => Array.isArray(entry) && entry[1] === promptId)
      );
      if (!present) throw new Error('COMFY_RESUME_PROMPT_LOST');
    }
    let cancellation: Promise<void> | undefined;
    const abort = (): void => {
      cancellation = this.cancel(frozen, promptId);
      void cancellation.catch((): void => undefined);
    };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    let remoteTerminal = false;
    try {
      onProgress?.(0);
      const completed = await this.wait(frozen, promptId, signal);
      remoteTerminal = true;
      const artifacts = await this.download(frozen, promptId, completed, signal);
      onProgress?.(100);
      return { promptId, artifacts };
    } catch (error) {
      if (remoteTerminal && error instanceof Error) Object.assign(error, { remoteTerminal: true });
      if (cancellation) {
        try {
          await cancellation;
          if (error instanceof Error) Object.assign(error, { remoteTerminal: true });
        } catch {
          /* Keep the remote uncertainty when cancellation was not confirmed. */
        }
      }
      throw error;
    } finally {
      signal.removeEventListener('abort', abort);
    }
  }
  private async download(
    profile: ComfyProfile,
    promptId: string,
    history: HistoryEntry,
    signal: AbortSignal
  ): Promise<ComfyGenerationResult['artifacts']> {
    const candidates = Object.values(history.outputs ?? {})
      .flatMap((output) =>
        ['images', 'videos', 'gifs', 'audio', 'audios'].flatMap((key) =>
          Array.isArray(output[key])
            ? (output[key] as unknown[])
            : output[key] && typeof output[key] === 'object'
              ? [output[key]]
              : []
        )
      )
      .map(record)
      .filter(
        (item) =>
          typeof item.filename === 'string' && item.filename && (item.type === undefined || item.type === 'output')
      );
    if (!candidates.length) throw new Error('COMFY_NO_OUTPUT');
    const directory = fs.mkdtempSync(path.join(this.outputDirectory(), `${hash(promptId).slice(0, 16)}-`));
    const artifacts: ComfyGenerationResult['artifacts'] = [];
    const seen = new Set<string>();
    try {
      for (const item of candidates) {
        this.throwAborted(signal);
        const filename = String(item.filename);
        const subfolder = typeof item.subfolder === 'string' ? item.subfolder : '';
        const key = stable({ filename, subfolder });
        if (seen.has(key)) continue;
        seen.add(key);
        const query = new URLSearchParams({ filename, subfolder, type: 'output' });
        let response: Response;
        try {
          response = await this.request(profile, `/view?${query}`, {}, signal);
        } catch (cause) {
          this.throwAborted(signal);
          throw this.diagnosed(new Error('COMFY_OUTPUT_RETRIEVAL_FAILED', { cause }), cause, 'output');
        }
        if (!response.ok) {
          await response.body?.cancel();
          throw new Error(`COMFY_OUTPUT_DOWNLOAD_HTTP_${response.status}`);
        }
        const extension = path.extname(path.basename(filename.replaceAll('\\', '/'))).toLowerCase();
        const safeExtension = /^\.[a-z0-9]{1,8}$/.test(extension) ? extension : '.bin';
        const target = path.join(directory, `${artifacts.length + 1}${safeExtension}`);
        if (!response.body) throw new Error('COMFY_OUTPUT_EMPTY');
        try {
          await pipeline(
            Readable.fromWeb(response.body as import('node:stream/web').ReadableStream),
            fs.createWriteStream(target, { flags: 'wx' }),
            { signal }
          );
        } catch (cause) {
          this.throwAborted(signal);
          const code = (cause as NodeJS.ErrnoException | undefined)?.code;
          if (code && ['ENOSPC', 'EACCES', 'EPERM', 'EEXIST', 'ENOENT'].includes(code)) throw cause;
          throw this.diagnosed(new Error('COMFY_OUTPUT_RETRIEVAL_FAILED', { cause }), cause, 'output');
        }
        this.throwAborted(signal);
        if (!fs.statSync(target).size) throw new Error('COMFY_OUTPUT_EMPTY');
        const reportedType = response.headers.get('content-type')?.split(';')[0];
        artifacts.push({
          path: target,
          mimeType:
            mimeType(filename) === 'application/octet-stream' &&
            reportedType &&
            /^(image|video|audio)\/[\w.+-]+$/.test(reportedType)
              ? reportedType
              : mimeType(filename),
        });
      }
      return artifacts;
    } catch (error) {
      fs.rmSync(directory, { recursive: true, force: true });
      throw error;
    }
  }

  /** Delete only this queued prompt and interrupt only if it is the sole matching active prompt. */
  async runtimeResourceKey(profile: ComfyProfile): Promise<string> {
    const stats = await this.stats(profile);
    if (stats) await this.assertIdentity(profile, stats);
    return comfyRuntimeResourceKey(profile.environment.baseUrl, stats ?? {});
  }

  /** Request cache eviction only on an idle, identified runtime and observe device memory recovery. */
  async clearMemory(profile: ComfyProfile, reason: ComfyCleanupReason, signal: AbortSignal): Promise<void> {
    const frozen = structuredClone(profile);
    let baseline: number[] = [];
    const observations: number[][] = [];
    let confirmed = false;
    let failure: unknown;
    try {
      this.throwAborted(signal);
      assertEnvironment(frozen);
      const before = await this.json(frozen, '/system_stats', {}, signal);
      await this.assertIdentity(frozen, before);
      const identityBefore = await (this.options.runtimeInspector ?? inspectService)(frozen, before);
      const assertIdle = async (): Promise<void> => {
        const queue = await this.json(frozen, '/queue', {}, signal);
        if (!Array.isArray(queue.queue_running) || !Array.isArray(queue.queue_pending))
          throw new Error('COMFY_QUEUE_INVALID_RESPONSE');
        if (queue.queue_running.length || queue.queue_pending.length) throw new Error('COMFY_MEMORY_CLEAR_QUEUE_BUSY');
      };
      const memory = (stats: Record<string, unknown>): number[] =>
        Array.isArray(stats.devices)
          ? stats.devices.map((value) => {
              const device = record(value);
              return typeof device.vram_free === 'number' && Number.isFinite(device.vram_free) ? device.vram_free : NaN;
            })
          : [];
      baseline = memory(before);
      await assertIdle();
      if (!baseline.length || baseline.some((value) => !Number.isFinite(value)))
        throw new Error('COMFY_MEMORY_CLEAR_TELEMETRY_UNAVAILABLE');
      await this.json(
        frozen,
        '/free',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ unload_models: true, free_memory: true }),
        },
        signal
      );
      let emptySamples = 0;
      for (let attempt = 0; attempt < Math.min(this.options.maxPollAttempts ?? 10, 10); attempt++) {
        await this.pause(this.options.pollIntervalMs ?? 500, signal);
        await assertIdle();
        const after = await this.json(frozen, '/system_stats', {}, signal);
        await this.assertIdentity(frozen, after);
        const identityAfter = await (this.options.runtimeInspector ?? inspectService)(frozen, after);
        if (identityBefore?.pid !== undefined && identityAfter?.pid !== identityBefore.pid)
          throw new Error('COMFY_MEMORY_CLEAR_RUNTIME_CHANGED');
        const observed = memory(after);
        observations.push(observed);
        const devices = Array.isArray(after.devices) ? after.devices.map(record) : [];
        const emptyAllocator = devices.length > 0 && devices.every((device) => device.torch_vram_total === 0);
        emptySamples = emptyAllocator ? emptySamples + 1 : 0;
        if (
          observed.length === baseline.length &&
          observed.every((value) => Number.isFinite(value)) &&
          observed.every((value, index) => value >= baseline[index]) &&
          (observed.some((value, index) => value > baseline[index]) || emptySamples >= 2)
        ) {
          confirmed = true;
          return;
        }
      }
      throw new Error('COMFY_MEMORY_CLEAR_UNCONFIRMED');
    } catch (error) {
      failure = error;
      throw error;
    } finally {
      // One bounded record per cleanup, including identity/queue/telemetry
      // failures. Only safe error codes and memory/component metadata are logged.
      try {
        const file = this.diagnosticFile('memory');
        const error = failure instanceof Error ? /^COMFY_[A-Z0-9_]+/.exec(failure.message)?.[0] : undefined;
        this.writeDiagnostic(
          file,
          stable({
            at: new Date(this.now()).toISOString(),
            reason,
            components: frozen.components,
            before: baseline,
            observations,
            confirmed,
            error: failure ? (error ?? 'COMFY_MEMORY_CLEAR_FAILED') : undefined,
          })
        );
        if (failure instanceof Error) Object.assign(failure, { diagnosticLogPath: file });
      } catch {
        /* Diagnostics must not change a confirmed cleanup or mask its failure. */
      }
    }
  }

  /** Delete only this queued prompt and interrupt only if it is the sole matching active prompt. */
  async cancel(profile: ComfyProfile, promptId: string, requireKnown = false): Promise<void> {
    const stats = await this.stats(profile);
    if (!stats) throw new Error('COMFY_SERVER_UNAVAILABLE');
    await this.assertIdentity(profile, stats);
    const queue = await this.json(profile, '/queue');
    if (!Array.isArray(queue.queue_running) || !Array.isArray(queue.queue_pending))
      throw new Error('COMFY_QUEUE_INVALID_RESPONSE');
    const running = queue.queue_running.filter((entry) => Array.isArray(entry));
    const knownInQueue = [...queue.queue_running, ...queue.queue_pending].some(
      (entry) => Array.isArray(entry) && entry[1] === promptId
    );
    if (queue.queue_pending.some((entry) => Array.isArray(entry) && entry[1] === promptId))
      await this.json(profile, '/queue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ delete: [promptId] }),
      });
    if (running.length === 1 && running[0][1] === promptId) {
      let targeted = false;
      try {
        const source = fs.readFileSync(path.join(profile.environment.root, 'server.py'), 'utf8');
        const interruptSource = /async def post_interrupt\([^]*?(?=\n\s*@|$)/.exec(source)?.[0] ?? source;
        targeted =
          /(?:get\(['"]prompt_id['"]\)|\[['"]prompt_id['"]\])/.test(interruptSource) &&
          /(?:currently_running|targeted interruption)/.test(interruptSource);
      } catch {
        /* Do not use a global interrupt whose prompt ownership cannot be enforced. */
      }
      if (!targeted) throw new Error('COMFY_TARGETED_INTERRUPT_UNAVAILABLE');
      await this.json(profile, '/interrupt', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt_id: promptId }),
      });
    }
    // POST only acknowledges the request. Confirm the prompt disappeared from
    // queue and history reached a terminal state before releasing the local
    // submission barrier.
    let absent = 0;
    for (let attempt = 0; attempt < 10; attempt++) {
      await this.pause(Math.min(this.options.pollIntervalMs ?? 500, 1000));
      const currentStats = await this.stats(profile);
      if (!currentStats) throw new Error('COMFY_SERVER_UNAVAILABLE');
      await this.assertIdentity(profile, currentStats);
      const currentQueue = await this.json(profile, '/queue');
      if (!Array.isArray(currentQueue.queue_running) || !Array.isArray(currentQueue.queue_pending))
        throw new Error('COMFY_QUEUE_INVALID_RESPONSE');
      const present = [...currentQueue.queue_running, ...currentQueue.queue_pending].some(
        (entry) => Array.isArray(entry) && entry[1] === promptId
      );
      if (present) {
        absent = 0;
        continue;
      }
      const history = await this.json(profile, `/history/${encodeURIComponent(promptId)}`);
      const entry = history[promptId] as HistoryEntry | undefined;
      if (
        entry?.status?.completed ||
        entry?.status?.status_str === 'error' ||
        entry?.status?.messages?.some((message) => Array.isArray(message) && message[0] === 'execution_interrupted')
      )
        return;
      if (!entry && ++absent >= 2) {
        if (requireKnown && !knownInQueue) throw new Error('COMFY_SUBMISSION_STATE_UNKNOWN');
        return;
      }
    }
    throw new Error('COMFY_CANCEL_UNCONFIRMED');
  }

  /** Check that installation will not mutate a busy or externally owned live environment. */
  async assertInstallable(profile: ComfyProfile): Promise<void> {
    const stats = await this.stats(profile);
    if (!stats) return;
    await this.assertIdentity(profile, stats);
    const queue = await this.json(profile, '/queue');
    if (!Array.isArray(queue.queue_running) || !Array.isArray(queue.queue_pending))
      throw new Error('COMFY_QUEUE_INVALID_RESPONSE');
    if (queue.queue_running.length || queue.queue_pending.length) throw new Error('COMFY_RUNTIME_BUSY');
    const owned = this.owned.get(loopbackUrl(profile).origin);
    if (!owned || owned.exited || owned.environmentKey !== environmentKey(profile))
      throw new Error('COMFY_EXTERNAL_RUNTIME_RUNNING');
  }

  /** Stop only children launched by this engine instance, optionally scoped to one selected environment. */
  async stopOwned(profile?: ComfyProfile): Promise<void> {
    for (const [origin, owned] of this.owned.entries()) {
      if (profile && owned.environmentKey !== environmentKey(profile)) continue;
      if (!owned.exited) {
        owned.child.kill();
        for (let attempt = 0; !owned.exited && attempt < 100; attempt++) await this.pause(50);
        if (!owned.exited) throw new Error('COMFY_OWNED_SERVER_STOP_TIMEOUT');
      }
      this.owned.delete(origin);
    }
  }
  private throwAborted(signal: AbortSignal): void {
    if (signal.aborted) throw new Error('COMFY_JOB_CANCELLED');
  }
  private async pause(milliseconds: number, signal?: AbortSignal): Promise<void> {
    if (signal) this.throwAborted(signal);
    await new Promise<void>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const cleanup = (): void => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
      };
      const abort = (): void => {
        cleanup();
        reject(new Error('COMFY_JOB_CANCELLED'));
      };
      signal?.addEventListener('abort', abort, { once: true });
      const done = (): void => {
        cleanup();
        resolve();
      };
      if (this.options.sleep)
        this.options.sleep(milliseconds).then(done, (error) => {
          cleanup();
          reject(error);
        });
      else timer = setTimeout(done, milliseconds);
    });
  }
}
