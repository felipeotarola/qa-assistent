import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Previews } from '../infra/repo-runner/preview.mjs';
import { environmentPlanHash } from '../shared/mission-environment.mjs';
import { browserPolicyDigest } from '../infra/browser/policy.mjs';
import { executionHash } from '../infra/execution/admission.mjs';
import { previewHandoff, previewHandoffHash, matchPreviewHandoffReceipt } from '../shared/preview-handoff.mjs';

function fixture(options = {}) {
  const at = Date.now(), id = randomUUID(), owner = 'a'.repeat(64), workspaceId = randomUUID();
  const original = { version: 1, runtime: 'unit:preview', missionId: randomUUID(), taskId: randomUUID(), attemptId: randomUUID(), dispatchId: randomUUID(), mandateRevision: 1, planRevision: 1, requestHash: 'a'.repeat(64), deadlineAt: new Date(at + 600000).toISOString() };
  const execution = { ...original, taskId: randomUUID(), attemptId: randomUUID(), dispatchId: randomUUID() };
  const processId = randomUUID(), plan = { version: 1, repoUrl: 'https://github.com/example/project', root: '/workspace/repository', directory: '/workspace/repository', commit: 'a'.repeat(40), command: 'npm run dev', port: 3000, variables: [],
    executionProfile: { version: 1, runtime: 'node24', imageDigest: `sha256:${'1'.repeat(64)}`, packageManager: 'npm', packageManagerVersion: '11.5.0', installDirectory: '/workspace/repository', lockfile: 'package-lock.json', lockfileSha256: '2'.repeat(64), ignoreScripts: true } };
  const job = { jobId: original.dispatchId, id, owner, workspaceId, status: 'completed', cleanup: 'retained', executorStopped: true, execution: original,
    environmentExecution: { version: 1, phase: 'apply', planHash: environmentPlanHash(plan), plan }, environment: { ...plan, processId, httpStatus: 200 } };
  const sandbox = { id, owner, workspaceId, execution: original, status: 'ready', expiresAt: at + 600000, processes: [{ id: processId, status: 'running' }] };
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
      if (path.startsWith('/sessions/')) return Response.json(options.physical?.() ?? { id: previews.active.sessionId, status: 'ready', control: 'agent', controlEpoch: 2, expiresAt: execution.deadlineAt, policyVersion: 1, policyDigest: browserPolicyDigest(policy) });
      assert.equal(path, '/sessions');
      const passedPolicy = request.body ? JSON.parse(request.body).policy : null;
      return Response.json({ sessionId: randomUUID(), connectUrl: 'wss://fixture.test/cdp', liveUrl: 'https://fixture.test/viewer', expiresAt: execution.deadlineAt,
        ...(passedPolicy ? { policyVersion: 1, policyDigest: options.badPolicy ? 'b'.repeat(64) : browserPolicyDigest(passedPolicy) } : {}) });
    } });
  return { previews, sandbox, job, input, calls, requests, admissions, containers };
}

async function opened(options) {
  const f = fixture(options);
  const session = await f.previews.open(f.sandbox, 3000, f.input);
  f.next = { version: 1, handoffId: randomUUID(), sandboxId: f.sandbox.id, sessionId: session.sessionId,
    creationRequestHash: f.previews.active.requestHash, previousExecution: structuredClone(f.input.execution),
    execution: { ...f.input.execution, attemptId: randomUUID(), dispatchId: randomUUID(), deadlineAt: new Date(Date.parse(f.input.execution.deadlineAt) - 60000).toISOString() },
    policy: structuredClone(f.input.policy), expectedEnvironment: { ...f.input.expectedEnvironment }, port: 3000 };
  return f;
}

test('handoff retains exact creation and physical session with a shorter current deadline; only admission and GET', async () => {
  const f = await opened(), before = f.calls.length, original = f.previews.active, session = original.session;
  const creation = executionHash({ execution: original.execution, requestHash: original.requestHash, policy: original.policy, expectedEnvironment: original.expectedEnvironment });
  const receipt = await f.previews.handoff(f.sandbox, f.next);
  assert.equal(f.calls.length, before, 'No Docker, network, command, process or secret effect');
  assert.equal(f.requests.filter(r => r.path === '/sessions').length, 1);
  assert.strictEqual(f.previews.active, original); assert.strictEqual(original.session, session);
  assert.equal(executionHash({ execution: original.execution, requestHash: original.requestHash, policy: original.policy, expectedEnvironment: original.expectedEnvironment }), creation);
  assert.equal(receipt.sessionId, session.sessionId); assert.equal(receipt.controlEpoch, 2);
  assert.deepEqual(original.authorization.execution, f.next.execution);
  assert.equal(receipt.requestHash, previewHandoffHash(f.next));
  assert.deepEqual(matchPreviewHandoffReceipt(receipt, f.next, session.policyDigest), receipt);
  await f.previews.authorizeHeartbeat(original);
  assert.equal(f.admissions.at(-1).execution.attemptId, f.next.execution.attemptId);
  assert.equal(f.admissions.at(-1).payloadHash, receipt.requestHash);
  await assert.rejects(f.previews.open(f.sandbox, 3000, f.input), /changed on replay/);
});

test('wire rejects widened scope, added credentials, identity rewrites and deadline expansion', async () => {
  const f = await opened();
  for (const change of [
    input => { input.execution.runtime = 'other'; }, input => { input.execution.missionId = randomUUID(); },
    input => { input.execution.taskId = randomUUID(); }, input => { input.execution.requestHash = 'b'.repeat(64); },
    input => { input.execution.planRevision++; }, input => { input.execution.mandateRevision++; },
    input => { input.execution.deadlineAt = new Date(Date.parse(input.previousExecution.deadlineAt) + 1).toISOString(); },
    input => { input.execution.attemptId = input.previousExecution.attemptId; }, input => { input.execution.dispatchId = input.previousExecution.dispatchId; },
    input => { input.cookie = 'not-a-wire-field'; }, input => { input.expectedEnvironment.extra = 'no'; },
    input => { input.policy.allowedOrigins.push('https://other.test'); }, input => { input.policy.readOnly = false; },
    input => { input.policy.allowedOrigins = ['http://127.0.0.1:3000']; }, input => { input.port = 80; },
  ]) {
    const input = structuredClone(f.next); change(input); assert.throws(() => previewHandoff(input));
  }
});

test('exact replay does not transition again; renamed payload and stale predecessor cannot adopt', async () => {
  const f = await opened(), first = await f.previews.handoff(f.sandbox, f.next), authorization = f.previews.active.authorization;
  assert.deepEqual(await f.previews.handoff(f.sandbox, f.next), first); assert.strictEqual(f.previews.active.authorization, authorization);
  await assert.rejects(f.previews.handoff(f.sandbox, { ...f.next, handoffId: randomUUID() }));
  const second = { ...f.next, handoffId: randomUUID(), execution: { ...f.next.execution, attemptId: randomUUID(), dispatchId: randomUUID() } };
  await assert.rejects(f.previews.handoff(f.sandbox, second));
  assert.strictEqual(f.previews.active.authorization, authorization);
});

test('second human return uses its immediate predecessor and a new control epoch, unchanged creation', async () => {
  let epoch = 2, f;
  f = await opened({ physical: () => ({ id: f.previews.active.sessionId, status: 'ready', control: 'agent', controlEpoch: epoch,
    expiresAt: f.input.execution.deadlineAt, policyVersion: 1, policyDigest: browserPolicyDigest(f.input.policy) }) });
  await f.previews.handoff(f.sandbox, f.next);
  const next = { ...f.next, handoffId: randomUUID(), previousExecution: f.next.execution,
    execution: { ...f.next.execution, attemptId: randomUUID(), dispatchId: randomUUID(), deadlineAt: new Date(Date.parse(f.next.execution.deadlineAt) - 1000).toISOString() } };
  await assert.rejects(f.previews.handoff(f.sandbox, next), /new human return/);
  epoch = 4;
  const receipt = await f.previews.handoff(f.sandbox, next);
  assert.equal(receipt.controlEpoch, 4); assert.equal(receipt.creationRequestHash, f.next.creationRequestHash);
  assert.equal(f.requests.filter(r => r.path === '/sessions').length, 1);
});

test('actual session/control/policy/expiry mismatches deny without any authorization transition', async () => {
  for (const change of [
    row => { row.id = randomUUID(); }, row => { row.status = 'closed'; }, row => { row.control = 'human'; },
    row => { row.controlEpoch = 0; }, row => { row.policyDigest = 'b'.repeat(64); },
    row => { row.expiresAt = new Date(Date.parse(row.expiresAt) + 1000).toISOString(); },
  ]) {
    let f;
    f = await opened({ physical: () => {
      const row = { id: f.previews.active.sessionId, status: 'ready', control: 'agent', controlEpoch: 2,
        expiresAt: f.input.execution.deadlineAt, policyVersion: 1, policyDigest: browserPolicyDigest(f.input.policy) };
      change(row); return row;
    } });
    const authorization = f.previews.active.authorization, effects = f.calls.length;
    await assert.rejects(f.previews.handoff(f.sandbox, f.next));
    assert.strictEqual(f.previews.active.authorization, authorization); assert.equal(f.calls.length, effects);
  }
});

test('fixed admission denial and expiry during admission/physical read deny transfer', async () => {
  for (const boundary of ['denied', 'admission', 'physical']) {
    let f;
    f = await opened({
      admit: async value => {
        if (!value.operationId.startsWith('preview:handoff:')) return;
        if (boundary === 'denied') throw new Error('Revoked');
        if (boundary === 'admission') f.sandbox.expiresAt = 0;
      },
      physical: () => {
        if (boundary === 'physical') f.sandbox.expiresAt = 0;
        return { id: f.previews.active.sessionId, status: 'ready', control: 'agent', controlEpoch: 2,
          expiresAt: f.input.execution.deadlineAt, policyVersion: 1, policyDigest: browserPolicyDigest(f.input.policy) };
      },
    });
    const authorization = f.previews.active.authorization;
    await assert.rejects(f.previews.handoff(f.sandbox, f.next)); assert.strictEqual(f.previews.active.authorization, authorization);
  }
});

test('lost-ack status exposes only a matching physically live handoff; no admission or new effect', async () => {
  const f = await opened(), receipt = await f.previews.handoff(f.sandbox, f.next), admissions = f.admissions.length, effects = f.calls.length;
  assert.deepEqual((await f.previews.status(f.sandbox, 3000, f.input)).handoff, receipt);
  assert.equal(f.admissions.length, admissions); assert.equal(f.calls.length, effects);
  f.previews.active.authorization.execution.deadlineAt = new Date(0).toISOString();
  assert.equal((await f.previews.status(f.sandbox, 3000, f.input)).handoff, undefined);
  assert.equal((await f.previews.closeBound(f.sandbox, 3000, f.input)).confirmed, true);
  assert.equal(f.containers.size, 0); assert.equal((await f.previews.status(f.sandbox, 3000, f.input)).cleanupConfirmed, true);
});

test('absent restarted preview never transfers and cleanup still needs physical absence', async () => {
  const f = await opened(); f.previews.active = null;
  await assert.rejects(f.previews.handoff(f.sandbox, f.next));
  assert.equal((await f.previews.status(f.sandbox, 3000, f.input)).cleanupConfirmed, false);
  assert.equal(f.requests.filter(r => r.path === '/sessions').length, 1);
});

test('close racing the handoff waits, revokes the transition and cleans exactly the original resource', async () => {
  let release, reached;
  const waiting = new Promise(resolve => { reached = resolve; }), gate = new Promise(resolve => { release = resolve; });
  const f = await opened({ admit: async value => { if (value.operationId.startsWith('preview:handoff:')) { reached(); await gate; } } });
  const handoff = f.previews.handoff(f.sandbox, f.next); await waiting;
  const closing = f.previews.closeBound(f.sandbox, 3000, f.input); release();
  await assert.rejects(handoff); assert.equal((await closing).confirmed, true); assert.equal(f.previews.active, null);
});

test('receipt is exact metadata only and cannot extend authority or borrow another session', async () => {
  const f = await opened(), receipt = await f.previews.handoff(f.sandbox, f.next);
  for (const change of [
    row => { row.cookie = 'no'; }, row => { row.attemptId = randomUUID(); }, row => { row.requestHash = 'c'.repeat(64); },
    row => { row.sessionId = randomUUID(); }, row => { row.observedAt = f.next.execution.deadlineAt; }, row => { row.controlEpoch = -1; },
  ]) { const row = structuredClone(receipt); change(row); assert.throws(() => matchPreviewHandoffReceipt(row, f.next, receipt.policyDigest)); }
});
