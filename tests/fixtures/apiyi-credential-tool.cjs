// Test-only credential-command replacement. Never forwards to real OS tools.
// Plain fixture values are not an implementation or assertion of OS encryption.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SERVICE = 'openh3-apiyi-image-generation';
const ACCOUNT = 'default';
const same = (actual, expected) =>
  actual.length === expected.length && actual.every((value, index) => value === expected[index]);
const validKey = (value) => typeof value === 'string' && value.length > 0 && !/\s/.test(value) && !value.includes('\0');

function classify(tool, args) {
  if (tool === 'security') {
    if (same(args, ['-h'])) return { action: 'help', operation: '-h' };
    if (same(args, ['find-generic-password', '-a', ACCOUNT, '-s', SERVICE, '-w']))
      return { action: 'get', operation: 'find-generic-password' };
    if (same(args, ['delete-generic-password', '-a', ACCOUNT, '-s', SERVICE]))
      return { action: 'delete', operation: 'delete-generic-password' };
    if (same(args, ['add-generic-password', '-a', ACCOUNT, '-s', SERVICE, '-w', args[6], '-U']) && validKey(args[6]))
      return { action: 'set', operation: 'add-generic-password', value: args[6] };
  }
  if (tool === 'secret-tool') {
    if (same(args, ['--help'])) return { action: 'help', operation: '--help' };
    if (same(args, ['lookup', 'service', SERVICE, 'account', ACCOUNT])) return { action: 'get', operation: 'lookup' };
    if (same(args, ['clear', 'service', SERVICE, 'account', ACCOUNT])) return { action: 'delete', operation: 'clear' };
    if (same(args, ['store', '--label', SERVICE, 'service', SERVICE, 'account', ACCOUNT])) {
      const value = fs.readFileSync(0, 'utf8');
      if (validKey(value)) return { action: 'set', operation: 'store', value };
    }
  }
  return null;
}

function fixtureDirectory() {
  const requested = process.env.APIYI_TEST_CREDENTIAL_DIR;
  if (!requested || !path.isAbsolute(requested) || !fs.lstatSync(requested).isDirectory()) return null;
  const directory = fs.realpathSync(requested);
  const relative = path.relative(fs.realpathSync(os.tmpdir()), directory);
  if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) return null;
  if (process.platform !== 'win32') fs.chmodSync(directory, 0o700);
  return directory;
}

function rejectSymlink(file) {
  try {
    if (!fs.lstatSync(file).isFile()) throw new Error('Invalid fixture file.');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

function privateWrite(file, content, append = false) {
  rejectSymlink(file);
  const options = { mode: 0o600, encoding: 'utf8' };
  if (append) fs.appendFileSync(file, content, options);
  else fs.writeFileSync(file, content, options);
  if (process.platform !== 'win32') fs.chmodSync(file, 0o600);
}

function readValue(file) {
  rejectSymlink(file);
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  const stored = JSON.parse(text);
  if (!stored || !validKey(stored.apiKey)) throw new Error('Invalid fixture state.');
  return stored.apiKey;
}

function main() {
  const [tool, ...args] = process.argv.slice(2);
  const directory = fixtureDirectory();
  if (!directory) return invalid();
  const command = classify(tool, args);
  if (!command) return invalid();
  // Trace only canonical operations after validation, never argv, stdin, or keys.
  privateWrite(
    path.join(directory, 'operations.jsonl'),
    JSON.stringify({ tool, operation: command.operation }) + '\n',
    true
  );
  if (command.action === 'help') return 0;
  const state = path.join(directory, tool + '.json');
  if (command.action === 'set') {
    privateWrite(state, JSON.stringify({ apiKey: command.value }));
    return 0;
  }
  const value = readValue(state);
  if (value === null) return tool === 'security' ? 44 : 1;
  if (command.action === 'get') process.stdout.write(value + '\n');
  else fs.unlinkSync(state);
  return 0;
}

function invalid() {
  process.stderr.write('Unsupported credential fixture invocation.\n');
  return 64;
}

try {
  process.exitCode = main();
} catch {
  // A caught error can include command arguments or stored values: do not echo it.
  process.stderr.write('Credential fixture operation failed.\n');
  process.exitCode = 1;
}
