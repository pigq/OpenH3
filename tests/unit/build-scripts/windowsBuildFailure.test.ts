import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const workflow = readFileSync('.github/workflows/_build-reusable.yml', 'utf8').replace(/\r\n/g, '\n');
const pwshAvailable =
  spawnSync('pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', 'exit 0'], {
    encoding: 'utf8',
    timeout: 10000,
    windowsHide: true,
  }).status === 0;
// Windows CI must execute these regressions; other developer hosts need not install pwsh.
const itWithPwsh = process.platform === 'win32' || pwshAvailable ? it : it.skip;

function workflowStep(name: string) {
  const section = workflow.split('      - name: ' + name + '\n')[1]?.split('\n      - name: ')[0];
  if (!section) throw new Error('Missing build workflow step: ' + name);
  return section;
}

const windowsStep = workflowStep('Build with electron-builder (Windows)');
const windowsScript = windowsStep
  .split('        run: |\n')[1]
  .split('\n        env:')[0]
  .split('\n')
  .map((line) => line.replace(/^ {10}/, ''))
  .join('\n')
  .replaceAll('$' + '{{ matrix.platform }}', 'windows-x64');

function nativeExit(code: number) {
  return "& '" + process.execPath.replaceAll("'", "''") + "' -e 'process.exit(" + code + ")'";
}

function executeWindowsStep(command: string, seed = 0, nativeErrors = false) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'openh3-windows-ci-'));
  const script = path.join(directory, 'step.ps1');
  const output = path.join(directory, 'github-output.txt');
  const continued = path.join(directory, 'after-build.txt');
  try {
    writeFileSync(
      script,
      [
        '$global:LASTEXITCODE = ' + seed,
        '$PSNativeCommandUseErrorActionPreference = $' + nativeErrors,
        windowsScript,
        // An explicit failure must stop the script before any subsequent action.
        "[IO.File]::WriteAllText($env:WINDOWS_BUILD_CONTINUATION_FILE, 'continued')",
        // Mirror the Actions pwsh epilogue rather than assume bare -File semantics.
        'if (Test-Path -LiteralPath variable:\\LASTEXITCODE) { exit $LASTEXITCODE }',
      ].join('\n')
    );
    const result = spawnSync('pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', script], {
      cwd: directory,
      env: {
        ...process.env,
        WINDOWS_BUILD_COMMAND: command,
        GITHUB_OUTPUT: output,
        WINDOWS_BUILD_CONTINUATION_FILE: continued,
      },
      encoding: 'utf8',
      timeout: 10000,
      windowsHide: true,
    });
    return {
      status: result.status,
      stdout: result.stdout ?? '',
      errorCode: (result.error as NodeJS.ErrnoException | undefined)?.code ?? null,
      result: existsSync(output) ? readFileSync(output, 'utf8').trim() : '',
      continued: existsSync(continued),
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe('Windows CI build failure propagation', () => {
  it('checks the native code immediately and fails closed before reporting success on every host', () => {
    expect(windowsScript).toContain('$LASTEXITCODE = 0');
    expect(windowsScript).toMatch(
      /iex \$Command\s*\n\s*\$BuildExitCode = \$LASTEXITCODE\s*\n\s*if \(\$BuildExitCode -ne 0\)/
    );
    expect(windowsScript).toMatch(/catch \{[\s\S]*"result=failure"[\s\S]*exit \$BuildExitCode[\s\S]*throw/);
    expect(windowsScript).not.toContain('will not block the workflow');
    expect(windowsScript).not.toContain('workflow is allowed to continue');
  });

  it('keeps artifact verification, cleanup and upload gated on successful Windows output', () => {
    for (const name of [
      'Verify desktop asar isolation',
      'Clean up non-installer artifacts',
      'Upload build artifacts',
    ]) {
      const step = workflowStep(name);
      expect(step).toContain('success() &&');
      expect(step).toContain(
        "!startsWith(matrix.platform, 'windows') || steps.windows-build.outputs.result == 'success'"
      );
    }
  });

  itWithPwsh.each([
    { name: 'native exit 23', command: nativeExit(23), status: 23, seed: 0, nativeErrors: false },
    {
      name: 'native exit 23 with native errors enabled',
      command: nativeExit(23),
      status: 23,
      seed: 0,
      nativeErrors: true,
    },
    {
      name: 'PowerShell exception',
      command: "throw 'synthetic Windows build failure'",
      status: 1,
      seed: 0,
      nativeErrors: false,
    },
    { name: 'native success', command: nativeExit(0), status: 0, seed: 0, nativeErrors: false },
    {
      name: 'cmdlet success with a stale native code',
      command: "Write-Host 'synthetic cmdlet success'",
      status: 0,
      seed: 23,
      nativeErrors: false,
    },
  ])('executes the actual workflow block: $name', ({ command, status, seed, nativeErrors }) => {
    const result = executeWindowsStep(command, seed, nativeErrors);
    expect(result.errorCode).toBeNull();
    expect(result.status).toBe(status);
    expect(result.result).toBe(status === 0 ? 'result=success' : 'result=failure');
    expect(result.stdout.includes('Windows build completed successfully')).toBe(status === 0);
    expect(result.continued).toBe(status === 0);
  });
});
