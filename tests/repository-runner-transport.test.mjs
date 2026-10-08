import test from 'node:test';
import assert from 'node:assert/strict';
import { callRepositoryRunner as repositoryRunner } from '../server/utils/repository-runner.ts';

test('runner maps transport failures to unavailable without replaying writes', async t => {
  const prior = { url: process.env.REPO_RUNNER_URL, key: process.env.REPO_RUNNER_KEY };
  process.env.REPO_RUNNER_URL = 'https://runner.example.test';
  process.env.REPO_RUNNER_KEY = 'test-only';
  t.after(() => { for (const [name, value] of [['REPO_RUNNER_URL', prior.url], ['REPO_RUNNER_KEY', prior.key]]) { if(value === undefined) delete process.env[name]; else process.env[name] = value; } });
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; throw new TypeError('fetch failed: internal hostname'); });
  for (const body of [undefined, { action: 'start' }]) {
    const before = calls;
    await assert.rejects(repositoryRunner('/sandboxes', body), error => error.statusCode === 503 && !error.message.includes('hostname'));
    assert.equal(calls, before + 1);
  }
});

test('runner keeps successful status projection and remote validation errors', async t => {
  const prior = { url: process.env.REPO_RUNNER_URL, key: process.env.REPO_RUNNER_KEY };
  process.env.REPO_RUNNER_URL = 'https://runner.example.test'; process.env.REPO_RUNNER_KEY = 'test-only';
  t.after(() => { for (const [name, value] of [['REPO_RUNNER_URL', prior.url], ['REPO_RUNNER_KEY', prior.key]]) { if(value === undefined) delete process.env[name]; else process.env[name] = value; } });
  const mocked = t.mock.method(globalThis, 'fetch', async () => Response.json({ sessions: [] }));
  assert.deepEqual(await repositoryRunner('/sandboxes'), { sessions: [] });
  mocked.mock.mockImplementation(async () => Response.json({ error: 'Invalid action' }, { status: 400 }));
  await assert.rejects(repositoryRunner('/sandboxes', {}), e => e.statusCode === 400);
});
