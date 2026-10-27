import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { main, runAcceptance, scenarioRoot, readSource } from './installed-upgrade.mjs';
import { createProvenance } from './artifacts.mjs';
import { OFFICIAL } from '../windows-upgrade-contract.mjs';
import * as installed from './installed-upgrade.mjs';

const env = {
  GITHUB_ACTIONS: 'true',
  RUNNER_ENVIRONMENT: 'github-hosted',
  RUNNER_OS: 'Windows',
  RUNNER_TEMP: 'D:\\runner\\temp',
  GITHUB_REPOSITORY: 'pigq/OpenH3',
  GITHUB_RUN_ID: '123',
  GITHUB_RUN_ATTEMPT: '1',
};
const context = { repository: env.GITHUB_REPOSITORY, sourceSha: 'a'.repeat(40), runId: '123', runAttempt: '1' };
const source = {
  sha: context.sourceSha,
  repoRoot: 'D:\\runner\\repo',
  packageBytes: Buffer.from('{"version":"3.0.1"}'),
  lockBytes: Buffer.from('fixed lock'),
};

function contentFixture() {
  const resourcesPath = 'D:\\runner\\app\\resources';
  const directory = path.win32.join(resourcesPath, 'content-catalog');
  const families = [
    'h3',
    'fasth3-omni',
    'qwen-edit',
    'z-image',
    'flux-3-image-klein',
    'moss-image-base',
    'moss-image-sft',
    'krea2',
  ].map((family) => ({ family, name: family, kind: family.includes('h3') ? 'video' : 'image' }));
  const templates = Array.from({ length: 52 }, (_, index) => ({
    key: `template-${index}`,
    kind: index === 51 ? 'video' : 'image',
    ratio: '16:9',
    ...(index === 51 ? { duration: 6 } : {}),
  }));
  const image = Buffer.from('real installed fixture cover bytes');
  const video = Buffer.from('real installed fixture video bytes');
  const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
  const assets = [image, video].map((bytes, index) => ({
    sha256: hash(bytes),
    path: `assets/${hash(bytes)}`,
    sizeBytes: bytes.length,
    mimeType: index ? 'video/mp4' : 'image/webp',
  }));
  const catalog = {
    schemaVersion: 1,
    releaseSequence: 0,
    models: families.map((family) => ({
      ...family,
      id: `official:model-${family.family}`,
      cover: assets[0].sha256,
      requiredCapabilities: [`comfy.${family.family}`],
    })),
    entries: templates.map((template) => ({
      ...template,
      id: `official:${template.key}`,
      entryType: 'template',
      cover: assets[0].sha256,
      requiresReference: false,
      requiredCapabilities: [`template.${template.kind}`],
      ...(template.kind === 'video' ? { media: assets[1].sha256 } : {}),
    })),
    assets,
  };
  const keyring = Buffer.from('{"public-key":"public fixture only"}');
  const files = new Map([
    [path.win32.join(directory, 'catalog.json'), Buffer.from(JSON.stringify(catalog))],
    [path.win32.join(directory, 'trusted-keys.json'), keyring],
    [path.win32.join(source.repoRoot, 'resources', 'content-catalog', 'trusted-keys.json'), keyring],
    ...assets.map((asset, index) => [path.win32.join(directory, ...asset.path.split('/')), [image, video][index]]),
  ]);
  const reads = [];
  let parsed = 0;
  const deps = {
    fsOps: {
      async readFile(file) {
        reads.push(file);
        if (!files.has(file)) throw Object.assign(Error('missing installed content: ' + file), { code: 'ENOENT' });
        return files.get(file);
      },
      async lstat(file) {
        return { isSymbolicLink: () => false, isFile: () => files.has(file), isDirectory: () => !files.has(file) };
      },
      async realpath(file) {
        return file;
      },
    },
    async loadContentContract() {
      return {
        families,
        templates,
        parseCatalog(value) {
          parsed++;
          assert.equal(value.schemaVersion, 1, 'reviewed schema rejected invalid catalog');
          return value;
        },
      };
    },
  };
  const save = () => files.set(path.win32.join(directory, 'catalog.json'), Buffer.from(JSON.stringify(catalog)));
  return {
    resourcesPath,
    directory,
    families,
    templates,
    catalog,
    files,
    reads,
    deps,
    save,
    get parsed() {
      return parsed;
    },
  };
}

test('candidate content audit reads installed 8-family/52-template catalog and every referenced asset without exporting', async () => {
  assert.equal(typeof installed.auditInstalledContent, 'function');
  const f = contentFixture();
  const result = await installed.auditInstalledContent(f.resourcesPath, source.repoRoot, f.deps);
  assert.equal(f.parsed, 1, 'Must use the reviewed source schema');
  assert.equal(result.families.length, 8);
  assert.equal(result.templateIds.length, 52);
  assert.deepEqual(
    result.assets.map((asset) => asset.sha256).sort(),
    f.catalog.assets.map((asset) => asset.sha256).sort()
  );
  for (const asset of f.catalog.assets)
    assert.ok(f.reads.includes(path.win32.join(f.directory, ...asset.path.split('/'))));
  assert.match(result.catalog.sha256, /^[a-f0-9]{64}$/);
  assert.match(result.keyring.sha256, /^[a-f0-9]{64}$/);
});

test('installed content audit rejects incomplete reviewed source and changed family/template IDs even with unchanged counts', async () => {
  assert.equal(typeof installed.auditInstalledContent, 'function');
  for (const mutate of [
    (f) => f.families.pop(),
    (f) => f.templates.pop(),
    (f) => {
      f.catalog.models[0].family = 'wrong-family';
    },
    (f) => {
      f.catalog.entries[0].id = 'official:wrong-template';
    },
    (f) => {
      f.catalog.entries[0].id = f.catalog.entries[1].id;
    },
    (f) => {
      f.catalog.schemaVersion = 99;
    },
  ]) {
    const f = contentFixture();
    mutate(f);
    f.save();
    await assert.rejects(installed.auditInstalledContent(f.resourcesPath, source.repoRoot, f.deps));
  }
});

test('installed content audit rejects missing/corrupt assets, changed keyring and redirected installed files', async () => {
  assert.equal(typeof installed.auditInstalledContent, 'function');
  for (const mutate of [
    (f) => f.files.delete(path.win32.join(f.directory, ...f.catalog.assets[1].path.split('/'))),
    (f) => f.files.set(path.win32.join(f.directory, ...f.catalog.assets[1].path.split('/')), Buffer.from('corrupt')),
    (f) =>
      f.files.set(
        path.win32.join(f.directory, ...f.catalog.assets[1].path.split('/')),
        Buffer.alloc(f.catalog.assets[1].sizeBytes, 0)
      ),
    (f) => {
      f.catalog.assets[0].sizeBytes++;
      f.save();
    },
    (f) => f.files.set(path.win32.join(f.directory, 'trusted-keys.json'), Buffer.from('{}')),
    (f) => {
      f.deps.fsOps.realpath = async (file) => (file.endsWith('catalog.json') ? 'D:\\elsewhere\\catalog.json' : file);
    },
    (f) => {
      f.deps.fsOps.lstat = async () => ({ isFile: () => true, isDirectory: () => true, isSymbolicLink: () => true });
    },
  ]) {
    const f = contentFixture();
    mutate(f);
    await assert.rejects(installed.auditInstalledContent(f.resourcesPath, source.repoRoot, f.deps));
  }
});

test('resource audit requires installed content only for the candidate, preserving genuine legacy compatibility', async () => {
  assert.equal(typeof installed.auditResources, 'function');
  const f = contentFixture();
  const feedPath = path.win32.join(f.resourcesPath, 'app-update.yml');
  f.files.set(feedPath, Buffer.from('{"provider":"github","owner":"pigq","repo":"OpenH3"}'));
  f.deps.fsOps.stat = async () => ({ isFile: () => true, size: 100 });
  f.deps.verifyCore = () => ({ missing: [], failures: [] });
  f.deps.loadManifest = JSON.parse;
  const identity = { resourcesPath: f.resourcesPath, platform: 'win32', arch: 'x64' };
  const legacy = await installed.auditResources({ ...identity, version: '3.0.0' }, source.repoRoot, f.deps);
  assert.equal(legacy.content, undefined);
  assert.equal(f.parsed, 0);
  const candidate = await installed.auditResources({ ...identity, version: '3.0.1' }, source.repoRoot, f.deps);
  assert.equal(candidate.content.templateIds.length, 52);
  assert.equal(candidate.content.families.length, 8);
});

test('reviewed content contract loader bundles only schema and source lists in memory for Node 22', async () => {
  assert.equal(typeof installed.loadReviewedContentContract, 'function');
  let options;
  const contract = await installed.loadReviewedContentContract(source.repoRoot, {
    build: async (value) => {
      options = value;
      return {
        outputFiles: [
          { text: 'export const parseCatalog = (x) => x; export const families = []; export const templates = [];' },
        ],
      };
    },
  });
  assert.equal(typeof contract.parseCatalog, 'function');
  assert.equal(options.write, false);
  assert.equal(options.target, 'node22');
  assert.equal(options.format, 'esm');
  assert.match(options.stdin.contents, /contentCatalog\/schema\.ts/);
  assert.match(options.stdin.contents, /comfyDraft\.ts/);
  assert.match(options.stdin.contents, /creationTemplates\.ts/);
  assert.doesNotMatch(options.stdin.contents, /export-builtin|createContentRuntime/);
});

test('source inspection rejects dirty tracked files even when HEAD equals reviewed SHA', async () => {
  let read = false;
  await assert.rejects(
    readSource(source.repoRoot, source.sha, {
      git: async (_cmd, args) => ({
        stdout: args[0] === 'rev-parse' ? source.sha : ' M packages/desktop/src/index.ts\n',
      }),
      readFile: async () => {
        read = true;
        return Buffer.alloc(0);
      },
    }),
    /dirty tracked/
  );
  assert.equal(read, false);
});

function fake({
  scenario = 'manual-migration',
  failQuit = false,
  reparse = false,
  changeModels = false,
  badQuickCheck = false,
  wrongNewVersion = false,
} = {}) {
  const root = scenarioRoot(env, scenario);
  const candidateDir = path.win32.join(root, 'candidate');
  const bytes = Buffer.from('pure fake adapter candidate never executed');
  const sha512 = createHash('sha512').update(bytes).digest('base64');
  const manifest = {
    version: '3.0.1',
    path: 'OpenH3-3.0.1-win-x64.exe',
    sha512,
    files: [{ url: 'OpenH3-3.0.1-win-x64.exe', size: bytes.length, sha512 }],
  };
  const manifestBytes = Buffer.from(JSON.stringify(manifest));
  const signature = { status: 'NotSigned', subject: null, thumbprint: null };
  const provenance = createProvenance({
    context,
    manifest,
    manifestBytes,
    installerBytes: bytes,
    ...source,
    signature,
  });
  const files = new Map([
    [path.win32.join(candidateDir, manifest.path), bytes],
    [path.win32.join(candidateDir, 'latest.yml'), manifestBytes],
    [path.win32.join(candidateDir, 'provenance.json'), Buffer.from(JSON.stringify(provenance))],
  ]);
  const calls = [];
  const reports = [];
  let installedVersion;
  let settings;
  let conversation;
  let messages;
  const io = {
    testOnly: true,
    async ensureOwnedRoot(value) {
      calls.push(['physical-root', value]);
      if (reparse) throw Error('Reparse point ancestor rejected');
    },
    async ensureOwnedDirectory(value) {
      calls.push(['directory', value]);
    },
    async readFile(value, encoding) {
      if (!files.has(value)) throw Error('Fake file missing: ' + value);
      return encoding ? files.get(value).toString(encoding) : files.get(value);
    },
    async writeFile(value, bytes) {
      files.set(value, Buffer.from(bytes));
    },
    async writeJson(value, data) {
      reports.push(structuredClone(data));
      files.set(value, Buffer.from(JSON.stringify(data)));
    },
    async inspectSignature() {
      calls.push(['signature']);
      return signature;
    },
    async assertFreshProductProfile() {
      calls.push(['fresh-profile']);
    },
    async enableCdnIsolation() {
      calls.push(['cdn-deny']);
      return { enabled: true, addresses: ['0.0.0.0', '::'], attemptsMonitored: false };
    },
    async install(args) {
      calls.push(['install', args.version]);
      installedVersion = args.version;
      if (changeModels && args.version === '3.0.1')
        for (const key of files.keys())
          if (key.includes('user-models')) files.set(key, Buffer.from('unwanted overwrite'));
      return {
        exitCode: 0,
        events: [
          {
            event: 'session-end',
            message: 'event=session-end result=success',
            session: args.session,
            version: args.version,
            updated: false,
            instDir: args.installDir,
          },
        ],
      };
    },
    async launchInstalled({ executablePath, mode }) {
      calls.push(['launch', mode]);
      const version = wrongNewVersion && installedVersion === '3.0.1' ? '3.0.0' : installedVersion;
      const identity = {
        pid: mode === 'official-old' ? 100 : 200,
        executable: executablePath,
        packaged: true,
        version,
        platform: 'win32',
        arch: 'x64',
        userData: 'C:\\Users\\runner\\AppData\\Roaming\\OpenH3',
        appRoot: path.win32.join(path.win32.dirname(executablePath), 'resources', 'app.asar'),
        resourcesPath: path.win32.join(path.win32.dirname(executablePath), 'resources'),
      };
      const request = async (method, route, body) => {
        calls.push(['api', method, route]);
        if (route.startsWith('/api/settings/client')) {
          if (method === 'PUT') settings = body;
          return settings;
        }
        if (route === '/api/conversations') {
          conversation = {
            id: 'new-conversation',
            name: body.name,
            type: body.type,
            extra: body.extra,
            runtime: {
              state: 'idle',
              can_send_message: true,
              has_task: false,
              task_status: null,
              is_processing: false,
              pending_confirmations: 0,
              turn_id: null,
            },
          };
          return conversation;
        }
        if (method === 'POST' && route.endsWith('/messages')) {
          messages = {
            items: [
              {
                id: 'user-id',
                conversation_id: conversation.id,
                type: 'text',
                position: 'right',
                status: 'finish',
                created_at: 10,
                content: { content: body.content },
              },
              {
                id: 'tip-id',
                conversation_id: conversation.id,
                type: 'tips',
                position: 'center',
                status: 'error',
                created_at: 11,
                content: { source: 'send_failed' },
              },
            ],
          };
          return { msg_id: 'user-id', turn_id: 'turn-id' };
        }
        return route.includes('/messages?') ? messages : conversation;
      };
      return {
        identity,
        request,
        backendDataDir: identity.userData + '\\OpenH3',
        systemInfo: { platform: 'windows', arch: 'x86_64' },
        async quitNormally() {
          calls.push(['normal-quit', mode]);
          if (failQuit) throw Error('backend did not stop');
          return { normalExit: true };
        },
      };
    },
    async sqliteQuickCheck(file) {
      calls.push(['quick-check', file]);
      return { quick_check: badQuickCheck ? 'corrupt' : 'ok', path: file };
    },
    async cleanup() {
      calls.push(['cleanup']);
      return [];
    },
  };
  const services = {
    loadManifest: (text) => JSON.parse(text),
    officialProvider: async ({ directory }) => {
      calls.push(['official-hash-verified']);
      const file = path.win32.join(directory, OFFICIAL.name);
      files.set(file, Buffer.from('fake official bytes'));
      return { path: file, identity: { ...OFFICIAL }, verified: true };
    },
    resourceAudit: async () => ({ missing: [], failures: [], ffmpeg: ['actual-fake-paths'] }),
  };
  return { io, services, config: { scenario, root, candidateDir, context, source }, calls, files, reports };
}

test('entry rejects host before loading any OS adapter, Playwright or installer', async () => {
  let loaded = false;
  await assert.rejects(
    main({
      argv: [],
      env,
      platform: 'win32',
      arch: 'arm64',
      createAdapter: async () => {
        loaded = true;
      },
    }),
    /hosted Windows x64/
  );
  assert.equal(loaded, false);
});

test('Stage A closes true old -> real candidate manual migration, preserving actual profile/history and user-model sentinel', async () => {
  const f = fake();
  const report = await runAcceptance(f.config, f.io, f.services);
  assert.equal(report.stages['manual-migration'].status, 'PASS');
  assert.equal(report.stages['manual-migration'].oldExit.normalExit, true);
  assert.equal(report.stages['manual-migration'].newExit.normalExit, true);
  assert.equal(report.overallAcceptance, 'NOT-COVERED');
  assert.equal(report.executionMode, 'injected-test-adapter');
  assert.deepEqual(
    f.calls.filter((c) => c[0] === 'install').map((c) => c[1]),
    ['3.0.0', '3.0.1']
  );
  assert.ok(f.calls.findIndex((c) => c[0] === 'cdn-deny') < f.calls.findIndex((c) => c[0] === 'install'));
  assert.ok(
    f.calls.findIndex((c) => c[0] === 'normal-quit') < f.calls.findIndex((c) => c[0] === 'install' && c[1] === '3.0.1')
  );
  assert.equal(report.stages['manual-migration'].userModels.validModelOrInferenceTested, false);
  assert.equal(
    report.stages['manual-migration'].userModels.before.sha256,
    report.stages['manual-migration'].userModels.after.sha256
  );
});

test('physical reparse escape, non-normal quit, wrong version, corrupt DB and overwritten user models fail closed', async () => {
  for (const options of [
    { reparse: true },
    { failQuit: true },
    { wrongNewVersion: true },
    { badQuickCheck: true },
    { changeModels: true },
  ]) {
    const f = fake(options);
    await assert.rejects(runAcceptance(f.config, f.io, f.services));
    if (options.reparse)
      assert.equal(
        f.calls.some((c) => c[0] === 'install'),
        false
      );
    if (options.failQuit)
      assert.deepEqual(
        f.calls.filter((c) => c[0] === 'install').map((c) => c[1]),
        ['3.0.0']
      );
    if (!options.reparse) assert.equal(f.reports.at(-1).stages['manual-migration'].status, 'FAIL');
  }
});

test('updater adapter gaps remain NOT-COVERED and cannot make the workflow green', async () => {
  for (const scenario of ['cancel', 'disconnect', 'corrupt', 'downloaded-quit', 'install']) {
    const f = fake({ scenario });
    let ran = false;
    f.services.updaterRunner = async (config) => {
      ran = true;
      assert.equal(config.scenario, scenario);
      throw Object.assign(Error('NOT-COVERED: owned observer unavailable'), { code: 'NOT_COVERED' });
    };
    await assert.rejects(runAcceptance(f.config, f.io, f.services), /NOT-COVERED/);
    assert.equal(
      f.calls.some((c) => c[0] === 'install' || c[0] === 'launch'),
      false
    );
    assert.equal(ran, true);
    assert.equal(f.reports.at(-1).stages[scenario].status, 'NOT-COVERED');
  }
});

test('mutated candidate provenance is rejected before any installer and cleanup failure cannot be PASS', async () => {
  const f = fake();
  f.files.set(path.win32.join(f.config.candidateDir, 'provenance.json'), Buffer.from('{}'));
  await assert.rejects(runAcceptance(f.config, f.io, f.services));
  assert.equal(
    f.calls.some((c) => c[0] === 'install'),
    false
  );
  const g = fake();
  g.io.cleanup = async () => {
    throw Error('Cannot revalidate owned process');
  };
  await assert.rejects(runAcceptance(g.config, g.io, g.services), /Cannot revalidate/);
  assert.equal(g.reports.at(-1).stages['manual-migration'].status, 'FAIL');
  const b = fake({ scenario: 'cancel' });
  b.services.updaterRunner = async () => ({ status: 'PASS' });
  b.io.cleanup = async () => {
    throw Error('Updater cleanup failure');
  };
  await assert.rejects(runAcceptance(b.config, b.io, b.services), /Updater cleanup failure/);
  assert.equal(b.reports.at(-1).stages.cancel.status, 'FAIL');
  const forced = fake();
  forced.io.cleanup = async () => [{ pid: 45, executable: 'D:\\temp\\owned\\app\\OpenH3.exe' }];
  await assert.rejects(runAcceptance(forced.config, forced.io, forced.services), /cleanup|forced/i);
  assert.equal(forced.reports.at(-1).stages['manual-migration'].status, 'FAIL');
});
