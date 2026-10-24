import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';

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
