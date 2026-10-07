import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Runner } from '../infra/repo-runner/runner.mjs';
import { ResourceBudget } from '../infra/execution/budget.mjs';

const barrier = () => { let release; const promise = new Promise(resolve => { release = resolve; }); return { promise, release }; };
async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'syna-repo-cleanup-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const calls = [], storageCalls = [], budget = new ResourceBudget(); let now = Date.now(), failRemove = true, failStorage = false;
  const binding = { version: 1, runtime: 'autonomy-test:cleanup', missionId: randomUUID(), taskId: randomUUID(), attemptId: randomUUID(), dispatchId: randomUUID(), mandateRevision: 1, planRevision: 1, requestHash: 'a'.repeat(64), deadlineAt: new Date(now + 600000).toISOString() };
  const input = { id: binding.dispatchId, execution: binding, expectedCommit: 'a'.repeat(40), url: 'https://github.com/example/fixture', mode: 'test', script: 'test' };
  const execute = async args => {
    calls.push(args);
    if (args[0] === 'rm') {
      const persisted = JSON.parse(await readFile(join(directory, `${input.id}.json`), 'utf8'));
      assert.ok(persisted.cleanupRetry.attempts >= 1 && persisted.cleanupRetry.attempts <= 3, 'Retry is persisted before physical removal');
      assert.equal(persisted.cleanup.confirmed, false);
      return { code: failRemove ? 1 : 0, output: failRemove ? 'Docker unavailable' : '' };
    }
    if (args.includes('rev-parse')) return { code: 0, output: 'a'.repeat(40) };
    if (args.includes('node') && args.includes('-e')) return { code: 0, output: JSON.stringify({ scripts: { test: 'node --test' }, lock: true }) };
    return { code: 0, output: '' };
  };
  const storage = { prepare: async () => '/synthetic/workspace', remove: async id => { storageCalls.push(id); if (failStorage) throw Error('Storage still mounted'); } };
  const config = { directory, execute, storage, budget, now: () => now, admission: { admit: async () => {} }, ...options };
  const runner = new Runner(config); await runner.init(); runner.stopping = true;
  const job = await runner.submit(input); budget.reserve(job.id, 1536);
  return { runner, job, calls, storageCalls, budget, config, input,
    advance: () => { now += 30001; }, removeWorks: () => { failRemove = false; }, storageFails: () => { failStorage = true; },
    saved: async () => JSON.parse(await readFile(join(directory, `${job.id}.json`), 'utf8')) };
}
const history = job => ({ status: job.status, message: job.message, finishedAt: job.finishedAt, logs: job.logs, commit: job.commit, testExitCode: job.testExitCode, plan: job.plan, execution: job.execution, fingerprint: job.fingerprint, commandJournal: job.commandJournal });

test('terminal cancel retries only physical cleanup, preserves outcome and waits for both removals before release', async t => {
  const f = await fixture(t); await f.runner.run(f.job);
  assert.equal(f.job.cleanup.confirmed, false); assert.equal(f.job.cleanupRetry.attempts, 1); assert.equal(f.budget.usedMiB, 1536);
  const before = structuredClone(history(f.job)), commands = f.calls.length;
  await f.runner.cancel(f.job.id); assert.equal(f.calls.length, commands, 'Cooldown does not run Docker');
  f.advance(); f.removeWorks(); const entered = barrier(), storage = barrier();
  f.runner.storage = { remove: async id => { assert.equal(id, f.job.id); entered.release(); await storage.promise; } };
  const pending = f.runner.cancel(f.job.id); await entered.promise;
  assert.equal(f.job.cleanup.confirmed, false); assert.equal(f.budget.usedMiB, 1536);
  storage.release(); await pending;
  assert.equal(f.job.cleanup.confirmed, true); assert.equal((await f.saved()).cleanup.confirmed, true); assert.equal(f.budget.usedMiB, 0);
  assert.deepEqual(history(f.job), before); assert.deepEqual(f.calls.slice(commands), [['rm', '-f', `qa-repo-${f.job.id}`]]);
  await f.runner.cancel(f.job.id); assert.equal(f.calls.length, commands + 1, 'Confirmed removal is not repeated');
});

test('persistent three-attempt cap and cooldown cannot be reset by repeated cancel or worker restart', async t => {
  const f = await fixture(t); await f.runner.run(f.job); const original = structuredClone(history(f.job));
  const restart = new Runner(f.config); await assert.rejects(restart.init(), /admission remains disabled/);
  assert.equal(f.calls.filter(args => args[0] === 'rm').length, 1);
  f.advance(); await restart.cancel(f.job.id); assert.equal((await f.saved()).cleanupRetry.attempts, 2);
  f.advance(); await restart.cancel(f.job.id); assert.equal((await f.saved()).cleanupRetry.attempts, 3);
  assert.equal((await f.saved()).cleanupRetry.exhausted, true);
  f.advance(); f.removeWorks(); await restart.cancel(f.job.id);
  const restartedAgain = new Runner(f.config); await assert.rejects(restartedAgain.init(), /admission remains disabled/);
  assert.equal(f.calls.filter(args => args[0] === 'rm').length, 3); assert.equal(f.budget.usedMiB, 1536);
  assert.equal((await f.saved()).cleanup.confirmed, false); assert.deepEqual(history(await f.saved()), original);
});

test('concurrent terminal cancellation shares one cleanup attempt with no command replay', async t => {
  const f = await fixture(t); await f.runner.run(f.job); f.advance(); f.removeWorks();
  await Promise.all(Array.from({ length: 12 }, () => f.runner.cancel(f.job.id)));
  assert.equal(f.calls.filter(args => args[0] === 'rm').length, 2); assert.equal(f.job.cleanupRetry.attempts, 2);
  assert.equal(f.calls.filter(args => args[0] === 'run').length, 1); assert.equal(f.job.cleanup.confirmed, true);
});

test('storage failure retains reservation even after successful container removal', async t => {
  const f = await fixture(t); await f.runner.run(f.job); f.advance(); f.removeWorks(); f.storageFails();
  await f.runner.cancel(f.job.id);
  assert.equal(f.storageCalls.length, 1); assert.equal(f.job.cleanup.confirmed, false); assert.equal(f.budget.usedMiB, 1536);
});

test('unknown durable cleanup intent is not followed by physical removal', async t => {
  const f = await fixture(t); await f.runner.run(f.job); f.advance(); f.removeWorks();
  const save = f.runner.save.bind(f.runner), count = f.calls.length;
  f.runner.save = async () => { throw Error('Synthetic persistence unavailable'); };
  await f.runner.cancel(f.job.id);
  assert.equal(f.calls.length, count); assert.equal(f.job.cleanup.confirmed, false); assert.equal(f.budget.usedMiB, 1536);
  f.runner.save = save;
});

test('positive cleanup receipt remains hidden until persistence acknowledges it', async t => {
  const f = await fixture(t); await f.runner.run(f.job); f.advance(); f.removeWorks();
  const entered = barrier(), persist = barrier();
  f.runner.onState = async snapshot => { if (snapshot.cleanup?.confirmed) { entered.release(); await persist.promise; } };
  const pending = f.runner.cancel(f.job.id); await entered.promise;
  assert.equal(f.job.cleanup.confirmed, false); assert.equal(f.budget.usedMiB, 1536);
  persist.release(); await pending; assert.equal(f.job.cleanup.confirmed, true); assert.equal(f.budget.usedMiB, 0);
});

test('hung physical cleanup returns boundedly and holds its lock until the original effect settles', async t => {
  const f = await fixture(t, { cleanupTimeoutMs: 40 }); await f.runner.run(f.job); f.advance(); f.removeWorks();
  const entered = barrier(), physical = barrier();
  f.runner.storage = { remove: async () => { entered.release(); await physical.promise; } };
  const pending = f.runner.cancel(f.job.id); await entered.promise; await pending;
  assert.equal(f.job.cleanup.confirmed, false); assert.equal(f.budget.usedMiB, 1536);
  f.advance(); await f.runner.cancel(f.job.id); assert.equal(f.job.cleanupRetry.attempts, 2, 'Timed-out storage is not entered concurrently');
  physical.release(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.job.cleanup.confirmed, false, 'Late unbounded completion is not a new receipt');
  f.runner.storage = { remove: async () => {} }; await f.runner.cancel(f.job.id);
  assert.equal(f.job.cleanupRetry.attempts, 3); assert.equal(f.job.cleanup.confirmed, true);
});

test('legacy terminal cleanup failure consumes its original attempt and retains its original outcome', async t => {
  const f = await fixture(t); await f.runner.run(f.job); delete f.job.cleanupRetry; await f.runner.save(f.job);
  const original = structuredClone(history(f.job)); f.removeWorks();
  const tooSoon = new Runner(f.config); await assert.rejects(tooSoon.init(), /admission remains disabled/);
  assert.equal(f.calls.filter(args => args[0] === 'rm').length, 1, 'Legacy receipt still imposes its cooldown');
  f.advance();
  const recovered = new Runner(f.config); await recovered.init();
  assert.equal(recovered.jobs.get(f.job.id).cleanupRetry.attempts, 2); assert.deepEqual(history(recovered.jobs.get(f.job.id)), original);
});

test('restart after durable cleanup but before terminal outcome does not discard the cleanup receipt', async t => {
  const f = await fixture(t); f.removeWorks(); await f.runner.run(f.job);
  const cleanup = structuredClone(f.job.cleanup), count = f.calls.length;
  // The physical cleanup was persisted while status was still cleaning; the
  // final outcome write was lost in this crash window.
  f.job.status = 'cleaning'; f.job.finishedAt = null; await f.runner.save(f.job);
  const recovered = new Runner(f.config); await recovered.init();
  const current = recovered.jobs.get(f.job.id);
  assert.equal(current.status, 'blocked'); assert.equal(current.telemetry.failureKind, 'interrupted');
  assert.deepEqual(current.cleanup, cleanup); assert.equal(current.cleanupRetry.attempts, 1); assert.equal(f.calls.length, count);
});

test('invalid cleanup journal, foreign resource and forged execution never remove anything', async t => {
  const f = await fixture(t); await f.runner.run(f.job); f.advance(); const count = f.calls.length;
  const original = structuredClone(f.job);
  f.job.cleanup.resourceId = randomUUID(); await assert.rejects(f.runner.cancel(f.job.id), /identity/);
  Object.assign(f.job, structuredClone(original)); f.job.execution.attemptId = randomUUID(); await assert.rejects(f.runner.cancel(f.job.id), /identity/);
  Object.assign(f.job, structuredClone(original)); f.job.cleanupRetry.attempts = -1; await assert.rejects(f.runner.cancel(f.job.id), /history/);
  assert.equal(f.calls.length, count); assert.equal(f.budget.usedMiB, 1536);
});

test('missing-container output must identify exactly this resource before storage can be removed', async t => {
  const f = await fixture(t); await f.runner.run(f.job); f.advance(); let storage = 0;
  f.runner.storage = { remove: async () => { storage++; } };
  f.runner.execute = async () => ({ code: 1, output: `Error response from daemon: No such container: qa-repo-${randomUUID()}` });
  await f.runner.cancel(f.job.id); assert.equal(storage, 0); assert.equal(f.job.cleanup.confirmed, false);
  f.advance(); f.runner.execute = async () => ({ code: 1, output: `Error response from daemon: No such container: qa-repo-${f.job.id}\n` });
  await f.runner.cancel(f.job.id); assert.equal(storage, 1); assert.equal(f.job.cleanup.confirmed, true);
});
