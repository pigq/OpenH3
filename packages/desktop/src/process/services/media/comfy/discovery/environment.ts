import fs from 'node:fs';
import { isIP } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

export type ComfyCommandOptions = { cwd?: string; timeout: number; windowsHide: boolean; maxBuffer: number };
export type ComfyCommandRunner = (file: string, args: string[], options: ComfyCommandOptions) => Promise<string>;
export type ComfyGpu = {
  vendor: 'nvidia' | 'amd' | 'apple' | 'unknown';
  name: string;
  totalMemoryBytes?: number;
  freeMemoryBytes?: number;
  driver?: string;
  computeCapability?: string;
};
export type ComfyPythonRuntime = {
  status: 'available' | 'missing' | 'broken';
  executable?: string;
  version?: string;
  packages: Record<string, string>;
  packageMetadataFiles?: string[];
  packageDirectories?: string[];
  torchVersion?: string;
  cudaVersion?: string;
  hipVersion?: string;
  accelerator: 'cuda' | 'rocm' | 'mps' | 'cpu' | 'unknown';
  devices?: Array<{ name: string; totalMemoryBytes?: number; computeCapability?: string }>;
  error?: string;
};
export type ComfyEnvironmentReport = {
  checkedAt: string;
  machine: {
    os: NodeJS.Platform;
    arch: string;
    totalMemoryBytes: number;
    freeMemoryBytes: number;
    disk?: { path: string; totalBytes: number; freeBytes: number };
    gpuStatus: 'available' | 'unknown';
    gpus: ComfyGpu[];
  };
  runtime: ComfyPythonRuntime;
  comfy: {
    root?: string;
    status: 'installed' | 'missing' | 'incomplete';
    revision?: string;
    customNodes: Array<{ name: string; path: string; revision?: string }>;
    service: 'online' | 'offline' | 'not-configured';
    systemStats?: Record<string, unknown>;
  };
  network: ComfyNetworkReport;
  issues: string[];
};
export type ComfyNetworkSourceProbe = {
  url: string;
  host: string;
  status: 'reachable' | 'unreachable' | 'invalid';
  httpStatus?: number;
  finalUrl?: string;
  contentLengthBytes?: number;
  range: 'supported' | 'unsupported' | 'unknown';
  error?: string;
};
export type ComfyNetworkReport = {
  checkedAt: string;
  requested: boolean;
  proxy: { http: boolean; https: boolean; noProxy: boolean };
  sources: ComfyNetworkSourceProbe[];
};
export type ComfyEnvironmentProbeOptions = {
  root?: string;
  python?: string;
  baseUrl?: string;
  runCommand?: ComfyCommandRunner;
  fetchImpl?: typeof fetch;
  platform?: NodeJS.Platform;
  arch?: string;
  totalMemoryBytes?: number;
  freeMemoryBytes?: number;
  /** Exact immutable model or workflow URLs to probe. No downloads are performed. */
  sources?: string[];
};

/** A shallow, opt-in discovery result for already existing ComfyUI installs. */
export type ComfyEnvironmentCandidate = {
  root: string;
  reason: 'configured' | 'known-path' | 'recent-path';
  python?: string;
  baseUrl?: string;
};

export type ComfyEnvironmentDiscoveryOptions = {
  /** Explicit roots supplied by the app's persisted profile/recent-path store. */
  roots?: string[];
  /** Additional platform-specific roots known to the caller. */
  knownRoots?: string[];
  /** Keep discovery bounded; this is not a whole-disk search. */
  maxCandidates?: number;
  platform?: NodeJS.Platform;
  homeDirectory?: string;
  environment?: NodeJS.ProcessEnv;
};

const exec = promisify(execFile);
export const runComfyCommand: ComfyCommandRunner = async (file, args, options) =>
  (await exec(file, args, options)).stdout;
const commandOptions: ComfyCommandOptions = { timeout: 10_000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 };

function existingDirectory(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const resolved = path.resolve(value);
    return fs.statSync(resolved).isDirectory() ? resolved : undefined;
  } catch {
    return undefined;
  }
}

function candidateRoot(root: string): string | undefined {
  const resolved = existingDirectory(root);
  if (!resolved) return undefined;
  if (fs.existsSync(path.join(resolved, 'main.py'))) return resolved;
  // Common launchers point at a parent directory containing a ComfyUI checkout.
  const nested = existingDirectory(path.join(resolved, 'ComfyUI'));
  return nested && fs.existsSync(path.join(nested, 'main.py')) ? nested : undefined;
}

function candidatePython(root: string): string | undefined {
  return [
    path.join(root, '.venv', 'Scripts', 'python.exe'),
    path.join(root, '.venv', 'bin', 'python'),
    path.join(root, 'venv', 'Scripts', 'python.exe'),
    path.join(root, 'venv', 'bin', 'python'),
    path.join(root, 'python_embeded', 'python.exe'),
    path.join(path.dirname(root), 'python_embeded', 'python.exe'),
  ].find((value) => fs.existsSync(value));
}

/**
 * Find existing ComfyUI roots without traversing an entire disk.
 *
 * The caller supplies persisted/recent roots when available. Built-in paths are
 * deliberately small and platform-specific; each path is checked at most one
 * level below its parent. No process is started and no files are downloaded.
 */
export function discoverComfyEnvironmentCandidates(
  options: ComfyEnvironmentDiscoveryOptions = {}
): ComfyEnvironmentCandidate[] {
  const platform = options.platform ?? process.platform;
  const env = options.environment ?? process.env;
  const home = options.homeDirectory ?? os.homedir();
  const maxCandidates = Math.max(1, Math.min(64, options.maxCandidates ?? 16));
  const known = [
    path.join(home, 'ComfyUI'),
    path.join(home, 'comfyui'),
    path.join(home, 'Documents', 'ComfyUI'),
    path.join(home, 'Desktop', 'ComfyUI'),
    ...(platform === 'win32'
      ? [env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'ComfyUI'), env.APPDATA && path.join(env.APPDATA, 'ComfyUI')]
      : []),
    ...(platform === 'linux' ? [path.join(home, '.local', 'share', 'ComfyUI')] : []),
    ...(platform === 'darwin' ? [path.join(home, 'Library', 'Application Support', 'ComfyUI')] : []),
    ...(options.knownRoots ?? []),
  ];
  const seen = new Set<string>();
  const candidates: ComfyEnvironmentCandidate[] = [];
  const add = (value: string | undefined, reason: ComfyEnvironmentCandidate['reason']): void => {
    const root = value && candidateRoot(value);
    if (!root) return;
    const key = platform === 'win32' ? path.normalize(root).toLowerCase() : path.normalize(root);
    if (seen.has(key) || candidates.length >= maxCandidates) return;
    seen.add(key);
    candidates.push({ root, reason, python: candidatePython(root), baseUrl: 'http://127.0.0.1:8188' });
  };
  for (const root of options.roots ?? []) add(root, 'recent-path');
  for (const root of known) add(root, 'known-path');
  return candidates;
}

const PYTHON_PROBE = `import sys, json, importlib.metadata as metadata, os
result = {"executable": sys.executable, "version": sys.version.split()[0], "packages": {}, "packageMetadataFiles": [], "packageDirectories": []}
for distribution in metadata.distributions():
    name = distribution.metadata.get("Name")
    if name:
        result["packages"][name.lower().replace("_", "-")] = distribution.version
    location = getattr(distribution, "_path", None)
    if location:
        location = str(location)
        result["packageMetadataFiles"].append(os.path.join(location, "METADATA"))
        result["packageDirectories"].append(os.path.dirname(location))
try:
    import torch
    devices = []
    cuda = torch.cuda.is_available()
    if cuda:
        for i in range(torch.cuda.device_count()):
            p = torch.cuda.get_device_properties(i)
            devices.append({"name": p.name, "totalMemoryBytes": p.total_memory, "computeCapability": str(p.major) + "." + str(p.minor)})
    result["torch"] = {"version": torch.__version__, "cudaVersion": torch.version.cuda, "hipVersion": getattr(torch.version, "hip", None), "cudaAvailable": cuda, "mpsAvailable": bool(getattr(torch.backends, "mps", None) and torch.backends.mps.is_available()), "devices": devices}
    result["packageMetadataFiles"].append(torch.__file__)
except Exception as error:
    result["torchError"] = type(error).__name__
result["packageDirectories"] = sorted(set(result["packageDirectories"]))
print(json.dumps(result))`;

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}
function parseJsonOutput(text: string): Record<string, unknown> {
  for (const line of text.trim().split(/\r?\n/).reverse()) {
    try {
      const value = object(JSON.parse(line));
      if (Object.keys(value).length) return value;
    } catch {
      /* Python libraries may emit diagnostics before the result. */
    }
  }
  throw new Error('COMFY_PYTHON_PROBE_INVALID_RESPONSE');
}

/** Inspect the selected interpreter itself; machine driver capability is not a Python CUDA result. */
export async function readPythonRuntime(
  python?: string,
  options: { runCommand?: ComfyCommandRunner; root?: string } = {}
): Promise<ComfyPythonRuntime> {
  if (!python || !fs.existsSync(python))
    return { status: 'missing', executable: python, packages: {}, accelerator: 'unknown', error: 'PYTHON_MISSING' };
  try {
    const data = parseJsonOutput(
      await (options.runCommand ?? runComfyCommand)(python, ['-c', PYTHON_PROBE], {
        ...commandOptions,
        timeout: 30_000,
        cwd: options.root,
      })
    );
    const torch = object(data.torch);
    const packages = Object.fromEntries(
      Object.entries(object(data.packages)).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
    );
    return {
      status: 'available',
      executable: typeof data.executable === 'string' ? data.executable : python,
      version: typeof data.version === 'string' ? data.version : undefined,
      packages,
      packageMetadataFiles: strings(data.packageMetadataFiles),
      packageDirectories: strings(data.packageDirectories),
      torchVersion: typeof torch.version === 'string' ? torch.version : undefined,
      cudaVersion: typeof torch.cudaVersion === 'string' ? torch.cudaVersion : undefined,
      hipVersion: typeof torch.hipVersion === 'string' ? torch.hipVersion : undefined,
      accelerator:
        torch.cudaAvailable === true
          ? torch.hipVersion
            ? 'rocm'
            : 'cuda'
          : torch.mpsAvailable === true
            ? 'mps'
            : Object.keys(torch).length
              ? 'cpu'
              : 'unknown',
      devices: Array.isArray(torch.devices) ? (torch.devices as ComfyPythonRuntime['devices']) : [],
      error: typeof data.torchError === 'string' ? `TORCH_IMPORT_${data.torchError}` : undefined,
    };
  } catch {
    return { status: 'broken', executable: python, packages: {}, accelerator: 'unknown', error: 'PYTHON_PROBE_FAILED' };
  }
}

function vendor(name: string): ComfyGpu['vendor'] {
  return /nvidia/i.test(name) ? 'nvidia' : /amd|radeon/i.test(name) ? 'amd' : /apple/i.test(name) ? 'apple' : 'unknown';
}
async function probeGpus(
  platform: NodeJS.Platform,
  run: ComfyCommandRunner,
  accelerator?: ComfyPythonRuntime['accelerator']
): Promise<ComfyGpu[]> {
  for (const capability of !accelerator || accelerator === 'cuda' || accelerator === 'unknown' ? [true, false] : []) {
    try {
      const output = await run(
        'nvidia-smi',
        [
          `--query-gpu=index,name,memory.total,memory.free,driver_version${capability ? ',compute_cap' : ''}`,
          '--format=csv,noheader,nounits',
        ],
        commandOptions
      );
      const gpus = output
        .trim()
        .split(/\r?\n/)
        .map((line) => line.split(',').map((field) => field.trim()))
        .filter((fields) => fields.length >= 5 && /nvidia|geforce|quadro|tesla|rtx/i.test(fields[1]))
        .map((fields) => ({
          vendor: 'nvidia' as const,
          name: fields[1],
          totalMemoryBytes: Number.isFinite(Number(fields[2])) ? Number(fields[2]) * 2 ** 20 : undefined,
          freeMemoryBytes: Number.isFinite(Number(fields[3])) ? Number(fields[3]) * 2 ** 20 : undefined,
          driver: fields[4],
          computeCapability: fields[5] && /^\d+\.\d+$/.test(fields[5]) ? fields[5] : undefined,
        }));
      if (gpus.length) return gpus;
    } catch {
      /* Older drivers may not provide compute_cap. */
    }
  }
  try {
    if (accelerator && accelerator !== 'rocm' && accelerator !== 'unknown') throw new Error('ROCM_NOT_SELECTED');
    const output = await run(
      'rocm-smi',
      ['--showproductname', '--showmeminfo', 'vram', '--showdriverversion', '--json'],
      commandOptions
    );
    const entries = Object.values(object(JSON.parse(output))).map(object);
    const gpus = entries.flatMap((entry): ComfyGpu[] => {
      const read = (expression: RegExp): unknown => Object.entries(entry).find(([key]) => expression.test(key))?.[1];
      const name = read(/card series|product name|card model/i);
      if (typeof name !== 'string') return [];
      const total = Number(read(/VRAM Total Memory \(B\)/i));
      const used = Number(read(/VRAM Total Used Memory \(B\)/i));
      const driver = read(/driver version/i);
      return [
        {
          vendor: 'amd',
          name,
          totalMemoryBytes: Number.isFinite(total) ? total : undefined,
          freeMemoryBytes: Number.isFinite(total) && Number.isFinite(used) ? Math.max(0, total - used) : undefined,
          driver: typeof driver === 'string' ? driver : undefined,
        },
      ];
    });
    if (gpus.length) return gpus;
  } catch {
    /* ROCm tooling is optional; unknown AMD memory stays explicit. */
  }
  try {
    if (platform === 'win32') {
      const output = await run(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          'Get-CimInstance Win32_VideoController | Select-Object Name,AdapterRAM,DriverVersion | ConvertTo-Json -Compress',
        ],
        commandOptions
      );
      const json: unknown = JSON.parse(output);
      return (Array.isArray(json) ? json : [json])
        .map(object)
        .filter((gpu) => typeof gpu.Name === 'string')
        .map((gpu) => ({
          name: String(gpu.Name),
          vendor: vendor(String(gpu.Name)),
          totalMemoryBytes: typeof gpu.AdapterRAM === 'number' ? gpu.AdapterRAM : undefined,
          driver: typeof gpu.DriverVersion === 'string' ? gpu.DriverVersion : undefined,
        }));
    }
    if (platform === 'darwin') {
      const json = object(JSON.parse(await run('system_profiler', ['SPDisplaysDataType', '-json'], commandOptions)));
      return (Array.isArray(json.SPDisplaysDataType) ? json.SPDisplaysDataType : [])
        .map(object)
        .filter((gpu) => typeof gpu.sppci_model === 'string')
        .map((gpu) => ({ name: String(gpu.sppci_model), vendor: vendor(String(gpu.sppci_model)) }));
    }
    const output = await run('lspci', [], commandOptions);
    return output
      .split(/\r?\n/)
      .filter((line) => /VGA compatible controller|3D controller|Display controller/i.test(line))
      .map((line) => ({ name: line.slice(line.indexOf(':', line.indexOf(':') + 1) + 1).trim(), vendor: vendor(line) }));
  } catch {
    return [];
  }
}

/** Read only stable machine and accelerator driver evidence for compatibility fingerprints. */
export async function readComfyHardwareIdentity(
  options: {
    accelerator?: ComfyPythonRuntime['accelerator'];
    runCommand?: ComfyCommandRunner;
    platform?: NodeJS.Platform;
    arch?: string;
  } = {}
): Promise<{
  os: NodeJS.Platform;
  arch: string;
  osRelease: string;
  cpu: string;
  gpus: Array<Omit<ComfyGpu, 'freeMemoryBytes'>>;
}> {
  const platform = options.platform ?? process.platform;
  const run = options.runCommand ?? runComfyCommand;
  const gpus =
    options.accelerator === 'cpu'
      ? []
      : await probeGpus(
          platform,
          (file, args, settings) => run(file, args, { ...settings, timeout: 3000 }),
          options.accelerator
        );
  return {
    os: platform,
    arch: options.arch ?? process.arch,
    osRelease: os.release(),
    cpu: os.cpus()[0]?.model ?? 'unknown',
    gpus: gpus.map(({ freeMemoryBytes: _freeMemoryBytes, ...gpu }) => gpu),
  };
}
async function revision(root: string, run: ComfyCommandRunner): Promise<string | undefined> {
  try {
    const value = (await run('git', ['-C', root, 'rev-parse', 'HEAD'], commandOptions)).trim();
    return /^[a-f\d]{7,64}$/i.test(value) ? value : undefined;
  } catch {
    return undefined;
  }
}
function disk(root: string): ComfyEnvironmentReport['machine']['disk'] {
  let target = path.resolve(root);
  while (!fs.existsSync(target) && path.dirname(target) !== target) target = path.dirname(target);
  try {
    const stats = fs.statfsSync(target);
    return { path: target, totalBytes: stats.bsize * stats.blocks, freeBytes: stats.bsize * stats.bavail };
  } catch {
    return undefined;
  }
}

function redactedUrl(value: URL): string {
  const copy = new URL(value.toString());
  copy.username = '';
  copy.password = '';
  copy.search = '';
  copy.hash = '';
  return copy.toString();
}

const TRUSTED_SOURCE_HOSTS = [
  'modelscope.cn',
  'huggingface.co',
  'hf.co',
  'hf-mirror.com',
  'github.com',
  'githubusercontent.com',
  'gitlab.com',
  'gitee.com',
  'gitcode.com',
  'pypi.org',
  'pypi.tuna.tsinghua.edu.cn',
  'mirrors.tuna.tsinghua.edu.cn',
  'pypi.mirrors.ustc.edu.cn',
  'mirrors.aliyun.com',
  'mirrors.cloud.tencent.com',
  'pythonhosted.org',
  'pytorch.org',
  'comfy.org',
  'comfyui.org',
];
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

function safeUrlText(value: string): string {
  try {
    return redactedUrl(new URL(value));
  } catch {
    return value.replace(/(https?:\/\/)[^/@\s]+@/i, '$1').replace(/[?#].*$/, '');
  }
}

function validateSourceUrl(value: URL): string | undefined {
  if (value.protocol !== 'https:' || value.username || value.password) return 'NETWORK_SOURCE_URL_UNSUPPORTED';
  const host = value.hostname.toLowerCase().replace(/\.$/, '');
  const labels = host.split('.');
  if (isIP(host.replace(/^\[|\]$/g, '')) || labels.some((label) => ['localhost', 'local', 'internal'].includes(label)))
    return 'NETWORK_SOURCE_HOST_UNTRUSTED';
  if (!TRUSTED_SOURCE_HOSTS.some((trusted) => host === trusted || host.endsWith(`.${trusted}`)))
    return 'NETWORK_SOURCE_HOST_UNTRUSTED';
  if (value.port && value.port !== '443') return 'NETWORK_SOURCE_URL_UNSUPPORTED';
  return undefined;
}

async function requestTrustedSource(
  initialUrl: URL,
  init: RequestInit,
  fetchImpl: typeof fetch
): Promise<{ response: Response; finalUrl: URL }> {
  let current = new URL(initialUrl);
  for (let redirects = 0; redirects <= 5; redirects += 1) {
    const invalid = validateSourceUrl(current);
    if (invalid) throw new Error(invalid);
    const response = await fetchImpl(current, { ...init, redirect: 'manual' });
    if (!REDIRECT_STATUSES.has(response.status)) return { response, finalUrl: current };
    const location = response.headers.get('location');
    await response.body?.cancel();
    if (!location) throw new Error('NETWORK_SOURCE_REDIRECT_MISSING_LOCATION');
    if (redirects === 5) throw new Error('NETWORK_SOURCE_REDIRECT_LIMIT');
    try {
      current = new URL(location, current);
    } catch {
      throw new Error('NETWORK_SOURCE_REDIRECT_INVALID');
    }
  }
  throw new Error('NETWORK_SOURCE_REDIRECT_LIMIT');
}

async function probeNetworkSource(urlText: string, fetchImpl: typeof fetch): Promise<ComfyNetworkSourceProbe> {
  let parsed: URL;
  try {
    parsed = new URL(urlText);
    const invalid = validateSourceUrl(parsed);
    if (invalid) throw new Error(invalid);
  } catch (error) {
    return {
      url: safeUrlText(urlText),
      host: 'invalid',
      status: 'invalid',
      range: 'unknown',
      error: error instanceof Error ? error.message : 'NETWORK_SOURCE_URL_INVALID',
    };
  }
  const url = redactedUrl(parsed);
  try {
    const { response, finalUrl } = await requestTrustedSource(
      parsed,
      {
        method: 'HEAD',
        signal: AbortSignal.timeout(8_000),
      },
      fetchImpl
    );
    const contentLength = Number(response.headers.get('content-length'));
    let range: ComfyNetworkSourceProbe['range'] = /bytes/i.test(response.headers.get('accept-ranges') ?? '')
      ? 'supported'
      : 'unknown';
    if (range === 'unknown' && response.ok) {
      try {
        const rangedResult = await requestTrustedSource(
          finalUrl,
          {
            method: 'GET',
            headers: { range: 'bytes=0-0' },
            signal: AbortSignal.timeout(8_000),
          },
          fetchImpl
        );
        const ranged = rangedResult.response;
        range = ranged.status === 206 ? 'supported' : 'unsupported';
        await ranged.body?.cancel();
      } catch (error) {
        if (error instanceof Error && error.message.startsWith('NETWORK_SOURCE_')) throw error;
        range = 'unknown';
      }
    }
    return {
      url,
      host: parsed.host,
      status: response.ok ? 'reachable' : 'unreachable',
      httpStatus: response.status,
      finalUrl: redactedUrl(finalUrl),
      contentLengthBytes: Number.isSafeInteger(contentLength) && contentLength > 0 ? contentLength : undefined,
      range,
      ...(response.ok ? {} : { error: `HTTP_${response.status}` }),
    };
  } catch (error) {
    return {
      url,
      host: parsed.host,
      status: 'unreachable',
      range: 'unknown',
      error:
        error instanceof Error && /^NETWORK_SOURCE_[A-Z_]+$/.test(error.message)
          ? error.message
          : 'NETWORK_SOURCE_UNREACHABLE',
    };
  }
}

async function probeNetwork(sources: string[] | undefined, fetchImpl: typeof fetch): Promise<ComfyNetworkReport> {
  const requested = Boolean(sources?.length);
  const sourceResults = requested
    ? await Promise.all((sources ?? []).slice(0, 12).map((url) => probeNetworkSource(url, fetchImpl)))
    : [];
  return {
    checkedAt: new Date().toISOString(),
    requested,
    proxy: {
      http: Boolean(process.env.HTTP_PROXY || process.env.http_proxy),
      https: Boolean(process.env.HTTPS_PROXY || process.env.https_proxy),
      noProxy: Boolean(process.env.NO_PROXY || process.env.no_proxy),
    },
    sources: sourceResults,
  };
}

/** Read-only system and selected ComfyUI environment inventory. Never installs, downloads, or launches a service. */
export async function probeComfyEnvironment(
  options: ComfyEnvironmentProbeOptions = {}
): Promise<ComfyEnvironmentReport> {
  const run = options.runCommand ?? runComfyCommand;
  const platform = options.platform ?? process.platform;
  const root = options.root ? path.resolve(options.root) : undefined;
  const python =
    options.python ??
    (root
      ? [
          path.join(root, '.venv', 'Scripts', 'python.exe'),
          path.join(root, '.venv', 'bin', 'python'),
          path.join(root, 'python_embeded', 'python.exe'),
        ].find((candidate) => fs.existsSync(candidate))
      : undefined);
  const [runtime, gpus, gitRevision] = await Promise.all([
    readPythonRuntime(python, { runCommand: run, root }),
    probeGpus(platform, run),
    root ? revision(root, run) : undefined,
  ]);
  const network = await probeNetwork(options.sources, options.fetchImpl ?? fetch);
  const customRoot = root ? path.join(root, 'custom_nodes') : undefined;
  const customNodes =
    customRoot && fs.existsSync(customRoot)
      ? await Promise.all(
          fs
            .readdirSync(customRoot, { withFileTypes: true })
            .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== '__pycache__')
            .map(async (entry) => {
              const nodePath = path.join(customRoot, entry.name);
              return { name: entry.name, path: nodePath, revision: await revision(nodePath, run) };
            })
        )
      : [];
  const comfyStatus =
    root && fs.existsSync(path.join(root, 'main.py'))
      ? 'installed'
      : root && fs.existsSync(root) && fs.readdirSync(root).length
        ? 'incomplete'
        : 'missing';
  let service: ComfyEnvironmentReport['comfy']['service'] = options.baseUrl ? 'offline' : 'not-configured';
  let systemStats: Record<string, unknown> | undefined;
  if (options.baseUrl) {
    try {
      const url = new URL(options.baseUrl);
      if (
        url.protocol !== 'http:' ||
        !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
        url.username ||
        url.password
      )
        throw new Error('COMFY_LOCAL_SERVER_REQUIRED');
      const response = await (options.fetchImpl ?? fetch)(`${url.origin}/system_stats`, {
        signal: AbortSignal.timeout(3000),
      });
      if (response.ok) {
        systemStats = object(await response.json());
        if (Object.keys(object(systemStats.system)).length) service = 'online';
      }
    } catch {
      /* Missing or offline is an inventory result, not an installation request. */
    }
  }
  const issues = [
    runtime.status === 'missing' ? 'PYTHON_MISSING' : runtime.status === 'broken' ? 'PYTHON_PROBE_FAILED' : undefined,
    runtime.error,
    comfyStatus === 'missing' ? 'COMFYUI_MISSING' : comfyStatus === 'incomplete' ? 'COMFYUI_INCOMPLETE' : undefined,
    !gpus.length ? 'GPU_PROBE_UNAVAILABLE' : undefined,
    network.requested && network.sources.length === 0 ? 'NETWORK_PROBE_INCOMPLETE' : undefined,
    network.requested && network.sources.length > 0 && network.sources.every((source) => source.status !== 'reachable')
      ? 'NETWORK_SOURCES_UNREACHABLE'
      : undefined,
  ].filter((issue): issue is string => Boolean(issue));
  return {
    checkedAt: new Date().toISOString(),
    machine: {
      os: platform,
      arch: options.arch ?? process.arch,
      totalMemoryBytes: options.totalMemoryBytes ?? os.totalmem(),
      freeMemoryBytes: options.freeMemoryBytes ?? os.freemem(),
      disk: disk(root ?? process.cwd()),
      gpuStatus: gpus.length ? 'available' : 'unknown',
      gpus,
    },
    runtime,
    comfy: { root, status: comfyStatus, revision: gitRevision, customNodes, service, systemStats },
    network,
    issues: [...new Set(issues)],
  };
}
