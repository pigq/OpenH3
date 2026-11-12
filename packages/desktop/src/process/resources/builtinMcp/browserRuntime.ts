import fs from 'node:fs';
import path from 'node:path';

export type BuiltinNodeRuntime = { executable: string; npxCli: string };

/** Resolve Node/npm from the same managed runtime bundled with OpenH3 Core. */
export function resolveBuiltinNodeRuntime(
  resourcesRoots: string[],
  platform = process.platform,
  arch = process.arch
): BuiltinNodeRuntime | undefined {
  for (const resourcesRoot of resourcesRoots) {
    const bundleRoot = path.resolve(resourcesRoot, 'bundled-openh3-core', `${platform}-${arch}`, 'managed-resources');
    const manifestPath = path.join(bundleRoot, 'manifest.json');
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
        runtimeKey?: string;
        node?: { root?: string; executable?: string };
      };
      if (manifest.runtimeKey !== `${platform}-${arch}` || !manifest.node?.root) continue;
      const relativeRoot = manifest.node.root.replaceAll('\\', '/');
      if (path.posix.isAbsolute(relativeRoot) || relativeRoot.split('/').includes('..')) continue;
      const nodeRoot = path.resolve(bundleRoot, ...relativeRoot.split('/'));
      const relative = path.relative(bundleRoot, nodeRoot);
      if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) continue;
      const executableName = manifest.node.executable || (platform === 'win32' ? 'node.exe' : 'bin/node');
      const executable = path.resolve(nodeRoot, executableName);
      const relativeExecutable = path.relative(nodeRoot, executable);
      if (
        relativeExecutable === '..' ||
        relativeExecutable.startsWith(`..${path.sep}`) ||
        path.isAbsolute(relativeExecutable)
      )
        continue;
      const npxCli = path.join(nodeRoot, 'node_modules', 'npm', 'bin', 'npx-cli.js');
      if (fs.statSync(executable).isFile() && fs.statSync(npxCli).isFile()) return { executable, npxCli };
    } catch {
      // Older or incomplete runtime bundles keep the PATH-based compatibility route.
    }
  }
  return undefined;
}
