import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { missionEnvironmentExecution, environmentPlanHash, environmentRequestFingerprint } from '../shared/mission-environment.mjs';
import { EnvironmentManager } from '../infra/codex-worker/environment.mjs';
import { CodexWorker, setupCallbackResult, visibleJob } from '../infra/codex-worker/worker.mjs';
import { Sandboxes } from '../infra/repo-runner/sandbox.mjs';
import { executionHash } from '../infra/execution/admission.mjs';

const execution = () => ({ version: 1, runtime: 'unit:environment', missionId: randomUUID(), taskId: randomUUID(), attemptId: randomUUID(), dispatchId: randomUUID(), mandateRevision: 1, planRevision: 1, requestHash: 'a'.repeat(64), deadlineAt: new Date(Date.now() + 60000).toISOString() });
const executionProfile = () => ({ version: 1, runtime: 'node24', imageDigest: `sha256:${'1'.repeat(64)}`, packageManager: 'npm', packageManagerVersion: '11.5.0', installDirectory: '/workspace/repository', lockfile: 'package-lock.json', lockfileSha256: '2'.repeat(64), ignoreScripts: true });
const plan = () => ({ version: 1, repoUrl: 'https://github.com/example/project', root: '/workspace/repository', directory: '/workspace/repository', commit: 'a'.repeat(40), command: 'npm --ignore-scripts run dev -- --host 0.0.0.0', port: 3000, variables: [{ name: 'PUBLIC_TEST_KEY', required: true }], executionProfile: executionProfile() });
const prepare = () => ({ version: 1, phase: 'prepare', repoUrl: plan().repoUrl, commit: plan().commit, inspectedRunId: randomUUID() });
const apply = () => { const value = plan(); return { version: 1, phase: 'apply', sourceSetupJobId: randomUUID(), plan: value, planHash: environmentPlanHash(value), consent: { id: randomUUID(), revision: 1, vaultRevision: 1 } }; };
test('environment wire freezes all fields, rejects values and hashes canonical execution plans', () => {
  const first = apply(); assert.deepEqual(missionEnvironmentExecution(first), first);
  const initial = prepare(); assert.deepEqual(missionEnvironmentExecution(initial), initial);
  for (const value of [{ ...initial, values: {} }, { ...initial, commit: ['a'.repeat(40)] }, { ...first, planHash: 'b'.repeat(64) }, { ...first, consent: { ...first.consent, values: {} } }, { ...first, consent: null, callbackUrl: 'https://elsewhere' }, { ...first, plan: { ...first.plan, values: {} } }]) assert.throws(() => missionEnvironmentExecution(value));
  const binding = execution(); assert.equal(environmentRequestFingerprint(binding, 'Prepare', initial), environmentRequestFingerprint(binding, 'Prepare', { ...initial }));
  assert.notEqual(environmentRequestFingerprint(binding, 'Prepare', initial), environmentRequestFingerprint(binding, 'Changed', initial));
  const monorepo = { ...first.plan, directory: '/workspace/repository/apps/web' };
  assert.equal(missionEnvironmentExecution({ ...first, plan: monorepo, planHash: environmentPlanHash(monorepo) }).plan.executionProfile.installDirectory, '/workspace/repository');
  for (const installDirectory of ['/workspace/other', '/workspace/repository/other', '/workspace/repository/apps/web/nested']) assert.throws(() => environmentPlanHash({ ...monorepo, executionProfile: { ...monorepo.executionProfile, installDirectory } }));
});

async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'syna-mission-environment-'));
  const binding = execution(), spec = options.prepare ? prepare() : apply();
  const input = { action: 'start', id: randomUUID(), owner: 'b'.repeat(64), workspaceId: randomUUID(), userId: randomUUID(), jobId: binding.dispatchId, task: 'Prepare this application for QA', execution: binding, environmentExecution: spec };
  const state = { id: input.id, owner: input.owner, workspaceId: input.workspaceId, execution: binding, status: 'ready', processes: [], containerCreated: true }, calls = [], admissions = [], requests = [];
  let lock = Promise.resolve(), constructors = 0;
  const sandboxes = { leaseMs: 300000, sessions: new Map([[state.id, state]]),
    owned(id, owner) { const value = this.sessions.get(id); if (!value || value.owner !== owner) throw Error('Not found'); return value; },
    serial(_id, fn) { const pending = lock.catch(() => {}).then(fn); lock = pending; return pending; },
    async save() {},
    async close(value, status) {
      assert.equal(status, 'deleted');
      calls.push({ args: ['close', value.id] }); value.status = status; value.containerCreated = false;
      return { resourceId: value.id, executionHash: executionHash(value.execution), confirmed: true };
    },
    async execute(args, stdin) {
      calls.push({ args, stdin });
      if (options.execute) { const result = await options.execute(args, stdin); if (result !== undefined) return result; }
      if (args[0] === 'inspect') return executionProfile().imageDigest;
      if (args.some(value => String(value).includes('function inspectMissionProfile'))) { const profile = executionProfile(); delete profile.imageDigest; return JSON.stringify(profile); }
      const script = args.find(value => typeof value === 'string' && value.includes('projects'));
      if (script) return JSON.stringify({ projects: [{ directory: '.', kind: 'node', scripts: { dev: 'node app.mjs' }, lock: true, engines: {}, packageManager: null }] });
      if (args.some(value => String(value).includes('function healthInside'))) return '{"httpStatus":200}';
      return '{}';
    },
  };
  const secretValue = 'SYNTHETIC_TEST_VALUE_NOT_A_REAL_KEY';
  const manager = new EnvironmentManager({ sandboxes, directory: join(directory, 'redaction'), key: 'test-key', appUrl: 'http://127.0.0.1:1', secret: 'local-key-'.repeat(4), fetch: async (url, request) => {
    requests.push({ url: String(url), request });
    if (options.release) return options.release(url, request);
    return new Response(JSON.stringify({ values: { PUBLIC_TEST_KEY: secretValue }, releaseId: randomUUID(), validUntil: binding.deadlineAt }));
  } }); await manager.init();
  const clients = [];
  class Client {
    constructor(options) { constructors++; this.options = options; clients.push(this); }
    async initialize() {}
    async request(method) { return method === 'thread/start' ? { thread: { id: 'synthetic-thread' } } : {}; }
    async close() { this.stopReceipt = { mechanism: 'synthetic', scopeId: 'test', empty: true, observedAt: new Date().toISOString() }; }
  }
  const worker = new CodexWorker({ directory: join(directory, 'jobs'), sandboxes, environments: manager, Client, accessMode: 'shared', inspectionCommand: 'inspect', admission: { admit: async value => { admissions.push(value); if (options.deny?.(value)) throw Error('Revoked'); return {}; } } }); await worker.init();
  if (!options.prepare) {
    const source = { id: randomUUID(), jobId: spec.sourceSetupJobId, owner: 'c'.repeat(64), userId: input.userId, workspaceId: input.workspaceId, status: 'needs_configuration', execution: binding, environmentExecution: prepare(), environment: { ...spec.plan, variables: spec.plan.variables.map(v => ({ ...v, reason: 'Needed' })) }, cleanup: 'confirmed', executorStopped: true };
    worker.jobs.set(spec.sourceSetupJobId, source); sandboxes.sessions.set(source.id, { id: source.id, owner: source.owner, workspaceId: source.workspaceId, execution: binding, status: 'stopped', processes: [] });
  }
  t.after(async () => { await worker.close(); await rm(directory, { recursive: true, force: true }); });
  return { directory, worker, manager, input, state, calls, admissions, requests, secretValue, clients, constructors: () => constructors };
}
async function finished(worker, jobId) {
  for (let i = 0; i < 200; i++) { const job = worker.jobs.get(jobId); if (job && !worker.active.has(jobId)) return job; await delay(5); }
  throw Error('Synthetic worker did not settle');
}

test('prepare captures an identity-bound plan without an app process and stops both executors', async t => {
  const f = await fixture(t, { prepare: true }); await f.worker.rpc(f.input);
  for (let i = 0; i < 100 && !f.clients.length; i++) await delay(5);
  const job = f.worker.jobs.get(f.input.jobId); job.inspected = true;
  const value = plan(); value.variables = value.variables.map(v => ({ ...v, reason: 'Needed for page data' }));
  const result = await f.worker.call(job, 'report_environment', value, 'plan:first');
  assert.equal(result.commit, value.commit); assert.equal(result.httpStatus, null); assert.equal(result.probeKind, 'identity');
  await f.worker.finish(job, 'completed', 'Done');
  assert.equal(job.status, 'needs_configuration'); assert.equal(job.executorStopped, true); assert.equal(job.cleanup, 'confirmed'); assert.equal(f.state.status, 'deleted');
  assert.equal(f.requests.length, 0); assert.ok(!JSON.stringify(job).includes('vaultContext'));
});

test('apply is model-free, stops all installers before release, and stores no values', async t => {
  const f = await fixture(t); await f.worker.rpc(f.input); const job = await finished(f.worker, f.input.jobId);
  assert.equal(job.status, 'completed'); assert.equal(job.cleanup, 'retained'); assert.equal(job.executorStopped, true); assert.equal(f.constructors(), 0);
  assert.equal(job.environment.probeKind, 'http'); assert.equal(job.usage.tokens, 0);
  assert.ok(f.calls.some(call => call.args.includes('--ignore-scripts'))); assert.ok(f.calls.some(call => call.args[0] === 'stop')); assert.ok(f.calls.some(call => call.args[0] === 'start'));
  assert.equal(f.requests.length, 1); assert.equal(f.requests[0].url, 'http://127.0.0.1:1/api/internal/environment-release'); assert.equal(f.requests[0].request.redirect, 'error');
  assert.deepEqual(Object.keys(JSON.parse(f.requests[0].request.body)).sort(), ['execution', 'resourceId', 'operationId', 'planHash', 'sourceSetupJobId'].sort());
  const injection = f.calls.find(call => call.stdin?.includes(f.secretValue)); assert.ok(injection); assert.ok(!JSON.stringify(f.calls.map(call => call.args)).includes(f.secretValue));
  assert.ok(!JSON.stringify(f.admissions).includes(f.secretValue)); assert.ok(!JSON.stringify(job).includes(f.secretValue)); assert.ok(!JSON.stringify(f.state).includes(f.secretValue));
  assert.equal(f.state.credentialBound, true); assert.deepEqual(await readdir(join(f.directory, 'redaction')), []);
  assert.ok(!(await readFile(join(f.directory, 'jobs', `${job.jobId}.json`), 'utf8')).includes(f.secretValue));
  const saved = await f.worker.rpc({ ...f.input, action: 'mission_status' }); assert.equal(saved.fingerprint, environmentRequestFingerprint(f.input.execution, f.input.task, f.input.environmentExecution)); assert.ok(saved.sequence > 0);
  assert.ok(!('environmentExecution' in visibleJob(job))); assert.ok(!('environmentJournal' in setupCallbackResult(job)));
  const before = f.calls.length; await f.worker.rpc(f.input); assert.equal(f.calls.length, before);
  await f.worker.rpc({ ...f.input, action: 'cancel' }); assert.equal(job.status, 'completed'); assert.equal(job.cleanup, 'confirmed'); assert.equal(f.state.status, 'deleted');
  assert.ok((await f.worker.rpc({ ...f.input, action: 'mission_status' })).sequence > saved.sequence);
});

test('uncertain release never replays and failed apply closes the sandbox', async t => {
  const f = await fixture(t, { release() { throw Error('Lost response containing private data'); } });
  await f.worker.rpc(f.input); const job = await finished(f.worker, f.input.jobId);
  assert.equal(job.status, 'failed'); assert.equal(job.environmentJournal['environment:release'].state, 'unknown'); assert.equal(job.cleanup, 'confirmed');
  assert.equal(f.requests.length, 1); assert.ok(!f.calls.some(call => call.stdin?.includes('"values"')));
  await f.worker.rpc(f.input); assert.equal(f.requests.length, 1); assert.ok(!JSON.stringify(job).includes('private data'));
});

test('changed identity after installation blocks release and cannot retry under a renamed command', async t => {
  let checks = 0;
  const f = await fixture(t, { execute(args) { if (args.some(value => String(value).includes('function verifyMissionCheckout')) && ++checks === 2) throw Error('Dirty tracked tree'); } });
  await f.worker.rpc(f.input); const job = await finished(f.worker, f.input.jobId);
  assert.equal(job.status, 'failed'); assert.equal(f.requests.length, 0); assert.equal(job.cleanup, 'confirmed');
  assert.equal(job.environmentJournal['environment:verify-final'].state, 'unknown');
  await f.worker.rpc(f.input); assert.equal(checks, 2);
});

test('different image, package manager or lockfile cannot inherit a prior consent', async t => {
  for (const change of [{ imageDigest: `sha256:${'3'.repeat(64)}` }, { packageManagerVersion: '11.6.0' }, { lockfileSha256: '4'.repeat(64) }]) {
    const f = await fixture(t, { execute(args) {
      if (change.imageDigest && args[0] === 'inspect') return change.imageDigest;
      if (args.some(value => String(value).includes('function inspectMissionProfile'))) { const profile = { ...executionProfile(), ...change }; delete profile.imageDigest; return JSON.stringify(profile); }
    } });
    await f.worker.rpc(f.input); const job = await finished(f.worker, f.input.jobId);
    assert.equal(job.status, 'failed'); assert.equal(f.requests.length, 0);
    assert.ok(!f.calls.some(call => call.args.includes('ci')));
  }
});

test('apply requires exact previous plan, principal, runtime and two confirmed stops', async t => {
  for (const change of [{ cleanup: 'unknown' }, { executorStopped: false }, { status: 'failed' }, { userId: randomUUID() }, { workspaceId: randomUUID() }, { execution: execution() }, { environment: { ...plan(), commit: 'b'.repeat(40) } }]) {
    const f = await fixture(t), source = f.worker.jobs.get(f.input.environmentExecution.sourceSetupJobId); Object.assign(source, change);
    await assert.rejects(f.worker.rpc(f.input), /Prepared environment/); assert.equal(f.calls.length, 0);
  }
});

test('revoked start admission never injects already released values', async t => {
  const f = await fixture(t, { deny: input => input.operationId === 'environment:start' });
  await f.worker.rpc(f.input); const job = await finished(f.worker, f.input.jobId);
  assert.equal(f.requests.length, 1); assert.equal(job.status, 'failed'); assert.equal(job.cleanup, 'confirmed');
  assert.ok(!f.calls.some(call => call.stdin?.includes(f.secretValue)));
});

test('cancellation during an in-flight release waits for settlement and never injects late values', async t => {
  let release, entered; const barrier = new Promise(resolve => { release = resolve; }), started = new Promise(resolve => { entered = resolve; });
  const f = await fixture(t, { async release() { entered(); await barrier; return new Response(JSON.stringify({ values: { PUBLIC_TEST_KEY: f.secretValue }, releaseId: randomUUID(), validUntil: f.input.execution.deadlineAt })); } });
  await f.worker.rpc(f.input); await started;
  const cancel = f.worker.rpc({ ...f.input, action: 'cancel' });
  for (let i = 0; i < 100 && f.worker.jobs.get(f.input.jobId).status !== 'cancelled'; i++) await delay(5);
  assert.equal(f.worker.jobs.get(f.input.jobId).status, 'cancelled'); release(); await cancel;
  const job = await finished(f.worker, f.input.jobId); assert.equal(job.status, 'cancelled'); assert.equal(job.cleanup, 'confirmed');
  assert.ok(!f.calls.some(call => call.stdin?.includes(f.secretValue)));
});

test('credential-bound file and shell access remains denied without in-memory redaction values', async t => {
  const f = await fixture(t), sandbox = new Sandboxes({ directory: join(f.directory, 'unused'), execute: async () => { throw Error('Must not execute'); } });
  sandbox.sessions.set(f.state.id, { ...f.state, credentialBound: true });
  for (const action of ['spawn', 'read', 'write', 'remove']) await assert.rejects(sandbox.rpc({ ...f.input, action, operationId: 'command:attempt' }), /Credential-bound/);
});

test('release validates strict reply, required names, consent and bounded expiry', async t => {
  const f = await fixture(t); const job = { ...f.input };
  const good = { values: { PUBLIC_TEST_KEY: f.secretValue }, validUntil: f.input.execution.deadlineAt, releaseId: randomUUID() };
  for (const bad of [{ ...good, extra: true }, { ...good, validUntil: new Date(Date.now() - 100).toISOString() }, { ...good, validUntil: new Date(Date.parse(good.validUntil) + 1).toISOString() }, { ...good, values: {} }, { ...good, values: { ...good.values, PATH: 'bad' } }, { ...good, values: { PUBLIC_TEST_KEY: '\0' } }]) { f.manager.request = async () => new Response(JSON.stringify(bad)); await assert.rejects(f.manager.releaseMission(job)); }
  f.manager.request = async () => new Response(JSON.stringify(good));
  await assert.rejects(f.manager.releaseMission({ ...job, environmentExecution: { ...job.environmentExecution, consent: null } }), /consent/);
});

test('private absence receipt proves only the exact owned sandbox and original dispatch', async t => {
  const f = await fixture(t);
  assert.deepEqual(await f.worker.rpc({ ...f.input, action: 'mission_status' }), { absent: true, jobId: f.input.jobId, id: f.input.id, execution: f.input.execution });
  for (const change of [{ owner: 'd'.repeat(64) }, { workspaceId: randomUUID() }, { jobId: randomUUID() }, { execution: undefined }, { execution: { ...f.input.execution, attemptId: randomUUID() } }]) await assert.rejects(f.worker.rpc({ ...f.input, action: 'mission_status', ...change }));
  assert.equal(f.calls.length, 0); assert.equal(f.worker.jobs.size, 1);
});

test('actual loopback release transport uses fixed route and never pushes values in the request', async t => {
  const f = await fixture(t); let received;
  const server = createServer(async (req, res) => { let body = ''; for await (const chunk of req) body += chunk; received = { url: req.url, body }; res.end(JSON.stringify({ values: { PUBLIC_TEST_KEY: f.secretValue }, validUntil: f.input.execution.deadlineAt, releaseId: randomUUID() })); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => server.close(resolve)));
  f.manager.appUrl = `http://127.0.0.1:${server.address().port}`; f.manager.request = fetch;
  const result = await f.manager.releaseMission(f.input); assert.equal(result.values.PUBLIC_TEST_KEY, f.secretValue);
  assert.equal(received.url, '/api/internal/environment-release'); assert.ok(!received.body.includes(f.secretValue));
});
