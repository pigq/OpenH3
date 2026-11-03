/**
 * Resolve the OpenH3 backend binary path.
 *
 * Search order:
 *  1. OPENH3_BACKEND_BIN, then the legacy AIONUI_BACKEND_BIN override
 *  2. The canonical bundled directory, then the legacy bundled directory
 *  3. The repository resources bundle in development
 *  4. `openh3-core` on PATH, then the legacy `aioncore` name
 */

import { existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execSync } from 'node:child_process';
import {
  BACKEND_BINARY_ENV_VARS,
  BACKEND_BINARY_NAME,
  BACKEND_BUNDLE_DIR_NAME,
  LEGACY_BACKEND_BINARY_NAMES,
  LEGACY_BACKEND_BUNDLE_DIR_NAME,
} from '@/common/config/productIdentity';

const MAX_DIR_ENTRIES = 20;
const MAX_LOOKUP_TEXT_LENGTH = 1000;

type BackendBinaryResolveDiagnostics = {
  envOverridePath?: string;
  envOverrideVariable?: string;
  envOverrideExists?: boolean;
  resourcesPath?: string;
  bundledDirName?: string;
  runtimeKey: string;
  binaryName: string;
  checkedBundledPath?: string;
  bundledDirExists?: boolean;
  runtimeDirExists?: boolean;
  resourcesDirEntries?: string[];
  runtimeDirEntries?: string[];
  pathLookupCommand: string;
  pathLookupResult?: string;
  pathLookupError?: string;
};

class BackendBinaryResolveError extends Error {
  readonly diagnostics: BackendBinaryResolveDiagnostics;

  constructor(message: string, diagnostics: BackendBinaryResolveDiagnostics) {
    super(message);
    this.name = 'BackendBinaryResolveError';
    this.diagnostics = diagnostics;
  }
}

function getBinaryName(baseName = BACKEND_BINARY_NAME): string {
  return process.platform === 'win32' ? `${baseName}.exe` : baseName;
}

function getBinaryNames(): string[] {
  return [BACKEND_BINARY_NAME, ...LEGACY_BACKEND_BINARY_NAMES].map(getBinaryName);
}

function getRuntimeKey(): string {
  return `${process.platform}-${process.arch}`;
}

function listDirEntries(dirPath: string): string[] | undefined {
  try {
    return readdirSync(dirPath, { withFileTypes: true })
      .slice(0, MAX_DIR_ENTRIES)
      .map((entry) => `${entry.name}${entry.isDirectory() ? '/' : ''}`);
  } catch {
    return undefined;
  }
}

function trimLookupText(text: string): string {
  return text.trim().slice(0, MAX_LOOKUP_TEXT_LENGTH);
}

/**
 * Resolve the OpenH3 backend binary path.
 * Returns the absolute path to the binary, or throws if not found.
 */
export function resolveBinaryPath(): string {
  const runtimeKey = getRuntimeKey();
  const binaryName = getBinaryName();
  const diagnostics: BackendBinaryResolveDiagnostics = {
    runtimeKey,
    binaryName,
    pathLookupCommand: getBinaryNames()
      .map((name) => (process.platform === 'win32' ? `where ${name}` : `which ${name}`))
      .join(' && '),
  };

  const override = envOverridePath(diagnostics);
  if (override) return override;

  const bundled = bundledPath(runtimeKey, diagnostics);
  if (bundled) return bundled;

  if (process.env.NODE_ENV === 'development') {
    const developmentBundle = bundledPath(runtimeKey, diagnostics, resolve('resources'));
    if (developmentBundle) return developmentBundle;
  }

  const fromPath = resolveFromSystemPATH(diagnostics);
  if (fromPath) return fromPath;

  throw new BackendBinaryResolveError(
    `Cannot find "${BACKEND_BINARY_NAME}" binary. Checked legacy "${LEGACY_BACKEND_BINARY_NAMES.join(
      ', '
    )}" names, bundled locations, and system PATH.`,
    diagnostics
  );
}

/**
 * Honor the canonical or legacy backend binary env override.
 * The value is resolved to an absolute path (relative to process.cwd) so it
 * survives the backend launcher spawning with a different working directory.
 * Returns the path when it points at an existing file. When the variable is
 * set but the file is missing, throws so a typo fails loudly instead of
 * silently falling back to the bundled or PATH binary.
 */
function envOverridePath(diagnostics: BackendBinaryResolveDiagnostics): string | null {
  const configured = BACKEND_BINARY_ENV_VARS.map((variable) => ({ variable, raw: process.env[variable]?.trim() })).find(
    (entry) => entry.raw
  );
  if (!configured?.raw) return null;

  const { variable, raw } = configured;
  const absolute = resolve(raw);
  diagnostics.envOverridePath = absolute;
  diagnostics.envOverrideVariable = variable;
  const exists = existsSync(absolute);
  diagnostics.envOverrideExists = exists;
  if (exists) return absolute;

  throw new BackendBinaryResolveError(
    `${variable} is set to "${raw}" but no file exists at "${absolute}".`,
    diagnostics
  );
}

/**
 * Check bundled binary in resources directory.
 * Layout: bundled-openh3-core/{platform}-{arch}/openh3-core[.exe]
 * Legacy packages use bundled-aioncore/{platform}-{arch}/aioncore[.exe].
 */
function bundledPath(
  runtimeKey: string,
  diagnostics: BackendBinaryResolveDiagnostics,
  resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
): string | null {
  if (!resourcesPath) return null;
  diagnostics.resourcesPath = resourcesPath;

  const bundleDirs = [BACKEND_BUNDLE_DIR_NAME, LEGACY_BACKEND_BUNDLE_DIR_NAME];
  const binaryNames = getBinaryNames();
  diagnostics.resourcesDirEntries = listDirEntries(resourcesPath);

  for (const bundleDir of bundleDirs) {
    const bundledDir = join(resourcesPath, bundleDir);
    const runtimeDir = join(bundledDir, runtimeKey);
    diagnostics.bundledDirExists = diagnostics.bundledDirExists || existsSync(bundledDir);
    diagnostics.runtimeDirExists = diagnostics.runtimeDirExists || existsSync(runtimeDir);
    const runtimeEntries = listDirEntries(runtimeDir);
    diagnostics.runtimeDirEntries = diagnostics.runtimeDirEntries ?? runtimeEntries;

    for (const binaryName of binaryNames) {
      const candidate = join(runtimeDir, binaryName);
      diagnostics.checkedBundledPath ??= candidate;
      if (existsSync(candidate)) {
        diagnostics.bundledDirName = bundleDir;
        return candidate;
      }
    }
  }
  return null;
}

/**
 * Try to find the binary on the system PATH.
 */
function resolveFromSystemPATH(diagnostics: BackendBinaryResolveDiagnostics): string | null {
  const errors: string[] = [];
  for (const binaryName of getBinaryNames()) {
    const command = process.platform === 'win32' ? `where ${binaryName}` : `which ${binaryName}`;
    try {
      const result = execSync(command, { encoding: 'utf-8', timeout: 5000 }).trim();
      diagnostics.pathLookupResult = trimLookupText([diagnostics.pathLookupResult, result].filter(Boolean).join('\n'));
      const firstMatch = result.split(/\r?\n/).find((line) => line.trim());
      if (firstMatch && existsSync(firstMatch.trim())) return firstMatch.trim();
    } catch (error) {
      errors.push(error instanceof Error ? trimLookupText(error.message) : String(error));
    }
  }
  if (errors.length > 0) diagnostics.pathLookupError = errors.join('\n').slice(0, MAX_LOOKUP_TEXT_LENGTH);
  return null;
}

export type { BackendBinaryResolveDiagnostics };
