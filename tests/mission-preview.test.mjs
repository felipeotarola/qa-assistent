import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Previews } from '../infra/repo-runner/preview.mjs';
import { environmentPlanHash } from '../shared/mission-environment.mjs';
import { browserPolicyDigest, browserRequestAllowed } from '../infra/browser/policy.mjs';
import { executionHash } from '../infra/execution/admission.mjs';

function fixture(options = {}) {
  const at = Date.now(), id = randomUUID(), owner = 'a'.repeat(64), workspaceId = randomUUID();
  const original = { version: 1, runtime: 'unit:preview', missionId: randomUUID(), taskId: randomUUID(), attemptId: randomUUID(), dispatchId: randomUUID(), mandateRevision: 1, planRevision: 1, requestHash: 'a'.repeat(64), deadlineAt: new Date(at + 60000).toISOString() };
  const execution = { ...original, taskId: randomUUID(), attemptId: randomUUID(), dispatchId: randomUUID() };
  const processId = randomUUID(), plan = { version: 1, repoUrl: 'https://github.com/example/project', root: '/workspace/repository', directory: '/workspace/repository', commit: 'a'.repeat(40), command: 'npm run dev', port: 3000, variables: [],
    executionProfile: { version: 1, runtime: 'node24', imageDigest: `sha256:${'1'.repeat(64)}`, packageManager: 'npm', packageManagerVersion: '11.5.0', installDirectory: '/workspace/repository', lockfile: 'package-lock.json', lockfileSha256: '2'.repeat(64), ignoreScripts: true } };
  const job = { jobId: original.dispatchId, id, owner, workspaceId, status: 'completed', cleanup: 'retained', executorStopped: true, execution: original,
    environmentExecution: { version: 1, phase: 'apply', planHash: environmentPlanHash(plan), plan }, environment: { ...plan, processId, httpStatus: 200 } };
  const sandbox = { id, owner, workspaceId, execution: original, status: 'ready', expiresAt: at + 60000, processes: [{ id: processId, status: 'running' }] };
  const policy = { version: 1, allowedOrigins: ['http://172.30.0.20:3000'], readOnly: true, deadlineAt: execution.deadlineAt };
  const input = { execution, policy, expectedEnvironment: { jobId: job.jobId, planHash: job.environmentExecution.planHash, processId } };
  const calls = [], requests = [], admissions = [], containers = new Set(); let hasRule = false;
  const previews = new Previews({ base: 'https://fixture.test/repository', sandboxes: { sessions: new Map([[id, sandbox]]) }, environmentJob: key => key === job.jobId ? job : null,
    admission: { async admit(value) { admissions.push(value); await options.admit?.(value); } },
    execute: async (command, args) => {
      calls.push({ command, args });
      if (options.execute) { const supplied = await options.execute(command, args); if (supplied !== undefined) return supplied; }
      if (command === 'docker' && args[0] === 'run') { containers.add(`qa-preview-${id}`); return 'synthetic-container'; }
      if (command === 'docker' && args[0] === 'rm') { containers.delete(args.at(-1)); return ''; }
      if (args.includes('{{.HostConfig.Memory}}')) return '2147483648';
      if (args.includes('{{.EnableIPv6}}')) return 'false';
      if (command === 'sysctl') return '1';
      if (command === 'docker' && args[0] === 'inspect' && args.length === 2) {
        if (!containers.has(args[1])) throw new Error('Error: No such object'); return '{}';
      }
      if (command === 'docker' && args[0] === 'inspect') return args.at(-1).startsWith('qa-sandbox-') ? '172.30.0.20' : '172.30.0.21';
      if (command === 'iptables' && args[0] === '-A') hasRule = true;
      if (command === 'iptables' && args[0] === '-F') hasRule = false;
      if (command === 'iptables' && args[0] === '-S') return '-N QA_PREVIEW' + (hasRule ? '\n-A QA_PREVIEW -s 172.30.0.21/32 -j ACCEPT' : '');
      return '';
    },
    fetch: async (url, request) => {
      const path = new URL(url).pathname; requests.push({ path, request });
      if (path === '/health') return Response.json({ ready: true });
      assert.equal(path, '/sessions');
      const passedPolicy = request.body ? JSON.parse(request.body).policy : null;
      return Response.json({ sessionId: randomUUID(), connectUrl: 'wss://fixture.test/cdp', liveUrl: 'https://fixture.test/viewer', expiresAt: execution.deadlineAt,
        ...(passedPolicy ? { policyVersion: 1, policyDigest: options.badPolicy ? 'b'.repeat(64) : browserPolicyDigest(passedPolicy) } : {}) });
    } });
  return { previews, sandbox, job, input, calls, requests, admissions, containers };
}

test('target discovery reads only the owned retained environment address, never grants network or browser access', async () => {
  const f = fixture(), result = await f.previews.target(f.sandbox, { execution: f.input.execution, expectedEnvironment: f.input.expectedEnvironment });
  assert.deepEqual(result, { origin: f.input.policy.allowedOrigins[0], envJobId: f.job.jobId, planHash: f.job.environmentExecution.planHash });
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].args[0], 'inspect'); assert.equal(f.previews.active, null); assert.equal(f.admissions.length, 0); assert.equal(f.requests.length, 0);
});

test('owned binding, plan, process, runtime and epoch must match; no manual omission or adoption', async () => {
  const changes = [
    f => { f.input.execution.missionId = randomUUID(); }, f => { f.input.execution.runtime = 'other'; }, f => { f.input.execution.mandateRevision++; },
    f => { f.input.execution.planRevision++; }, f => { f.input.expectedEnvironment.processId = randomUUID(); }, f => { f.input.expectedEnvironment.planHash = 'b'.repeat(64); },
    f => { f.job.owner = 'b'.repeat(64); }, f => { f.job.workspaceId = randomUUID(); }, f => { f.job.cleanup = 'unknown'; },
    f => { f.job.environment.httpStatus = 500; }, f => { f.sandbox.processes[0].status = 'completed'; }, f => { f.sandbox.status = 'stopped'; },
  ];
  for (const change of changes) { const f = fixture(); change(f); await assert.rejects(f.previews.open(f.sandbox, 3000, f.input)); assert.equal(f.calls.length, 0); }
  const f = fixture(); await assert.rejects(f.previews.open(f.sandbox, 3000));
  const manual = { ...f.sandbox, execution: undefined }; await assert.rejects(f.previews.open(manual, 3000, f.input));
});

test('autonomous open freezes the exact origin and policy before effects, and requires service policy receipt', async () => {
  for (const change of [input => { input.policy.allowedOrigins = ['http://172.30.0.99:3000']; }, input => { input.policy.allowedOrigins.push('https://external.test'); }, input => { input.policy.readOnly = false; }, input => { input.policy.deadlineAt = new Date(Date.parse(input.execution.deadlineAt) + 1).toISOString(); }]) {
    const f = fixture(); change(f.input); await assert.rejects(f.previews.open(f.sandbox, 3000, f.input)); assert.ok(!f.calls.some(c => c.args[0] === 'run' || c.args[0] === '-A'));
  }
  const missing = fixture(); delete missing.input.policy; await assert.rejects(missing.previews.open(missing.sandbox, 3000, missing.input));
  const bad = fixture({ badPolicy: true }); await assert.rejects(bad.previews.open(bad.sandbox, 3000, bad.input), /exact read-only policy/); assert.equal(bad.previews.active, null); assert.equal(bad.containers.size, 0);
});

test('each physical boundary admits the same immutable payload and parallel replay creates only one session', async () => {
  const f = fixture(), sessions = await Promise.all(Array.from({ length: 4 }, () => f.previews.open(f.sandbox, 3000, f.input)));
  assert.ok(sessions.every(s => s.sessionId === sessions[0].sessionId)); assert.equal(f.calls.filter(c => c.args[0] === 'run').length, 1); assert.equal(f.requests.filter(r => r.path === '/sessions').length, 1);
  const wanted = executionHash({ sandboxId: f.sandbox.id, port: 3000, ...f.input });
  assert.deepEqual(f.admissions.slice(0, 3).map(a => a.operationId), ['preview:create', 'preview:network', 'preview:session']);
  assert.ok(f.admissions.every(a => a.kind === 'environment.preview' && a.resourceId === f.input.execution.dispatchId && a.payloadHash === wanted));
  const policy = JSON.parse(f.requests.find(r => r.path === '/sessions').request.body).policy;
  assert.deepEqual(policy, f.input.policy); assert.equal(sessions[0].policyDigest, browserPolicyDigest(policy)); assert.equal(f.previews.active.sessionId, sessions[0].sessionId);
  assert.equal(browserRequestAllowed(policy, { url: 'http://172.30.0.20:3000/write', method: 'POST', navigation: false }), false);
  assert.equal(browserRequestAllowed(policy, { url: 'http://172.30.0.99:3000/', method: 'GET', navigation: true }), false);
  assert.equal(browserRequestAllowed(policy, { url: 'http://172.30.0.20:3000/', method: 'GET', navigation: true }), true);
  const changed = structuredClone(f.input); changed.execution.attemptId = randomUUID();
  await assert.rejects(f.previews.open(f.sandbox, 3000, changed), /changed on replay/);
  await f.previews.closeBound(f.sandbox, 3000, f.input);
});

test('revocation at each physical admission denies remaining effects and cleans the owned preview', async () => {
  for (const denied of ['preview:create', 'preview:network', 'preview:session']) {
    const f = fixture({ admit: async value => { if (value.operationId === denied) throw new Error('Revoked'); } });
    await assert.rejects(f.previews.open(f.sandbox, 3000, f.input), /Revoked/);
    assert.equal(f.previews.active, null); assert.equal(f.containers.size, 0); assert.ok(!f.requests.some(r => r.path === '/sessions'));
    if (denied === 'preview:create') assert.ok(!f.calls.some(c => c.args[0] === 'run'));
    if (denied !== 'preview:session') assert.ok(!f.calls.some(c => c.args[0] === '-A'));
  }
});

test('close racing an admitted opening cannot leave a container or return a new session after cleanup', async () => {
  let reached, release; const entered = new Promise(resolve => { reached = resolve; }), blocked = new Promise(resolve => { release = resolve; });
  const f = fixture({ admit: async value => { if (value.operationId === 'preview:network') { reached(); await blocked; } } });
  const opening = f.previews.open(f.sandbox, 3000, f.input); await entered;
  const closing = f.previews.closeBound(f.sandbox, 3000, f.input); release();
  await assert.rejects(opening, /closed during admission/); assert.equal((await closing).confirmed, true);
  assert.equal(f.containers.size, 0); assert.equal(f.previews.active, null); assert.equal(f.requests.length, 0);
});

test('status repairs lost acknowledgement; close works after deadline without issuing a new admission', async () => {
  const f = fixture(), session = await f.previews.open(f.sandbox, 3000, f.input), before = f.admissions.length;
  const current = await f.previews.status(f.sandbox, 3000, f.input); assert.equal(current.session.sessionId, session.sessionId); assert.equal(current.cleanupConfirmed, false);
  // Deadline is past at the time of status/cleanup. The original request remains
  // byte-identical; only the test clock is replaced while reading that receipt.
  const originalNow = Date.now; Date.now = () => Date.parse(f.input.execution.deadlineAt) + 100;
  try {
    assert.equal((await f.previews.closeBound(f.sandbox, 3000, f.input)).confirmed, true);
    const gone = await f.previews.status(f.sandbox, 3000, f.input); assert.equal(gone.absent, true); assert.equal(gone.cleanupConfirmed, true);
    assert.equal(f.admissions.length, before); await assert.rejects(f.previews.open(f.sandbox, 3000, f.input));
  } finally { Date.now = originalNow; }
});

test('absence and cleanup failure never manufacture a physical stop receipt', async () => {
  let broken = false;
  const f = fixture({ execute: async cmd => { if (broken && cmd === 'docker') throw new Error('Docker unavailable'); } });
  assert.equal((await f.previews.status(f.sandbox, 3000, f.input)).cleanupConfirmed, true, 'Actual inspect missing + no rules proves initial absence');
  await f.previews.open(f.sandbox, 3000, f.input); broken = true;
  await assert.rejects(f.previews.closeBound(f.sandbox, 3000, f.input), /Docker unavailable/);
  assert.equal(f.previews.active.closing, true); assert.equal((await f.previews.status(f.sandbox, 3000, f.input)).cleanupConfirmed, false);
  await assert.rejects(f.previews.open(f.sandbox, 3000, f.input), /capacity/);
  broken = false; assert.equal((await f.previews.closeBound(f.sandbox, 3000, f.input)).confirmed, true);
  broken = true; assert.equal((await f.previews.status(f.sandbox, 3000, f.input)).cleanupConfirmed, false, 'Missing in-memory slot plus transport failure is unknown');
});

test('a new Iris attempt receives a fresh preview policy and session after discovery cleanup', async () => {
  const f = fixture(), first = await f.previews.open(f.sandbox, 3000, f.input); await f.previews.closeBound(f.sandbox, 3000, f.input);
  const next = structuredClone(f.input); next.execution.attemptId = randomUUID(); next.execution.dispatchId = randomUUID(); next.execution.taskId = randomUUID();
  next.execution.deadlineAt = new Date(Date.parse(next.execution.deadlineAt) - 1000).toISOString(); next.policy.deadlineAt = next.execution.deadlineAt;
  const second = await f.previews.open(f.sandbox, 3000, next); assert.notEqual(first.sessionId, second.sessionId); assert.notEqual(first.policyDigest, second.policyDigest);
  await assert.rejects(f.previews.closeBound(f.sandbox, 3000, f.input), /changed on close/); assert.equal(f.previews.active.sessionId, second.sessionId);
  await f.previews.closeBound(f.sandbox, 3000, next);
});

test('the original apply deadline caps later preview attempts and heartbeat admission', async () => {
  const f = fixture();
  f.input.execution.deadlineAt = new Date(Date.parse(f.job.execution.deadlineAt) + 10000).toISOString();
  f.input.policy.deadlineAt = f.input.execution.deadlineAt;
  await assert.rejects(f.previews.open(f.sandbox, 3000, f.input), /exceeds/);
  f.input.policy.deadlineAt = f.job.execution.deadlineAt;
  await f.previews.open(f.sandbox, 3000, f.input);
  const current = f.previews.active, expiresAt = f.sandbox.expiresAt;
  await f.previews.authorizeHeartbeat(current);
  assert.equal(f.sandbox.expiresAt, expiresAt, 'Admission never extends the sandbox itself');
  assert.equal(f.admissions.at(-1).operationId, 'preview:session');
  const now = Date.now; Date.now = () => Date.parse(f.job.execution.deadlineAt) + 1;
  try { await assert.rejects(f.previews.authorizeHeartbeat(current)); await assert.rejects(f.previews.target(f.sandbox, { execution: f.input.execution, expectedEnvironment: f.input.expectedEnvironment })); }
  finally { Date.now = now; }
  await f.previews.closeBound(f.sandbox, 3000, f.input);
});

test('heartbeat rechecks revocation and closing after the physical admission wait', async () => {
  let heartbeat = false, f;
  f = fixture({ admit: async () => { if (heartbeat) f.previews.active.closing = true; } });
  await f.previews.open(f.sandbox, 3000, f.input); const current = f.previews.active;
  heartbeat = true; await assert.rejects(f.previews.authorizeHeartbeat(current), /no longer owns/);
  const count = f.admissions.length; await assert.rejects(f.previews.authorizeHeartbeat(current)); assert.equal(f.admissions.length, count);
  await f.previews.closeBound(f.sandbox, 3000, f.input);
});
