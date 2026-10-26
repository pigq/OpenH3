import { describe, expect, it } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { runInNewContext } from 'node:vm';
import { load } from 'js-yaml';

const projectRoot = resolve(__dirname, '../..');
const itWithBashAndNode =
  spawnSync('bash', ['-lc', 'command -v node >/dev/null'], { encoding: 'utf8' }).status === 0 ? it : it.skip;

function readProjectFile(path: string): string {
  return readFileSync(resolve(projectRoot, path), 'utf8');
}

function yamlBlock(content: string, key: string): string {
  const startMatch = content.match(new RegExp(`^${key}:\\s*$`, 'm'));
  if (!startMatch || startMatch.index === undefined) return '';

  const blockStart = startMatch.index + startMatch[0].length;
  const rest = content.slice(blockStart);
  const nextTopLevelKey = rest.search(/^[a-zA-Z][a-zA-Z0-9]*:\s*$/m);
  return nextTopLevelKey === -1 ? rest : rest.slice(0, nextTopLevelKey);
}

type ManualWorkflow = {
  on: { workflow_dispatch: { inputs: Record<string, { default?: unknown; required?: boolean; options?: string[] }> } };
  permissions: Record<string, string>;
  jobs: Record<
    string,
    {
      if?: string;
      uses?: string;
      needs?: string;
      with?: Record<string, unknown>;
      secrets?: string;
      environment?: string;
      permissions?: Record<string, string>;
      concurrency?: { group: string; 'cancel-in-progress': boolean };
      steps?: {
        name?: string;
        uses?: string;
        if?: string;
        with?: Record<string, unknown>;
        env?: Record<string, string>;
        run?: string;
      }[];
    }
  >;
};

function manualWorkflow(): ManualWorkflow {
  return load(readProjectFile('.github/workflows/build-manual.yml')) as ManualWorkflow;
}

describe('manual build and official content mode isolation', () => {
  it('reuses the existing workflow entry within its input and directory budget', () => {
    const inputs = manualWorkflow().on.workflow_dispatch.inputs;
    expect(inputs.mode).toMatchObject({
      default: 'build',
      options: expect.arrayContaining(['build', 'official-content']),
    });
    expect(Object.keys(inputs).length).toBeLessThanOrEqual(10);
    expect(inputs.branch).toMatchObject({ default: 'main', required: true });
    expect(inputs.platform.options).toEqual([
      'macos-arm64',
      'macos-x64',
      'windows-x64',
      'windows-arm64',
      'linux-x64',
      'linux-arm64',
      'all',
    ]);
    expect(inputs.platform.default).toBe('macos-arm64');
    expect(inputs.skip_code_quality.default).toBe(false);
    expect(inputs.openh3_core_run_id.default).toBe('');
    expect(inputs.aioncore_run_id.default).toBe('');
    expect(inputs.content_source).toBeDefined();
    expect(inputs.content_sequence).toBeDefined();
    expect(inputs.content_source.required).not.toBe(true);
    expect(inputs.content_sequence.required).not.toBe(true);
    expect(inputs.rollback_reason.required).not.toBe(true);
    expect(inputs.key_id).toBeUndefined();
    expect(inputs.min_client_version).toBeUndefined();
    expect(existsSync(resolve(projectRoot, '.github/workflows/publish-content-catalog.yml'))).toBe(false);
    expect(readdirSync(resolve(projectRoot, '.github/workflows')).length).toBeLessThanOrEqual(14);
  });

  it.each([
    ['build', 'pigq/OpenH3', 'refs/heads/main', ['prepare-matrix', 'build-pipeline']],
    ['build', 'contributor/OpenH3', 'refs/heads/feature', ['prepare-matrix', 'build-pipeline']],
    ['official-content', 'pigq/OpenH3', 'refs/heads/main', ['publish-official-content']],
    ['official-content', 'pigq/OpenH3', 'refs/heads/feature', []],
    ['official-content', 'contributor/OpenH3', 'refs/heads/main', []],
    ['official-content', 'pigq/OpenH3', 'refs/tags/v3.0.1', []],
    ['windows-upgrade-acceptance', 'pigq/OpenH3', 'refs/heads/main', []],
    ['unknown', 'pigq/OpenH3', 'refs/heads/main', []],
  ])('isolates %s jobs for %s at %s', (mode, repository, ref, expected) => {
    const jobs = manualWorkflow().jobs;
    const selected = ['prepare-matrix', 'build-pipeline', 'publish-official-content'].filter((id) => {
      expect(jobs[id], id).toBeDefined();
      const condition = jobs[id].if;
      expect(condition, `${id} must have an explicit mode gate`).toBeTruthy();
      // These job gates intentionally use only GitHub/JavaScript-compatible comparisons.
      return runInNewContext(condition!.replace(/^\s*\$\{\{|\}\}\s*$/g, ''), {
        inputs: { mode },
        github: { repository, ref, event_name: 'workflow_dispatch' },
      });
    });
    expect(selected).toEqual(expected);
  });

  it('preserves the ordinary six-platform reusable build inputs, permissions and secrets', () => {
    const workflow = manualWorkflow();
    expect(workflow.jobs['build-pipeline']).toMatchObject({
      needs: 'prepare-matrix',
      uses: './.github/workflows/_build-reusable.yml',
      permissions: { contents: 'write', actions: 'write' },
      with: {
        matrix: '${{ needs.prepare-matrix.outputs.matrix }}',
        ref: '${{ inputs.branch }}',
        skip_code_quality: '${{ inputs.skip_code_quality }}',
        openh3_core_run_id: '${{ inputs.openh3_core_run_id || inputs.aioncore_run_id }}',
        append_commit_hash: true,
        upload_installers_only: true,
      },
      secrets: 'inherit',
    });
    const matrixScript = workflow.jobs['prepare-matrix'].steps![0].run!;
    for (const platform of workflow.on.workflow_dispatch.inputs.platform.options!.filter((value) => value !== 'all')) {
      expect(matrixScript).toContain(`"platform":"${platform}"`);
      expect(matrixScript).toContain(`[ "$PLATFORM" = "${platform}" ]`);
    }
  });

  it('scopes publication writes, approval, concurrency and the private key to content publication', () => {
    const workflow = manualWorkflow();
    expect(workflow.permissions).toEqual({ contents: 'read', actions: 'read' });
    const publish = workflow.jobs['publish-official-content'];
    expect(publish).toMatchObject({
      environment: 'official-content',
      permissions: { contents: 'write' },
      concurrency: { group: 'official-content-publication', 'cancel-in-progress': false },
    });
    expect(publish.needs).toBeUndefined();
    expect(publish.uses).toBeUndefined();
    expect(publish.secrets).toBeUndefined();
    const checkout = publish.steps!.find((step) => step.uses?.startsWith('actions/checkout@'));
    expect(checkout?.with).toEqual({ ref: '${{ github.sha }}', 'persist-credentials': false });
    const signing = publish.steps!.filter((step) => JSON.stringify(step).includes('CONTENT_SIGNING_PRIVATE_KEY'));
    expect(signing).toHaveLength(1);
    expect(signing[0].env).toMatchObject({
      SIGNING_PEM: '${{ secrets.CONTENT_SIGNING_PRIVATE_KEY }}',
      CONTENT_KEY_ID: 'openh3-content-20261024',
      CONTENT_MIN_CLIENT: '3.0.1',
      CONTENT_ROLLBACK_REASON: '${{ inputs.rollback_reason }}',
    });
    expect(signing[0].run).toContain('scripts/content-catalog/publish.mjs --publish');
    expect(signing[0].run).toContain('--rollback-reason "$CONTENT_ROLLBACK_REASON"');
    expect(signing[0].run).toContain('trap ');
    expect(signing[0].run).toContain("flag:'wx'");
    const validation = publish.steps!.find((step) => step.run?.includes('scripts/content-catalog/build.mjs'));
    expect(validation?.env).toMatchObject({
      CONTENT_SOURCE: '${{ inputs.content_source }}',
      CONTENT_SEQUENCE: '${{ inputs.content_sequence }}',
    });
    expect(publish.steps!.indexOf(validation!)).toBeLessThan(publish.steps!.indexOf(signing[0]));
    expect(publish.steps!.some((step) => step.if === 'always()' && step.run?.includes('fs.rmSync'))).toBe(true);
    expect(JSON.stringify(workflow.jobs['build-pipeline'])).not.toContain('CONTENT_SIGNING_PRIVATE_KEY');
    expect(
      readProjectFile('.github/workflows/build-manual.yml').match(/secrets\.CONTENT_SIGNING_PRIVATE_KEY/g)
    ).toHaveLength(1);
    for (const step of publish.steps!) expect(step.run ?? '').not.toContain('${{ inputs.');
  });

  itWithBashAndNode('rejects content sources outside the reviewed commit before building or signing', () => {
    const validation = manualWorkflow().jobs['publish-official-content'].steps!.find((step) =>
      step.run?.includes('scripts/content-catalog/build.mjs')
    );
    const guard = validation!.run!.split('node scripts/content-catalog/build.mjs')[0];
    mkdirSync(resolve(projectRoot, '.runtime'), { recursive: true });
    const tempDir = mkdtempSync(resolve(projectRoot, '.runtime/content-workflow-inputs-'));
    const untracked = resolve(tempDir, 'source.json');
    writeFileSync(untracked, '{}');
    try {
      for (const [source, sequence, success] of [
        ['package.json', '1', true],
        [relative(projectRoot, untracked).replaceAll('\\', '/'), '1', false],
        ['', '1', false],
        ['package.json', '', false],
      ] as const) {
        const result = spawnSync('bash', ['-c', guard], {
          cwd: projectRoot,
          encoding: 'utf8',
          env: { ...process.env, GITHUB_WORKSPACE: projectRoot, CONTENT_SOURCE: source, CONTENT_SEQUENCE: sequence },
        });
        expect(result.status === 0, `${source} / ${sequence}: ${result.stdout}\n${result.stderr}`).toBe(success);
      }
    } finally {
      rmSync(tempDir, { force: true, recursive: true });
    }
  });
});

describe('release packaging configuration', () => {
  it('checks the default branch and supports manual quality verification', () => {
    const workflow = readProjectFile('.github/workflows/build-and-release.yml');
    expect(workflow).toContain('branches: [main, dev]');
    expect(workflow).toContain('workflow_dispatch:');
    expect(workflow).toContain("github.ref == 'refs/heads/main'");
  });

  it('does not attempt to rerun a workflow from inside its own running jobs', () => {
    const workflow = readProjectFile('.github/workflows/build-and-release.yml');
    expect(workflow).not.toContain('auto-retry-workflow:');
    expect(workflow).not.toContain('/actions/runs/${{ github.run_id }}/rerun');
  });

  it('preserves a release that was already published manually', () => {
    const workflow = readProjectFile('.github/workflows/build-and-release.yml');
    expect(workflow).toContain('repos.getReleaseByTag');
    expect(workflow).toContain('steps.existing-release.outputs.published');
  });

  it('does not bring the installer wizard forward for silent updates', () => {
    const source = readProjectFile('resources/windows/installer-update-verify.nsh');
    const macro = source.split('!macro AIONUI_BRING_UPDATED_INSTALLER_TO_FRONT')[1].split('!macroend')[0];
    expect(macro).toContain('${IfNot} ${Silent}');
    expect(macro.indexOf('BringToFront')).toBeGreaterThan(macro.indexOf('${IfNot} ${Silent}'));
  });

  it('preserves user data and installation identity for in-place Windows updates', () => {
    const config = readProjectFile('packages/desktop/electron-builder.yml');
    const nsis = yamlBlock(config, 'nsis');
    expect(nsis).toContain('deleteAppDataOnUninstall: false');
    expect(nsis).toContain('guid: f3bfde38-8429-545c-a4e9-a078d87dee6c');
    expect(nsis).toContain('oneClick: false');
    const updater = readProjectFile('packages/desktop/src/process/services/autoUpdaterService.ts');
    expect(updater).toContain('autoUpdater.autoInstallOnAppQuit = false');
    expect(updater).not.toContain("app.setPath('userData'");
  });

  it('keeps mac zip artifacts enabled', () => {
    const config = readProjectFile('packages/desktop/electron-builder.yml');
    const macBlock = yamlBlock(config, 'mac');

    expect(macBlock).toContain('    - dmg');
    expect(macBlock).toContain('    - zip');
  });

  it('does not build Windows zip artifacts', () => {
    const config = readProjectFile('packages/desktop/electron-builder.yml');
    const winBlock = yamlBlock(config, 'win');

    expect(winBlock).toContain('    - nsis');
    expect(winBlock).not.toContain('    - zip');
  });

  it('bundles Windows FFmpeg and ffprobe for media jobs and H3 reference preflight', () => {
    const config = readProjectFile('packages/desktop/electron-builder.yml');
    const winBlock = yamlBlock(config, 'win');

    expect(winBlock).toContain('from: resources/ffmpeg/win32-${arch}');
    expect(winBlock).toContain('to: ffmpeg');
    expect(readProjectFile('scripts/afterPack.js')).toContain("['ffmpeg.exe', 'ffprobe.exe']");
  });

  it('does not support embedding provider credentials in release packages', () => {
    const afterPack = readProjectFile('scripts/afterPack.js');

    expect(afterPack).not.toContain('AIONUI_PROVIDER_BOOTSTRAP_FILE');
    expect(afterPack).not.toContain('video-provider-bootstrap.json');
    expect(readProjectFile('scripts/open-source-release-audit.js')).toContain("providerBootstrap: 'forbidden'");
  });

  it('links first-run H3 setup to the upstream model and ComfyUI licenses', () => {
    const setup = readProjectFile(
      'packages/desktop/src/renderer/components/settings/SettingsModal/contents/H3EnvironmentContent.tsx'
    );

    expect(setup).toContain('https://huggingface.co/MiniMaxAI/MiniMax-H3/blob/main/LICENSE');
    expect(setup).toContain('https://github.com/Comfy-Org/ComfyUI/blob/master/LICENSE');
    expect(readProjectFile('packages/desktop/src/renderer/services/i18n/locales/zh-CN/settings.json')).toContain(
      '确认所在地区不属于美国、欧盟、英国或韩国'
    );
  });

  it('uses OpenH3 as the display and desktop packaging identity while retaining legacy migration metadata', () => {
    const html = readProjectFile('packages/desktop/src/renderer/index.html');
    const manifest = readProjectFile('public/manifest.webmanifest');
    const identity = readProjectFile('packages/desktop/src/common/config/productIdentity.ts');
    const builder = readProjectFile('packages/desktop/electron-builder.yml');

    expect(html).toContain('content="OpenH3"');
    expect(manifest).toContain('"name": "OpenH3"');
    expect(manifest).toContain('"short_name": "OpenH3"');
    expect(identity).toContain("LEGACY_PRODUCT_NAME = 'AionUi'");
    expect(builder).toContain('appId: com.openh3.app');
    expect(builder).toContain('owner: pigq');
    expect(builder).toContain('repo: OpenH3');
    expect(builder).toContain('      - openh3');
  });

  it('migrates existing Linux protocol handlers while preserving the legacy desktop-file ID', () => {
    const installer = readProjectFile('scripts/install-ubuntu.sh');

    expect(installer).toContain('local legacy_desktop_file="${desktop_dir}/aionui.desktop"');
    expect(installer).toContain('Name=AionUi (Legacy)');
    expect(installer).toContain('NoDisplay=true');
    expect(installer).toContain('Exec=/usr/bin/OpenH3 --no-sandbox %U');
    expect(installer).toContain('xdg-mime default openh3.desktop x-scheme-handler/openh3');
    expect(installer).toContain('xdg-mime default openh3.desktop x-scheme-handler/aionui');
  });

  itWithBashAndNode('manages a legacy manual WebUI process and preserves an unrelated reused PID', () => {
    const installer = readProjectFile('scripts/install-ubuntu.sh');
    const manager = installer.split("<< 'SCRIPT_EOF'\n")[1]?.split('\nSCRIPT_EOF')[0];
    expect(manager).toBeDefined();

    const result = spawnSync(
      'bash',
      [
        '-c',
        `set -e
task_dir=$(mktemp -d)
trap 'rm -rf "$task_dir"' EXIT
eval "$OPENH3_TEST_MANAGER"
PIDFILE="$task_dir/openh3.pid"
LEGACY_PIDFILE="$task_dir/aionui.pid"
trace="$task_dir/trace"
kill() { [ "$1" = '-0' ] || echo "kill $*" >> "$trace"; }
ps() { echo "$OPENH3_TEST_PROCESS"; }
pkill() { echo "pkill $*" >> "$trace"; }
sleep() { :; }
echo 424242 > "$LEGACY_PIDFILE"
status > "$task_dir/status"
grep -q '424242' "$task_dir/status"
stop
[ ! -e "$LEGACY_PIDFILE" ]
grep -q 'kill 424242' "$trace"
grep -q 'pkill -f AionUi --webui' "$trace"

echo 424242 > "$LEGACY_PIDFILE"
OPENH3_TEST_PROCESS='unrelated-server'
: > "$trace"
if stop; then exit 1; fi
[ -f "$LEGACY_PIDFILE" ]
[ ! -s "$trace" ]
if start; then exit 1; fi
[ -f "$LEGACY_PIDFILE" ]
[ ! -s "$trace" ]
`,
      ],
      {
        cwd: projectRoot,
        env: { ...process.env, OPENH3_TEST_MANAGER: manager, OPENH3_TEST_PROCESS: '/usr/bin/AionUi --webui' },
        encoding: 'utf8',
      }
    );

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  });

  itWithBashAndNode('downloads x64 assets with an amd64 fallback and keeps ARM64 package names', () => {
    const result = spawnSync(
      'bash',
      [
        '-c',
        `set -e
# Bash 3.2 can source process-substitution pipes as empty files.
eval "$(sed '$d' scripts/install-ubuntu.sh)"
declare -F detect_arch resolve_version download_deb >/dev/null
task_dir=$(mktemp -d)
trap 'rm -rf "$task_dir"' EXIT
trace="$task_dir/downloads"
mktemp() { command mktemp -d "$task_dir/download.XXXXXX"; }
uname() { echo "$OPENH3_TEST_ARCH"; }
curl() {
    local url="\${!#}" output=''
    echo "$url" >> "$trace"
    [[ "$url" != *linux-x64.deb ]] || return 22
    while [ "$#" -gt 0 ]; do
        if [ "$1" = '-o' ]; then shift; output="$1"; fi
        shift
    done
    printf 'fixture-deb' > "$output"
}
OPENH3_VERSION=2.2.2
OPENH3_TEST_ARCH=x86_64
detect_arch
resolve_version
[ "$DEB_ARCH" = amd64 ]
[ "$RELEASE_ARCH" = x64 ]
download_deb
[ "$(wc -l < "$trace")" -eq 2 ]
grep -q 'OpenH3-2.2.2-linux-x64.deb' "$trace"
grep -q 'OpenH3-2.2.2-linux-amd64.deb' "$trace"
[ -s "$DEB_PATH" ]

: > "$trace"
OPENH3_TEST_ARCH=aarch64
detect_arch
resolve_version
[ "$DEB_ARCH" = arm64 ]
[ "$RELEASE_ARCH" = arm64 ]
download_deb
[ "$(wc -l < "$trace")" -eq 1 ]
grep -q 'OpenH3-2.2.2-linux-arm64.deb' "$trace"
[ -s "$DEB_PATH" ]
`,
      ],
      { cwd: projectRoot, encoding: 'utf8' }
    );
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  });

  it('ships the user-approved OpenH3 logo source and transparent wordmark', () => {
    const source = resolve(projectRoot, 'packages/desktop/src/renderer/assets/logos/brand/openh3-logo-source.png');
    const wordmark = resolve(projectRoot, 'packages/desktop/src/renderer/assets/logos/brand/openh3-logo.png');

    expect(existsSync(source)).toBe(true);
    expect(statSync(source).size).toBeGreaterThan(1024);
    expect(existsSync(wordmark)).toBe(true);
    expect(statSync(wordmark).size).toBeGreaterThan(1024);
  });

  it('ships reproducible OpenH3 desktop icon assets', () => {
    const iconGenerator = readProjectFile('scripts/generate-openh3-icons.mjs');
    const generatedAssets = [
      'packages/desktop/src/renderer/assets/logos/brand/app.png',
      'resources/app.png',
      'resources/app.ico',
    ];

    expect(iconGenerator).toContain('fileURLToPath');
    for (const asset of generatedAssets) {
      expect(existsSync(resolve(projectRoot, asset))).toBe(true);
      expect(statSync(resolve(projectRoot, asset)).size).toBeGreaterThan(1024);
    }
  });

  it('declares the workspace package license without inventing a repository URL', () => {
    const packageFiles = [
      'packages/desktop/package.json',
      'packages/shared-scripts/package.json',
      'packages/web-cli/package.json',
      'packages/web-host/package.json',
    ];

    for (const packageFile of packageFiles) {
      const manifest = JSON.parse(readProjectFile(packageFile)) as {
        license?: string;
        repository?: unknown;
      };
      expect(manifest.license, packageFile).toBe('Apache-2.0');
      expect(manifest.repository, packageFile).toBeUndefined();
    }
  });

  it('bundles the checked-in third-party license evidence with desktop releases', () => {
    const config = readProjectFile('packages/desktop/electron-builder.yml');

    expect(config).toContain('from: resources/third-party-licenses');
    expect(config).toContain('to: third-party-licenses');
    expect(readProjectFile('resources/third-party-licenses/LICENSE.ComfyUI-v0.35.0-LICENSE')).toContain(
      'GNU GENERAL PUBLIC LICENSE'
    );
  });

  it('uploads mac zip artifacts without a stale Windows zip glob', () => {
    const workflow = readProjectFile('.github/workflows/_build-reusable.yml');

    expect(workflow).toContain('out/OpenH3-*-mac-*.zip');
    expect(workflow).not.toContain('out/OpenH3-*-win32-*.zip');
  });

  it('retries mac prepackaged builds with both dmg and zip targets', () => {
    const script = readProjectFile('scripts/build-with-builder.js');

    expect(script).toMatch(/--mac\s+dmg\s+zip\s+--\$\{targetArch\}\s+--prepackaged/);
  });

  itWithBashAndNode('fails release asset preparation when a mac zip is missing', () => {
    const tempDir = mkdtempSync(resolve(tmpdir(), 'aionui-release-assets-'));
    const artifactsDir = resolve(tempDir, 'build-artifacts');
    const outputDir = resolve(tempDir, 'release-assets');

    try {
      const env = { ...process.env, MOCK_VERSION: '1.0.0' };
      const createResult = spawnSync('bash', ['scripts/create-mock-release-artifacts.sh', artifactsDir], {
        cwd: projectRoot,
        env,
        encoding: 'utf8',
      });
      expect(createResult.status).toBe(0);

      rmSync(resolve(artifactsDir, 'macos-build-arm64', 'OpenH3-1.0.0-mac-arm64.zip'), { force: true });

      const prepareResult = spawnSync('bash', ['scripts/prepare-release-assets.sh', artifactsDir, outputDir], {
        cwd: projectRoot,
        env,
        encoding: 'utf8',
      });

      expect(prepareResult.status).not.toBe(0);
      expect(`${prepareResult.stdout}\n${prepareResult.stderr}`).toContain('Missing macOS zip artifact');
    } finally {
      rmSync(tempDir, { force: true, recursive: true });
    }
  });
});
