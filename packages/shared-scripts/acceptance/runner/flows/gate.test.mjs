import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyReports } from './gate.mjs';

const context = { repository: 'pigq/OpenH3', sourceSha: 'a'.repeat(40), runId: '123', runAttempt: '2' };
const scenarios = ['manual-migration', 'cancel', 'disconnect', 'corrupt', 'downloaded-quit', 'install'];
const reports = () =>
  scenarios.map((scenario) => ({
    ...context,
    schemaVersion: 1,
    executionMode: 'github-hosted-installed',
    scenario,
    stages: { [scenario]: { status: 'PASS' } },
  }));

test('gate requires exactly one genuine hosted PASS per scenario from this source/run/attempt', () => {
  assert.deepEqual(verifyReports(reports(), context), { status: 'PASS', scenarios });
  for (const key of ['repository', 'sourceSha', 'runId', 'runAttempt']) {
    const input = reports();
    input[0][key] = 'different';
    assert.throws(() => verifyReports(input, context));
  }
});

test('gate rejects missing, duplicate, fake adapter, NOT-COVERED and failed evidence', () => {
  assert.throws(() => verifyReports(reports().slice(1), context));
  assert.throws(() => verifyReports([...reports(), reports()[0]], context));
  for (const status of ['NOT-COVERED', 'FAIL', undefined]) {
    const input = reports();
    input[3].stages.corrupt = { status };
    assert.throws(() => verifyReports(input, context));
  }
  const fake = reports();
  fake[1].executionMode = 'injected-test-adapter';
  assert.throws(() => verifyReports(fake, context));
});
