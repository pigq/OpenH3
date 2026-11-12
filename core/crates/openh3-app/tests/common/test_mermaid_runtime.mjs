import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const scripts = path.join(app, 'assets/builtin-skills/mermaid/scripts');
const renderer = path.join(scripts, 'render.mjs');

function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'mermaid 中文 paths '));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cwd = path.join(root, '用户 workspace');
  const bin = path.join(root, 'fake bin');
  const cache = path.join(root, '独立 cache');
  for (const dir of [cwd, bin, cache]) mkdirSync(dir);
  writeFileSync(path.join(cwd, 'package.json'), '{"name":"untouched-user-project"}\n');
  const npmCli = path.join(bin, 'npm-cli.js');
  writeFileSync(npmCli, `
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
if (process.env.MERMAID_TEST_INSTALL_FAIL === '1') process.exit(37);
const prefixIndex = args.indexOf('--prefix');
const target = prefixIndex < 0 ? process.cwd() : args[prefixIndex + 1];
fs.writeFileSync(path.join(target, 'installer-cwd.txt'), process.cwd());
const dir = path.join(target, 'node_modules', 'beautiful-mermaid');
fs.mkdirSync(path.join(dir, 'dist'), {recursive:true});
fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({name:'beautiful-mermaid',version:'1.1.3',type:'module',exports:{'.':{import:'./dist/index.js'}}}));
fs.writeFileSync(path.join(dir, 'dist/index.js'), \`export const THEMES = {'github-dark':{bg:'#000'}}; export function renderMermaid(code) { if(code.includes('BAD_GRAPH')) throw Error('Invalid diagram fixture'); return '<svg>' + code + '</svg>'; } export const renderMermaidAscii = code => 'ASCII:' + code;\`);
`);
  if (process.platform === 'win32') {
    writeFileSync(path.join(bin, 'npm.cmd'), `@echo off\r\n"${process.execPath}" "${npmCli}" %*\r\n`);
  } else {
    writeFileSync(path.join(bin, 'npm'), `#!/bin/sh\nexec '${process.execPath}' '${npmCli}' "$@"\n`, { mode: 0o755 });
  }
  const env = { ...process.env, LOCALAPPDATA: cache, XDG_CACHE_HOME: cache, npm_execpath: npmCli };
  const pathKey = Object.keys(env).find(key => key.toLowerCase() === 'path') ?? 'PATH';
  env[pathKey] = bin + path.delimiter + env[pathKey];
  return { root, cwd, cache, env };
}

function run(f, input, args = [], additions = {}) {
  return spawnSync(process.execPath, [renderer, '--stdin', ...args], {
    cwd: f.cwd, input, encoding: 'utf8', env: { ...f.env, ...additions }, timeout: 30_000,
  });
}

test('installs and resolves from the same isolated cache from a Unicode/space cwd', t => {
  const f = fixture(t);
  const result = run(f, 'graph LR\nA[中文]-->B[完成]', ['--output', 'result.svg']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(readFileSync(path.join(f.cwd, 'result.svg'), 'utf8'), /^<svg>.*中文/s);
  assert.deepEqual(readdirSync(f.cwd).sort(), ['package.json', 'result.svg']);
  assert.equal(readFileSync(path.join(f.cwd, 'package.json'), 'utf8'), '{"name":"untouched-user-project"}\n');
  const secondCwd = path.join(f.root, 'another 项目 directory');
  mkdirSync(secondCwd);
  const reuse = run({ ...f, cwd: secondCwd }, 'graph LR\nA-->B', ['--ascii'], { MERMAID_TEST_INSTALL_FAIL: '1' });
  assert.equal(reuse.status, 0, reuse.stderr);
  assert.match(reuse.stdout, /^ASCII:/);
  assert.deepEqual(readdirSync(secondCwd), []);
});

test('an install failure exits nonzero without claiming or writing success', t => {
  const f = fixture(t);
  const result = run(f, 'graph LR\nA-->B', ['--output', 'failed.svg'], { MERMAID_TEST_INSTALL_FAIL: '1' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /37|install.*fail/i);
  assert.doesNotMatch(result.stderr, /Written to:/);
  assert.equal(existsSync(path.join(f.cwd, 'failed.svg')), false);
  assert.deepEqual(readdirSync(f.cwd), ['package.json']);
});

test('render failure exits nonzero and leaves an existing output untouched', t => {
  const f = fixture(t);
  writeFileSync(path.join(f.cwd, 'result.svg'), 'previous output');
  const result = run(f, 'BAD_GRAPH', ['--output', 'result.svg']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Invalid diagram fixture/);
  assert.doesNotMatch(result.stderr, /Written to:/);
  assert.equal(readFileSync(path.join(f.cwd, 'result.svg'), 'utf8'), 'previous output');
  assert.deepEqual(readdirSync(f.cwd).sort(), ['package.json', 'result.svg']);
});
