import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { createPublicKey } from 'node:crypto';
export const root = path.resolve(import.meta.dirname, '../..');
export async function bundleModule(entry) {
  const outfile = path.join(root, '.runtime', `content-${randomUUID()}.cjs`);
  await fs.mkdir(path.dirname(outfile), { recursive: true });
  await build({
    entryPoints: [path.resolve(root, entry)],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    packages: 'external',
    tsconfig: path.join(root, 'tsconfig.json'),
    plugins: [
      {
        name: 'content-asset-paths',
        setup(b) {
          b.onResolve({ filter: /\?url$/ }, (args) => ({
            path: args.path.startsWith('@/')
              ? path.join(root, 'packages/desktop/src', args.path.slice(2, -4))
              : path.resolve(args.resolveDir, args.path.slice(0, -4)),
            namespace: 'asset-path',
          }));
          b.onLoad({ filter: /.*/, namespace: 'asset-path' }, (args) => ({
            contents: `export default ${JSON.stringify(args.path)}`,
            loader: 'js',
          }));
        },
      },
    ],
  });
  try {
    return createRequire(import.meta.url)(outfile);
  } finally {
    await fs.unlink(outfile);
  }
}
export const digest = (b) => createHash('sha256').update(b).digest('hex');
export async function atomicWrite(file, bytes) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  await fs.writeFile(temp, bytes, { flag: 'wx', mode: 0o600 });
  await fs.rename(temp, file);
}
export const isMain = (url) => Boolean(process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(url));
export const canonical = (value) =>
  JSON.stringify(value, (_key, v) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)))
      : v
  );
export function assertKeyring(keys) {
  if (!keys || typeof keys !== 'object' || Array.isArray(keys) || Object.keys(keys).length === 0)
    throw Error('TRUST_UNCONFIGURED');
  for (const [id, pem] of Object.entries(keys))
    if (!/^[\w-]{1,64}$/.test(id) || typeof pem !== 'string' || createPublicKey(pem).asymmetricKeyType !== 'ed25519')
      throw Error('KEYRING_INVALID');
}
