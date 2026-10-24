import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(process.env.APIYI_SKILL_ROOT ?? 'resources/skills/apiyi-image-generation');
const key = 'test-only-apiyi-secret-never-log';
const model = 'apiyi-test-nondefault-model';
const credentialTool = path.resolve('tests/fixtures/apiyi-credential-tool.cjs');
const nativeBackend =
  process.platform === 'win32'
    ? 'windows-dpapi'
    : process.platform === 'darwin'
      ? 'macos-keychain'
      : process.platform === 'linux'
        ? 'linux-secret-tool'
        : 'file';
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN9sAAAAASUVORK5CYII=',
  'base64'
);
let temp: string;
let credentialEnv: NodeJS.ProcessEnv;
let server: Server;
let baseUrl: string;
let mode = 'base64';
const requests: Array<{ url: string; body: string; auth?: string }> = [];

type CommandResult = { code: number; stdout: string; stderr: string; diagnostic: string };

async function runNode(args: string[], env: NodeJS.ProcessEnv, cwd: string, input = '') {
  const started = Date.now();
  return new Promise<CommandResult>((resolve) => {
    const child = execFile(process.execPath, args, { cwd, env, timeout: 20000 }, (error, stdout, stderr) => {
      // Error.message/stack can contain argv. Report only non-secret process metadata.
      const diagnostic = JSON.stringify({
        errorCode: error?.code ?? null,
        killed: Boolean(error?.killed),
        signal: error?.signal ?? null,
        elapsedMs: Date.now() - started,
      });
      resolve({ code: error ? Number(error.code) || 1 : 0, stdout, stderr, diagnostic });
    });
    child.stdin?.end(input);
  });
}

async function run(args: string[], input?: object) {
  return runNode(
    [path.join(root, 'bin/install.js'), ...args],
    { ...credentialEnv, APIYI_IMAGE_CONFIG_DIR: path.join(temp, 'state'), USERPROFILE: temp, HOME: temp },
    temp,
    input ? JSON.stringify(input) : ''
  );
}

beforeAll(async () => {
  temp = await fs.mkdtemp(path.join(os.tmpdir(), 'apiyi-skill-'));
  if (process.platform !== 'win32') await fs.chmod(temp, 0o700);
  const credentials = path.join(temp, 'credential-fixture');
  await fs.mkdir(credentials, { mode: 0o700 });
  credentialEnv = {
    ...process.env,
    APIYI_TEST_CREDENTIAL_DIR: credentials,
    APIYI_TEST_NODE: process.execPath,
    APIYI_TEST_CREDENTIAL_FIXTURE: credentialTool,
  };
  // Only these CLI children see the replacements; Windows still uses real DPAPI.
  if (process.platform !== 'win32') {
    const bin = path.join(temp, 'bin');
    await fs.mkdir(bin, { mode: 0o700 });
    for (const tool of ['security', 'secret-tool']) {
      const wrapper = path.join(bin, tool);
      await fs.writeFile(
        wrapper,
        '#!/bin/sh\nexec "$APIYI_TEST_NODE" "$APIYI_TEST_CREDENTIAL_FIXTURE" ' + tool + ' "$@"\n',
        { mode: 0o700 }
      );
      await fs.chmod(wrapper, 0o700);
    }
    credentialEnv.PATH = bin + path.delimiter + (process.env.PATH ?? '');
  }
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      requests.push({ url: req.url ?? '', body: Buffer.concat(chunks).toString(), auth: req.headers.authorization });
      if (req.url === '/asset.png') {
        res.setHeader('Content-Type', 'image/png');
        res.end(png);
        return;
      }
      res.setHeader('Content-Type', 'application/json');
      if (mode === 'unauthorized') {
        res.statusCode = 401;
        res.end(JSON.stringify({ error: `bad key ${key}` }));
        return;
      }
      if (mode === 'empty') {
        res.end(JSON.stringify({ data: [] }));
        return;
      }
      if (mode === 'invalid') {
        res.end(JSON.stringify({ data: [{ b64_json: 'not-an-image' }] }));
        return;
      }
      res.end(
        JSON.stringify({
          data: [
            mode === 'url' ? { url: `${baseUrl.replace('/v1', '')}/asset.png` } : { b64_json: png.toString('base64') },
          ],
        })
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('Missing test port');
  baseUrl = `http://127.0.0.1:${addr.port}/v1`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await fs.rm(temp, { recursive: true, force: true });
});

describe.sequential('OpenH3 APIYi Skill runtime', () => {
  it('accepts stdin credentials and persists a model without echoing the key', async () => {
    const r = await run(['configure', '--stdin-json'], { baseUrl, apiKey: key, model });
    expect(r.code, r.diagnostic).toBe(0);
    expect(r.stdout + r.stderr).not.toContain(key);
    const doctor = await run(['doctor']);
    expect(doctor.code, doctor.diagnostic).toBe(0);
    expect(doctor.stdout + doctor.stderr).not.toContain(key);
    const state = JSON.parse(doctor.stdout);
    expect(state.configured).toBe(true);
    expect(state.model).toBe(model);
    expect(state.secretBackend).toBe(nativeBackend);
  });
  it('never prints secrets in doctor or env and isolates legacy api2img state', async () => {
    for (const command of ['doctor', 'env']) {
      const r = await run([command]);
      expect(r.code, r.diagnostic).toBe(0);
      expect(r.stdout + r.stderr).not.toContain(key);
      expect(JSON.parse(r.stdout).secretBackend).toBe(nativeBackend);
    }
    expect(await fs.readFile(path.join(temp, 'state/config.json'), 'utf8')).not.toContain(key);
    await expect(fs.access(path.join(temp, '.api2img'))).rejects.toThrow();
    if (process.platform === 'win32') {
      const secret = await fs.readFile(path.join(temp, 'state/secret.json'), 'utf8');
      expect(secret).not.toContain(key);
      expect(JSON.parse(secret).backend).toBe('windows-dpapi');
    } else if (process.platform === 'darwin' || process.platform === 'linux') {
      await expect(fs.access(path.join(temp, 'state/secret.json'))).rejects.toThrow();
      const trace = await fs.readFile(path.join(temp, 'credential-fixture/operations.jsonl'), 'utf8');
      expect(trace).not.toContain(key);
      const operations = trace
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      const tool = process.platform === 'darwin' ? 'security' : 'secret-tool';
      const expected =
        process.platform === 'darwin' ? ['add-generic-password', 'find-generic-password'] : ['store', 'lookup'];
      for (const operation of expected) expect(operations).toContainEqual({ tool, operation });
      for (const operation of operations) expect(Object.keys(operation).sort()).toEqual(['operation', 'tool']);
    }
  });
  it('dry-runs the saved model without network calls', async () => {
    const count = requests.length;
    const r = await run(['generate', '--prompt', 'orange cat', '--size', '768x1024', '--dry-run']);
    expect(r.code, r.diagnostic).toBe(0);
    expect(JSON.parse(r.stdout).model).toBe(model);
    expect(requests).toHaveLength(count);
  });
  it('generates base64 output through Images API and refuses overwrite before billing', async () => {
    mode = 'base64';
    const args = ['generate', '--prompt', 'orange cat', '--out', 'cat.png'];
    const r = await run(args);
    expect(r.code, r.diagnostic).toBe(0);
    expect(await fs.readFile(path.join(temp, 'cat.png'))).toEqual(png);
    expect(requests.at(-1)?.url).toBe('/v1/images/generations');
    expect(requests.at(-1)?.auth).toBe(`Bearer ${key}`);
    const count = requests.length;
    expect((await run(args)).code).not.toBe(0);
    expect(requests).toHaveLength(count);
  });
  it('downloads URL outputs without forwarding provider credentials', async () => {
    mode = 'url';
    const r = await run(['generate', '--prompt', 'cat', '--out', 'url.png']);
    expect(r.code, r.diagnostic).toBe(0);
    expect(await fs.readFile(path.join(temp, 'url.png'))).toEqual(png);
    expect(requests.at(-1)?.auth).toBeUndefined();
  });
  it('sends multipart image edits', async () => {
    mode = 'base64';
    await fs.writeFile(path.join(temp, 'input.png'), png);
    const r = await run(['edit', '--image', 'input.png', '--prompt', 'blue background', '--out', 'edit.png']);
    expect(r.code, r.diagnostic).toBe(0);
    expect(requests.at(-1)?.url).toBe('/v1/images/edits');
    expect(requests.at(-1)?.body).toContain('filename="input.png"');
  });
  it('fails on empty or invalid images instead of reporting success', async () => {
    for (const [value, message] of [
      ['empty', 'Unexpected image count in API response.'],
      ['invalid', 'Invalid base64 image.'],
    ]) {
      mode = value;
      const count = requests.length;
      const r = await run(['generate', '--prompt', 'cat', '--out', value + '.png']);
      expect(r.code, r.diagnostic).not.toBe(0);
      expect(requests).toHaveLength(count + 1);
      expect(requests.at(-1)?.url).toBe('/v1/images/generations');
      expect(r.stderr).toContain(message);
      expect(r.stdout + r.stderr).not.toContain(key);
      await expect(fs.access(path.join(temp, value + '.png'))).rejects.toThrow();
    }
  });
  it('reports HTTP failure without key disclosure or automatic retries', async () => {
    mode = 'unauthorized';
    const count = requests.length;
    const r = await run(['generate', '--prompt', 'cat', '--out', 'failure.png']);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain('401');
    expect(r.stdout + r.stderr).not.toContain(key);
    expect(requests).toHaveLength(count + 1);
  });
});

// Invoke the Node fixture directly on every OS, including Windows where runtime
// credential coverage deliberately continues to exercise actual DPAPI.
describe('APIYi credential command fixture', () => {
  it.each(['security', 'secret-tool'] as const)('isolates and validates the %s protocol', async (tool) => {
    const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'apiyi-tool-'));
    const credentials = path.join(sandbox, 'credentials');
    await fs.mkdir(credentials, { mode: 0o700 });
    const env = { ...process.env, APIYI_TEST_CREDENTIAL_DIR: credentials };
    const call = (args: string[], input = '') => runNode([credentialTool, tool, ...args], env, sandbox, input);
    const service = 'openh3-apiyi-image-generation';
    const help = tool === 'security' ? ['-h'] : ['--help'];
    const get =
      tool === 'security'
        ? ['find-generic-password', '-a', 'default', '-s', service, '-w']
        : ['lookup', 'service', service, 'account', 'default'];
    const set =
      tool === 'security'
        ? ['add-generic-password', '-a', 'default', '-s', service, '-w', key, '-U']
        : ['store', '--label', service, 'service', service, 'account', 'default'];
    const clear =
      tool === 'security'
        ? ['delete-generic-password', '-a', 'default', '-s', service]
        : ['clear', 'service', service, 'account', 'default'];
    try {
      const helpResult = await call(help);
      expect(helpResult.code, helpResult.diagnostic).toBe(0);
      expect(helpResult.stdout + helpResult.stderr).not.toContain(key);
      expect((await call(get)).code).not.toBe(0);
      const saved = await call(set, tool === 'secret-tool' ? key : '');
      expect(saved.code, saved.diagnostic).toBe(0);
      expect(saved.stdout + saved.stderr).not.toContain(key);
      const loaded = await call(get);
      expect(loaded.code, loaded.diagnostic).toBe(0);
      expect(loaded.stdout).toBe(key + '\n');
      expect(loaded.stderr).toBe('');
      const tracePath = path.join(credentials, 'operations.jsonl');
      const trace = await fs.readFile(tracePath, 'utf8');
      const operations = trace
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      expect(operations).toEqual([help, get, set, get].map(([operation]) => ({ tool, operation })));
      expect(trace).not.toContain(key);
      for (const args of [
        [],
        ['unsupported', key],
        [...set, '--unexpected', key],
        get.map((argument) => (argument === service ? 'wrong-service' : argument)),
      ]) {
        const rejected = await call(args, key);
        expect(rejected.code, rejected.diagnostic).toBe(64);
        expect(rejected.stdout + rejected.stderr).not.toContain(key);
      }
      const invalidStore = tool === 'security' ? set.map((argument, index) => (index === 6 ? '' : argument)) : set;
      const emptyKey = await call(invalidStore);
      expect(emptyKey.code, emptyKey.diagnostic).toBe(64);
      expect(emptyKey.stdout + emptyKey.stderr).not.toContain(key);
      for (const invocation of [['unsupported-tool', key], []]) {
        const rejected = await runNode([credentialTool, ...invocation], env, sandbox, key);
        expect(rejected.code, rejected.diagnostic).toBe(64);
        expect(rejected.stdout + rejected.stderr).not.toContain(key);
      }
      for (const directory of ['', '.', os.tmpdir(), path.parse(os.tmpdir()).root]) {
        const rejected = await runNode(
          [credentialTool, tool, ...get],
          { ...env, APIYI_TEST_CREDENTIAL_DIR: directory },
          sandbox
        );
        expect(rejected.code, rejected.diagnostic).toBe(64);
        expect(rejected.stdout + rejected.stderr).not.toContain(key);
      }
      expect(await fs.readFile(tracePath, 'utf8')).toBe(trace);
      expect((await call(get)).stdout).toBe(key + '\n');
      if (process.platform !== 'win32') {
        expect((await fs.stat(credentials)).mode & 0o777).toBe(0o700);
        expect((await fs.stat(path.join(credentials, tool + '.json'))).mode & 0o777).toBe(0o600);
        expect((await fs.stat(tracePath)).mode & 0o777).toBe(0o600);
      }
      const cleared = await call(clear);
      expect(cleared.code, cleared.diagnostic).toBe(0);
      expect(cleared.stdout + cleared.stderr).not.toContain(key);
      expect((await call(get)).code).not.toBe(0);
    } finally {
      await fs.rm(sandbox, { recursive: true, force: true });
    }
  });
});
