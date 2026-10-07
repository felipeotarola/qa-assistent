import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { eq, inArray, sql } from 'drizzle-orm';
import { setTimeout as delay } from 'node:timers/promises';
import { controllerFixture } from './helpers/mission-controller-fixture.mjs';

// Actual controller, run/review/report persistence and evidence file reads.
// The browser and reviewer outputs are synthetic; this is bounded-loop/fence
// verification, not a live QA acceptance or a genuine product verdict.
const h = await controllerFixture(), { db, schema } = h;
const { testRunAction } = await import('../server/utils/test-runs.ts');
const { runChecks } = await import('../shared/test-run.ts');
const { saveFile } = await import('../server/utils/workspaces.ts');
const { del, workspaceStorageToken } = await import('../server/utils/evidence-storage.ts');
const { proposeMissionComplements } = await import('../server/utils/mission-complements.ts');
const files = [], captureIds = [], conclusions = new Map(), checks = [];
const scripts = globalThis.missionControllerFixtureExecutors, originalReview = scripts.assessResult;
scripts.assessResult = async (input, _attachments, _signal, onUsage) => {
  const verdict = conclusions.get(input.runId); assert.ok(verdict, 'Only explicitly synthetic conclusive fixtures invoke this model');
  const proof = input.evidence.find(evidence => evidence.readStatus === 'read' && evidence.provenance?.producer === 'test-capture'); assert.ok(proof);
  onUsage?.(20);
  return { verdict, summary: 'Synthetic verdict for continuation boundaries.', findings: input.requirements.map(requirement => ({ requirementId: requirement.id,
    verdict, explanation: 'Synthetic independent fixture observation.', evidenceIds: [proof.id], suggestedNextStep: '', gap: null })) };
};
const active = attempt => ['reserved', 'dispatching', 'dispatch_unknown', 'running'].includes(attempt.status);
const latestBrowser = state => state.attempts.filter(attempt => attempt.kind === 'browser_tests').sort((a, b) => b.supplementRound - a.supplementRound || b.attemptNo - a.attemptNo)[0];
async function check(name, fn) { try { await fn(); checks.push(name); } catch (error) { console.error('FAILED', name, error); throw error; } }
async function finish(f, attempt, verdict) {
  const state = await h.state(f), task = state.tasks.find(task => task.id === attempt.taskId);
  const [itemId, caseId] = task.spec.caseKeys[0].split(':'), execution = { execution: { attemptId: attempt.id, dispatchId: attempt.dispatchId } };
  const action = { action: 'start', itemId, caseId, expectedVersion: task.spec.planVersions.find(plan => plan.itemId === itemId).version,
    requestId: randomUUID(), environment: task.spec.target.environment, target: task.spec.target, mission: { missionId: f.id, taskId: task.id } };
  const run = await testRunAction(h.owner, f.workspace, f.thread, action, execution), points = runChecks(run.snapshot);
  const evidenceItemIds = [];
  if (verdict) {
    const evidence = await saveFile(h.owner, f.workspace, 'synthetic-failure.txt', 'text/plain', Buffer.from('Synthetic observed mismatch for the unchanged case.'), f.thread, db,
      { provenance: { version: 1, origin: 'tool', producer: 'test-capture', sourceType: 'test', sourceId: run.id, observedAt: new Date().toISOString(), url: task.spec.target.url } });
    files.push((await h.row(schema.workspaceItems, evidence.id)).blobPath); evidenceItemIds.push(evidence.id);
    const captureId = randomUUID(); captureIds.push(captureId);
    await db.insert(schema.testCaptures).values({ id: captureId, runId: run.id, itemId: evidence.id, title: 'Synthetic trace', action: 'inspect', url: task.spec.target.url });
    conclusions.set(run.id, verdict);
  }
  await testRunAction(h.owner, f.workspace, f.thread, { action: 'finish', runId: run.id, result: { schemaVersion: 2,
    outcome: verdict ? 'failed' : 'inconclusive', actual: 'Synthetic execution fixture.', observations: [], evidenceItemIds,
    checks: points.map(point => ({ id: point.id, status: verdict ? 'mismatch' : 'unverified', actual: 'Synthetic checkpoint observation.' })),
    remaining: verdict ? [] : points.map(point => ({ checkId: point.id, reason: 'Synthetic observation is missing.' })) } }, execution);
  // Explicit synthetic executor accounting; absence of real provider calls is
  // not presented as unknown production usage or as model cost measurement.
  await db.update(schema.missionAttempts).set({ usage: { tokens: 100, toolCalls: 2, durationMs: 1 } }).where(eq(schema.missionAttempts.id, attempt.id));
  await db.update(schema.browserJobs).set({ status: 'completed', updatedAt: new Date() }).where(eq(schema.browserJobs.id, attempt.dispatchId));
  return { run, action, execution };
}
async function nextRound(f, round) {
  for (let index = 0; index < 12; index++) {
    await h.workers(f); await h.pass(f);
    const state = await h.state(f), attempt = latestBrowser(state);
    if (attempt?.supplementRound === round && active(attempt)) return { state, attempt };
    assert.notEqual(state.mission.lifecycle, 'closed', `Closed before complement round ${round}`);
  }
  assert.fail(`Complement round ${round} was not dispatched`);
}
async function pendingComplement() {
  const f = await h.fixture(), ready = await h.browserReady(f), attempt = latestBrowser(ready);
  const result = await finish(f, attempt); await h.pass(f); await h.workers(f);
  const state = await h.state(f), review = state.tasks.find(task => task.spec.kind === 'review');
  await db.update(schema.missionTasks).set({ state: 'completed' }).where(eq(schema.missionTasks.id, review.id));
  const reviewAttempt = state.attempts.find(value => value.taskId === review.id);
  await db.update(schema.missionAttempts).set({ status: 'completed', finishedAt: new Date() }).where(eq(schema.missionAttempts.id, reviewAttempt.id));
  await db.update(schema.missions).set({ nextWakeAt: new Date(0) }).where(eq(schema.missions.id, f.id));
  const identity = h.attempts.leaseIdentity(await h.attempts.claimMission(f.id));
  let task;
  try { [task] = await db.transaction(async tx => proposeMissionComplements(tx, await h.attempts.claimedMission(tx, identity), { ...review, state: 'completed' })); }
  finally { await h.attempts.releaseMissionLease(identity, 0); }
  assert.ok(task); return { f, task, ...result };
}
try {
  await check('full controller stops after two unchanged-case supplements and saves a partial report', async () => {
    const f = await h.fixture(), ready = await h.browserReady(f), runs = [];
    runs.push((await finish(f, latestBrowser(ready))).run);
    for (const round of [1, 2]) {
      const { state, attempt } = await nextRound(f, round), task = state.tasks.find(task => task.id === attempt.taskId);
      assert.equal(state.mission.phase, 'complement'); assert.equal(task.spec.complement.runId, runs.at(-1).id);
      assert.deepEqual(task.spec.caseKeys, [`${runs[0].itemId}:${runs[0].caseId}`]);
      const before = state.attempts.length; await h.pass(f); await h.pass(f);
      assert.equal((await h.state(f)).attempts.length, before, 'Polling cannot duplicate an in-flight complement');
      runs.push((await finish(f, attempt)).run);
    }
    const end = await h.settle(f);
    assert.equal(end.mission.lifecycle, 'closed'); assert.equal(end.reports.length, 1); assert.equal(end.reports[0].status, 'completed');
    assert.equal(end.reports[0].document.partial, true);
    assert.deepEqual(end.tasks.filter(task => task.spec.kind === 'browser_tests').map(task => task.supplementRound).sort(), [0, 1, 2]);
    assert.equal(end.attempts.filter(attempt => attempt.kind === 'browser_tests').length, 3);
    const events = await h.rows(schema.missionEvents, f.id);
    assert.equal(events.filter(event => event.kind === 'complement_planned').length, 2);
    assert.ok(events.some(event => event.kind === 'complement_not_started' && event.payload.reason === 'round_limit'));
    for (const run of runs) assert.equal((await h.row(schema.testRuns, run.id)).result.outcome, 'inconclusive');
  });
  for (const verdict of ['supported', 'contradicted']) await check(`${verdict} negative result is preserved without a supplement`, async () => {
    const f = await h.fixture(), ready = await h.browserReady(f), { run } = await finish(f, latestBrowser(ready), verdict);
    const end = await h.settle(f);
    assert.equal(end.reports[0].status, 'completed'); assert.equal(end.tasks.filter(task => task.spec.kind === 'browser_tests').length, 1);
    assert.equal((await h.row(schema.testRuns, run.id)).result.outcome, 'failed');
    const assessments = await db.select().from(schema.resultAssessments).where(eq(schema.resultAssessments.runId, run.id));
    assert.equal(assessments[0].assessment.verdict, verdict); assert.ok(assessments[0].assessment.findings.every(finding => finding.gap === null));
  });
  await check('pause prevents a pending supplement from dispatching', async () => {
    const { f } = await pendingComplement(); await h.operate(f, 'pause');
    await h.pass(f); await h.pass(f);
    const end = await h.state(f); assert.equal(end.mission.lifecycle, 'paused');
    assert.equal(end.attempts.filter(attempt => attempt.kind === 'browser_tests').length, 1);
  });
  await check('cancellation reports saved observations without dispatching a pending supplement', async () => {
    const { f } = await pendingComplement(); await h.operate(f, 'cancel');
    const end = await h.settle(f); assert.equal(end.mission.lifecycle, 'closed'); assert.equal(end.mission.closureReason, 'cancelled');
    assert.equal(end.attempts.filter(attempt => attempt.kind === 'browser_tests').length, 1);
  });
  await check('source changed after dispatch stops tools and new START but preserves an existing run receipt', async () => {
    const f = await h.fixture(), ready = await h.browserReady(f); await finish(f, latestBrowser(ready));
    const { state, attempt } = await nextRound(f, 1), task = state.tasks.find(task => task.id === attempt.taskId);
    const [itemId, caseId] = task.spec.caseKeys[0].split(':'), execution = { execution: { attemptId: attempt.id, dispatchId: attempt.dispatchId } };
    const action = { action: 'start', itemId, caseId, expectedVersion: task.spec.planVersions[0].version, requestId: randomUUID(),
      environment: task.spec.target.environment, target: task.spec.target, mission: { missionId: f.id, taskId: task.id } };
    const started = await testRunAction(h.owner, f.workspace, f.thread, action, execution);
    await db.update(schema.resultAssessments).set({ inputHash: 'd'.repeat(64) }).where(eq(schema.resultAssessments.id, task.spec.complement.assessmentId));
    const denied = error => error.statusCode === 409 && error.data?.code === 'complement_stale';
    await assert.rejects(h.attempts.authorizeMissionOperation({ userId: h.owner, workspaceId: f.workspace, attemptId: attempt.id,
      dispatchId: attempt.dispatchId, callId: randomUUID(), tool: 'browser', input: { action: 'inspect', runId: started.id } }), denied);
    await assert.rejects(testRunAction(h.owner, f.workspace, f.thread, { ...action, requestId: randomUUID() }, execution), denied);
    const points = runChecks(started.snapshot);
    const saved = await testRunAction(h.owner, f.workspace, f.thread, { action: 'finish', runId: started.id, result: { schemaVersion: 2,
      outcome: 'inconclusive', actual: 'Synthetic executor preserved interruption.', observations: [], evidenceItemIds: [],
      checks: points.map(point => ({ id: point.id, status: 'unverified', actual: 'Interrupted.' })), remaining: points.map(point => ({ checkId: point.id, reason: 'Original review changed.' })) } }, execution);
    assert.equal(saved.result.outcome, 'inconclusive'); assert.equal((await h.row(schema.testRuns, started.id)).result.actual, saved.result.actual);
    await h.operate(f, 'cancel'); await h.settle(f);
  });
  await check('changed plan before complement reservation reaches a bounded partial report without a new browser', async () => {
    const { f, run } = await pendingComplement(), plan = await h.row(schema.workspaceItems, run.itemId);
    await db.update(schema.workspaceItems).set({ version: plan.version + 1 }).where(eq(schema.workspaceItems.id, plan.id));
    const end = await h.settle(f); assert.equal(end.mission.lifecycle, 'closed'); assert.equal(end.reports[0].status, 'completed');
    assert.equal(end.reports[0].document.partial, true); assert.equal(end.attempts.filter(attempt => attempt.kind === 'browser_tests').length, 1);
  });
  for (const operation of ['dispatch', 'tool']) await check(`${operation} cannot authorize after the complement content-lock wait crosses its deadline`, async () => {
    const { f, task } = await pendingComplement();
    await db.update(schema.missions).set({ nextWakeAt: new Date(0) }).where(eq(schema.missions.id, f.id));
    const identity = h.attempts.leaseIdentity(await h.attempts.claimMission(f.id));
    const reservation = await h.attempts.reserveMissionAttempt(identity, task.id, { usesModel: true, resource: { kind: 'browser', poolKey: 'browser' } });
    assert.equal(reservation.status, 'reserved');
    const attempt = reservation.attempt, deadline = new Date(Date.now() + 700);
    await db.update(schema.missionAttempts).set({ deadlineAt: deadline }).where(eq(schema.missionAttempts.id, attempt.id));
    let unlock, entered;
    const gate = new Promise(resolve => { unlock = resolve; }), acquired = new Promise(resolve => { entered = resolve; });
    const key = `workspace-content:${f.workspace}`;
    const held = db.transaction(async tx => { await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`); entered(); await gate; });
    await acquired;
    const request = operation === 'dispatch' ? h.attempts.markMissionDispatch(identity, attempt.id)
      : h.attempts.authorizeMissionOperation({ userId: h.owner, workspaceId: f.workspace, attemptId: attempt.id, dispatchId: attempt.dispatchId, callId: randomUUID(), tool: 'browser', input: { action: 'inspect' } });
    const result = request.then(value => ({ value }), error => ({ error }));
    try {
      const until = Date.now() + 5000;
      while (!(await h.sql`select 1 from pg_locks where locktype='advisory' and not granted and classid::bigint=((hashtextextended(${key},0) >> 32) & 4294967295) and objid::bigint=(hashtextextended(${key},0) & 4294967295)`).length) {
        assert.ok(Date.now() < until, 'The operation must wait on the actual content lock'); await delay(10);
      }
      while (!(await h.sql`select clock_timestamp() >= ${deadline.toISOString()}::timestamptz as expired`)[0].expired) { assert.ok(Date.now() < until); await delay(10); }
    } finally { unlock(); await held; }
    try {
      const outcome = await result;
      assert.equal(outcome.error?.statusCode, 409, 'Expired complement operation must be rejected');
      const stored = await h.row(schema.missionAttempts, attempt.id);
      assert.equal(stored.status, 'reserved'); assert.equal(stored.toolCalls, 0);
    } finally { await h.attempts.releaseMissionLease(identity, 0); }
  });
} finally {
  scripts.assessResult = originalReview;
  if (captureIds.length) await db.delete(schema.testCaptures).where(inArray(schema.testCaptures.id, captureIds));
  await Promise.all(files.map(file => del(file, { token: workspaceStorageToken() }))); await h.close();
}
console.log(JSON.stringify({ passed: checks.length, checks, models: 'synthetic only', database: 'actual isolated PostgreSQL' }));
