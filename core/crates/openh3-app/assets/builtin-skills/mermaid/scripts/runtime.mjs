import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const VERSION = '1.1.3';
const DEPENDENCIES = { 'beautiful-mermaid': VERSION, elkjs: '0.11.0', entities: '7.0.1' };

function runtimeDirectory() {
  const base = process.platform === 'win32'
    ? process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local')
    : process.env.XDG_CACHE_HOME || join(homedir(), '.cache');
  return resolve(base, 'OpenH3', 'mermaid', `beautiful-mermaid-${VERSION}`);
}

function npmCli() {
  const candidates = [
    process.env.npm_execpath,
    join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    resolve(dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js'),
  ];
  for (const directory of (process.env.PATH || '').split(delimiter)) {
    for (const name of ['npm', 'npm.cmd']) {
      const command = join(directory, name);
      if (existsSync(command)) candidates.push(realpathSync(command));
    }
    candidates.push(join(directory, 'node_modules', 'npm', 'bin', 'npm-cli.js'));
  }
  const found = candidates.find(file => file && file.endsWith('npm-cli.js') && existsSync(file));
  if (!found) throw new Error('npm CLI not found. Use a Node.js installation with npm available.');
  return found;
}

function installedEntry(runtime) {
  const packageRoot = join(runtime, 'node_modules', 'beautiful-mermaid');
  const metadata = join(packageRoot, 'package.json');
  if (!existsSync(metadata)) return undefined;
  const pkg = JSON.parse(readFileSync(metadata, 'utf8'));
  // This entry is the import export published by beautiful-mermaid 1.1.3.
  const entry = join(packageRoot, 'dist', 'index.js');
  return pkg.version === VERSION && existsSync(entry) ? entry : undefined;
}

export async function loadMermaid() {
  const runtime = runtimeDirectory();
  let entry = installedEntry(runtime);
  if (!entry) {
    const npm = npmCli();
    mkdirSync(runtime, { recursive: true });
    writeFileSync(join(runtime, 'package.json'), JSON.stringify({
      name: 'openh3-mermaid-runtime', private: true, dependencies: DEPENDENCIES,
    }, null, 2) + '\n', 'utf8');
    console.error(`Installing beautiful-mermaid ${VERSION} in ${runtime}`);
    // Run npm's JS entry with the current Node executable: no shell quoting,
    // .cmd execution, user-project mutation, or npm lifecycle scripts.
    const result = spawnSync(process.execPath, [npm, 'install', '--prefix', runtime,
      '--cache', join(runtime, 'npm-cache'), '--ignore-scripts', '--no-audit',
      '--no-fund', '--loglevel=error'], {
      cwd: runtime, stdio: ['ignore', 2, 2], windowsHide: true,
    });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`Dependency install failed (exit ${result.status ?? result.signal}).`);
    entry = installedEntry(runtime);
    if (!entry) throw new Error(`Dependency install did not provide beautiful-mermaid ${VERSION}.`);
  }
  return import(pathToFileURL(entry).href);
}
