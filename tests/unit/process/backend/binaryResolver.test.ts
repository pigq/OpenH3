/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { execSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveBinaryPath } from '@/process/backend/binaryResolver';

vi.mock('node:child_process', () => ({
  execSync: vi.fn(),
}));

vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
  readdirSync: vi.fn(),
}));

const originalResourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
const originalBackendBin = process.env.AIONUI_BACKEND_BIN;
const originalOpenH3BackendBin = process.env.OPENH3_BACKEND_BIN;

function setResourcesPath(resourcesPath: string | undefined): void {
  Object.defineProperty(process, 'resourcesPath', {
    configurable: true,
    value: resourcesPath,
  });
}

function restoreBackendBin(): void {
  if (originalBackendBin === undefined) {
    delete process.env.AIONUI_BACKEND_BIN;
  } else {
    process.env.AIONUI_BACKEND_BIN = originalBackendBin;
  }
  if (originalOpenH3BackendBin === undefined) {
    delete process.env.OPENH3_BACKEND_BIN;
  } else {
    process.env.OPENH3_BACKEND_BIN = originalOpenH3BackendBin;
  }
}

function dirEntry(name: string, isDirectory = false): ReturnType<typeof readdirSync>[number] {
  return {
    name,
    isDirectory: () => isDirectory,
  } as unknown as ReturnType<typeof readdirSync>[number];
}

describe('resolveBinaryPath', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.AIONUI_BACKEND_BIN;
    delete process.env.OPENH3_BACKEND_BIN;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    setResourcesPath(originalResourcesPath);
    restoreBackendBin();
  });

  it('uses the project bundle during development before looking on PATH', () => {
    vi.stubEnv('NODE_ENV', 'development');
    setResourcesPath('/electron/runtime/resources');
    const projectBinary = join(
      process.cwd(),
      'resources',
      'bundled-openh3-core',
      `${process.platform}-${process.arch}`,
      process.platform === 'win32' ? 'openh3-core.exe' : 'openh3-core'
    );
    vi.mocked(existsSync).mockImplementation((filename) => filename === projectBinary);
    expect(resolveBinaryPath()).toBe(projectBinary);
    expect(execSync).not.toHaveBeenCalled();
  });

  it('returns the AIONUI_BACKEND_BIN override when the file exists', () => {
    const overrideInput = '/custom/aioncore';
    // Resolve mirrors the implementation so the expectation holds on Windows too.
    const overridePath = resolve(overrideInput);
    process.env.AIONUI_BACKEND_BIN = overrideInput;
    vi.mocked(existsSync).mockImplementation((path) => path === overridePath);

    expect(resolveBinaryPath()).toBe(overridePath);
    // Override wins before bundled/PATH lookup runs.
    expect(execSync).not.toHaveBeenCalled();
  });

  it('prefers the canonical OPENH3_BACKEND_BIN override when both names are set', () => {
    const canonicalInput = '/custom/openh3-core';
    const legacyInput = '/custom/aioncore';
    const canonicalPath = resolve(canonicalInput);
    process.env.OPENH3_BACKEND_BIN = canonicalInput;
    process.env.AIONUI_BACKEND_BIN = legacyInput;
    vi.mocked(existsSync).mockImplementation((path) => path === canonicalPath);

    expect(resolveBinaryPath()).toBe(canonicalPath);
  });

  it('trims whitespace around AIONUI_BACKEND_BIN before use', () => {
    const overrideInput = '/custom/aioncore';
    const overridePath = resolve(overrideInput);
    process.env.AIONUI_BACKEND_BIN = `  ${overrideInput}  `;
    vi.mocked(existsSync).mockImplementation((path) => path === overridePath);

    expect(resolveBinaryPath()).toBe(overridePath);
  });

  it('resolves a relative AIONUI_BACKEND_BIN against process.cwd', () => {
    process.env.AIONUI_BACKEND_BIN = 'rel/aioncore';
    const absolute = resolve('rel/aioncore');
    vi.mocked(existsSync).mockImplementation((path) => path === absolute);

    expect(resolveBinaryPath()).toBe(absolute);
  });

  it('throws with override diagnostics when AIONUI_BACKEND_BIN points at a missing file', () => {
    const overrideInput = '/custom/missing-aioncore';
    const overridePath = resolve(overrideInput);
    process.env.AIONUI_BACKEND_BIN = overrideInput;
    vi.mocked(existsSync).mockReturnValue(false);

    // Error message quotes the raw input, diagnostics carry the resolved path.
    expect(() => resolveBinaryPath()).toThrow(`AIONUI_BACKEND_BIN is set to "${overrideInput}"`);

    try {
      resolveBinaryPath();
    } catch (error) {
      expect(error).toMatchObject({
        name: 'BackendBinaryResolveError',
        diagnostics: expect.objectContaining({
          envOverridePath: overridePath,
          envOverrideExists: false,
        }),
      });
    }
    // A missing explicit override fails loudly instead of falling back.
    expect(execSync).not.toHaveBeenCalled();
  });

  it('ignores a blank AIONUI_BACKEND_BIN and falls back to the normal search order', () => {
    process.env.AIONUI_BACKEND_BIN = '   ';
    const resolved = '/usr/local/bin/aioncore';

    setResourcesPath(undefined);
    vi.mocked(execSync).mockReturnValue(`${resolved}\n`);
    vi.mocked(existsSync).mockImplementation((path) => path === resolved);

    expect(resolveBinaryPath()).toBe(resolved);
  });

  it('attaches bundled path diagnostics when the backend cannot be resolved', () => {
    const resourcesPath = '/app/resources';
    const runtimeKey = `${process.platform}-${process.arch}`;
    const binaryName = process.platform === 'win32' ? 'openh3-core.exe' : 'openh3-core';
    const bundledDir = join(resourcesPath, 'bundled-openh3-core');
    const runtimeDir = join(bundledDir, runtimeKey);
    const checkedBundledPath = join(runtimeDir, binaryName);

    setResourcesPath(resourcesPath);
    vi.mocked(existsSync).mockReturnValue(false);
    vi.mocked(readdirSync).mockImplementation((path) => {
      if (path === resourcesPath) return [dirEntry('bundled-openh3-core', true)];
      if (path === runtimeDir) return [dirEntry('manifest.json')];
      return [] as ReturnType<typeof readdirSync>;
    });
    vi.mocked(execSync).mockImplementation(() => {
      throw new Error('not found on PATH');
    });

    expect(() => resolveBinaryPath()).toThrow('Cannot find "openh3-core" binary');

    try {
      resolveBinaryPath();
    } catch (error) {
      expect(error).toMatchObject({
        name: 'BackendBinaryResolveError',
        diagnostics: expect.objectContaining({
          resourcesPath,
          runtimeKey,
          binaryName,
          checkedBundledPath,
          bundledDirExists: false,
          runtimeDirExists: false,
          resourcesDirEntries: ['bundled-openh3-core/'],
          runtimeDirEntries: ['manifest.json'],
          pathLookupCommand:
            process.platform === 'win32'
              ? 'where openh3-core.exe && where aioncore.exe'
              : 'which openh3-core && which aioncore',
          pathLookupError: expect.stringContaining('not found on PATH'),
        }),
      });
    }
  });
});
