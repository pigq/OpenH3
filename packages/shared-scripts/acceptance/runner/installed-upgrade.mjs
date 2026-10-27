// Guard-first CLI. Importing this file does not import Playwright or start an app.
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import {
  assertHostedRunner,
  assertWithinWindows,
  assertInstallerSuccess,
  OFFICIAL,
} from '../windows-upgrade-contract.mjs';
import { seedInstalledProfile, verifyInstalledProfile } from '../windows-installed-seed.mjs';
import { assertContext, digest, verifyBundle, verifyOfficial } from './artifacts.mjs';
import { runUpdaterScenario } from './flows/updater.mjs';

export const SCENARIOS = ['manual-migration', 'cancel', 'disconnect', 'corrupt', 'downloaded-quit', 'install'];
const samePath = (a, b) => path.win32.normalize(a).toLowerCase() === path.win32.normalize(b).toLowerCase();

export function scenarioRoot(env, scenario) {
  assert.ok(SCENARIOS.includes(scenario), 'Unknown scenario');
  assert.match(env.GITHUB_RUN_ID, /^[1-9][0-9]*$/);
  assert.match(env.GITHUB_RUN_ATTEMPT, /^[1-9][0-9]*$/);
  return assertWithinWindows(
    env.RUNNER_TEMP,
    path.win32.join(env.RUNNER_TEMP, `openh3 acceptance-${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT}-${scenario}`)
  );
}

export async function readSource(repoRoot, expectedSha, deps = {}) {
  const git = deps.git ?? promisify(execFile);
  const { stdout } = await git('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, windowsHide: true });
  assert.equal(stdout.trim(), expectedSha, 'Checkout is not the exact reviewed source SHA');
  const status = await git('git', ['status', '--porcelain', '--untracked-files=no'], {
    cwd: repoRoot,
    windowsHide: true,
  });
  assert.equal(status.stdout.trim(), '', 'Refusing dirty tracked source before provenance/installation');
  const read = deps.readFile ?? fs.readFile;
  return {
    repoRoot,
    sha: stdout.trim(),
    trackedClean: true,
    packageBytes: await read(path.join(repoRoot, 'package.json')),
    lockBytes: await read(path.join(repoRoot, 'bun.lock')),
  };
}

async function githubBytes(url, token, accept = 'application/octet-stream') {
  for (let redirects = 0; redirects < 6; redirects++) {
    const target = new URL(url);
    assert.equal(target.protocol, 'https:');
    assert.ok(
      [
        'api.github.com',
        'github.com',
        'release-assets.githubusercontent.com',
        'objects.githubusercontent.com',
        'github-releases.githubusercontent.com',
      ].includes(target.hostname),
      'Non-GitHub official download redirect refused'
    );
    const headers = { Accept: accept, 'User-Agent': 'OpenH3-installed-acceptance' };
    if (token && target.hostname === 'api.github.com') headers.Authorization = `Bearer ${token}`;
    const response = await fetch(target, { headers, redirect: 'manual', signal: AbortSignal.timeout(300_000) });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel();
      url = new URL(response.headers.get('location'), target).href;
      continue;
    }
    assert.equal(response.status, 200, `GitHub official download failed (${response.status})`);
    return Buffer.from(await response.arrayBuffer());
  }
  throw Error('Too many GitHub official download redirects');
}

export async function obtainOfficial({ io, directory, token }) {
  await io.ensureOwnedDirectory(directory);
  const metadata = JSON.parse(
    (
      await githubBytes(
        'https://api.github.com/repos/pigq/OpenH3/releases/tags/v3.0.0',
        token,
        'application/vnd.github+json'
      )
    ).toString('utf8')
  );
  assert.equal(metadata.id, OFFICIAL.releaseId);
  assert.equal(metadata.tag_name, OFFICIAL.tag);
  assert.equal(metadata.draft, false);
  assert.equal(metadata.prerelease, false);
  const asset = metadata.assets?.find((a) => a.id === OFFICIAL.assetId);
  assert.equal(asset?.name, OFFICIAL.name);
  assert.equal(asset.size, OFFICIAL.size);
  assert.equal(asset.digest, `sha256:${OFFICIAL.sha256}`);
  assert.equal(new URL(asset.browser_download_url).hostname, 'github.com');
  assert.equal(new URL(asset.browser_download_url).pathname, `/pigq/OpenH3/releases/download/v3.0.0/${OFFICIAL.name}`);
  const assetApi = `https://api.github.com/repos/pigq/OpenH3/releases/assets/${OFFICIAL.assetId}`;
  assert.equal(asset.url, assetApi);
  // API octet-stream also works for a private repository's official asset.
  // Authorization is attached only to api.github.com, never a redirect host.
  const bytes = await githubBytes(assetApi, token);
  const identity = verifyOfficial(bytes);
  const file = path.win32.join(directory, OFFICIAL.name);
  await io.writeFile(file, bytes);
  await io.writeJson(path.win32.join(directory, 'official-release.json'), {
    id: metadata.id,
    tag: metadata.tag_name,
    publishedAt: metadata.published_at,
    asset: { id: asset.id, name: asset.name, size: asset.size, digest: asset.digest },
    identity,
  });
  return { path: file, identity, verified: true };
}

export async function loadReviewedContentContract(repoRoot, deps = {}) {
  const build = deps.build ?? (await import('esbuild')).build;
  // Bundle the reviewed TypeScript definitions in memory for Node 22. Never run
  // the content exporter or create another runtime that could rewrite evidence.
  const output = await build({
    absWorkingDir: repoRoot,
    stdin: {
      contents: [
        "export { parseCatalog } from './packages/desktop/src/common/contentCatalog/schema.ts';",
        "export { COMFY_FAMILIES as families } from './packages/desktop/src/renderer/pages/guid/Creation/comfyDraft.ts';",
        "export { CREATION_TEMPLATES as templates } from './packages/desktop/src/renderer/pages/guid/utils/creationTemplates.ts';",
      ].join('\n'),
      resolveDir: repoRoot,
      sourcefile: 'installed-content-contract.mjs',
    },
    bundle: true,
    write: false,
    platform: 'node',
    target: 'node22',
    format: 'esm',
    logLevel: 'silent',
    tsconfig: path.join(repoRoot, 'tsconfig.json'),
    plugins: [
      {
        name: 'read-only-content-asset-paths',
        setup(builder) {
          builder.onResolve({ filter: /\?url$/ }, (args) => ({
            path: args.path.startsWith('@/')
              ? path.join(repoRoot, 'packages/desktop/src', args.path.slice(2, -4))
              : path.resolve(args.resolveDir, args.path.slice(0, -4)),
            namespace: 'content-asset-path',
          }));
          builder.onLoad({ filter: /.*/, namespace: 'content-asset-path' }, (args) => ({
            contents: `export default ${JSON.stringify(args.path)}`,
            loader: 'js',
          }));
        },
      },
    ],
  });
  assert.equal(output.outputFiles?.length, 1, 'Reviewed content contract must have one in-memory module');
  return import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString('base64')}`);
}

export async function auditInstalledContent(resourcesPath, repoRoot, deps = {}) {
  const fsOps = deps.fsOps ?? fs;
  const contract = await (deps.loadContentContract ?? loadReviewedContentContract)(repoRoot);
  const sorted = (values) => [...values].sort();
  const familyIds = contract.families.map((family) => family.family);
  assert.deepEqual(
    sorted(familyIds),
    sorted([
      'h3',
      'fasth3-omni',
      'qwen-edit',
      'z-image',
      'flux-3-image-klein',
      'moss-image-base',
      'moss-image-sft',
      'krea2',
    ]),
    'Reviewed source must preserve all eight approved model families'
  );
  const templateIds = contract.templates.map((template) => `official:${template.key}`);
  assert.equal(templateIds.length, 52, 'Reviewed source must preserve all 52 templates');
  assert.equal(new Set(templateIds).size, 52, 'Reviewed source contains duplicate template IDs');
  const directory = assertWithinWindows(resourcesPath, path.win32.join(resourcesPath, 'content-catalog'));
  const physical = async (file, isDirectory = false) => {
    const stat = await fsOps.lstat(file);
    assert.equal(stat.isSymbolicLink(), false, `Installed content link rejected: ${file}`);
    assert.equal(isDirectory ? stat.isDirectory() : stat.isFile(), true, `Wrong installed content type: ${file}`);
    assert.ok(samePath(await fsOps.realpath(file), file), `Installed content physical path differs: ${file}`);
  };
  await physical(directory, true);
  const readInstalled = async (name) => {
    const file = assertWithinWindows(directory, path.win32.join(directory, name));
    await physical(file);
    return { path: file, bytes: await fsOps.readFile(file) };
  };
  const catalogFile = await readInstalled('catalog.json');
  const catalog = contract.parseCatalog(JSON.parse(catalogFile.bytes.toString('utf8').replace(/^\uFEFF/, '')));
  assert.equal(catalog.releaseSequence, 0, 'Installed bundle must be the built-in catalog');
  assert.deepEqual(
    sorted(catalog.models.map((model) => model.family)),
    sorted(familyIds),
    'Installed model families differ'
  );
  assert.deepEqual(
    sorted(catalog.models.map((model) => model.id)),
    sorted(familyIds.map((id) => `official:model-${id}`)),
    'Installed model IDs differ'
  );
  assert.deepEqual(
    sorted(catalog.entries.map((entry) => entry.id)),
    sorted(templateIds),
    'Installed template IDs differ'
  );
  for (const expected of contract.families) {
    const actual = catalog.models.find((model) => model.family === expected.family);
    assert.equal(actual.name, expected.name, `Changed model name: ${expected.family}`);
    assert.equal(actual.kind, expected.kind, `Changed model kind: ${expected.family}`);
    assert.deepEqual(actual.requiredCapabilities, [`comfy.${expected.family}`]);
  }
  for (const expected of contract.templates) {
    const actual = catalog.entries.find((entry) => entry.id === `official:${expected.key}`);
    assert.equal(actual.entryType, 'template');
    for (const field of ['kind', 'ratio'])
      assert.equal(actual[field], expected[field], `Changed template ${expected.key}.${field}`);
    assert.equal(actual.requiresReference, Boolean(expected.requiresReference));
    assert.deepEqual(actual.requiredCapabilities, [`template.${expected.kind}`]);
    if (expected.kind === 'video') assert.equal(actual.duration, expected.duration);
  }
  const keyring = await readInstalled('trusted-keys.json');
  const sourceKeyring = await fsOps.readFile(path.join(repoRoot, 'resources/content-catalog/trusted-keys.json'));
  assert.equal(
    digest(keyring.bytes),
    digest(sourceKeyring),
    'Installed content trust keyring differs from reviewed source'
  );
  const declared = new Map(catalog.assets.map((asset) => [asset.sha256, asset]));
  const referenced = new Set(
    [...catalog.models, ...catalog.entries].flatMap((entry) => [entry.cover, ...(entry.media ? [entry.media] : [])])
  );
  for (const hash of referenced) assert.ok(declared.has(hash), `Missing referenced content asset: ${hash}`);
  await physical(path.win32.join(directory, 'assets'), true);
  const assets = [];
  for (const asset of catalog.assets) {
    assert.equal(asset.path, `assets/${asset.sha256}`, 'Installed content must use digest-addressed local assets');
    const file = await readInstalled(asset.path);
    assert.equal(file.bytes.length, asset.sizeBytes, `Installed content asset size mismatch: ${asset.sha256}`);
    assert.equal(digest(file.bytes), asset.sha256, `Installed content asset SHA256 mismatch: ${asset.sha256}`);
    assets.push({
      path: file.path,
      sha256: asset.sha256,
      sizeBytes: file.bytes.length,
      referenced: referenced.has(asset.sha256),
    });
  }
  return {
    directory,
    catalog: { path: catalogFile.path, sha256: digest(catalogFile.bytes), releaseSequence: catalog.releaseSequence },
    keyring: { path: keyring.path, sha256: digest(keyring.bytes) },
    families: sorted(familyIds),
    templateIds: sorted(templateIds),
    assets,
    modelWeightsOrInferenceTested: false,
  };
}

export async function auditResources(identity, repoRoot, deps = {}) {
  const require = createRequire(import.meta.url);
  const fsOps = deps.fsOps ?? fs;
  const verifyCore =
    deps.verifyCore ??
    require(path.join(repoRoot, 'packages/shared-scripts/src/verify-bundled-openh3-core-resources.js'))
      .verifyBundledOpenH3CoreResources;
  const result = verifyCore({
    resourcesDir: identity.resourcesPath,
    electronPlatformName: identity.platform,
    targetArch: identity.arch,
  });
  assert.equal(result.missing.length, 0, `Missing bundled core: ${result.missing.join(',')}`);
  assert.equal(result.failures.length, 0, `Invalid bundled core: ${result.failures.join(',')}`);
  const ffmpeg = [];
  for (const name of ['ffmpeg.exe', 'ffprobe.exe']) {
    const file = path.win32.join(identity.resourcesPath, 'ffmpeg', name);
    const info = await fsOps.stat(file);
    assert.ok(info.isFile() && info.size > 0, `Missing/empty ${name}`);
    ffmpeg.push({ path: file, size: info.size });
  }
  let productionFeed;
  let content;
  if (identity.version === '3.0.1') {
    const configPath = path.win32.join(identity.resourcesPath, 'app-update.yml');
    const configBytes = await fsOps.readFile(configPath);
    const loadManifest = deps.loadManifest ?? (await import('js-yaml')).load;
    const config = loadManifest(configBytes.toString('utf8'));
    assert.equal(config.provider, 'github');
    assert.equal(config.owner, 'pigq');
    assert.equal(config.repo, 'OpenH3');
    productionFeed = {
      path: configPath,
      sha256: digest(configBytes),
      provider: config.provider,
      owner: config.owner,
      repo: config.repo,
    };
    content = await auditInstalledContent(identity.resourcesPath, repoRoot, deps);
  }
  return { ...result, ffmpeg, productionFeed, content };
}

function assertInstalled(app, installDir, version) {
  const i = app.identity;
  assert.equal(i.packaged, true);
  assert.equal(i.version, version);
  assert.equal(i.platform, 'win32');
  assert.equal(i.arch, 'x64');
  assert.ok(samePath(i.executable, path.win32.join(installDir, 'OpenH3.exe')), 'Wrong installed executable');
  assertWithinWindows(installDir, i.appRoot);
  assertWithinWindows(installDir, i.resourcesPath);
  assert.match(i.userData, /^[a-z]:\\/i);
  assert.match(app.backendDataDir, /^[a-z]:\\/i);
}

export async function runAcceptance(config, io, services = {}) {
  const { scenario, root, candidateDir, context, source } = config;
  assertContext(context);
  assert.ok(SCENARIOS.includes(scenario));
  assert.equal(source.sha, context.sourceSha);
  assertWithinWindows(root, candidateDir);
  await io.ensureOwnedRoot(root); // realpath/reparse validation precedes every write/spawn
  const evidenceDir = path.win32.join(root, 'evidence');
  await io.ensureOwnedDirectory(evidenceDir);
  const reportPath = path.win32.join(evidenceDir, 'acceptance.json');
  const report = {
    schemaVersion: 1,
    executionMode: io.testOnly ? 'injected-test-adapter' : 'github-hosted-installed',
    ...context,
    scenario,
    root,
    overallAcceptance: 'NOT-COVERED',
    startedAt: new Date().toISOString(),
    stages: Object.fromEntries(SCENARIOS.map((s) => [s, { status: 'NOT-COVERED' }])),
    limitations: [
      'Production live feed is not published/tested',
      'Standard-user UAC is not covered',
      'No successful model inference is tested',
    ],
  };
  let fault;
  await io.writeJson(reportPath, report);
  try {
    const manifestBytes = await io.readFile(path.win32.join(candidateDir, 'latest.yml'));
    const loadManifest = services.loadManifest ?? (async (text) => (await import('js-yaml')).load(text));
    const manifest = await loadManifest(manifestBytes.toString('utf8'));
    const installerPath = path.win32.join(candidateDir, 'OpenH3-3.0.1-win-x64.exe');
    const installerBytes = await io.readFile(installerPath);
    const provenance = JSON.parse(await io.readFile(path.win32.join(candidateDir, 'provenance.json'), 'utf8'));
    report.candidate = verifyBundle({
      context,
      provenance,
      manifest,
      manifestBytes,
      installerBytes,
      packageBytes: source.packageBytes,
      lockBytes: source.lockBytes,
    });
    assert.deepEqual(
      await io.inspectSignature(installerPath),
      provenance.signature,
      'Downloaded artifact signature measurement differs from provenance'
    );
    await io.assertFreshProductProfile();
    report.cdnGuard = await io.enableCdnIsolation();
    assert.equal(report.cdnGuard.enabled, true);
    report.limitations.push(
      'Hosts deny prevents legacy CDN connection; complete attempted-request monitoring is NOT-COVERED'
    );
    if (scenario !== 'manual-migration') {
      report.stages[scenario] = await (services.updaterRunner ?? runUpdaterScenario)(
        {
          scenario,
          root,
          evidenceDir,
          installerPath,
          installerBytes,
          manifestBytes,
          context,
          repoRoot: source.repoRoot,
        },
        io,
        { ...services, resourceAudit: services.resourceAudit ?? auditResources }
      );
    } else {
      const official = await (services.officialProvider ?? obtainOfficial)({
        io,
        directory: path.win32.join(root, 'official'),
        token: services.githubToken,
      });
      assert.equal(official.verified, true);
      assert.deepEqual(official.identity, { ...OFFICIAL });
      report.official = official.identity;
      const installDir = path.win32.join(root, 'app');
      const cwd = path.win32.join(root, 'control');
      const workspaceDir = path.win32.join(root, 'user-workspace');
      const modelsDir = path.win32.join(root, 'user-models');
      for (const dir of [cwd, workspaceDir, modelsDir]) await io.ensureOwnedDirectory(dir);
      const marker = `upgrade-${context.runId}-${context.runAttempt}-中文持久化`;
      const workspaceFile = path.win32.join(workspaceDir, 'upgrade-user-file.txt');
      const modelFile = path.win32.join(modelsDir, 'user-owned-NOT-A-VALID-MODEL.marker');
      await io.writeFile(workspaceFile, Buffer.from(`User workspace marker ${marker}\n`));
      await io.writeFile(modelFile, Buffer.from(`Acceptance sentinel, NOT valid model weights. ${marker}\n`));
      const fileSnapshot = async (file) => {
        const bytes = await io.readFile(file);
        return { path: file, size: bytes.length, sha256: digest(bytes) };
      };
      const beforeWorkspace = await fileSnapshot(workspaceFile);
      const beforeModel = await fileSnapshot(modelFile);
      const install = async (file, version) => {
        const session = randomBytes(6).toString('hex');
        const result = await io.install({
          installerPath: file,
          installDir,
          logPath: path.win32.join(evidenceDir, `installer-${version}.jsonl`),
          session,
          version,
        });
        assert.equal(result.exitCode, 0);
        assertInstallerSuccess(result.events, { session, version, updated: false, installDir });
        return { session, ...result };
      };
      const oldInstall = await install(official.path, '3.0.0');
      const old = await io.launchInstalled({
        executablePath: path.win32.join(installDir, 'OpenH3.exe'),
        mode: 'official-old',
        cwd,
      });
      assertInstalled(old, installDir, '3.0.0');
      const audit = services.resourceAudit ?? auditResources;
      const oldResources = await audit(old.identity, source.repoRoot);
      const baseline = await seedInstalledProfile({ request: old.request, marker, workspaceDir });
      await io.writeJson(path.win32.join(evidenceDir, 'baseline.json'), {
        identity: old.identity,
        systemInfo: old.systemInfo,
        backendDataDir: old.backendDataDir,
        baseline,
        workspace: beforeWorkspace,
        userModel: beforeModel,
        resources: oldResources,
      });
      const oldExit = await old.quitNormally();
      assert.equal(oldExit.normalExit, true, 'Old app/backend did not exit normally');
      const oldDbPath = path.win32.join(old.backendDataDir, 'aionui-backend.db');
      const oldDb = await io.sqliteQuickCheck(oldDbPath);
      assert.equal(oldDb.quick_check, 'ok');
      const newInstall = await install(installerPath, '3.0.1');
      const next = await io.launchInstalled({
        executablePath: path.win32.join(installDir, 'OpenH3.exe'),
        mode: 'candidate-manual',
        cwd,
      });
      assertInstalled(next, installDir, '3.0.1');
      assert.ok(samePath(next.identity.userData, old.identity.userData), 'Upgrade changed actual userData');
      assert.ok(samePath(next.backendDataDir, old.backendDataDir), 'Upgrade changed actual backend data directory');
      const newResources = await audit(next.identity, source.repoRoot);
      const persisted = await verifyInstalledProfile({ request: next.request, baseline });
      const newExit = await next.quitNormally();
      assert.equal(newExit.normalExit, true, 'Candidate app/backend did not exit normally');
      const newDb = await io.sqliteQuickCheck(path.win32.join(next.backendDataDir, 'aionui-backend.db'));
      assert.equal(newDb.quick_check, 'ok');
      const afterWorkspace = await fileSnapshot(workspaceFile);
      const afterModel = await fileSnapshot(modelFile);
      assert.deepEqual(afterWorkspace, beforeWorkspace, 'User workspace file changed');
      assert.deepEqual(afterModel, beforeModel, 'User-owned model directory/file sentinel changed');
      report.stages[scenario] = {
        status: 'PASS',
        claim:
          'Official v3.0.0 -> genuine candidate 3.0.1 by one manual installer overwrite, not old updater automation',
        oldInstall,
        newInstall,
        oldIdentity: old.identity,
        newIdentity: next.identity,
        oldExit,
        newExit,
        oldDb,
        newDb,
        userData: next.identity.userData,
        backendDataDir: next.backendDataDir,
        baseline,
        persisted,
        oldResources,
        newResources,
        workspace: { before: beforeWorkspace, after: afterWorkspace },
        userModels: {
          directory: modelsDir,
          before: beforeModel,
          after: afterModel,
          validModelOrInferenceTested: false,
        },
      };
    }
  } catch (error) {
    fault = error;
    report.stages[scenario] = { status: error.code === 'NOT_COVERED' ? 'NOT-COVERED' : 'FAIL', error: error.message };
  } finally {
    let cleanupError;
    try {
      report.cleanup = await io.cleanup();
      assert.ok(Array.isArray(report.cleanup), 'Owned cleanup must report actual forced terminations');
      if (!fault && report.cleanup.length)
        cleanupError = Error('Successful acceptance required forced owned-process cleanup instead of a normal exit');
    } catch (error) {
      cleanupError = error;
    }
    if (cleanupError) {
      fault = cleanupError;
      report.stages[scenario] = { status: 'FAIL', error: cleanupError.message, phase: 'owned-cleanup' };
    }
    report.finishedAt = new Date().toISOString();
    await io.writeJson(reportPath, report);
  }
  if (fault) throw fault;
  return report;
}

export async function main(options = {}) {
  const env = options.env ?? process.env;
  assertHostedRunner(env, options.platform ?? process.platform, options.arch ?? process.arch);
  const { values } = parseArgs({
    args: options.argv ?? process.argv.slice(2),
    options: { scenario: { type: 'string' }, 'source-sha': { type: 'string' } },
    strict: true,
  });
  const context = {
    repository: env.GITHUB_REPOSITORY,
    sourceSha: values['source-sha'],
    runId: env.GITHUB_RUN_ID,
    runAttempt: env.GITHUB_RUN_ATTEMPT,
  };
  assertContext(context);
  assert.ok(SCENARIOS.includes(values.scenario), 'An explicit known --scenario is required');
  assert.equal(context.sourceSha, env.GITHUB_SHA, 'Acceptance must use the exact workflow dispatch SHA');
  const source = await (options.readSource ?? readSource)(process.cwd(), context.sourceSha);
  const io = await (
    options.createAdapter ?? (async () => (await import('./windows-os.mjs')).createWindowsAdapter(env))
  )();
  if (!options.createAdapter) assert.notEqual(io.testOnly, true, 'Production CLI refuses test adapters');
  const root = scenarioRoot(env, values.scenario);
  return runAcceptance(
    { root, candidateDir: path.win32.join(root, 'candidate'), context, source, scenario: values.scenario },
    io,
    { ...options.services, githubToken: env.GITHUB_TOKEN }
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().then(
    (report) => {
      process.stdout.write(
        `${JSON.stringify({ scenario: report.scenario, status: report.stages[report.scenario].status, overallAcceptance: report.overallAcceptance })}\n`
      );
    },
    (error) => {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
    }
  );
}
