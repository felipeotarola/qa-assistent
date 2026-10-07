import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { missionExecution, executionAdmission } from '../shared/mission-execution.mjs';
import { ExecutorAdmission, executionHash, sameExecution } from '../infra/execution/admission.mjs';
import { Runner, validate } from '../infra/repo-runner/runner.mjs';
import { Sandboxes } from '../infra/repo-runner/sandbox.mjs';
import { ResourceBudget } from '../infra/execution/budget.mjs';
import { CodexWorker, visibleJob, setupCallbackResult } from '../infra/codex-worker/worker.mjs';
import { CodexClient } from '../infra/codex-worker/client.mjs';

const execution = () => ({ version: 1, runtime: 'autonomy-test:unit', missionId: randomUUID(), taskId: randomUUID(), attemptId: randomUUID(), dispatchId: randomUUID(), mandateRevision: 1, planRevision: 1, requestHash: 'a'.repeat(64), deadlineAt: new Date(Date.now() + 60000).toISOString() });
const request = () => ({ execution: execution(), resourceId: randomUUID(), operationId: 'command:0', kind: 'repository.command', payloadHash: 'b'.repeat(64) });
const receipt = input => ({ allowed: true, attemptId: input.execution.attemptId, dispatchId: input.execution.dispatchId, resourceId: input.resourceId, operationId: input.operationId, kind: input.kind, payloadHash: input.payloadHash, validUntil: input.execution.deadlineAt });
async function directory(t, prefix) { const path = await mkdtemp(join(tmpdir(), prefix)); t.after(() => rm(path, { recursive: true, force: true })); return path; }
test('strict execution binding preserves identity and rejects additions, omissions and malformed authority', () => {
  const value = execution();
  assert.deepEqual(missionExecution(value), value);
  assert.equal(executionHash(value), executionHash(Object.fromEntries(Object.entries(value).reverse())));
  for (const change of [{ version: 2 }, { runtime: '' }, { attemptId: 'not-a-uuid' }, { planRevision: 0 }, { mandateRevision: 1.5 }, { requestHash: 'secret' }, { deadlineAt: '2026-02-30T00:00:00.000Z' }, { callbackUrl: 'https://attacker.invalid' }, { values: {} }]) assert.throws(() => missionExecution({ ...value, ...change }));
  for (const key of Object.keys(value)) { const partial = { ...value }; delete partial[key]; assert.throws(() => missionExecution(partial)); }
  assert.throws(() => sameExecution(value, undefined));
  assert.throws(() => sameExecution(null, value));
  assert.throws(() => sameExecution(value, { ...value, planRevision: 2 }));
  assert.deepEqual(sameExecution(value, value), value);
  assert.equal(sameExecution(null, undefined), null);
  assert.throws(() => executionAdmission({ ...request(), kind: 'host.shell' }));
  assert.throws(() => executionAdmission({ ...request(), operationId: '' }));
});
test('actual loopback HTTP admission uses fixed server callback, exact authenticated echo and no redirects/retries', async t => {
  const seen = [];
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    const input = JSON.parse(body); seen.push({ url: req.url, authorization: req.headers.authorization, input });
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(receipt(input)));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const input = request(), secret = 'local-test-only-'.repeat(3);
  const client = new ExecutorAdmission({ appUrl: `http://127.0.0.1:${server.address().port}`, secret });
  assert.equal((await client.admit(input)).allowed, true);
  assert.equal(seen.length, 1); assert.equal(seen[0].url, '/api/internal/autonomy/executor/admit');
  assert.equal(seen[0].authorization, `Bearer ${secret}`); assert.deepEqual(seen[0].input, input);
  await assert.rejects(client.admit({ ...input, callbackUrl: 'http://elsewhere' })); assert.equal(seen.length, 1);
});
test('denied, partial, oversized, expired and mismatched receipts never grant effects or widen deadline', async () => {
  const input = request(); let calls = 0;
  const client = result => new ExecutorAdmission({ appUrl: 'https://app.invalid', secret: 'x'.repeat(32), fetch: async (_url, options) => { calls++; assert.equal(options.redirect, 'error'); return new Response(JSON.stringify(result)); } });
  for (const change of [{ allowed: false }, { attemptId: randomUUID() }, { dispatchId: randomUUID() }, { resourceId: randomUUID() }, { operationId: 'new-call' }, { payloadHash: 'c'.repeat(64) }, { kind: 'codex.turn' }, { validUntil: new Date(Date.now() - 100).toISOString() }, { validUntil: new Date(Date.parse(input.execution.deadlineAt) + 1).toISOString() }, { unexpected: true }]) await assert.rejects(client({ ...receipt(input), ...change }).admit(input));
  await assert.rejects(client({ huge: 'x'.repeat(17000) }).admit(input));
  const before = calls;
  await assert.rejects(new ExecutorAdmission({ appUrl: undefined, secret: '' }).admit(input)); assert.equal(calls, before);
  let attempts = 0;
  await assert.rejects(new ExecutorAdmission({ appUrl: 'https://app.invalid', secret: 'x'.repeat(32), fetch: async () => { attempts++; throw new Error('secret transport text'); } }).admit(input), error => !error.message.includes('secret transport text'));
  assert.equal(attempts, 1);
});
async function runnerFixture(t, overrides = {}) {
  const calls = [], admissions = [];
  const runner = new Runner({ directory: await directory(t, 'syna-runner-admission-'), admission: { admit: async value => { admissions.push(value); if (overrides.deny?.(value)) throw new Error('Revoked'); return receipt(value); } }, execute: async args => {
    calls.push(args);
    if (args.includes('rev-parse')) return { code: 0, output: overrides.commit || 'a'.repeat(40) };
    if (args.includes('node') && args.includes('-e')) return { code: 0, output: JSON.stringify(overrides.inventory || { scripts: { test: 'node --test' }, lock: true }) };
    return { code: 0, output: '' };
  } });
  await runner.init(); runner.stopping = true;
  const binding = execution();
  const input = { id: binding.dispatchId, execution: binding, expectedCommit: 'a'.repeat(40), url: 'https://github.com/example/repo', mode: 'test', script: 'test' };
  return { runner, calls, admissions, input };
}
test('runner preserves frozen SHA and idempotent binding, including concurrent replay and historical receipt', async t => {
  const { runner, calls, admissions, input } = await runnerFixture(t);
  const jobs = await Promise.all([runner.submit(input), runner.submit(input), runner.submit(input)]);
  assert.equal(new Set(jobs).size, 1);
  await runner.run(jobs[0]); assert.equal(jobs[0].status, 'passed');
  assert.equal(jobs[0].cleanup.confirmed, true); assert.equal(jobs[0].cleanup.resourceId, input.id);
  assert.ok(calls.some(args => args.includes('fetch') && args.includes(input.expectedCommit)));
  assert.ok(calls.some(args => args.includes('--detach'))); assert.ok(!calls.some(args => args.includes('clone')));
  assert.equal(calls.filter(args => args[0] === 'run').length, 1);
  assert.equal(admissions.length, calls.filter(args => args[0] !== 'rm').length + 1);
  assert.equal(new Set(admissions.map(v => v.operationId)).size, admissions.length);
  await assert.rejects(runner.submit({ ...input, execution: undefined }));
  await assert.rejects(runner.submit({ ...input, execution: { ...input.execution, planRevision: 2 } }));
  await assert.rejects(runner.submit({ ...input, expectedCommit: 'b'.repeat(40) }));
  runner.admission.admit = async () => { throw new Error('Closed'); };
  assert.equal((await runner.submit(input)).status, 'passed');
  assert.throws(() => validate({ ...input, expectedCommit: undefined }));
});
test('runner rejects changed actual SHA before install and revoked queued work before container launch', async t => {
  const mismatch = await runnerFixture(t, { commit: 'b'.repeat(40) });
  const job = await mismatch.runner.submit(mismatch.input); await mismatch.runner.run(job);
  assert.equal(job.status, 'blocked'); assert.match(job.message, /commit/);
  assert.ok(!mismatch.calls.some(args => args.includes('ci')));
  const denied = await runnerFixture(t, { deny: () => true });
  const pending = await denied.runner.submit(denied.input); await denied.runner.run(pending);
  assert.equal(pending.status, 'blocked'); assert.deepEqual(denied.calls.map(args => args[0]), ['rm']);
});
test('repository inventory remains available when a monorepo needs an explicit strategy', async t => {
  const { runner, input, calls } = await runnerFixture(t, { inventory: { projects: [{ directory: 'one', kind: 'node', scripts: { test: 'node --test' }, lock: true }, { directory: 'two', kind: 'node', scripts: { test: 'node --test' }, lock: true }] } });
  const job = await runner.submit({ ...input, mode: 'inspect', expectedCommit: undefined }); await runner.run(job);
  assert.equal(job.status, 'review'); assert.equal(job.projects.length, 2); assert.equal(job.plan, null);
  assert.ok(!calls.some(args => args.includes('ci')));
});
async function sandboxFixture(t, deny = () => false) {
  const calls = [], admissions = [], budget = new ResourceBudget();
  const sandboxes = new Sandboxes({ directory: await directory(t, 'syna-sandbox-admission-'), budget, events: { publish: async () => {} }, storage: { prepare: async () => '/synthetic/workspace', remove: async () => {} }, execute: async args => { calls.push(args); return ''; }, admission: { admit: async value => { admissions.push(value); if (deny(value)) throw new Error('Revoked'); return receipt(value); } } });
  await sandboxes.init();
  const input = { id: randomUUID(), owner: 'a'.repeat(64), workspaceId: randomUUID(), execution: execution(), operationId: 'ensure', action: 'ensure' };
  return { sandboxes, calls, admissions, input, budget };
}
test('sandbox checks authority after serial wait and never adopts or drops saved execution identity', async t => {
  let revoked = false;
  const { sandboxes, input, calls } = await sandboxFixture(t, () => revoked);
  let release; const barrier = sandboxes.serial(input.id, () => new Promise(resolve => { release = resolve; }));
  await new Promise(resolve => setImmediate(resolve));
  const pending = sandboxes.rpc(input); revoked = true; release(); await barrier;
  await assert.rejects(pending, /Revoked/); assert.equal(calls.length, 0);
  revoked = false; await sandboxes.rpc(input);
  await assert.rejects(sandboxes.rpc({ ...input, execution: undefined }), /binding/);
  await assert.rejects(sandboxes.rpc({ ...input, execution: { ...input.execution, mandateRevision: 2 } }), /binding/);
  revoked = true;
  assert.equal((await sandboxes.rpc({ ...input, execution: undefined, action: 'status' })).status, 'ready');
  assert.equal((await sandboxes.rpc({ ...input, execution: undefined, action: 'stop' })).status, 'deleted');
});
test('sandbox process receipt rejects altered args and unknown transport never spawns again', async t => {
  const { sandboxes, input, calls } = await sandboxFixture(t); await sandboxes.rpc(input);
  const spawn = { ...input, action: 'spawn', operationId: 'tool:one', processId: randomUUID(), command: 'echo synthetic' };
  const execute = sandboxes.execute; sandboxes.execute = async args => { if (args.includes('-d')) { calls.push(args); throw new Error('Transport outcome unknown'); } return execute(args); };
  await assert.rejects(sandboxes.rpc(spawn), /unknown/);
  assert.equal((await sandboxes.rpc(spawn)).status, 'interrupted');
  assert.equal(calls.filter(args => args.includes('/opt/qa/process.cjs')).length, 1);
  await assert.rejects(sandboxes.rpc({ ...spawn, command: 'different' }), /already used/);
  sandboxes.sessions.get(input.id).processes = [];
  await assert.rejects(sandboxes.rpc(spawn), /Historical/);
  assert.equal(calls.filter(args => args.includes('/opt/qa/process.cjs')).length, 1);
});
test('autonomous direct file operations cannot bypass the scoped tool journal', async t => {
  const { sandboxes, input, calls } = await sandboxFixture(t); await sandboxes.rpc(input);
  const count = calls.length;
  for (const action of ['read', 'write', 'remove']) await assert.rejects(sandboxes.rpc({ ...input, action, operationId: `direct:${action}`, path: '/workspace/example', data: 'dGVzdA==' }), /dedicated mission adapter/);
  assert.equal(calls.length, count);
});
test('ensure receipt replays never repeat create/start/seed and cannot change its template', async t => {
  const { sandboxes, input, calls } = await sandboxFixture(t);
  await sandboxes.rpc(input); const count = calls.length;
  const view = await sandboxes.rpc(input);
  assert.equal(view.status, 'ready'); assert.ok(!('ensureJournal' in view)); assert.equal(calls.length, count);
  await assert.rejects(sandboxes.rpc({ ...input, templateKey: 'different' }), /another template/);
  await sandboxes.rpc({ ...input, action: 'stop' }); const stopped = calls.length;
  assert.equal((await sandboxes.rpc(input)).status, 'deleted'); assert.equal(calls.length, stopped);
});
test('unknown ensure outcome is durable and cannot be replayed under the same or a renamed operation', async t => {
  const { sandboxes, input, calls } = await sandboxFixture(t);
  sandboxes.execute = async args => { calls.push(args); if (args[0] === 'run') throw new Error('Lost Docker create receipt'); return ''; };
  await assert.rejects(sandboxes.rpc(input), /Lost Docker create receipt/);
  assert.equal(calls.filter(args => args[0] === 'run').length, 1);
  const stored = JSON.parse(await readFile(join(sandboxes.directory, `${input.id}.json`), 'utf8'));
  assert.equal(stored.ensureJournal[input.operationId].state, 'unknown');
  sandboxes.sessions.set(input.id, stored);
  await assert.rejects(sandboxes.rpc(input), /unknown/);
  await assert.rejects(sandboxes.rpc({ ...input, operationId: 'renamed' }), /Unconfirmed/);
  assert.equal(calls.filter(args => args[0] === 'run').length, 1);
});
test('unknown template seeding is not retried even when the container already became ready', async t => {
  const { sandboxes, input, calls } = await sandboxFixture(t);
  sandboxes.templates.get = async () => ({ 'synthetic.txt': 'test-only fixture' });
  sandboxes.execute = async args => { calls.push(args); if (args[0] === 'exec' && args.includes('-e')) throw new Error('Lost seed receipt'); return ''; };
  const ensure = { ...input, templateKey: 'synthetic-template' };
  await assert.rejects(sandboxes.rpc(ensure), /Lost seed receipt/);
  assert.equal(sandboxes.sessions.get(input.id).status, 'ready');
  const count = calls.length;
  await assert.rejects(sandboxes.rpc(ensure), /unknown/);
  await assert.rejects(sandboxes.rpc({ ...ensure, operationId: 'renamed' }), /Unconfirmed/);
  assert.equal(calls.length, count);
});
async function codexFixture(t) {
  let worker; t.after(() => worker?.close());
  const sandbox = await sandboxFixture(t); await sandbox.sandboxes.rpc(sandbox.input);
  const admissions = [], clients = [];
  class Client {
    constructor(options) { this.options = options; this.requests = []; clients.push(this); }
    async initialize() { this.requests.push('initialize'); }
    async request(method) { this.requests.push(method); return { thread: { id: 'synthetic-thread' } }; }
    close() { this.closed = true; }
  }
  worker = new CodexWorker({ directory: await directory(t, 'syna-codex-admission-'), sandboxes: sandbox.sandboxes, inspectionCommand: () => 'inspect-fixed', Client, accessMode: 'shared', admission: { admit: async value => { admissions.push(value); return receipt(value); } } });
  await worker.init();
  const identity = { ...sandbox.input }; delete identity.operationId;
  const input = { ...identity, userId: randomUUID(), jobId: sandbox.input.execution.dispatchId, task: 'Inspect only', action: 'start' };
  return { ...sandbox, worker, input, admissions, clients };
}
test('Codex admits before constructor, initialization and turn; fingerprints and RPC receipts do not replay effects', async t => {
  const { worker, input, admissions, clients, sandboxes } = await codexFixture(t);
  await worker.rpc(input);
  const job = worker.jobs.get(input.jobId);
  for (let i = 0; i < 100 && !clients[0]?.requests.includes('turn/start'); i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.deepEqual(clients[0].requests, ['initialize', 'thread/start', 'turn/start']);
  assert.deepEqual(admissions.map(value => value.operationId), ['initialize:spawn', 'initialize:protocol', 'initialize:thread', 'turn']);
  assert.deepEqual(job.usage, { providerCalls: null, tokens: null, accounting: 'whole-turn-reservation' });
  await worker.rpc(input); assert.equal(clients.length, 1);
  await assert.rejects(worker.rpc({ ...input, execution: undefined }), /binding/);
  await assert.rejects(worker.rpc({ ...input, vault: { entries: [] } }), /payload/);
  let spawns = 0; const old = sandboxes.rpc.bind(sandboxes); sandboxes.rpc = async value => { if (value.action === 'spawn') spawns++; return old(value); };
  const first = await worker.call(job, 'inspect_environment', {}, 'rpc:1');
  assert.deepEqual(await worker.call(job, 'inspect_environment', {}, 'rpc:1'), first); assert.equal(spawns, 1);
  await assert.rejects(worker.call(job, 'execute', { command: 'new' }, 'rpc:1'), /different arguments/);
  assert.ok(!('execution' in visibleJob(job)) && !('toolJournal' in visibleJob(job)));
  await assert.rejects(worker.rpc({ ...input, action: 'configure', attemptId: randomUUID(), values: { SECRET: 'never-deliver' } }), /worker-pull/);
});
test('Codex denial before spawn never creates a client; unknown tool completion is not replayed', async t => {
  const { worker, input, clients, sandboxes } = await codexFixture(t);
  worker.run = async () => {}; await worker.rpc(input); const job = worker.jobs.get(input.jobId);
  worker.admission.admit = async () => { throw new Error('Revoked'); };
  await assert.rejects(CodexWorker.prototype.run.call(worker, job), /Revoked/); assert.equal(clients.length, 0);
  worker.admission.admit = async value => receipt(value);
  let calls = 0; sandboxes.rpc = async () => { calls++; throw new Error('Lost command receipt'); };
  await assert.rejects(worker.call(job, 'inspect_environment', {}, 'rpc:unknown'), /Lost/);
  await assert.rejects(worker.call(job, 'inspect_environment', {}, 'rpc:unknown'), /unknown/);
  assert.equal(calls, 1);
});
test('Codex process close waits for actual exit and escalates boundedly instead of treating a signal as acknowledgement', async () => {
  // Explicit synthetic process isolation; real Linux cgroups are exercised in
  // codex-process-isolation.linux.mjs, never inferred from these fake emitters.
  const createProcessScope = () => ({ id: 'synthetic', mechanism: 'synthetic', attach() {}, empty: () => true, kill() {}, dispose() {} });
  const spawnProcess = stopOn => () => {
    const child = new EventEmitter(); child.pid = 123; child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.signals = [];
    child.stdio = [child.stdin, child.stdout, child.stderr, new PassThrough()];
    child.kill = signal => { child.signals.push(signal); if (signal === stopOn) queueMicrotask(() => child.emit('exit', null, signal)); return true; };
    return child;
  };
  const graceful = new CodexClient({ onRequest() {}, onEvent() {}, createProcessScope, spawnProcess: spawnProcess('SIGTERM'), closeGraceMs: 5, closeForceMs: 5 });
  await graceful.close(); assert.deepEqual(graceful.child.signals, ['SIGTERM']);
  const forced = new CodexClient({ onRequest() {}, onEvent() {}, createProcessScope, spawnProcess: spawnProcess('SIGKILL'), closeGraceMs: 5, closeForceMs: 5 });
  await forced.close(); assert.deepEqual(forced.child.signals, ['SIGTERM', 'SIGKILL']);
  const unknown = new CodexClient({ onRequest() {}, onEvent() {}, createProcessScope, spawnProcess: spawnProcess('never'), closeGraceMs: 5, closeForceMs: 5 });
  await assert.rejects(unknown.close(), /unconfirmed/); assert.equal(unknown.exited, undefined);
});
test('Otto shared capacity remains occupied when process exit is unconfirmed, and no secrets are pushed', async t => {
  const { worker, input, sandboxes } = await codexFixture(t); worker.run = async () => {};
  await worker.rpc(input); const job = worker.jobs.get(input.jobId);
  worker.active.get(input.jobId).client = { close: async () => { throw new Error('Unknown physical exit'); } };
  await worker.finish(job, 'cancelled', 'Cancelled');
  assert.equal(job.executorStopped, false); assert.equal(worker.active.size, 1);
  assert.equal(job.cleanup, 'confirmed'); assert.equal(sandboxes.sessions.get(input.id).status, 'deleted');
  assert.equal((await worker.rpc({ ...input, action: 'status' })).executorStopped, false);
  const callback = setupCallbackResult(job);
  assert.equal(callback.executorStopped, false); assert.equal(callback.cleanup, 'confirmed');
  assert.equal(setupCallbackResult({ ...job, executorStopped: undefined }).executorStopped, null);
  assert.ok(!('toolJournal' in callback) && !('task' in callback) && !('commands' in callback));
  const proof = { mechanism: 'cgroup-v2', scopeId: randomUUID(), empty: true, observedAt: new Date().toISOString() };
  assert.deepEqual(setupCallbackResult({ ...job, executorStopProof: proof }).executorStopProof, proof);
  assert.ok(!('executorStopProof' in visibleJob({ ...job, executorStopProof: proof })));
});
test('Codex live admission denies turn creation after a successful initialization and protocol handshake', async t => {
  const { worker, input, clients } = await codexFixture(t); worker.run = async () => {};
  await worker.rpc(input); const job = worker.jobs.get(input.jobId);
  worker.admission.admit = async value => { if (value.kind === 'codex.turn') throw new Error('Paused before turn'); return receipt(value); };
  await assert.rejects(CodexWorker.prototype.run.call(worker, job), /Paused/);
  assert.deepEqual(clients[0].requests, ['initialize', 'thread/start']);
  await worker.finish(job, 'interrupted', 'Paused'); assert.equal(clients[0].closed, true);
});
