import test from 'node:test';
import assert from 'node:assert/strict';
import { main } from './candidate-bundle.mjs';

test('bundle packaging refuses a local machine before source/file/signature operations', async () => {
  let operated = false;
  await assert.rejects(
    main({
      env: {},
      platform: 'win32',
      arch: 'x64',
      createAdapter: () => {
        operated = true;
      },
    }),
    /GitHub-hosted/
  );
  assert.equal(operated, false);
});

test('candidate bundler requires exact same dispatch SHA, not a branch or a different reviewed source', async () => {
  const env = {
    GITHUB_ACTIONS: 'true',
    RUNNER_ENVIRONMENT: 'github-hosted',
    RUNNER_OS: 'Windows',
    RUNNER_TEMP: 'D:\\runner\\temp',
    GITHUB_REPOSITORY: 'pigq/OpenH3',
    GITHUB_SHA: 'a'.repeat(40),
    GITHUB_RUN_ID: '123',
    GITHUB_RUN_ATTEMPT: '1',
  };
  let operated = false;
  await assert.rejects(
    main({
      env,
      platform: 'win32',
      arch: 'x64',
      argv: ['--source-sha', 'b'.repeat(40)],
      createAdapter: () => {
        operated = true;
      },
    }),
    /dispatch SHA/
  );
  assert.equal(operated, false);
});
