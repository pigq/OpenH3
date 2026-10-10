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

  it('uses OpenH3 as the display identity without changing legacy runtime packaging ids', () => {
    const html = readProjectFile('packages/desktop/src/renderer/index.html');
    const manifest = readProjectFile('public/manifest.webmanifest');
    const identity = readProjectFile('packages/desktop/src/common/config/productIdentity.ts');
    const builder = readProjectFile('packages/desktop/electron-builder.yml');

    expect(html).toContain('content="OpenH3"');
    expect(manifest).toContain('"name": "OpenH3"');
    expect(manifest).toContain('"short_name": "OpenH3"');
    expect(identity).toContain("LEGACY_PRODUCT_NAME = 'AionUi'");
    expect(builder).toContain('appId: com.aionui.app');
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

      rmSync(resolve(artifactsDir, 'macos-build-arm64', 'AionUi-1.0.0-mac-arm64.zip'), { force: true });

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
