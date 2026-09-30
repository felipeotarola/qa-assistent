import test from 'node:test';
import assert from 'node:assert/strict';
import { repositoryContext } from '../shared/repository-context.mjs';

test('repository history has a shared log budget and retains result evidence', () => {
  const runs = Array.from({ length: 30 }, (_, i) => ({ id: String(i), repositoryId: 'repo', job: {
    status: 'failed', testExitCode: 1, commit: 'abc', logs: 'x'.repeat(64000) + 'FINAL ERROR',
  } }));
  const input = { available: true, repositories: [], runs };
  const result = repositoryContext(input);
  assert.equal(result.runs.reduce((sum, run) => sum + run.job.logs.length, 0), 6000);
  assert.ok(result.runs[0].job.logs.endsWith('FINAL ERROR'));
  assert.equal(result.runs[29].job.logs, '');
  assert.equal(result.runs[29].job.logsTruncated, true);
  assert.equal(result.runs[29].job.status, 'failed');
  assert.equal(result.runs[29].job.testExitCode, 1);
  assert.equal(result.runs[29].job.commit, 'abc');
  assert.equal(input.runs[0].job.logs.length, 64011);
});

test('short outputs, missing jobs and error responses retain their meaning', () => {
  assert.deepEqual(repositoryContext({ error: 'unavailable' }), { error: 'unavailable' });
  assert.equal(repositoryContext({ runs: [{ id: 'pending', job: null }] }).runs[0].job, null);
  const result = repositoryContext({ logs: 'ok', status: 'passed', package: { scripts: { test: 'vitest' } } });
  assert.equal(result.logs, 'ok');
  assert.equal(result.logsTruncated, false);
  assert.equal(result.package.scripts.test, 'vitest');
});
