// Evidence gate only. This module never imports Electron or runs an installer.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { assertContext } from '../artifacts.mjs';
import { SCENARIOS } from '../installed-upgrade.mjs';

export function verifyReports(reports, context) {
  assertContext(context);
  assert.equal(reports.length, SCENARIOS.length, 'Missing or duplicate scenario evidence');
  for (const scenario of SCENARIOS) {
    const matches = reports.filter((r) => r.scenario === scenario);
    assert.equal(matches.length, 1, `Need exactly one ${scenario} report`);
    const report = matches[0];
    for (const [key, value] of Object.entries(context)) assert.equal(report[key], value, `Wrong ${key}`);
    assert.equal(report.schemaVersion, 1);
    assert.equal(report.executionMode, 'github-hosted-installed', 'Fake OS tests do not count as installed acceptance');
    assert.equal(report.stages?.[scenario]?.status, 'PASS', `NOT-COVERED/FAIL: ${scenario}`);
  }
  return { status: 'PASS', scenarios: [...SCENARIOS] };
}

export async function main(env = process.env) {
  const context = {
    repository: env.GITHUB_REPOSITORY,
    sourceSha: env.GITHUB_SHA,
    runId: env.GITHUB_RUN_ID,
    runAttempt: env.GITHUB_RUN_ATTEMPT,
  };
  const root = env.OPENH3_ACCEPTANCE_REPORTS;
  assert.ok(root && path.isAbsolute(root), 'Explicit artifact evidence root required');
  const files = [];
  async function scan(dir) {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      assert.equal(entry.isSymbolicLink(), false, 'Evidence links refused');
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) await scan(file);
      else if (entry.name === 'acceptance.json') files.push(file);
    }
  }
  await scan(root);
  const result = verifyReports(
    await Promise.all(files.map(async (file) => JSON.parse(await fs.readFile(file, 'utf8')))),
    context
  );
  process.stdout.write(`${JSON.stringify(result)}\n`);
  return result;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href)
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
