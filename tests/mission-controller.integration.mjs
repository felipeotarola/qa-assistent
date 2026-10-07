import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { controllerFixture } from './helpers/mission-controller-fixture.mjs';

// Actual isolated PostgreSQL and authored controller/queue/worker persistence.
// Page observations, planning/report models and browser executor are synthetic.
// This is deliberately not provider/browser/scheduler end-to-end acceptance.
const h = await controllerFixture(), { db, schema } = h, passed = [], failures = [];
async function check(name, fn) { try { await fn(); passed.push(name); } catch (error) { failures.push({ name, message: error.message, stack: error.stack }); console.error(`FAILED ${name}: ${error.message}`); } }
const ids = s => ({ tasks: s.tasks.map(t => t.id).sort(), attempts: s.attempts.map(a => a.id).sort(), jobs: s.attempts.filter(a => a.kind === 'browser_tests').map(a => a.dispatchId) });
async function reservedBrowser(f) {
  const planned = await h.until(f, s => s.tasks.some(t => t.spec.kind === 'browser_tests'));
  await db.update(schema.missions).set({ nextWakeAt: new Date(0) }).where(eq(schema.missions.id, f.id));
  const claimed = await h.attempts.claimMission(f.id); assert.ok(claimed);
  const lease = h.attempts.leaseIdentity(claimed), task = planned.tasks.find(t => t.spec.kind === 'browser_tests');
  const reserved = await h.attempts.reserveMissionAttempt(lease, task.id, { usesModel: true, resource: { kind: 'browser', poolKey: process.env.BROWSER_SERVICE_URL ?? 'browser-provider' } });
  assert.equal(reserved.status, 'reserved');
  await h.attempts.releaseMissionLease(lease, 0);
  return reserved;
}
try {
  assert.equal(process.env.GRUNDEN_API_TOKEN, '');
  await check('frozen plan edit before dispatch produces no browser job and releases its reserved resource', async () => {
    const f = await h.fixture();
    const s = await h.until(f, s => s.tasks.some(t => t.spec.kind === 'browser_tests'));
    const task = s.tasks.find(t => t.spec.kind === 'browser_tests'), expected = task.spec.planVersions[0], plan = await h.row(schema.workspaceItems, expected.itemId);
    await h.saveItem(h.owner, f.workspace, { id: plan.id, expectedVersion: plan.version, title: 'User edited plan', content: { ...plan.content, summary: 'Changed before browser dispatch' } });
    await h.pass(f);
    const after = await h.state(f), attempt = after.attempts.find(a => a.kind === 'browser_tests');
    assert.ok(attempt); assert.equal(attempt.status, 'failed'); assert.equal(after.claims.length, 0);
    assert.equal(await h.row(schema.browserJobs, attempt.dispatchId), undefined);
    assert.equal(h.calls.filter(c => c.kind === 'browser:start' && c.missionId === f.id).length, 0);
  });
  await check('failure before Iris admission retries the same persisted job and attempt', async () => {
    const f = await h.fixture({ mode: 'preadmission' }), initial = await h.browserReady(f), attempt = initial.attempts.find(a => a.kind === 'browser_tests');
    assert.equal(attempt.status, 'dispatch_unknown'); assert.equal((await h.row(schema.browserJobs, attempt.dispatchId)).status, 'starting');
    await h.pass(f);
    const after = await h.state(f); assert.deepEqual(ids(after), ids(initial)); assert.equal(after.claims.length, 1);
    assert.equal((await h.row(schema.browserJobs, attempt.dispatchId)).status, 'running');
    assert.deepEqual(h.calls.filter(c => c.kind === 'browser:start' && c.missionId === f.id).map(c => c.jobId), [attempt.dispatchId, attempt.dispatchId]);
  });
  await check('restart after reservation dispatches the same still-valid browser intent', async () => {
    const f = await h.fixture(), reserved = await reservedBrowser(f);
    assert.equal(await h.row(schema.browserJobs, reserved.attempt.dispatchId), undefined);
    await h.pass(f);
    const s = await h.state(f), own = s.attempts.filter(a => a.kind === 'browser_tests');
    assert.equal(own.length, 1); assert.equal(own[0].id, reserved.attempt.id); assert.equal(s.claims.length, 1);
    assert.equal((await h.row(schema.browserJobs, reserved.attempt.dispatchId)).status, 'running');
  });
  await check('plan edit after reservation but before restarted dispatch fails the intent and releases its claim', async () => {
    const f = await h.fixture(), reserved = await reservedBrowser(f), expected = reserved.task.spec.planVersions[0], plan = await h.row(schema.workspaceItems, expected.itemId);
    await h.saveItem(h.owner, f.workspace, { id: plan.id, expectedVersion: plan.version, title: 'Edited after reservation', content: { ...plan.content, summary: 'Edited in crash window' } });
    await h.pass(f); await h.pass(f);
    const s = await h.state(f); assert.equal((await h.row(schema.missionAttempts, reserved.attempt.id)).status, 'failed');
    assert.equal(s.claims.length, 0); assert.equal(await h.row(schema.browserJobs, reserved.attempt.dispatchId), undefined);
  });
  await check('expired reserved intent with no external job is settled and releases its resource', async () => {
    const f = await h.fixture(), reserved = await reservedBrowser(f);
    await db.update(schema.missionAttempts).set({ deadlineAt: new Date(Date.now() - 1000) }).where(eq(schema.missionAttempts.id, reserved.attempt.id));
    await h.pass(f); await h.pass(f);
    const s = await h.state(f), attempt = s.attempts.find(a => a.id === reserved.attempt.id);
    assert.ok(['failed', 'cancelled'].includes(attempt.status)); assert.equal(s.claims.length, 0);
    assert.equal(await h.row(schema.browserJobs, reserved.attempt.dispatchId), undefined);
  });
  await check('pending browser observation does not resend or duplicate task/attempt identities', async () => {
    const f = await h.fixture(), initial = await h.browserReady(f);
    await h.pass(f); await h.pass(f); await h.pass(f);
    assert.deepEqual(ids(await h.state(f)), ids(initial));
    assert.equal(h.calls.filter(c => c.kind === 'browser:start' && c.missionId === f.id).length, 1);
  });
  await check('disabled autonomy never dispatches a recovered reserved browser intent', async () => {
    const f = await h.fixture(), reserved = await reservedBrowser(f), before = h.calls.length;
    process.env.AUTONOMOUS_MISSIONS_ENABLED = 'false';
    try { await h.pass(f); } finally { process.env.AUTONOMOUS_MISSIONS_ENABLED = 'true'; }
    assert.equal(h.calls.slice(before).filter(c => c.kind === 'browser:start').length, 0);
    assert.equal(await h.row(schema.browserJobs, reserved.attempt.dispatchId), undefined);
  });
  await check('disabled autonomy never retries a pre-admission browser dispatch', async () => {
    const f = await h.fixture({ mode: 'preadmission' }); await h.browserReady(f); const before = h.calls.length;
    process.env.AUTONOMOUS_MISSIONS_ENABLED = 'false';
    try { await h.pass(f); } finally { process.env.AUTONOMOUS_MISSIONS_ENABLED = 'true'; }
    assert.equal(h.calls.slice(before).filter(c => c.kind === 'browser:start').length, 0);
  });
  await check('uncertain admitted browser exceeds bounded stop wait, retains claim, and can deliver a partial report', async () => {
    const f = await h.fixture({ mode: 'unknown' }), initial = await h.browserReady(f), attempt = initial.attempts.find(a => a.kind === 'browser_tests');
    const deadline = new Date(Date.now() - 130000);
    await db.update(schema.missionAttempts).set({ deadlineAt: deadline }).where(eq(schema.missionAttempts.id, attempt.id));
    await db.update(schema.missions).set({ deadlineAt: deadline, mandate: { ...initial.mission.mandate, issuedAt: new Date(Date.now() - 600000).toISOString(), deadlineAt: deadline.toISOString() } }).where(eq(schema.missions.id, f.id));
    await h.pass(f);
    const bounded = await h.state(f); assert.equal(bounded.attempts.find(a => a.id === attempt.id).status, 'failed');
    assert.equal(bounded.claims.length, 1); assert.equal(bounded.claims[0].state, 'uncertain');
    assert.equal((await h.row(schema.browserJobs, attempt.dispatchId)).status, 'cancelling');
    const closed = await h.settle(f); assert.equal(closed.mission.lifecycle, 'closed'); assert.equal(closed.mission.closureReason, 'deadline');
    assert.equal(closed.reports.length, 1); assert.equal(closed.reports[0].document.partial, true); assert.equal(closed.claims.length, 1);
    assert.equal(h.calls.filter(c => c.kind === 'browser:start' && c.missionId === f.id).length, 1);
  });
  await check('report and attempt binding commit atomically and survive acknowledgement loss without duplicate delivery', async () => {
    const f = await h.fixture({ intent: 'report_only' }); f.crashAfterReportQueue = true;
    await h.pass(f);
    const interrupted = await h.state(f); assert.equal(interrupted.reports.length, 1);
    assert.equal(interrupted.attempts[0].executorResourceId, interrupted.reports[0].id);
    await h.workers(f); // Even a completed report must be found after the crash.
    await h.pass(f);
    const recovered = await h.state(f); assert.equal(recovered.reports.length, 1); assert.equal(recovered.reports[0].id, interrupted.reports[0].id);
    assert.equal(recovered.attempts[0].executorResourceId, interrupted.reports[0].id);
    const closed = await h.settle(f); assert.equal(closed.reports.length, 1); assert.equal(closed.mission.lifecycle, 'closed');
    assert.ok(closed.reports[0].document.evidence.some(e => e.itemId === f.admission.sourceRefs[0].id), 'Report-only keeps its selected source in the frozen report');
    assert.equal(h.calls.filter(c => ['research', 'browser:start'].includes(c.kind) && c.missionId === f.id).length, 0);
  });
  await check('report queue requires the exact current report attempt before binding or creating a delivery', async () => {
    const f = await h.fixture({ intent: 'report_only' }), claimed = await h.attempts.claimMission(f.id), lease = h.attempts.leaseIdentity(claimed);
    const initial = await h.state(f), reservation = await h.attempts.reserveMissionAttempt(lease, initial.tasks[0].id, { usesModel: true });
    assert.equal(reservation.status, 'reserved');
    await h.attempts.markMissionDispatch(lease, reservation.attempt.id);
    await assert.rejects(h.missions.requestMissionReport(h.owner, f.workspace, f.id, false, { ...lease, attemptId: randomUUID() }), error => error.statusCode === 409);
    assert.equal((await h.state(f)).reports.length, 0);
    const requested = await h.missions.requestMissionReport(h.owner, f.workspace, f.id, false, { ...lease, attemptId: reservation.attempt.id });
    assert.equal((await h.row(schema.missionAttempts, reservation.attempt.id)).executorResourceId, requested.reportId);
    await h.attempts.releaseMissionLease(lease, 0);
    const closed = await h.settle(f); assert.equal(closed.reports.length, 1);
  });
  await check('discovery completion committed before successor creation reconstructs exactly one planning task', async () => {
    const f = await h.fixture(); await h.pass(f);
    const committed = await h.state(f); assert.equal(committed.tasks.length, 1); assert.equal(committed.tasks[0].state, 'completed');
    const sourceId = committed.tasks[0].sources[0].id; assert.ok(await h.row(schema.workspaceItems, sourceId));
    // Restart uses no in-memory continuation: a new controller pass sees only
    // committed task/source rows and must reconstruct the missing successor.
    await h.pass(f); await h.pass(f);
    const recovered = await h.state(f); assert.equal(recovered.tasks.filter(t => t.spec.kind === 'planning').length, 1);
    assert.equal(h.calls.filter(c => c.kind === 'research' && c.missionId === f.id).length, 1);
    assert.equal(recovered.tasks.find(t => t.spec.kind === 'planning').spec.sourceRefs[0].id, sourceId);
  });
  await check('pause stops current browser and prevents planning/execution successors until explicit resume', async () => {
    const f = await h.fixture(), initial = await h.browserReady(f), count = h.calls.length;
    await h.operate(f, 'pause'); await h.pass(f); await h.pass(f);
    const paused = await h.state(f); assert.equal(paused.mission.lifecycle, 'paused'); assert.equal(paused.claims.length, 0); assert.equal(paused.reports.length, 0);
    assert.equal(paused.attempts.find(a => a.kind === 'browser_tests').status, 'cancelled');
    assert.equal(h.calls.slice(count).filter(c => ['research', 'plan', 'browser:start'].includes(c.kind)).length, 0);
    assert.deepEqual(paused.tasks.map(t => t.id).sort(), initial.tasks.map(t => t.id).sort());
  });
  await check('cancel preserves saved sources and produces a partial cancellation report without more testing', async () => {
    const f = await h.fixture(), initial = await h.browserReady(f), source = initial.tasks.find(t => t.spec.kind === 'discovery').sources[0].id;
    await h.operate(f, 'cancel');
    const closed = await h.settle(f); assert.equal(closed.mission.closureReason, 'cancelled'); assert.equal(closed.claims.length, 0);
    assert.ok(await h.row(schema.workspaceItems, source)); assert.equal(closed.reports[0].document.partial, true);
    assert.equal(h.calls.filter(c => c.kind === 'browser:start' && c.missionId === f.id).length, 1);
  });
  await check('cancel while report is queued reaches bounded closure without duplicate delivery', async () => {
    const f = await h.fixture({ intent: 'report_only' }); await h.pass(f);
    const before = await h.state(f); assert.equal(before.reports.length, 1);
    await h.operate(f, 'cancel');
    const closed = await h.settle(f); assert.equal(closed.mission.lifecycle, 'closed'); assert.equal(closed.mission.closureReason, 'cancelled');
    assert.equal(closed.reports.length, 1);
  });
  await check('report deleted after persistence but before controller acknowledgement closes as delivery_failed', async () => {
    const f = await h.fixture({ intent: 'report_only' });
    await h.pass(f); await h.workers(f);
    const saved = await h.state(f), report = saved.reports[0], attempt = saved.attempts.find(row => row.kind === 'report');
    assert.equal(report.status, 'completed'); assert.ok(report.itemId);
    assert.equal(saved.mission.lifecycle, 'running');
    // A real UI delete can win this window. Expiry must not leave the completed
    // but unavailable source branch ahead of the controller's timeout handling.
    await db.update(schema.workspaceItems).set({ deletedAt: new Date() }).where(eq(schema.workspaceItems.id, report.itemId));
    await db.update(schema.missionAttempts).set({ deadlineAt: new Date(Date.now() - 1000) }).where(eq(schema.missionAttempts.id, attempt.id));
    const before = h.calls.length;
    await h.pass(f); await h.pass(f);
    const closed = await h.state(f);
    assert.equal(closed.mission.lifecycle, 'closed');
    assert.equal(closed.mission.closureReason, 'delivery_failed');
    assert.equal(closed.attempts.find(row => row.id === attempt.id).status, 'failed');
    assert.equal(closed.reports.length, 1, 'Explicitly deleted delivery must not be recreated');
    assert.ok((await h.row(schema.workspaceItems, report.itemId)).deletedAt);
    assert.equal(h.calls.slice(before).filter(call => ['report:queue', 'report:model'].includes(call.kind)).length, 0);
  });
  await check('lease loss after committed report completion recovers mission closure without another report', async () => {
    const f = await h.fixture({ intent: 'report_only' });
    await h.pass(f); await h.workers(f);
    const executors = globalThis.missionControllerFixtureExecutors, original = executors.currentMissionDelivery;
    let injected = false;
    executors.currentMissionDelivery = async (...args) => {
      const state = await h.state(f);
      if (!injected && args[1] === f.id && state.attempts.some(attempt => attempt.kind === 'report' && attempt.status === 'completed')) {
        injected = true;
        // Finish was durable, but the process loses its controller lease before
        // closure can commit. Recovery must derive closure from saved facts.
        await db.update(schema.missions).set({ leaseUntil: new Date(0) }).where(eq(schema.missions.id, f.id));
        throw Object.assign(new Error('Synthetic lease loss after committed report receipt'), { statusCode: 409 });
      }
      return original(...args);
    };
    try { await h.pass(f); } finally { executors.currentMissionDelivery = original; }
    assert.equal(injected, true, 'Fault must land after committed report completion');
    const interrupted = await h.state(f);
    assert.equal(interrupted.mission.lifecycle, 'running');
    assert.equal(interrupted.attempts.find(attempt => attempt.kind === 'report').status, 'completed');
    const before = h.calls.length;
    await h.pass(f); await h.pass(f);
    const closed = await h.state(f);
    assert.equal(closed.mission.lifecycle, 'closed');
    assert.equal(closed.reports.length, 1);
    assert.equal(closed.attempts.filter(attempt => attempt.kind === 'report').length, 1);
    assert.equal(h.calls.slice(before).filter(call => ['report:queue', 'report:model'].includes(call.kind)).length, 0);
  });
  await check('answered wait reconciles the obsolete active executor before a new bounded attempt', async () => {
    const f = await h.fixture(), initial = await h.browserReady(f), attempt = initial.attempts.find(a => a.kind === 'browser_tests');
    const wait = await db.transaction(async tx => {
      await h.control.lockMission(tx, f.id);
      return h.control.createMissionWait(tx, initial.mission, { reason: 'clarification', taskIds: [attempt.taskId], question: 'Confirm the observed navigation target.' });
    });
    await h.pass(f);
    assert.equal((await h.state(f)).tasks.find(t => t.id === attempt.taskId).state, 'waiting');
    await h.control.controlMission(h.owner, f.workspace, f.thread, { action: 'answer', missionId: f.id, requestId: randomUUID(), expectedMandateRevision: initial.mission.mandateRevision, waitId: wait.id, answer: { kind: 'text', text: 'Use the observed Articles link.' } });
    await h.pass(f); await h.pass(f);
    const reconciled = await h.state(f), previous = reconciled.attempts.find(a => a.id === attempt.id);
    assert.ok(['cancelled', 'failed'].includes(previous.status), 'A task set back to pending must stop its now-unauthorized executor');
    assert.ok(reconciled.attempts.filter(a => a.kind === 'browser_tests').length <= 2);
    assert.ok(h.calls.some(c => c.missionId === f.id && c.kind === 'browser:cancel' && c.jobId === attempt.dispatchId));
  });
  await check('actual graph persists discovery, plan, browser runs, deterministic review and synthetic model report', async () => {
    const f = await h.fixture(); await h.browserReady(f); const runs = await h.finishBrowser(f);
    const closed = await h.settle(f), kinds = closed.tasks.map(t => t.spec.kind);
    for (const kind of ['discovery', 'planning', 'browser_tests', 'review', 'report']) assert.equal(kinds.filter(k => k === kind).length, 1);
    assert.equal(closed.attempts.length, 5); assert.ok(closed.attempts.every(a => a.status === 'completed')); assert.equal(closed.claims.length, 0);
    assert.equal(closed.mission.closureReason, 'blocked'); assert.equal(closed.reports[0].document.partial, true);
    for (const run of runs) {
      const [review] = await db.select().from(schema.resultAssessments).where(eq(schema.resultAssessments.runId, run.id));
      assert.equal(review.status, 'completed'); assert.equal(review.assessment.verdict, 'needs_evidence'); assert.equal(review.model, 'deterministic-rules');
      assert.equal((await h.row(schema.testRuns, run.id)).result.outcome, 'inconclusive');
    }
    assert.ok(await h.row(schema.workspaceItems, closed.reports[0].itemId));
    assert.equal(closed.reports[0].document.tests.length, runs.length);
    const replay = await h.pass(f); assert.equal(replay.processed, false); assert.deepEqual(ids(await h.state(f)), ids(closed));
  });
  await check('closed cleanup retains an unknown stop and releases only after a later terminal receipt', async () => {
    const f = await h.closedClaim({ unknown: true });
    await h.reconcileClosedMissionResources();
    assert.ok(await h.row(schema.missionResourceClaims, f.claim.id));
    assert.equal((await h.row(schema.browserJobs, f.attempt.dispatchId)).status, 'cancelling');
    await db.update(schema.browserJobs).set({ status: 'cancelled' }).where(eq(schema.browserJobs.id, f.attempt.dispatchId));
    for (let i = 0; i < 3 && await h.row(schema.missionResourceClaims, f.claim.id); i++) await h.reconcileClosedMissionResources();
    assert.equal(await h.row(schema.missionResourceClaims, f.claim.id), undefined);
    assert.equal((await h.row(schema.missions, f.id)).lifecycle, 'closed');
    assert.equal(h.calls.filter(c => c.missionId === f.id && c.kind === 'browser:start').length, 1);
  });
  await check('closed terminal executor closes its matching agent browser before releasing the claim', async () => {
    const f = await h.closedClaim(), browser = await h.assignment(f), before = h.calls.length;
    for (let i = 0; i < 3 && await h.row(schema.missionResourceClaims, f.claim.id); i++) await h.reconcileClosedMissionResources();
    assert.equal(await h.row(schema.missionResourceClaims, f.claim.id), undefined);
    assert.equal((await h.row(schema.browserAssignments, browser.id)).sessionId, null);
    assert.deepEqual(h.calls.slice(before).filter(c => c.kind === 'provider:delete').map(c => c.path), [`/sessions/${browser.sessionId}`]);
    assert.equal(h.calls.slice(before).find(c => c.kind === 'browser:control' && c.sessionId === browser.sessionId).options.requireAgentControl, true);
  });
  for (const expired of [false, true]) await check(`closed cleanup preserves ${expired ? 'expired' : 'live'} human browser ownership without physical deletion`, async () => {
    const f = await h.closedClaim(), browser = await h.assignment(f, { human: true, expired }), before = h.calls.length;
    for (let i = 0; i < 3; i++) await h.reconcileClosedMissionResources();
    assert.equal((await h.row(schema.missionResourceClaims, f.claim.id))?.owner, 'human');
    assert.equal((await h.row(schema.browserAssignments, browser.id)).sessionId, browser.sessionId);
    assert.equal(h.calls.slice(before).filter(c => c.kind === 'provider:delete' && c.path === `/sessions/${browser.sessionId}`).length, 0);
  });
  await check('closed cleanup ignores another runtime without observing or releasing its executor', async () => {
    const f = await h.closedClaim({ unknown: true }), before = h.calls.length, other = `${process.env.PAT_RUNTIME_SCOPE}-other`;
    await db.update(schema.missions).set({ runtime: other }).where(eq(schema.missions.id, f.id));
    await db.update(schema.missionAttempts).set({ runtime: other }).where(eq(schema.missionAttempts.id, f.attempt.id));
    await db.update(schema.missionResourceClaims).set({ runtime: other }).where(eq(schema.missionResourceClaims.id, f.claim.id));
    await db.update(schema.browserJobs).set({ runtime: other }).where(eq(schema.browserJobs.id, f.attempt.dispatchId));
    await h.reconcileClosedMissionResources();
    assert.ok(await h.row(schema.missionResourceClaims, f.claim.id));
    assert.equal(h.calls.slice(before).filter(c => c.missionId === f.id).length, 0);
  });
  await check('closed cleanup does not trust a terminal job from a mismatched runtime or thread', async () => {
    const f = await h.closedClaim(), other = await h.fixture(), before = h.calls.length;
    await db.update(schema.browserJobs).set({ runtime: `${process.env.PAT_RUNTIME_SCOPE}-other`, threadId: other.thread }).where(eq(schema.browserJobs.id, f.attempt.dispatchId));
    for (let i = 0; i < 3; i++) await h.reconcileClosedMissionResources();
    assert.ok(await h.row(schema.missionResourceClaims, f.claim.id));
    assert.equal(h.calls.slice(before).filter(c => c.missionId === f.id).length, 0);
  });
  await check('closed cleanup preserves resources when the mission owner no longer owns the workspace', async () => {
    const f = await h.closedClaim(), browser = await h.assignment(f), other = randomUUID(), before = h.calls.length;
    await db.insert(schema.user).values({ id: other, name: 'Other fixture owner', email: `${other}@example.test` });
    try {
      await db.update(schema.workspaces).set({ userId: other }).where(eq(schema.workspaces.id, f.workspace));
      for (let i = 0; i < 3; i++) await h.reconcileClosedMissionResources();
      assert.ok(await h.row(schema.missionResourceClaims, f.claim.id));
      assert.equal((await h.row(schema.browserAssignments, browser.id)).sessionId, browser.sessionId);
      assert.equal(h.calls.slice(before).filter(c => c.kind === 'provider:delete' && c.path === `/sessions/${browser.sessionId}`).length, 0);
    } finally {
      await db.update(schema.workspaces).set({ userId: h.owner }).where(eq(schema.workspaces.id, f.workspace));
      await db.delete(schema.user).where(eq(schema.user.id, other));
    }
  });
  await check('closed cleanup bounds each batch and rotates past unknown executors to later terminal work', async () => {
    const runtime = process.env.PAT_RUNTIME_SCOPE;
    process.env.PAT_RUNTIME_SCOPE = `${runtime}-bounded`;
    try {
      const unknown = [];
      for (let i = 0; i < 3; i++) unknown.push(await h.closedClaim({ unknown: true }));
      const terminal = await h.closedClaim();
      for (let pass = 0; pass < 3; pass++) {
        const before = h.calls.length, processed = await h.reconcileClosedMissionResources();
        assert.ok(processed <= 3); assert.ok(h.calls.slice(before).filter(c => c.kind === 'browser:status').length <= 3);
      }
      assert.equal(await h.row(schema.missionResourceClaims, terminal.claim.id), undefined);
      for (const f of unknown) assert.ok(await h.row(schema.missionResourceClaims, f.claim.id));
    } finally { process.env.PAT_RUNTIME_SCOPE = runtime; }
  });
} finally { await h.close(); }
console.log(JSON.stringify({ passed: passed.length, checks: passed, failures }, null, 2));
if (failures.length) process.exitCode = 1;
