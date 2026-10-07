import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { CodexWorker } from '../infra/codex-worker/worker.mjs';
import { environmentPlanHash } from '../shared/mission-environment.mjs';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'syna-retention-'));
  const execution = { version: 1, runtime: 'unit:retention', missionId: randomUUID(), taskId: randomUUID(), attemptId: randomUUID(), dispatchId: randomUUID(), mandateRevision: 1, planRevision: 1, requestHash: 'a'.repeat(64), deadlineAt: new Date(Date.now() + 900000).toISOString() };
  const environment = { version: 1, repoUrl: 'https://github.com/example/test', root: '/workspace/repository', directory: '/workspace/repository', commit: 'b'.repeat(40), command: 'node app.mjs', port: 3000, variables: [], processId: randomUUID(), httpStatus: 200, probeKind: 'http', observedAt: new Date().toISOString(), executionProfile: { version: 1, runtime: 'node24', imageDigest: `sha256:${'a'.repeat(64)}`, packageManager: 'npm', packageManagerVersion: '11.5.0', installDirectory: '/workspace/repository', lockfile: 'package-lock.json', lockfileSha256: 'c'.repeat(64), ignoreScripts: true } };
  const job = { id: randomUUID(), jobId: execution.dispatchId, userId: randomUUID(), owner: 'e'.repeat(64), workspaceId: randomUUID(), execution, environment, environmentExecution: { version: 1, phase: 'apply', sourceSetupJobId: randomUUID(), planHash: environmentPlanHash(environment), plan: environment, consent: null }, status: 'completed', cleanup: 'retained', executorStopped: true };
  const state = { id: job.id, owner: job.owner, workspaceId: job.workspaceId, execution, status: 'ready', expiresAt: Date.now() + 60000, processes: [{ id: environment.processId, status: 'running' }] };
  const requests = [], commands = []; let saves = 0, calls = 0, pending = Promise.resolve();
  const sandboxes = { leaseMs: 300000, sessions: new Map([[state.id, state]]), owned(id, owner) { if (id !== state.id || owner !== state.owner) throw Error('Wrong owner'); return state; }, serial(_id, operation) { const next = pending.catch(() => {}).then(operation); pending = next; return next; }, async save() { saves++; }, async execute(args) { commands.push(args); return args[0] === 'inspect' ? 'true' : 'running'; } };
  const reply = () => ({ allowed: true, validUntil: new Date(Date.now() + 4000).toISOString(), retainUntil: new Date(Math.min(Date.now() + 240000, Date.parse(execution.deadlineAt))).toISOString() });
  const worker = new CodexWorker({ directory, sandboxes, appUrl: 'http://127.0.0.1:1', secret: 'local-test-only-'.repeat(3), fetch: async (url, request) => { calls++; requests.push({ url: String(url), request }); return Response.json(reply()); } }); await worker.init(); worker.jobs.set(job.jobId, job);
  const input = { action: 'mission_retain', id: job.id, owner: job.owner, userId: job.userId, workspaceId: job.workspaceId, jobId: job.jobId, execution };
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { worker, sandboxes, job, state, input, requests, commands, reply, saves: () => saves, calls: () => calls };
}

test('retention uses original apply and physical reads, with fixed ref-only callback and no budget charge', async t => {
  const f = await fixture(t), old = f.state.expiresAt;
  const result = await f.worker.rpc(f.input);
  assert.equal(result.retained, true); assert.ok(f.state.expiresAt > old); assert.equal(f.saves(), 1);
  assert.equal(f.commands.length, 2); assert.equal(f.requests[0].url, 'http://127.0.0.1:1/api/internal/environment-retain');
  assert.equal(f.requests[0].request.redirect, 'error');
  assert.deepEqual(JSON.parse(f.requests[0].request.body), { execution: f.input.execution, resourceId: f.job.id, jobId: f.job.jobId });
  assert.equal(f.job.toolJournal, undefined); assert.equal(f.job.status, 'completed'); assert.equal(f.job.cleanup, 'retained');
  assert.ok(f.state.expiresAt <= Date.parse(f.job.execution.deadlineAt));
});

test('wrong owner, workspace, original attempt and changed plan never retain', async t => {
  const f = await fixture(t);
  for (const change of [{ owner: 'f'.repeat(64) }, { workspaceId: randomUUID() }, { userId: randomUUID() }, { jobId: randomUUID() }, { execution: { ...f.input.execution, attemptId: randomUUID() } }]) await assert.rejects(f.worker.rpc({ ...f.input, ...change }));
  f.job.environment.command = 'node other.mjs'; await assert.rejects(f.worker.rpc(f.input));
  assert.equal(f.calls(), 0); assert.equal(f.saves(), 0);
});

test('expired or stopped environment cannot be resurrected by heartbeat', async t => {
  const f = await fixture(t);
  f.state.expiresAt = Date.now() - 1; await assert.rejects(f.worker.rpc(f.input));
  f.state.expiresAt = Date.now() + 60000; f.state.status = 'stopped'; await assert.rejects(f.worker.rpc(f.input));
  f.state.status = 'ready'; f.job.execution.deadlineAt = new Date(Date.now() - 1).toISOString(); await assert.rejects(f.worker.rpc(f.input));
  assert.equal(f.calls(), 0); assert.equal(f.saves(), 0);
});

test('missing container or dead process does not turn cached running into physical proof', async t => {
  const f = await fixture(t);
  f.sandboxes.execute = async () => 'false'; await assert.rejects(f.worker.rpc(f.input), /container/);
  f.sandboxes.execute = async args => args[0] === 'inspect' ? 'true' : 'completed'; await assert.rejects(f.worker.rpc(f.input), /process/);
  assert.equal(f.calls(), 0); assert.equal(f.saves(), 0);
});

test('revoked, unavailable, widened or malformed retention receipt leaves lease unchanged', async t => {
  const f = await fixture(t), old = f.state.expiresAt;
  for (const change of [{ allowed: false }, { extra: true }, { validUntil: new Date(Date.now() + 60000).toISOString() }, { retainUntil: new Date(Date.now() + 360000).toISOString() }, { validUntil: 'invalid' }, { retainUntil: new Date(Date.now() - 1).toISOString() }]) {
    f.worker.request = async () => Response.json({ ...f.reply(), ...change }); await assert.rejects(f.worker.rpc(f.input));
  }
  f.worker.request = async () => new Response('', { status: 409 }); await assert.rejects(f.worker.rpc(f.input));
  f.worker.request = async () => { throw Error('Lost receipt'); }; await assert.rejects(f.worker.rpc(f.input));
  assert.equal(f.state.expiresAt, old); assert.equal(f.saves(), 0);
});

test('preview operating admission is mandatory when provided and expiry is rechecked after it', async t => {
  const f = await fixture(t), old = f.state.expiresAt;
  await assert.rejects(f.worker.rpc(f.input, { beforeRetain: () => { throw Error('Operating attempt revoked'); } }), /revoked/);
  assert.equal(f.state.expiresAt, old);
  f.worker.request = async () => Response.json({ ...f.reply(), validUntil: new Date(Date.now() + 30).toISOString() });
  await assert.rejects(f.worker.rpc(f.input, { beforeRetain: () => delay(60) }), /expired/);
  assert.equal(f.state.expiresAt, old); assert.equal(f.saves(), 0);
});

test('physical-read wait past idle expiry does not revive an expired environment', async t => {
  const f = await fixture(t);
  f.state.expiresAt = Date.now() + 30;
  f.sandboxes.execute = async args => { await delay(35); return args[0] === 'inspect' ? 'true' : 'running'; };
  await assert.rejects(f.worker.rpc(f.input), /current/); assert.equal(f.calls(), 0); assert.equal(f.saves(), 0);
});
