import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { runChecks } from '../shared/test-run.ts';
import { controllerFixture } from './helpers/mission-controller-fixture.mjs';

// Real isolated PostgreSQL and controller. Model/executor/browser transport is
// synthetic. No createMissionWait in preparation: the controller must create it.
assert.equal(process.env.GRUNDEN_API_TOKEN, '');
const h = await controllerFixture(), { db, schema } = h;
const { testRunAction } = await import('../server/utils/test-runs.ts');
const { controlBrowser } = await import('../server/utils/browser.ts');
const { policyDigest } = await import('../server/utils/browser-mission-guard.ts');
const { browserAttemptCases } = await import('../server/utils/mission-browser-return.ts');
const { validateMissionComplement, proposeUnstartedBrowserRecovery } = await import('../server/utils/mission-complements.ts');
const { missionHash } = await import('../server/utils/mission-sources.ts');
const planner = h.scripts.planMission, checks = [], fixtures = [], requests = [];
const browserJob = h.scripts.browserJobAction;
h.scripts.browserJobAction = async (...args) => {
  const input = args[2];
  if (input.action === 'cancel') {
    const job = await h.row(schema.browserJobs, input.jobId);
    // Match the actual browserJobAction terminal short circuit: cancellation
    // does not relabel a completed/failed job as cancelled.
    if (job && ['completed', 'failed', 'cancelled'].includes(job.status)) return job;
  }
  return browserJob(...args);
};
h.scripts.planMission = async (...args) => {
  const result = await planner(...args);
  result.draft.cases = [0, 1, 2].map(index => ({ ...structuredClone(result.draft.cases[0]), title: `Original case ${index}` }));
  return result;
};
h.scripts.vpsBrowserRequest = async (path, method) => {
  assert.ok(fixtures.some(f => path === `/sessions/${f.assignment?.sessionId}` || path === `/sessions/${f.assignment?.sessionId}/agent?scoped=1` || path === `/sessions/${f.assignment?.sessionId}/human?scoped=1`));
  assert.ok(['DELETE', 'POST'].includes(method)); requests.push({ path, method }); return {};
};
const starts = f => h.calls.filter(call => call.missionId === f.id && call.kind === 'browser:start').length;
const execution = attempt => ({ execution: { attemptId: attempt.id, dispatchId: attempt.dispatchId } });
async function start(f, index, attempt = f.attempt) {
  const [itemId, caseId] = f.task.spec.caseKeys[index].split(':');
  return testRunAction(h.owner, f.workspace, f.thread, { action: 'start', itemId, caseId, expectedVersion: f.task.spec.planVersions.find(p => p.itemId === itemId).version,
    requestId: randomUUID(), environment: f.task.spec.target.environment, target: f.task.spec.target, mission: { missionId: f.id, taskId: f.task.id } }, execution(attempt));
}
async function finish(f, run, outcome = 'failed') {
  if (outcome === 'passed') {
    // Explicit synthetic entry receipt for the persistence contract. This test
    // does not open a page or claim actual DOM/browser evidence.
    await db.update(schema.testRuns).set({ browserEntryReceipt: { version: 1, sessionId: f.syntheticSession, requestedUrl: run.snapshot.entryUrl,
      observedUrl: run.snapshot.entryUrl, observedAt: new Date().toISOString(), callId: randomUUID() } }).where(eq(schema.testRuns.id, run.id));
  }
  return testRunAction(h.owner, f.workspace, f.thread, { action: 'finish', runId: run.id, result: { schemaVersion: 2, outcome,
    actual: 'Synthetic completed observation; no live product claim.', observations: [], evidenceItemIds: [], remaining: [],
    checks: runChecks(run.snapshot).map(check => ({ id: check.id, status: outcome === 'failed' ? 'mismatch' : 'verified', actual: 'Synthetic saved checkpoint.' })) } }, execution(f.attempt));
}
async function original({ allFinished = false, terminal = 'completed', takeover = true } = {}) {
  const f = await h.fixture(), ready = await h.browserReady(f); fixtures.push(f); f.syntheticSession = randomUUID();
  f.attempt = ready.attempts.find(a => a.kind === 'browser_tests'); f.task = ready.tasks.find(t => t.id === f.attempt.taskId);
  f.first = await start(f, 0); await finish(f, f.first); f.first = await h.row(schema.testRuns, f.first.id);
  f.interrupted = await start(f, 1);
  if (allFinished) { await finish(f, f.interrupted, 'passed'); await finish(f, await start(f, 2), 'passed'); }
  const agentId = `wrun_terminal_wait_${randomUUID()}`, sessionId = f.syntheticSession, mission = await h.row(schema.missions, f.id);
  await db.update(schema.browserJobs).set({ sessionId: agentId }).where(eq(schema.browserJobs.id, f.attempt.dispatchId));
  [f.assignment] = await db.insert(schema.browserAssignments).values({ id: randomUUID(), userId: h.owner, workspaceId: f.workspace, threadId: f.thread, agentId, sessionId,
    projectId: `self-hosted-policy-v1:${policyDigest({ version: 1, allowedOrigins: [...mission.mandate.allowedOrigins].sort(), readOnly: true, deadlineAt: f.attempt.deadlineAt.toISOString() })}`,
    liveUrl: 'https://viewer.example.test/', control: 'agent', expiresAt: f.attempt.deadlineAt }).returning();
  await db.update(schema.missionResourceClaims).set({ executorResourceId: sessionId }).where(eq(schema.missionResourceClaims.attemptId, f.attempt.id));
  if (takeover) await controlBrowser(h.owner, f.thread, 'human', sessionId);
  await db.update(schema.browserJobs).set({ status: terminal, updatedAt: new Date() }).where(eq(schema.browserJobs.id, f.attempt.dispatchId));
  await db.update(schema.missionAttempts).set({ usage: { tokens: 100, toolCalls: 2, durationMs: 1 } }).where(eq(schema.missionAttempts.id, f.attempt.id));
  assert.deepEqual(await h.rows(schema.missionWaits, f.id), []); return f;
}
async function waitFor(f) {
  await h.pass(f); const waits = await h.rows(schema.missionWaits, f.id);
  assert.equal(waits.length, 1, 'Terminal Iris before first reconciliation must produce one real human wait');
  const wait = waits[0]; assert.equal(wait.state, 'waiting'); assert.equal(wait.definition.reason, 'human_browser'); assert.deepEqual(wait.definition.taskIds, [f.task.id]);
  assert.equal(wait.definition.planRevision, f.attempt.planRevision); assert.equal(wait.definition.mandateRevision, f.attempt.mandateRevision);
  assert.equal((await h.row(schema.missionTasks, f.task.id)).state, 'waiting');
  return wait;
}
async function answer(f, wait) {
  await controlBrowser(h.owner, f.thread, 'agent', f.assignment.sessionId);
  return h.control.controlMission(h.owner, f.workspace, f.thread, { action: 'answer', missionId: f.id, waitId: wait.id,
    expectedMandateRevision: (await h.row(schema.missions, f.id)).mandateRevision, requestId: randomUUID(), answer: { kind: 'browser_returned', sessionId: f.assignment.sessionId } });
}
async function check(name, fn) {
  const first = fixtures.length;
  try { await fn(); checks.push(name); console.log(`PASS ${name}`); }
  finally {
    process.env.AUTONOMOUS_MISSIONS_ENABLED = 'true';
    // Only these synthetic test fixtures. Clear queued synthetic workers and
    // claims between checks; no real provider has been created by this script.
    for (const f of fixtures.slice(first)) {
      const assignment = f.assignment && await h.row(schema.browserAssignments, f.assignment.id);
      if (assignment?.sessionId && assignment.userId === h.owner) await controlBrowser(h.owner, f.thread, 'close', assignment.sessionId);
      await db.delete(schema.missionResourceClaims).where(eq(schema.missionResourceClaims.missionId, f.id));
      await db.update(schema.missionReports).set({ status: 'failed', leaseToken: null, leaseUntil: null }).where(and(eq(schema.missionReports.missionId, f.id), inArray(schema.missionReports.status, ['queued', 'running'])));
      await db.update(schema.resultAssessments).set({ status: 'failed', leaseToken: null, leaseUntil: null }).where(and(eq(schema.resultAssessments.workspaceId, f.workspace), inArray(schema.resultAssessments.status, ['queued', 'running'])));
    }
  }
}
try {
  for (const terminal of ['completed', 'failed']) await check(`${terminal} before first reconcile creates a bounded idempotent wait and same-session continuation`, async () => {
    const f = await original({ terminal }), wait = await waitFor(f), stopped = await h.row(schema.missionAttempts, f.attempt.id);
    assert.equal(stopped.status, terminal); assert.ok(stopped.finishedAt); assert.equal(stopped.leaseToken, null);
    const originalRuns = await db.select().from(schema.testRuns).where(eq(schema.testRuns.missionAttemptId, f.attempt.id));
    assert.equal(originalRuns.find(run => run.id === f.interrupted.id).result.outcome, 'interrupted'); assert.deepEqual(await h.row(schema.testRuns, f.first.id), f.first);
    for (let i = 0; i < 3; i++) await h.pass(f);
    assert.deepEqual(await h.rows(schema.missionWaits, f.id), [wait]); assert.equal(starts(f), 1);
    const claim = (await h.rows(schema.missionResourceClaims, f.id))[0]; assert.equal(claim.owner, 'human'); assert.equal(claim.executorResourceId, f.assignment.sessionId);
    assert.ok(wait.deadlineAt <= (await h.row(schema.missions, f.id)).deadlineAt);
    await answer(f, wait); await h.pass(f);
    const after = await h.state(f), next = after.attempts.find(a => a.kind === 'browser_tests' && a.id !== f.attempt.id); assert.ok(next);
    assert.equal(next.deadlineAt.toISOString(), f.attempt.deadlineAt.toISOString()); assert.equal(next.attemptNo, f.attempt.attemptNo + 1);
    assert.equal(after.claims.length, 1); assert.equal(after.claims[0].id, claim.id); assert.equal(after.claims[0].attemptId, next.id);
    assert.equal(after.claims[0].executorResourceId, f.assignment.sessionId); assert.deepEqual(await browserAttemptCases(db, next, f.task), f.task.spec.caseKeys.slice(1));
    assert.equal((await h.row(schema.browserAssignments, f.assignment.id)).agentId, f.assignment.agentId);
    assert.deepEqual(await h.row(schema.missionAttempts, f.attempt.id), stopped); assert.deepEqual(await db.select().from(schema.testRuns).where(eq(schema.testRuns.missionAttemptId, f.attempt.id)), originalRuns);
    await assert.rejects(start(f, 0, next), e => e.statusCode === 409); assert.equal(starts(f), 2);
    assert.ok(!requests.some(r => r.method === 'DELETE' && r.path.endsWith(f.assignment.sessionId)));
  });
  await check('all completed outcomes need no new return wait or retry', async () => {
    const f = await original({ allFinished: true }); await h.pass(f);
    assert.deepEqual(await h.rows(schema.missionWaits, f.id), []); assert.equal(starts(f), 1);
    assert.equal((await h.row(schema.missionTasks, f.task.id)).state, 'completed');
    assert.equal((await h.rows(schema.missionResourceClaims, f.id))[0].owner, 'human');
  });
  await check('takeover after terminal persistence before guarded cleanup becomes a real wait before any descendant dispatch', async () => {
    const f = await original({ takeover: false }), controllerControl = h.scripts.controlBrowser;
    let raced = false, terminalHistory;
    h.scripts.controlBrowser = async (...args) => {
      if (!raced && args[1] === f.thread && args[2] === 'close') {
        raced = true;
        terminalHistory = await h.row(schema.missionAttempts, f.attempt.id);
        assert.equal(terminalHistory.status, 'completed'); assert.equal(terminalHistory.leaseToken, null);
        await controlBrowser(h.owner, f.thread, 'human', f.assignment.sessionId);
      }
      return controllerControl(...args);
    };
    try { await h.pass(f); } finally { h.scripts.controlBrowser = controllerControl; }
    assert.equal(raced, true); assert.equal(starts(f), 1);
    assert.deepEqual(await h.rows(schema.missionWaits, f.id), []);
    const wait = await waitFor(f);
    assert.deepEqual(await h.row(schema.missionAttempts, f.attempt.id), terminalHistory);
    assert.deepEqual(await h.row(schema.testRuns, f.first.id), f.first);
    assert.equal(starts(f), 1);
    assert.ok(!requests.some(r => r.method === 'DELETE' && r.path.endsWith(f.assignment.sessionId)));
    await answer(f, wait); await h.pass(f);
    const state = await h.state(f), next = state.attempts.find(a => a.kind === 'browser_tests' && a.id !== f.attempt.id);
    assert.ok(next); assert.equal(state.claims[0].executorResourceId, f.assignment.sessionId);
    assert.deepEqual(await browserAttemptCases(db, next, f.task), f.task.spec.caseKeys.slice(1));
    assert.equal(starts(f), 2); assert.deepEqual(await h.row(schema.missionAttempts, f.attempt.id), terminalHistory);
  });
  await check('a wait observed before final saved outcomes returns without a new attempt', async () => {
    const f = await original({ terminal: 'running' }); await waitFor(f);
    // A final persistence callback already in flight may settle its own runs;
    // this does not supply new browser evidence or re-run any action.
    await finish(f, f.interrupted, 'passed');
    const [itemId, caseId] = f.task.spec.caseKeys[2].split(':');
    const [plan] = await db.select().from(schema.workspaceItems).where(eq(schema.workspaceItems.id, itemId));
    const snapshot = plan.content.cases.find(c => c.id === caseId);
    await db.insert(schema.testRuns).values({ ...f.first, id: randomUUID(), caseId, snapshot, requestId: randomUUID(), startedAt: new Date(), finishedAt: new Date(), browserEntryReceipt: null });
    await db.update(schema.browserJobs).set({ status: 'completed', updatedAt: new Date() }).where(eq(schema.browserJobs.id, f.attempt.dispatchId));
    await h.pass(f); const [wait] = await h.rows(schema.missionWaits, f.id); await answer(f, wait); await h.pass(f);
    assert.equal(starts(f), 1); assert.equal((await h.state(f)).attempts.filter(a => a.kind === 'browser_tests').length, 1);
    assert.equal((await h.row(schema.missionTasks, f.task.id)).state, 'completed');
  });
  await check('physical session cleanup cannot bypass unanswered or expired wait; final stays partial', async () => {
    const f = await original(), wait = await waitFor(f);
    await controlBrowser(h.owner, f.thread, 'close', f.assignment.sessionId);
    await h.pass(f); await h.pass(f);
    assert.equal(starts(f), 1); assert.equal((await h.state(f)).claims.length, 0);
    assert.equal((await h.row(schema.missionWaits, wait.id)).state, 'waiting');
    await db.update(schema.missionWaits).set({ deadlineAt: new Date(0) }).where(eq(schema.missionWaits.id, wait.id));
    const closed = await h.settle(f, 25);
    assert.equal(closed.mission.lifecycle, 'closed'); assert.equal((await h.row(schema.missionWaits, wait.id)).state, 'expired');
    assert.equal(starts(f), 1); assert.equal(closed.claims.length, 0);
    assert.ok(closed.reports.some(r => r.status === 'completed' && r.document?.partial));
    assert.equal(closed.tasks.filter(t => t.spec?.kind === 'browser_tests').length, 1);
    assert.deepEqual(await h.row(schema.testRuns, f.first.id), f.first);
  });
  await check('already queued descendant stays fenced after exact human wait and physical claim disappearance', async () => {
    const f = await original(); const child = await db.transaction(async tx => {
      await h.control.lockMission(tx, f.id); const mission = await h.missions.ownedMission(h.owner, f.workspace, f.id, tx);
      const operationId = `browser-remainder:${f.task.id}`;
      const next = await h.control.addMissionTask(tx, mission, { operationId, title: 'Synthetic prequeued descendant', spec: { ...f.task.spec, caseKeys: f.task.spec.caseKeys.slice(2) }, criterionIds: f.task.criterionIds });
      await h.control.recordMissionEvent(tx, mission, 'browser_remainder_planned', { version: 1, taskId: next.id, sourceTaskId: f.task.id, sourceAttemptId: f.attempt.id,
        planRevision: mission.planRevision, mandateRevision: mission.mandateRevision, caseKeys: next.spec.caseKeys, sourceSpecHash: missionHash(f.task.spec) }, operationId); return next;
    });
    // A server-issued descendant exists before observation of the takeover.
    await validateMissionComplement(db, await h.row(schema.missions, f.id), child);
    const wait = await waitFor(f); await controlBrowser(h.owner, f.thread, 'close', f.assignment.sessionId); await h.pass(f);
    assert.equal(starts(f), 1); assert.equal((await h.state(f)).claims.length, 0);
    await assert.rejects(validateMissionComplement(db, await h.row(schema.missions, f.id), child), e => e.data?.code === 'complement_stale');
    assert.equal((await h.row(schema.missionTasks, child.id)).state, 'blocked');
    assert.equal((await h.row(schema.missionWaits, wait.id)).state, 'waiting');
    assert.equal(await db.transaction(async tx => { await h.control.lockMission(tx, f.id); return proposeUnstartedBrowserRecovery(tx, await h.row(schema.missions, f.id), { ...f.task, state: 'blocked' }); }), null);
  });
  for (const expires of ['attempt', 'claim', 'assignment']) await check(`first terminal reconciliation after ${expires} expiry permanently fences human lineage without a new wait`, async () => {
    const f = await original();
    if (expires === 'attempt') await db.update(schema.missionAttempts).set({ deadlineAt: new Date(0) }).where(eq(schema.missionAttempts.id, f.attempt.id));
    if (expires === 'claim') await db.update(schema.missionResourceClaims).set({ expiresAt: new Date(0) }).where(eq(schema.missionResourceClaims.attemptId, f.attempt.id));
    if (expires === 'assignment') await db.update(schema.browserAssignments).set({ expiresAt: new Date(0) }).where(eq(schema.browserAssignments.id, f.assignment.id));
    await h.pass(f);
    assert.deepEqual(await h.rows(schema.missionWaits, f.id), []);
    const events = (await h.rows(schema.missionEvents, f.id)).filter(e => e.eventKey === `browser-return-invalidated:${f.attempt.id}`);
    assert.equal(events.length, 1); assert.deepEqual(events[0].payload, { taskId: f.task.id, attemptId: f.attempt.id });
    assert.equal((await h.row(schema.browserJobs, f.attempt.dispatchId)).status, 'completed');
    assert.equal((await h.row(schema.missionAttempts, f.attempt.id)).status, 'completed');
    assert.equal(starts(f), 1);
    await controlBrowser(h.owner, f.thread, 'close', f.assignment.sessionId);
    const closed = await h.settle(f, 25);
    assert.equal(closed.mission.lifecycle, 'closed'); assert.equal(closed.claims.length, 0);
    assert.equal(starts(f), 1); assert.equal(closed.tasks.filter(t => t.spec?.kind === 'browser_tests').length, 1);
    assert.deepEqual(await h.row(schema.testRuns, f.first.id), f.first);
    assert.equal(await db.transaction(async tx => { await h.control.lockMission(tx, f.id); return proposeUnstartedBrowserRecovery(tx, { ...closed.mission, lifecycle: 'running', phase: 'execute' }, { ...f.task, state: 'blocked' }); }), null);
    assert.equal((await h.rows(schema.missionEvents, f.id)).filter(e => e.eventKey === `browser-return-invalidated:${f.attempt.id}`).length, 1);
  });
  await check('independent saved-source review dispatches while the human browser branch waits', async () => {
    const f = await original(); const review = await db.transaction(async tx => {
      await h.control.lockMission(tx, f.id); const mission = await h.missions.ownedMission(h.owner, f.workspace, f.id, tx);
      return h.control.addMissionTask(tx, mission, { operationId: 'independent-saved-review', title: 'Independent review', spec: { kind: 'review', runIds: [f.first.id] }, criterionIds: f.task.criterionIds });
    });
    await waitFor(f); const state = await h.state(f);
    assert.ok(state.attempts.some(a => a.taskId === review.id && a.kind === 'review' && a.status === 'running'));
    assert.equal(starts(f), 1); assert.equal((await h.row(schema.missionTasks, f.task.id)).state, 'waiting');
  });
  await check('crash after committed invalidation resumes terminal settlement without duplicating history', async () => {
    const f = await original();
    await db.update(schema.missionResourceClaims).set({ expiresAt: new Date(0) }).where(eq(schema.missionResourceClaims.attemptId, f.attempt.id));
    await db.transaction(async tx => {
      await h.control.lockMission(tx, f.id);
      await h.control.recordMissionEvent(tx, await h.row(schema.missions, f.id), 'browser_return_invalidated', { taskId: f.task.id, attemptId: f.attempt.id }, `browser-return-invalidated:${f.attempt.id}`);
    });
    const before = (await h.rows(schema.missionEvents, f.id)).filter(e => e.eventKey === `browser-return-invalidated:${f.attempt.id}`);
    await h.pass(f); await h.pass(f);
    assert.equal((await h.row(schema.missionAttempts, f.attempt.id)).status, 'completed');
    assert.deepEqual((await h.rows(schema.missionEvents, f.id)).filter(e => e.eventKey === `browser-return-invalidated:${f.attempt.id}`), before);
    assert.deepEqual(await h.rows(schema.missionWaits, f.id), []); assert.equal(starts(f), 1);
  });
  for (const fault of ['pause', 'cancel', 'old-mandate', 'old-plan', 'work-deadline', 'attempt-deadline', 'flag-off', 'missing-claim', 'different-session', 'wrong-thread', 'report-phase']) await check(`${fault} does not create a new human wait`, async () => {
    const f = await original();
    if (fault === 'pause' || fault === 'cancel') await h.operate(f, fault);
    if (fault === 'old-mandate') await db.update(schema.missionAttempts).set({ mandateRevision: 0 }).where(eq(schema.missionAttempts.id, f.attempt.id));
    if (fault === 'old-plan') await db.update(schema.missionAttempts).set({ planRevision: 0 }).where(eq(schema.missionAttempts.id, f.attempt.id));
    if (fault === 'work-deadline') { const m = await h.row(schema.missions, f.id); await db.update(schema.missions).set({ deadlineAt: new Date(0), mandate: { ...m.mandate, deadlineAt: new Date(0).toISOString() } }).where(eq(schema.missions.id, f.id)); }
    if (fault === 'attempt-deadline') await db.update(schema.missionAttempts).set({ deadlineAt: new Date(0) }).where(eq(schema.missionAttempts.id, f.attempt.id));
    if (fault === 'flag-off') process.env.AUTONOMOUS_MISSIONS_ENABLED = 'false';
    if (fault === 'missing-claim') await db.delete(schema.missionResourceClaims).where(eq(schema.missionResourceClaims.attemptId, f.attempt.id));
    if (fault === 'different-session') await db.update(schema.missionResourceClaims).set({ executorResourceId: randomUUID() }).where(eq(schema.missionResourceClaims.attemptId, f.attempt.id));
    if (fault === 'wrong-thread') await db.update(schema.browserAssignments).set({ threadId: randomUUID() }).where(eq(schema.browserAssignments.id, f.assignment.id));
    if (fault === 'report-phase') await db.update(schema.missions).set({ phase: 'report' }).where(eq(schema.missions.id, f.id));
    await h.pass(f); assert.deepEqual(await h.rows(schema.missionWaits, f.id), []);
    if (fault === 'wrong-thread') await db.update(schema.browserAssignments).set({ threadId: f.thread }).where(eq(schema.browserAssignments.id, f.assignment.id));
  });
  await check('in-flight control lock defers terminal settlement, then creates one wait', async () => {
    const f = await original();
    await db.transaction(async tx => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`browser:${f.workspace}:${f.thread}:${f.assignment.agentId}`},0))`);
      const began = Date.now(); await h.pass(f); assert.ok(Date.now() - began < 3000);
      assert.equal((await h.row(schema.missionAttempts, f.attempt.id)).status, f.attempt.status);
      assert.deepEqual(await h.rows(schema.missionWaits, f.id), []);
    });
    await waitFor(f);
  });
} finally { await h.close(); }
console.log(JSON.stringify({ passed: checks.length, checks, database: 'actual isolated PostgreSQL when explicitly run', executor: 'synthetic', modelCalls: 0, physicalBrowser: false }));
