import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { assertHostedRunner } from '../windows-upgrade-contract.mjs';
import { assertContext, createProvenance } from './artifacts.mjs';
import { readSource } from './installed-upgrade.mjs';

export async function main(options = {}) {
  const env = options.env ?? process.env;
  assertHostedRunner(env, options.platform ?? process.platform, options.arch ?? process.arch);
  const { values } = parseArgs({
    args: options.argv ?? process.argv.slice(2),
    options: { 'source-sha': { type: 'string' } },
    strict: true,
  });
  const context = {
    repository: env.GITHUB_REPOSITORY,
    sourceSha: values['source-sha'],
    runId: env.GITHUB_RUN_ID,
    runAttempt: env.GITHUB_RUN_ATTEMPT,
  };
  assertContext(context);
  assert.equal(context.sourceSha, env.GITHUB_SHA, 'Candidate must use the exact workflow dispatch SHA');
  const source = await (options.readSource ?? readSource)(process.cwd(), context.sourceSha);
  const io = await (
    options.createAdapter ?? (async () => (await import('./windows-os.mjs')).createWindowsAdapter(env))
  )();
  const root = path.win32.join(env.RUNNER_TEMP, `openh3 candidate-${context.runId}-${context.runAttempt}`);
  const input = path.win32.join(root, 'raw');
  const output = path.win32.join(root, 'bundle');
  await io.ensureOwnedRoot(root);
  await io.ensureOwnedDirectory(output);
  const name = 'OpenH3-3.0.1-win-x64.exe';
  const installerBytes = await io.readFile(path.win32.join(input, name));
  const manifestBytes = await io.readFile(path.win32.join(input, 'latest.yml'));
  const manifest = await (options.loadManifest ?? (async (text) => (await import('js-yaml')).load(text)))(
    manifestBytes.toString('utf8')
  );
  const signature = await io.inspectSignature(path.win32.join(input, name));
  const provenance = createProvenance({ context, ...source, manifest, manifestBytes, installerBytes, signature });
  await io.writeFile(path.win32.join(output, name), installerBytes);
  await io.writeFile(path.win32.join(output, 'latest.yml'), manifestBytes);
  await io.writeJson(path.win32.join(output, 'provenance.json'), provenance);
  // Preserve a genuine optional blockmap, but never invent one or require
  // differential support that nsis.differentialPackage=false does not provide.
  const entries = await (options.listInput ?? fs.readdir)(input);
  if (entries.includes(`${name}.blockmap`))
    await io.writeFile(
      path.win32.join(output, `${name}.blockmap`),
      await io.readFile(path.win32.join(input, `${name}.blockmap`))
    );
  return { output, provenance };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().then(
    (result) =>
      process.stdout.write(
        `${JSON.stringify({ output: result.output, sourceSha: result.provenance.sourceSha, installerSha256: result.provenance.installer.sha256, signature: result.provenance.signature.status })}\n`
      ),
    (error) => {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
    }
  );
}
