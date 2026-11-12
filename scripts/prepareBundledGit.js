// Git is an application dependency, not a prerequisite the user must install.
// Upstream checksums: https://github.com/git-for-windows/git/releases/tag/v2.54.0.windows.1
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

async function prepareBundledGit(projectRoot, arch = process.arch) {
  if (process.platform !== 'win32') return;
  const hashes = {
    x64: '04f937e1f0918b17b9be6f2294cb2bb66e96e1d9832d1c298e2de088a1d0e668',
    arm64: '68f6bdda5b58f4e40f431c0da48b05ba5596445314d5e491e7b4aebb1ec2e985',
  };
  if (!hashes[arch]) throw new Error(`Unsupported bundled Git architecture: ${arch}`);
  const root = path.resolve(projectRoot, 'resources', 'bundled-git', `win32-${arch}`);
  fs.mkdirSync(root, { recursive: true });
  const archive = path.join(root, 'mingit.zip');
  const valid = () =>
    fs.existsSync(archive) &&
    crypto.createHash('sha256').update(fs.readFileSync(archive)).digest('hex') === hashes[arch];
  if (!valid()) {
    const url = `https://github.com/git-for-windows/git/releases/download/v2.54.0.windows.1/MinGit-2.54.0-${arch === 'x64' ? '64-bit' : 'arm64'}.zip`;
    const mirror = url.replace(
      'https://github.com/git-for-windows/git/releases/download/',
      'https://repo.huaweicloud.com/git-for-windows/'
    );
    for (const source of [mirror, url]) {
      try {
        execFileSync(
          'curl.exe',
          [
            '--fail',
            '--location',
            '--silent',
            '--show-error',
            '--connect-timeout',
            '15',
            '--max-time',
            '180',
            '--output',
            archive,
            source,
          ],
          { windowsHide: true, stdio: 'inherit' }
        );
        if (valid()) break;
      } catch {
        /* Try the other transport; the upstream digest is mandatory. */
      }
    }
  }
  if (!valid()) throw new Error('Bundled Git archive checksum mismatch');
  execFileSync('tar.exe', ['-xf', archive, '-C', root], { windowsHide: true });
  const binary = path.join(root, 'cmd', 'git.exe');
  if (!fs.existsSync(binary)) throw new Error('Bundled Git executable missing');
  if (arch === process.arch) {
    const version = execFileSync(binary, ['--version'], { encoding: 'utf8', windowsHide: true }).trim();
    if (version !== 'git version 2.54.0.windows.1') throw new Error(`Unexpected bundled Git: ${version}`);
  }
  console.log(`Bundled Git prepared: win32-${arch}`);
}
module.exports = { prepareBundledGit };
if (require.main === module)
  prepareBundledGit(path.resolve(__dirname, '..'), process.argv[2]).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
