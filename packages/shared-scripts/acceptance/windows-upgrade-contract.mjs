import path from 'node:path';
import { createHash } from 'node:crypto';

export const OFFICIAL = Object.freeze({
  tag: 'v3.0.0',
  releaseId: 419059111,
  assetId: 664506277,
  name: 'OpenH3-3.0.0-win-x64.exe',
  size: 240707005,
  sha256: '42d8b7998728283d4cc4054ddd7b01ec88b4cde13e677d31cc26f158badda7c8',
  commit: '099af50a3ac867d5aa2697c914e04d868386d696',
});

export function assertHostedRunner(env, platform, arch) {
  if (
    platform !== 'win32' ||
    arch !== 'x64' ||
    env.GITHUB_ACTIONS !== 'true' ||
    env.RUNNER_ENVIRONMENT !== 'github-hosted' ||
    env.RUNNER_OS !== 'Windows' ||
    !env.RUNNER_TEMP
  )
    throw new Error('Installed acceptance runs only on a GitHub-hosted Windows x64 runner');
}

function safeWindowsPath(value) {
  if (
    typeof value !== 'string' ||
    !/^[a-z]:\\/i.test(value) ||
    // eslint-disable-next-line no-control-regex
    /["\r\n\x00]/.test(value) ||
    value.split(/[\\/]/).includes('..')
  )
    throw new Error('Expected an absolute non-device Windows path without traversal/quotes');
  return path.win32.resolve(value);
}

export function assertWithinWindows(root, candidate) {
  const base = safeWindowsPath(root);
  const resolved = safeWindowsPath(candidate);
  const relative = path.win32.relative(base.toLowerCase(), resolved.toLowerCase());
  if (
    base === path.win32.parse(base).root ||
    !relative ||
    relative === '..' ||
    relative.startsWith('..\\') ||
    path.win32.isAbsolute(relative)
  )
    throw new Error('Path must be strictly within this run temporary root');
  return resolved;
}

export function installerArguments({ installDir, logPath, session }) {
  const target = safeWindowsPath(installDir);
  const log = safeWindowsPath(logPath);
  if (!/^[a-f0-9]{12}$/.test(session)) throw new Error('Invalid installer session');
  return `/S /currentuser --installer-log="${log}" --installer-session=${session} /D=${target}`;
}

export function childEnvironment(parent, mode) {
  if (!['official-old', 'candidate-manual', 'candidate-updater'].includes(mode))
    throw new Error('Unknown app child mode');
  const env = { ...parent };
  for (const key of Object.keys(env)) {
    if (
      /(?:TOKEN|SECRET|PASSWORD|PASSWD|CSC_LINK|CERTIFICATE|SENTRY_DSN)/i.test(key) ||
      /^(?:NODE_OPTIONS|ELECTRON_RUN_AS_NODE|ELECTRON_RENDERER_URL|AIONUI_E2E_|AIONUI_FORCE_DEV_AUTO_UPDATE|AIONUI_DEBUG_AUTO_UPDATE_CURRENT_VERSION)/i.test(
        key
      )
    )
      delete env[key];
  }
  if (mode === 'candidate-updater') {
    for (const key of Object.keys(env))
      if (/^(?:CI|GITHUB_ACTIONS|AIONUI_DISABLE_AUTO_UPDATE)$/i.test(key)) delete env[key];
  } else env.AIONUI_DISABLE_AUTO_UPDATE = '1';
  return env;
}

export function parseInstallerJsonl(text) {
  return text
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch {
        throw new Error(`Invalid installer JSONL line ${index + 1}`);
      }
    });
}

export function assertInstallerSuccess(events, expected) {
  const relevant = events.filter((event) => event.session === expected.session);
  // preInit can log before NSIS resolves $INSTDIR. The success terminus must
  // carry the final path; a populated earlier path must also agree.
  const matchingPath = (event) =>
    path.win32.normalize(event.instDir ?? '').toLowerCase() === path.win32.normalize(expected.installDir).toLowerCase();
  if (
    relevant.some(
      (event) =>
        event.version !== expected.version ||
        event.updated !== expected.updated ||
        (event.instDir && !matchingPath(event))
    )
  )
    throw new Error('Installer session identity mismatch');
  if (
    relevant.some(
      (event) =>
        (event.event === 'failure' && event.fatal !== false) || /(?:^|\s)result=fail(?:\s|$)/.test(event.message ?? '')
    )
  )
    throw new Error('Installer reported failure');
  if (
    !relevant.some(
      (event) =>
        event.event === 'session-end' &&
        matchingPath(event) &&
        /(?:^|\s)result=success(?:\s|$)/.test(event.message ?? '')
    )
  )
    throw new Error('No successful session-end for this installer session');
}

export function assertArtifactManifest(manifest, bytes, expectedVersion) {
  const name = `OpenH3-${expectedVersion}-win-x64.exe`;
  if (
    expectedVersion !== '3.0.1' ||
    manifest?.version !== expectedVersion ||
    manifest.path !== name ||
    !Array.isArray(manifest.files) ||
    manifest.files.length !== 1
  )
    throw new Error('Manifest must describe the exact final Windows x64 3.0.1 candidate');
  const file = manifest.files[0];
  const digest = createHash('sha512').update(bytes).digest('base64');
  if (file.url !== name || file.size !== bytes.length || file.sha512 !== digest || manifest.sha512 !== digest)
    throw new Error('Manifest installer name, size or SHA512 mismatch');
  return { name, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), sha512: digest };
}

export function selectOwnedProcesses(snapshot, registry) {
  const valid = (value) => {
    if (
      !Number.isInteger(Number(value.pid)) ||
      Number(value.pid) <= 0 ||
      typeof value.created !== 'string' ||
      !Number.isFinite(Date.parse(value.created))
    )
      return false;
    try {
      safeWindowsPath(value.executable);
      return true;
    } catch {
      return false;
    }
  };
  return snapshot.filter(
    (process) =>
      valid(process) &&
      registry.some(
        (owned) =>
          valid(owned) &&
          Number(process.pid) === Number(owned.pid) &&
          process.created === owned.created &&
          path.win32.resolve(process.executable).toLowerCase() === path.win32.resolve(owned.executable).toLowerCase()
      )
  );
}
