// Private, complete Python for creating model environments; never modifies system Python or PATH.
// Digests are from https://github.com/astral-sh/python-build-standalone/releases/expanded_assets/20251014
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

function prepareBundledPython(projectRoot, arch = process.arch) {
  if (process.platform !== 'win32') return;
  const hashes = {
    x64: '3c8b9b10a933909c98b9916297e2093b24a9c2abaa23df1c2622c2bfe052cb94',
    arm64: '518eef7d7d3fda73b5cf41f90ec15f5944e1af7b779bc0b31a56bee62e838bc4',
  };
  if (!hashes[arch]) throw new Error(`Unsupported bundled Python architecture: ${arch}`);
  const root = path.resolve(projectRoot, 'resources', 'bundled-python', `win32-${arch}`);
  fs.mkdirSync(root, { recursive: true });
  const archive = path.join(root, 'python.tar.gz');
  const valid = () =>
    fs.existsSync(archive) &&
    crypto.createHash('sha256').update(fs.readFileSync(archive)).digest('hex') === hashes[arch];
  if (!valid()) {
    const url = `https://github.com/astral-sh/python-build-standalone/releases/download/20251014/cpython-3.12.12%2B20251014-${arch === 'x64' ? 'x86_64' : 'aarch64'}-pc-windows-msvc-install_only_stripped.tar.gz`;
    execFileSync(
      'curl.exe',
      [
        '--fail',
        '--location',
        '--silent',
        '--show-error',
        '--retry',
        '2',
        '--connect-timeout',
        '15',
        '--max-time',
        '180',
        '--output',
        archive,
        url,
      ],
      { windowsHide: true, stdio: 'inherit' }
    );
  }
  if (!valid()) throw new Error('Bundled Python archive checksum mismatch');
  execFileSync('tar.exe', ['-xf', archive, '-C', root], { windowsHide: true });
  const binary = path.join(root, 'python', 'python.exe');
  if (!fs.existsSync(binary)) throw new Error('Bundled Python executable missing');
  if (arch === process.arch) {
    const version = execFileSync(binary, ['-I', '-c', 'import venv,ensurepip,pip,sys;print(sys.version.split()[0])'], {
      encoding: 'utf8',
      windowsHide: true,
    }).trim();
    if (version !== '3.12.12') throw new Error(`Unexpected bundled Python: ${version}`);
  }
  console.log(`Bundled complete Python prepared: win32-${arch}`);
}
module.exports = { prepareBundledPython };
if (require.main === module) {
  try {
    prepareBundledPython(path.resolve(__dirname, '..'), process.argv[2]);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
