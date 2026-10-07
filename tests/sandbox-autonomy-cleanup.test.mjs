import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { Sandboxes, sandboxDocker } from '../infra/repo-runner/sandbox.mjs';
import { CodexWorker } from '../infra/codex-worker/worker.mjs';
import { ResourceBudget } from '../infra/execution/budget.mjs';
import { executionHash } from '../infra/execution/admission.mjs';
import { environmentPlanHash } from '../shared/mission-environment.mjs';

async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'syna-autonomy-cleanup-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const execution = { version: 1, runtime: 'unit:cleanup', missionId: randomUUID(), taskId: randomUUID(), attemptId: randomUUID(), dispatchId: randomUUID(), mandateRevision: 1, planRevision: 1, requestHash: 'a'.repeat(64), deadlineAt: new Date(Date.now() + 900000).toISOString() };
  const input = { id: randomUUID(), owner: 'a'.repeat(64), workspaceId: randomUUID(), execution, operationId: 'create:first' };
  const calls = [], effects = [], containers = new Set(), disks = new Set(), budget = new ResourceBudget();
  let now = Date.now();
  const execute = async args => {
    calls.push(args);
    if (args[0] === 'run') containers.add(input.id);
    if (args[0] === 'rm') { effects.push('rm'); await options.removeContainer?.(); containers.delete(input.id); }
    if (args[0] === 'inspect') return containers.has(input.id) ? 'true' : 'false';
    if (args[0] === 'exec') return 'running';
    return '';
  };
  const storage = { prepare: async id => { disks.add(id); return `/isolated/${id}`; }, remove: async id => { effects.push('storage'); await options.removeStorage?.(); disks.delete(id); } };
  const config = { directory, events: { publish: async () => {} }, budget, execute, storage, now: () => now, cleanupTimeoutMs: options.timeout ?? 1000, admission: { admit: async () => {} } };
  const service = new Sandboxes(config); await service.init(); await service.rpc({ ...input, action: 'ensure' });
  const state = service.sessions.get(input.id);
  return { directory, input, execution, state, service, config, budget, calls, effects, containers, disks, advance: ms => { now += ms; }, saved: async () => JSON.parse(await readFile(join(directory, `${input.id}.json`), 'utf8')) };
}

test('autonomous stop destroys exact container and storage before durable confirmation and budget release', async t => {
  const f = await fixture(t); const save = f.service.save.bind(f.service);
  f.service.onClose = async id => { assert.equal(id, f.input.id); f.effects.push('preview'); };
  f.service.save = async state => {
    if (state.cleanup?.confirmed) { assert.deepEqual(f.effects, ['preview', 'rm', 'storage']); assert.equal(f.budget.usedMiB, 1536); }
    return save(state);
  };
  const view = await f.service.rpc({ ...f.input, action: 'stop' });
  assert.equal(view.status, 'deleted'); assert.equal(f.budget.usedMiB, 0);
  assert.equal(f.containers.size, 0); assert.equal(f.disks.size, 0);
  const saved = await f.saved(); assert.equal(saved.cleanup.confirmed, true); assert.equal(saved.cleanup.executionHash, executionHash(f.execution));
  assert.equal(view.cleanup, undefined); assert.equal(view.cleanupRetry, undefined); assert.equal(view.execution, undefined);
  const count = f.calls.length; await f.service.rpc({ ...f.input, action: 'stop' }); assert.equal(f.calls.length, count);
  await assert.rejects(f.service.rpc({ ...f.input, operationId: 'create:second', action: 'ensure' }), /lease ended/);
});

test('failed rm is not cleanup, cooldown and three-attempt cap survive process restart', async t => {
  const f = await fixture(t, { removeContainer: () => { throw Error('permission denied'); } });
  await assert.rejects(f.service.rpc({ ...f.input, action: 'stop' }), /unconfirmed/);
  assert.deepEqual(f.effects, ['rm']); assert.equal(f.budget.usedMiB, 1536); assert.equal(f.disks.size, 1);
  assert.equal((await f.saved()).cleanup.confirmed, false);
  for (let i = 0; i < 4; i++) await assert.rejects(f.service.rpc({ ...f.input, action: 'stop' }), /unconfirmed/);
  assert.equal(f.effects.length, 1);
  const recovered = new Sandboxes(f.config);
  await assert.rejects(recovered.init(), /admission remains disabled/); assert.equal(f.effects.length, 1);
  f.advance(30000); await assert.rejects(recovered.rpc({ ...f.input, action: 'stop' }), /unconfirmed/);
  f.advance(30000); await assert.rejects(recovered.rpc({ ...f.input, action: 'stop' }), /unconfirmed/);
  f.advance(30000); await recovered.tick();
  const again = new Sandboxes(f.config); await assert.rejects(again.init(), /admission remains disabled/);
  await assert.rejects(again.rpc({ ...f.input, action: 'stop' }), /unconfirmed/);
  assert.equal(f.effects.length, 3); assert.equal((await f.saved()).cleanupRetry.attempts, 3);
  assert.equal(f.budget.usedMiB, 1536); assert.equal(f.containers.size, 1);
});

test('storage failure after rm remains unknown, then retry only repeats cleanup and can recover', async t => {
  let failed = false;
  const f = await fixture(t, { removeStorage: () => { if (!failed) { failed = true; throw Error('mount busy'); } } });
  await assert.rejects(f.service.rpc({ ...f.input, action: 'stop' }), /unconfirmed/);
  assert.equal(f.containers.size, 0); assert.equal(f.disks.size, 1); assert.equal(f.budget.usedMiB, 1536);
  f.advance(30000); await f.service.tick();
  assert.equal(f.disks.size, 0); assert.equal(f.budget.usedMiB, 0); assert.equal((await f.saved()).cleanup.confirmed, true);
  assert.equal(f.calls.filter(args => args[0] === 'run').length, 1);
  assert.equal(f.calls.filter(args => args[0] === 'rm').length, 2);
});

test('timeout does not release the physical fence or turn a late removal into confirmation', async t => {
  let settle, entered; const barrier = new Promise(resolve => { settle = resolve; }); const started = new Promise(resolve => { entered = resolve; });
  let waits = 0;
  const f = await fixture(t, { timeout: 15, removeStorage: async () => { if (!waits++) { entered(); await barrier; } } });
  // Advance the deadline only after the physical adapter is in flight. Real
  // filesystem latency must not race this deliberately short test timeout.
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pending = assert.rejects(f.service.rpc({ ...f.input, action: 'stop' }), /unconfirmed/);
  await started; t.mock.timers.tick(15); await pending;
  f.advance(30000);
  assert.equal((await f.service.rpc({ ...f.input, action: 'status' })).status, 'blocked');
  await assert.rejects(f.service.rpc({ ...f.input, action: 'stop' }), /unconfirmed/);
  assert.equal(f.effects.length, 2); assert.equal(f.budget.usedMiB, 1536); assert.equal(f.service.cleanupLocks.has(f.input.id), true);
  // The released adapter, abort check and cleanup-lock finally are promise
  // continuations. Drain them, without guessing how many real milliseconds
  // they need on a busy full-suite process.
  settle(); await nextTurn();
  assert.equal(f.service.cleanupLocks.has(f.input.id), false);
  assert.equal(f.disks.size, 0); assert.equal((await f.saved()).cleanup.confirmed, false); assert.equal(f.budget.usedMiB, 1536);
  await f.service.rpc({ ...f.input, action: 'stop' }); assert.equal(f.state.cleanup.confirmed, true); assert.equal(f.budget.usedMiB, 0);
  assert.equal(f.effects.filter(effect => effect === 'rm').length, 2); assert.equal((await f.saved()).cleanupRetry.attempts, 2);
});

test('no physical action before journal save, and no budget release before confirmation save', async t => {
  for (const failConfirmed of [false, true]) {
    const f = await fixture(t), save = f.service.save.bind(f.service);
    f.service.save = async state => { if (state.cleanup?.confirmed === failConfirmed) throw Error('disk unavailable'); return save(state); };
    await assert.rejects(f.service.rpc({ ...f.input, action: 'stop' }), /unconfirmed/);
    assert.equal(f.effects.length, failConfirmed ? 2 : 0); assert.equal(f.budget.usedMiB, 1536);
    assert.notEqual((await f.saved()).cleanup?.confirmed, true);
    f.service.save = save; f.advance(30000); await f.service.rpc({ ...f.input, action: 'stop' }); assert.equal(f.budget.usedMiB, 0);
  }
});

test('cleanup identity and exact missing-container receipt cannot be substituted', async t => {
  const f = await fixture(t);
  await assert.rejects(f.service.destroy({ ...f.state }), /identity/);
  f.state.cleanup = { resourceId: randomUUID(), executionHash: executionHash(f.execution), confirmed: false };
  await assert.rejects(f.service.destroy(f.state), /identity/); delete f.state.cleanup;
  const execute = f.service.execute;
  f.service.execute = async args => { if (args[0] === 'rm') throw Error(`No such container: qa-sandbox-${f.input.id}-other`); return execute(args); };
  await assert.rejects(f.service.rpc({ ...f.input, action: 'stop' }), /unconfirmed/); assert.equal(f.disks.size, 1);
  f.advance(30000); f.containers.clear();
  f.service.execute = async args => { if (args[0] === 'rm') throw Error(`Error response from daemon: No such container: qa-sandbox-${f.input.id}`); return execute(args); };
  await f.service.rpc({ ...f.input, action: 'stop' }); assert.equal(f.disks.size, 0); assert.equal(f.budget.usedMiB, 0);
});

test('manual stop still preserves files, resumes the same container, and expiry removes it', async t => {
  const f = await fixture(t); delete f.state.execution; delete f.input.execution; delete f.state.ensureJournal;
  await f.service.rpc({ ...f.input, action: 'stop' });
  assert.equal(f.state.status, 'stopped'); assert.equal(f.disks.size, 1); assert.equal(f.containers.size, 1);
  assert.equal(f.state.cleanup, undefined); assert.equal(f.budget.usedMiB, 0);
  await f.service.rpc({ ...f.input, action: 'ensure' }); assert.equal(f.state.status, 'ready'); assert.equal(f.budget.usedMiB, 1536);
  assert.equal(f.calls.filter(args => args[0] === 'run').length, 1); assert.equal(f.calls.filter(args => args[0] === 'start').length, 1);
  f.state.expiresAt = 0; await f.service.tick(); assert.equal(f.disks.size, 0); assert.equal(f.containers.size, 0);
});

test('Docker completion requires explicit exit zero, including signalled timeout', async () => {
  function child() {
    const value = new EventEmitter(); value.stdout = new EventEmitter(); value.stderr = new EventEmitter(); value.stdin = new EventEmitter(); value.stdin.end = () => {};
    value.kill = signal => { queueMicrotask(() => value.emit('close', null, signal)); return true; }; return value;
  }
  for (const [code, signal] of [[null, 'SIGKILL'], [null, null], [1, null]]) {
    const value = child(); const operation = sandboxDocker(['rm', '-f', 'synthetic'], undefined, { spawnProcess: () => value });
    queueMicrotask(() => value.emit('close', code, signal)); await assert.rejects(operation, /did not succeed/);
  }
  const timed = child(); await assert.rejects(sandboxDocker([], undefined, { timeoutMs: 1, spawnProcess: () => timed }), /SIGKILL/);
  const good = child(); const operation = sandboxDocker([], undefined, { spawnProcess: () => good });
  queueMicrotask(() => { good.stdout.emit('data', 'removed'); good.emit('close', 0, null); }); assert.equal(await operation, 'removed');
});

async function workerFixture(t, phase, options = {}) {
  const f = await fixture(t, options);
  const environment = { version: 1, repoUrl: 'https://github.com/example/project', root: '/workspace/repository', directory: '/workspace/repository', commit: 'b'.repeat(40), command: 'node app.mjs', port: 3000, variables: [], processId: randomUUID(), httpStatus: 200, probeKind: 'http', observedAt: new Date().toISOString(), executionProfile: { version: 1, runtime: 'node24', imageDigest: `sha256:${'a'.repeat(64)}`, packageManager: 'npm', packageManagerVersion: '11.5.0', installDirectory: '/workspace/repository', lockfile: 'package-lock.json', lockfileSha256: 'c'.repeat(64), ignoreScripts: true } };
  const job = { id: f.input.id, owner: f.input.owner, workspaceId: f.input.workspaceId, userId: randomUUID(), jobId: f.execution.dispatchId, execution: f.execution, environmentExecution: { version: 1, phase, planHash: environmentPlanHash(environment) }, environment, status: 'running', processes: [], commands: {} };
  const worker = new CodexWorker({ directory: join(f.directory, 'jobs'), sandboxes: f.service, accessMode: 'shared', appUrl: 'http://127.0.0.1:1', secret: 'test-only-'.repeat(4), fetch: async () => Response.json({ allowed: true, validUntil: new Date(Date.now() + 4000).toISOString(), retainUntil: new Date(Date.now() + 240000).toISOString() }) });
  await worker.init(); worker.jobs.set(job.jobId, job); worker.active.set(job.jobId, {});
  const request = { ...f.input, userId: job.userId, jobId: job.jobId }; t.after(() => worker.close());
  return { ...f, worker, job, request };
}

test('actual Codex + Sandbox services confirm prepare and failed apply only after physical-adapter removal', async t => {
  for (const [phase, outcome] of [['prepare', 'completed'], ['apply', 'failed']]) {
    const f = await workerFixture(t, phase);
    await f.worker.finish(f.job, outcome, 'Original result');
    assert.equal(f.job.status, outcome); assert.equal(f.job.cleanup, 'confirmed'); assert.equal(f.state.status, 'deleted');
    assert.equal(f.containers.size, 0); assert.equal(f.disks.size, 0); assert.equal(f.budget.usedMiB, 0);
    const saved = await f.worker.rpc({ ...f.request, action: 'mission_status' }); assert.equal(saved.cleanup, 'confirmed');
  }
});

test('successful apply remains live through preview retention, then explicit cancel destroys without rewriting result', async t => {
  const f = await workerFixture(t, 'apply');
  f.state.processes.push({ id: f.job.environment.processId, status: 'running', stdout: '', stderr: '' });
  await f.worker.finish(f.job, 'completed', 'HTTP startup verified');
  assert.equal(f.job.cleanup, 'retained'); assert.equal(f.state.status, 'ready'); assert.equal(f.budget.usedMiB, 1536);
  let previewChecks = 0;
  const retained = await f.worker.rpc({ ...f.request, action: 'mission_retain' }, { beforeRetain: async () => { previewChecks++; } });
  assert.equal(retained.retained, true); assert.equal(previewChecks, 1); assert.deepEqual(f.effects, []);
  assert.equal(f.containers.size, 1); assert.equal(f.disks.size, 1);
  await f.worker.rpc({ ...f.request, action: 'mission_status' }); assert.deepEqual(f.effects, []);
  const stopped = await f.worker.rpc({ ...f.request, action: 'cancel' });
  assert.equal(stopped.status, 'completed'); assert.equal(stopped.message, 'HTTP startup verified'); assert.equal(stopped.cleanup, 'confirmed');
  assert.equal(f.disks.size, 0); assert.equal(f.containers.size, 0);
  await assert.rejects(f.worker.rpc({ ...f.request, action: 'mission_retain' }), /current/);
});

test('terminal Otto cleanup failure stays unknown, is read-only on status, and bounded cancel recovers same outcome', async t => {
  let fails = true; const f = await workerFixture(t, 'prepare', { removeStorage: () => { if (fails) throw Error('busy'); } });
  await f.worker.finish(f.job, 'completed', 'Prepared');
  assert.equal(f.job.cleanup, 'unknown'); assert.equal(f.budget.usedMiB, 1536);
  const original = { status: f.job.status, message: f.job.message, environment: structuredClone(f.job.environment) };
  const count = f.effects.length;
  for (let i = 0; i < 4; i++) assert.equal((await f.worker.rpc({ ...f.request, action: 'mission_status' })).cleanup, 'unknown');
  assert.equal(f.effects.length, count);
  await f.worker.rpc({ ...f.request, action: 'cancel' }); assert.equal(f.effects.length, count);
  fails = false; f.advance(30000); await f.worker.rpc({ ...f.request, action: 'cancel' });
  assert.equal(f.job.cleanup, 'confirmed'); assert.equal(f.budget.usedMiB, 0);
  for (const [key, value] of Object.entries(original)) assert.deepEqual(f.job[key], value);
  assert.equal(f.worker.active.size, 0); assert.equal(f.calls.filter(args => args[0] === 'run').length, 1);
});
