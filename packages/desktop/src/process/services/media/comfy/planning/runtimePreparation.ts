import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { ComfyInstallPlan, ComfyProfile } from '@/common/chat/document/creation/comfy';
import {
  readPythonRuntime,
  runComfyCommand,
  type ComfyCommandRunner,
  type ComfyEnvironmentReport,
} from '../discovery/environment';
import { record, records, stringValue, type CatalogRecord } from './catalog';

const CORE_REQUIREMENTS: Record<string, string> = {
  e0a32bce84f4603f2b61b16b50f8958e68fd6171: 'daa5c581620080f44c894609b852b5fd82fa102975f5dd31abeef2ca0e5a3fff',
  b1a247c9cf9dbfda4b2c0a0c1d50950667eeaa0c: 'be1b15fd2f8ea459609c2e62d573ab862f53443023316ba494b4190af50bc028',
  '46aad33e4d4c0696582611bf450dd93742fa9090': 'a1c157203644449634bddf5c117ad6d7e7d88567c07bad6572e547478f7c2e0b',
};
const TRUSTED_PACKAGE_HOSTS = [
  'pypi.org',
  'pythonhosted.org',
  'pypi.tuna.tsinghua.edu.cn',
  'mirrors.tuna.tsinghua.edu.cn',
  'pytorch.org',
];
// Fail closed if an index cannot provide PEP 658 metadata or byte ranges.
// pip --dry-run alone may otherwise download a multi-GB wheel while planning,
// before the installation operation has received its permission decision.
const METADATA_ONLY_PIP = `import sys,re
from urllib.parse import urlsplit
from pip._internal.network.session import PipSession
from pip._internal.cli.main import main
original=PipSession.send
def metadata_only(self,request,**kwargs):
 wheel=urlsplit(request.url).path.lower().endswith('.whl')
 if wheel and request.method.upper()=='GET':
  span=request.headers.get('Range','')
  match=re.fullmatch(r'bytes=(\\d+)-(\\d+)',span)
  suffix=re.fullmatch(r'bytes=-(\\d+)',span)
  bounded=match and 0<int(match[2])-int(match[1])+1<=1048576
  bounded=bounded or suffix and 0<int(suffix[1])<=1048576
  if not bounded:
   raise RuntimeError('COMFY_METADATA_ONLY_WHEEL_BODY_FORBIDDEN')
 response=original(self,request,**kwargs)
 if wheel and request.method.upper()=='GET' and response.status_code!=206:
  response.close()
  raise RuntimeError('COMFY_METADATA_ONLY_RANGE_UNSUPPORTED')
 return response
PipSession.send=metadata_only
sys.exit(main(sys.argv[1:]))`;
function packageUrl(value: string): URL {
  const url = new URL(value);
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    (url.port && url.port !== '443') ||
    !TRUSTED_PACKAGE_HOSTS.some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`))
  )
    throw new Error('COMFY_RUNTIME_PACKAGE_SOURCE_UNTRUSTED');
  return url;
}

export type RuntimePreparationOptions = {
  runCommand?: ComfyCommandRunner;
  fetchImpl?: typeof fetch;
  bootstrapPythons?: string[];
};
export type RuntimePreparation = {
  commands: ComfyInstallPlan['commands'];
  components: ComfyProfile['components'];
  evidence: string[];
};

/** The binary's own sys.executable/version output is required before it can create a venv. */
export async function findBootstrapPython(options: RuntimePreparationOptions, preferred?: string): Promise<string> {
  const suffix = process.platform === 'win32' ? ['python.exe', 'python3.exe'] : ['python3', 'python'];
  const paths = (process.env.PATH ?? '').split(path.delimiter);
  const possible = [
    ...(options.bootstrapPythons ?? []),
    preferred,
    process.env.OPENH3_PYTHON_PATH,
    process.env.PYTHON_PATH,
    ...paths.flatMap((directory) => suffix.map((name) => path.join(directory, name))),
  ];
  for (const value of new Set(possible)) {
    if (!value || !path.isAbsolute(value) || !fs.existsSync(value) || !fs.statSync(value).isFile()) continue;
    const runtime = await readPythonRuntime(value, { runCommand: options.runCommand });
    if (runtime.status !== 'available' || !runtime.version || !runtime.executable) continue;
    const [major, minor] = runtime.version.split('.').map(Number);
    if (major === 3 && minor >= 10 && minor <= 13) return runtime.executable;
  }
  throw new Error('COMFY_DETECTION_INCOMPLETE:BOOTSTRAP_PYTHON_3_10_TO_3_13_NOT_FOUND');
}

/**
 * Resolve all binary dependencies with the actual interpreter's pip solver.
 * --dry-run + --only-binary prevents environment installation and source-build hooks.
 * A network guard permits only metadata/HEAD/bounded byte ranges for wheels;
 * fallback to an unauthorized complete wheel transfer is explicitly blocked.
 * Every returned wheel is added to the ordinary resumable/hash-checked download
 * plan, and installed from its local path with --no-deps after authorization.
 */
export async function prepareComfyRuntime(
  input: {
    coreRevision: string;
    environment: ComfyProfile['environment'];
    targetRoot: string;
    report: ComfyEnvironmentReport;
    bootstrapPython: string;
    existing: boolean;
    runtimePins?: CatalogRecord;
  },
  options: RuntimePreparationOptions = {}
): Promise<RuntimePreparation> {
  const { coreRevision, environment, targetRoot, report, bootstrapPython, existing } = input;
  const expected = CORE_REQUIREMENTS[coreRevision];
  if (!expected) throw new Error(`COMFY_DETECTION_INCOMPLETE:RUNTIME_DEPENDENCY_PIN:${coreRevision}`);
  const fetcher = options.fetchImpl ?? fetch;
  let body: string | undefined;
  for (const requirementsUrl of [
    `https://cdn.jsdelivr.net/gh/Comfy-Org/ComfyUI@${coreRevision}/requirements.txt`,
    `https://raw.githubusercontent.com/Comfy-Org/ComfyUI/${coreRevision}/requirements.txt`,
  ]) {
    try {
      const response = await fetcher(requirementsUrl, { signal: AbortSignal.timeout(15_000), redirect: 'error' });
      if (!response.ok) continue;
      const contents = await response.text();
      if (crypto.createHash('sha256').update(contents).digest('hex') !== expected) continue;
      body = contents;
      break;
    } catch {
      /* The fixed SHA256 must match on either transport. */
    }
  }
  if (!body) throw new Error('COMFY_DETECTION_INCOMPLETE:PINNED_RUNTIME_REQUIREMENTS_UNAVAILABLE_OR_HASH_MISMATCH');
  const requirements = body
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
  if (
    requirements.some(
      (line) => !/^[A-Za-z0-9_.-]+(?:[<>=!~]+[A-Za-z0-9.*+_-]+(?:,[<>=!~]+[A-Za-z0-9.*+_-]+)*)?$/.test(line)
    )
  )
    throw new Error('COMFY_RUNTIME_REQUIREMENTS_UNSUPPORTED');
  const hasCuda = report.machine.gpus.some((gpu) => gpu.vendor === 'nvidia');
  if (!hasCuda || !['win32', 'linux'].includes(report.machine.os) || report.machine.arch !== 'x64')
    throw new Error('COMFY_DETECTION_INCOMPLETE:COLD_RUNTIME_PLATFORM_RECIPE');
  const gpu = report.machine.gpus.find((entry) => entry.vendor === 'nvidia')!;
  if (!gpu.driver || !gpu.computeCapability) throw new Error('COMFY_DETECTION_INCOMPLETE:CUDA_DRIVER_OR_ARCHITECTURE');
  if (Number(gpu.driver.split('.')[0]) < 570)
    throw new Error('COMFY_DEVICE_CONDITIONS_INSUFFICIENT:CUDA_12_8_REQUIRES_DRIVER_570');
  // Official previous-version matrix: https://pytorch.org/get-started/previous-versions/#v291
  // CUDA 12.8 supports Blackwell; live model/kernel verification remains mandatory.
  const torchPins = ['torch==2.9.1+cu128', 'torchvision==0.24.1+cu128', 'torchaudio==2.9.1+cu128'];
  if (input.runtimePins?.comfyCore && input.runtimePins.comfyCore !== coreRevision)
    throw new Error('COMFY_TOOL_NOT_READY:CANDIDATE_CORE_ABI_MISMATCH');
  const nativePins = [
    ['comfy-kitchen', stringValue(input.runtimePins?.comfyKitchen)],
    ['comfy-aimdo', stringValue(input.runtimePins?.comfyAimdo)],
  ].filter((entry) => entry[1]);
  if (nativePins.some((entry) => !/^\d+\.\d+\.\d+(?:[a-z\d.-]+)?$/i.test(entry[1])))
    throw new Error('COMFY_TOOL_NOT_READY:CANDIDATE_NATIVE_PACKAGE_PIN');
  const requested = [
    ...requirements.filter(
      (line) =>
        !/^(torch|torchvision|torchaudio)(?:$|[<>=!~])/.test(line) &&
        !nativePins.some(([name]) => line.startsWith(`${name}=`))
    ),
    ...torchPins,
    ...nativePins.map(([name, version]) => `${name}==${version}`),
  ];
  const run = options.runCommand ?? runComfyCommand;
  let resolved: Record<string, unknown> | undefined;
  const failures: string[] = [];
  for (const indexUrl of ['https://pypi.tuna.tsinghua.edu.cn/simple', 'https://pypi.org/simple']) {
    try {
      const output = await run(
        bootstrapPython,
        [
          '-c',
          METADATA_ONLY_PIP,
          'install',
          '--dry-run',
          '--ignore-installed',
          '--only-binary=:all:',
          '--no-cache-dir',
          '--use-feature=fast-deps',
          '--disable-pip-version-check',
          '--no-input',
          '--quiet',
          '--report',
          '-',
          '--index-url',
          indexUrl,
          '--extra-index-url',
          'https://download.pytorch.org/whl/cu128',
          ...requested,
        ],
        { cwd: path.dirname(bootstrapPython), timeout: 180_000, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }
      );
      const start = output.indexOf('{');
      const parsed = record(JSON.parse(output.slice(start)));
      if (!Array.isArray(parsed.install) || !parsed.install.length) throw new Error('EMPTY_WHEEL_REPORT');
      resolved = parsed;
      break;
    } catch (error) {
      const failure = record(error);
      const detail = `${stringValue(failure.stderr)} ${error instanceof Error ? error.message : ''}`;
      failures.push(
        /COMFY_METADATA_ONLY_[A-Z_]+/.exec(detail)?.[0] ??
          (/No module named pip/i.test(detail)
            ? 'PIP_MODULE_MISSING'
            : /No matching distribution|Could not find a version/i.test(detail)
              ? 'COMPATIBLE_BINARY_WHEEL_UNAVAILABLE'
              : /certificate|SSL/i.test(detail)
                ? 'PACKAGE_SOURCE_TLS_FAILED'
                : /timed out|ETIMEDOUT/i.test(detail)
                  ? 'PACKAGE_SOURCE_TIMEOUT'
                  : 'BINARY_METADATA_RESOLVER_FAILED')
      );
    }
  }
  if (!resolved)
    throw new Error(`COMFY_DETECTION_INCOMPLETE:BINARY_DEPENDENCY_METADATA_RESOLUTION:${failures.join(',')}`);
  const components: ComfyProfile['components'] = [];
  const resolveWheel = async (distribution: CatalogRecord): Promise<ComfyProfile['components'][number]> => {
    const download = record(distribution.download_info);
    const metadata = record(distribution.metadata);
    const hash = stringValue(record(record(download.archive_info).hashes).sha256);
    const url = packageUrl(stringValue(download.url));
    const name = decodeURIComponent(path.posix.basename(url.pathname));
    if (!name.endsWith('.whl') || !/^[a-f0-9]{64}$/i.test(hash) || !stringValue(metadata.version))
      throw new Error('COMFY_RUNTIME_WHEEL_IDENTITY_INCOMPLETE');
    const head = await fetcher(url, { method: 'HEAD', redirect: 'error', signal: AbortSignal.timeout(30_000) });
    const size = Number(head.headers.get('content-length'));
    if (!head.ok || !Number.isSafeInteger(size) || size <= 0)
      throw new Error(`COMFY_DETECTION_INCOMPLETE:WHEEL_SIZE:${name}`);
    return {
      role: 'runtime-wheel',
      name,
      path: path.join(targetRoot, '.openh3-wheels', name),
      version: stringValue(metadata.version),
      precision: 'binary-wheel',
      url: url.href,
      sha256: hash,
      sizeBytes: size,
    };
  };
  const distributions = records(resolved.install);
  for (let index = 0; index < distributions.length; index += 4) {
    components.push(...(await Promise.all(distributions.slice(index, index + 4).map(resolveWheel))));
  }
  const commands: ComfyInstallPlan['commands'] = [];
  if (!existing) {
    commands.push(
      {
        executable: 'git',
        args: ['clone', '--no-checkout', 'https://github.com/Comfy-Org/ComfyUI.git', environment.root],
        cwd: targetRoot,
        label: 'bootstrap:comfy-clone',
        revision: coreRevision,
        stage: 'prepare',
      },
      {
        executable: 'git',
        args: ['checkout', '--detach', coreRevision],
        cwd: environment.root,
        label: 'bootstrap:comfy-checkout',
        revision: coreRevision,
        stage: 'prepare',
      }
    );
  }
  if (!fs.existsSync(environment.python))
    commands.push({
      executable: bootstrapPython,
      args: ['-m', 'venv', path.dirname(path.dirname(environment.python))],
      cwd: targetRoot,
      label: 'bootstrap:python-venv',
      revision: 'python-venv-v1',
      stage: 'prepare',
    });
  commands.push({
    executable: environment.python,
    args: ['-m', 'pip', 'install', '--no-deps', '--no-index', ...components.map((component) => component.path)],
    cwd: environment.root,
    label: 'runtime:install-locked-binary-wheels',
    revision: coreRevision,
    stage: 'finish',
  });
  return {
    commands,
    components,
    evidence: [
      `requirements:${coreRevision}:${expected}`,
      'dependency-resolution:actual-interpreter-pip-only-binary',
      'runtime:torch-2.9.1+cu128;torchvision-0.24.1+cu128;torchaudio-2.9.1+cu128',
      ...nativePins.map(([name, version]) => `native-runtime-pin:${name}==${version}`),
      'kernel-validation:pending-real-smoke',
    ],
  };
}
