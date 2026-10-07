import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Runner } from '../infra/repo-runner/runner.mjs';

function request() {
  const id = randomUUID();
  return { id, url: 'https://github.com/example/repo', mode: 'inspect', script: 'auto', workspaceId: randomUUID(), execution: {
    version: 1, runtime: 'fixture', missionId: randomUUID(), taskId: randomUUID(), attemptId: randomUUID(), dispatchId: id,
    mandateRevision: 1, planRevision: 1, requestHash: 'a'.repeat(64), deadlineAt: new Date(Date.now() + 60000).toISOString(),
  } };
}
async function fixture(t, execute) {
  const directory = await mkdtemp(join(tmpdir(), 'cancel-unsubmitted-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const calls = [];
  const run = async args => { calls.push(args); assert.equal(args[0], 'rm', 'Cancellation must never execute a repository'); return execute ? execute(args) : { code: 0, output: '' }; };
  const runner = new Runner({ directory, execute: run }); await runner.init();
  return { runner, calls, directory, execute: run };
}
test('missing dispatch gets durable cancellation and physical cleanup, surviving a late submit and restart', async t => {
  const f = await fixture(t), input = request();
  const job = await f.runner.cancelUnsubmitted(input);
  assert.equal(job.status, 'cancelled'); assert.equal(job.cleanup.confirmed, true);
  assert.deepEqual(f.calls, [['rm', '-f', `qa-repo-${input.id}`]]);
  assert.equal((await f.runner.submit(input)).status, 'cancelled');
  const restarted = new Runner({ directory: f.directory, execute: f.execute }); await restarted.init();
  assert.equal((await restarted.submit(input)).status, 'cancelled');
  await assert.rejects(restarted.cancelUnsubmitted({ ...input, url: 'https://github.com/another/repo' }), /already used/);
  assert.equal(f.calls.length, 1);
});
test('late submission while cancellation is persisting cannot start execution', async t => {
  const f = await fixture(t), input = request(); let release;
  const save = f.runner.save.bind(f.runner);
  f.runner.save = async job => { if (!release) await new Promise(resolve => { release = resolve; }); return save(job); };
  const cancel = f.runner.cancelUnsubmitted(input);
  assert.equal((await f.runner.submit(input)).status, 'cancelled');
  release(); await cancel; assert.equal(f.calls.length, 1);
});
test('failed physical cleanup never issues confirmation', async t => {
  const f = await fixture(t, () => ({ code: 1, output: 'Docker unavailable' }));
  const job = await f.runner.cancelUnsubmitted(request());
  assert.equal(job.status, 'cancelled'); assert.equal(job.cleanup.confirmed, false);
});
test('cancellation requires autonomous binding', async t => {
  const f = await fixture(t), input = request(); delete input.execution;
  await assert.rejects(f.runner.cancelUnsubmitted(input), /binding required/);
  assert.equal(f.runner.jobs.size, 0); assert.equal(f.calls.length, 0);
});
