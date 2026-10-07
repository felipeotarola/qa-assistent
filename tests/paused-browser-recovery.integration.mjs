import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { controllerFixture } from './helpers/mission-controller-fixture.mjs';
import { fingerprint } from './helpers/evidence-acceptance.mjs';

// Real PostgreSQL/controller/job receipt and test-run reconciliation. Only the
// remote Eve status transport is synthetic; no provider or browser is started.
const h = await controllerFixture(), { db, schema } = h;
const { browserJobAction } = await import('../server/utils/browser-jobs.ts');
const { testRunAction } = await import('../server/utils/test-runs.ts');
const originalAction = h.scripts.browserJobAction, originalFetch = globalThis.fetch;
const passed = [], remote = new Map(), requests = [];
h.scripts.browserJobAction = (...args) => args[2].action === 'status' ? browserJobAction(...args) : originalAction(...args);
globalThis.fetch = async (url, init) => {
  assert.equal(new URL(url).pathname, '/eve/v1/workers/iris');
  const request = JSON.parse(init.body); assert.equal(request.action, 'status');
  const expected = remote.get(request.jobId); assert.ok(expected, 'Only the exact fixture executor may be observed');
  assert.equal(request.userId, h.owner); assert.equal(request.threadId, expected.threadId);
  requests.push({ jobId: request.jobId, action: request.action });
  if (expected.error) throw new Error('Synthetic lost status response');
  return Response.json(expected.response);
};
async function fixture() {
  const f = await h.fixture({ mode: 'unknown' }), state = await h.browserReady(f);
  const attempt = state.attempts.find(a => a.kind === 'browser_tests'), task = state.tasks.find(t => t.id === attempt.taskId);
  const sessionId = `paused-recovery-${randomUUID()}`;
  await db.update(schema.browserJobs).set({ status: 'running', sessionId }).where(eq(schema.browserJobs.id, attempt.dispatchId));
  const [itemId, caseId] = task.spec.caseKeys[0].split(':');
  const run = await testRunAction(h.owner, f.workspace, f.thread, { action: 'start', itemId, caseId, expectedVersion: task.spec.planVersions[0].version,
    requestId: randomUUID(), environment: task.spec.target.environment, target: task.spec.target, mission: { missionId: f.id, taskId: task.id } },
  { execution: { attemptId: attempt.id, dispatchId: attempt.dispatchId } });
  await h.operate(f, 'pause');
  // The actual controller's bounded grace expires while the worker ACK is lost.
  await db.update(schema.missionAttempts).set({ cancelRequestedAt: new Date(Date.now() - 180000) }).where(eq(schema.missionAttempts.id, attempt.id));
  await h.pass(f);
  const paused = await h.state(f);
  assert.equal(paused.mission.lifecycle, 'paused'); assert.equal(paused.attempts.find(a => a.id === attempt.id).status, 'failed');
  assert.equal(paused.claims.length, 1); assert.equal((await h.row(schema.browserJobs, attempt.dispatchId)).status, 'cancelling');
  remote.set(attempt.dispatchId, { threadId: f.thread, response: { status: 'dispatch_unknown' } });
  return { f, attempt, run, sessionId, paused };
}
async function check(name, fn) { await fn(); passed.push(name); }
try {
  await check('paused logical failure recovers lost terminal callback through status with autonomy disabled', async () => {
    const c = await fixture(), beforeCalls = h.calls.length;
    const savedHistory = fingerprint({ tasks: c.paused.tasks, attempts: c.paused.attempts, reports: c.paused.reports });
    const worker = remote.get(c.attempt.dispatchId);
    worker.response = { sessionId: c.sessionId, status: 'cancelled', report: 'Synthetic original durable terminal receipt.' };
    process.env.AUTONOMOUS_MISSIONS_ENABLED = 'false';
    try { await h.pass(c.f); } finally { process.env.AUTONOMOUS_MISSIONS_ENABLED = 'true'; }
    assert.equal(requests.filter(r => r.jobId === c.attempt.dispatchId).length, 1, 'Background cleanup must read the original executor after a lost callback');
    const after = await h.state(c.f), run = await h.row(schema.testRuns, c.run.id);
    assert.equal(after.claims.length, 0); assert.equal(after.mission.lifecycle, 'paused');
    assert.equal(run.result.outcome, 'interrupted'); assert.ok(run.finishedAt);
    assert.equal(fingerprint({ tasks: after.tasks, attempts: after.attempts, reports: after.reports }), savedHistory);
    assert.equal((await db.select().from(schema.resultAssessments).where(eq(schema.resultAssessments.runId, c.run.id))).length, 0);
    assert.ok(!h.calls.slice(beforeCalls).some(call => /model|queue|browser:start/.test(call.kind)));
    await h.pass(c.f); assert.equal(requests.filter(r => r.jobId === c.attempt.dispatchId).length, 1, 'Released claims do not keep polling');
  });
  await check('missing, failed and wrong-session observations preserve uncertainty until the exact terminal receipt', async () => {
    const c = await fixture(), worker = remote.get(c.attempt.dispatchId);
    const history = fingerprint(await h.row(schema.testRuns, c.run.id));
    for (const variant of ['missing', 'network', 'active', 'wrong-session']) {
      worker.error = variant === 'network'; worker.response = variant === 'active' ? { sessionId: c.sessionId, status: 'running' }
        : variant === 'wrong-session' ? { sessionId: 'foreign-session', status: 'cancelled' } : { status: 'dispatch_unknown' };
      await h.pass(c.f);
      assert.equal((await h.state(c.f)).claims.length, 1, variant); assert.equal(fingerprint(await h.row(schema.testRuns, c.run.id)), history, variant);
      assert.equal((await h.row(schema.browserJobs, c.attempt.dispatchId)).status, 'cancelling', variant);
    }
    worker.error = false; worker.response = { sessionId: c.sessionId, status: 'cancelled' }; await h.pass(c.f);
    assert.equal((await h.state(c.f)).claims.length, 0); assert.equal((await h.row(schema.testRuns, c.run.id)).result.outcome, 'interrupted');
  });
  await check('foreign runtime or thread cannot be polled or used as a cleanup receipt', async () => {
    const c = await fixture(), before = requests.length, other = await h.fixture();
    for (const value of [{ runtime: `${process.env.PAT_RUNTIME_SCOPE}-other` }, { runtime: process.env.PAT_RUNTIME_SCOPE, threadId: other.thread }]) {
      await db.update(schema.browserJobs).set(value).where(eq(schema.browserJobs.id, c.attempt.dispatchId)); await h.pass(c.f);
      assert.equal(requests.length, before); assert.equal((await h.state(c.f)).claims.length, 1); assert.equal((await h.row(schema.testRuns, c.run.id)).result, null);
    }
    await db.update(schema.browserJobs).set({ runtime: process.env.PAT_RUNTIME_SCOPE, threadId: c.f.thread }).where(eq(schema.browserJobs.id, c.attempt.dispatchId));
  });
  await check('terminal status recovery preserves physical human ownership', async () => {
    const c = await fixture(), claim = (await h.state(c.f)).claims[0];
    const assignment = await h.assignment({ ...c.f, attempt: c.attempt, claim }, { human: true, expired: true });
    remote.get(c.attempt.dispatchId).response = { sessionId: assignment.agentId, status: 'cancelled' };
    const before = h.calls.length; await h.pass(c.f);
    const after = await h.state(c.f);
    assert.equal(after.claims[0].owner, 'human'); assert.equal((await h.row(schema.browserAssignments, assignment.id)).sessionId, assignment.sessionId);
    assert.equal((await h.row(schema.testRuns, c.run.id)).result.outcome, 'interrupted');
    assert.ok(!h.calls.slice(before).some(call => call.kind === 'provider:delete'));
    assert.equal((await db.select().from(schema.missionEvents).where(and(eq(schema.missionEvents.missionId, c.f.id), eq(schema.missionEvents.kind, 'test_run_interrupted')))).length, 1);
  });
  console.log(JSON.stringify({ passed, checks: passed.length, scope: 'Actual isolated PostgreSQL/controller/original-job receipt; synthetic remote Eve status only; no live acceptance.' }, null, 2));
} finally { h.scripts.browserJobAction = originalAction; globalThis.fetch = originalFetch; await h.close(); }
