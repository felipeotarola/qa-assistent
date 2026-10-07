import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { controllerFixture } from './helpers/mission-controller-fixture.mjs';

// Actual isolated PG/controller. Executor receipts/reviews are synthetic test
// preparation; this file does not claim real authentication or model behavior.
assert.equal(process.env.GRUNDEN_API_TOKEN, '');
const h = await controllerFixture(), { db, schema } = h, checks = [];
const { proposeUnstartedBrowserRecovery, validateUnstartedBrowserRecovery, proposeMissionComplements, validateMissionComplement } = await import('../server/utils/mission-complements.ts');
const { missionHash } = await import('../server/utils/mission-sources.ts');
const { runChecks } = await import('../shared/test-run.ts');
const plan = h.scripts.planMission;
h.scripts.planMission = async (...args) => {
  const result = await plan(...args);
  result.draft.cases = [0, 1, 2].map(index => ({ ...structuredClone(result.draft.cases[0]), title: `Independent original case ${index}` }));
  return result;
};
async function claimed(f, operation) {
  await db.update(schema.missions).set({ nextWakeAt: new Date(0) }).where(eq(schema.missions.id, f.id));
  const lease = h.attempts.leaseIdentity(await h.attempts.claimMission(f.id));
  try { return await db.transaction(async tx => operation(tx, await h.attempts.claimedMission(tx, lease))); }
  finally { await h.attempts.releaseMissionLease(lease, 0); }
}
async function prepared({ waiting = false } = {}) {
  const f = await h.fixture(), state = await h.browserReady(f);
  const attempt = state.attempts.find(row => row.kind === 'browser_tests'), task = state.tasks.find(row => row.id === attempt.taskId);
  const wait = waiting ? await claimed(f, (tx, mission) => h.control.createMissionWait(tx, mission,
    { reason: 'human_browser', taskIds: [task.id], question: 'Return the original session.' })) : null;
  // Explicit synthetic terminal/no-physical-resource receipt. No browser
  // service has been called for this fresh test fixture.
  await db.update(schema.browserJobs).set({ status: 'completed' }).where(eq(schema.browserJobs.id, attempt.dispatchId));
  await db.update(schema.missionAttempts).set({ status: 'completed', finishedAt: new Date(), usage: { tokens: 10, toolCalls: 0, durationMs: 1 } }).where(eq(schema.missionAttempts.id, attempt.id));
  await db.update(schema.missionTasks).set({ state: 'blocked' }).where(eq(schema.missionTasks.id, task.id));
  await db.delete(schema.missionResourceClaims).where(eq(schema.missionResourceClaims.attemptId, attempt.id));
  return { f, wait, task: await h.row(schema.missionTasks, task.id), attempt: await h.row(schema.missionAttempts, attempt.id) };
}
async function invalidate(f, task, attempt) {
  await claimed(f, (tx, mission) => h.control.recordMissionEvent(tx, mission, 'browser_return_invalidated', { taskId: task.id, attemptId: attempt.id }, `browser-return-invalidated:${attempt.id}`));
}
const starts = f => h.calls.filter(call => call.kind === 'browser:start' && call.missionId === f.id).length;
async function check(name, fn) { await fn(); checks.push(name); console.log(`PASS ${name}`); }
try {
  await check('invalidated original cannot propose a fresh remainder for three unstarted cases', async () => {
    const { f, task, attempt } = await prepared(); await invalidate(f, task, attempt);
    assert.equal(await claimed(f, (tx, mission) => proposeUnstartedBrowserRecovery(tx, mission, task)), null);
    assert.equal((await h.state(f)).tasks.filter(row => row.operationId?.startsWith('browser-remainder:')).length, 0);
  });
  await check('already planned remainder is denied at validation and ordinary controller dispatch after source invalidation', async () => {
    const { f, task, attempt } = await prepared();
    const next = await claimed(f, (tx, mission) => proposeUnstartedBrowserRecovery(tx, mission, task)); assert.ok(next);
    await claimed(f, (tx, mission) => validateUnstartedBrowserRecovery(tx, mission, next, randomUUID()));
    await invalidate(f, task, attempt);
    await assert.rejects(claimed(f, (tx, mission) => validateUnstartedBrowserRecovery(tx, mission, next, randomUUID())), error => error.statusCode === 409);
    await assert.rejects(claimed(f, (tx, mission) => validateMissionComplement(tx, mission, next)), error => error.data?.code === 'complement_stale');
    const before = starts(f); await h.pass(f); await h.pass(f); assert.equal(starts(f), before);
    assert.equal((await h.row(schema.missionTasks, next.id)).state, 'blocked');
  });
  await check('unanswered and expired human waits block remainder without needing an answered-return event', async () => {
    for (const expired of [false, true]) {
      const { f, task, wait } = await prepared({ waiting: true });
      if (expired) await db.update(schema.missionWaits).set({ state: 'expired', deadlineAt: new Date(0) }).where(eq(schema.missionWaits.id, wait.id));
      await db.update(schema.missionTasks).set({ state: 'blocked' }).where(eq(schema.missionTasks.id, task.id));
      assert.equal(await claimed(f, (tx, mission) => proposeUnstartedBrowserRecovery(tx, mission, task)), null);
    }
  });
  await check('same-mission independent task still dispatches after another task loses human return', async () => {
    const { f, task, attempt } = await prepared();
    const sourceSpec = { ...task.spec, caseKeys: task.spec.caseKeys.slice(0, 2) };
    await db.update(schema.missionTasks).set({ spec: sourceSpec }).where(eq(schema.missionTasks.id, task.id));
    await db.update(schema.missionAttempts).set({ requestHash: missionHash({ spec: sourceSpec, planRevision: attempt.planRevision, mandateRevision: attempt.mandateRevision }) }).where(eq(schema.missionAttempts.id, attempt.id));
    const independent = await claimed(f, (tx, mission) => h.control.addMissionTask(tx, mission, { operationId: 'synthetic-independent-original', title: 'Separate original scope', criterionIds: task.criterionIds,
      spec: { ...task.spec, caseKeys: task.spec.caseKeys.slice(2) } }));
    await invalidate(f, task, attempt);
    await claimed(f, (tx, mission) => validateMissionComplement(tx, mission, independent));
    const before = starts(f); await h.pass(f); assert.equal(starts(f), before + 1);
    assert.equal((await h.row(schema.missionTasks, independent.id)).state, 'running');
  });
  await check('old epoch, foreign runtime and unrelated wait do not poison a current original task', async () => {
    for (const mode of ['epoch', 'runtime', 'unrelated-wait']) {
      const { f, task, attempt } = await prepared();
      if (mode === 'unrelated-wait') {
        const other = await claimed(f, (tx, mission) => h.control.addMissionTask(tx, mission, { operationId: 'independent-waiting-work', title: 'Independent synthetic prerequisite', criterionIds: [],
          spec: { kind: 'discovery', target: mission.admission.target } }));
        await claimed(f, (tx, mission) => h.control.createMissionWait(tx, mission, { reason: 'human_browser', taskIds: [other.id], question: 'Independent synthetic wait.' }));
      } else {
        const [old] = await db.insert(schema.missionAttempts).values({ ...attempt, id: randomUUID(), dispatchId: randomUUID(), attemptNo: 2,
          ...(mode === 'epoch' ? { mandateRevision: attempt.mandateRevision - 1 } : { runtime: 'foreign-test-runtime' }) }).returning();
        await invalidate(f, task, old);
      }
      assert.ok(await claimed(f, (tx, mission) => proposeUnstartedBrowserRecovery(tx, mission, task)), mode);
    }
  });
  await check('interrupted-run review cannot propose or dispatch a complement after exact auth invalidation', async () => {
    const f = await h.fixture(); const ready = await h.browserReady(f);
    const attempt = ready.attempts.find(row => row.kind === 'browser_tests'), task = ready.tasks.find(row => row.id === attempt.taskId);
    const runs = await h.finishBrowser(f), run = await h.row(schema.testRuns, runs[0].id);
    const coverage = runChecks(run.snapshot).map(check => ({ id: check.id, status: 'unverified', actual: 'Synthetic interrupted observation.' }));
    await db.update(schema.testRuns).set({ result: { schemaVersion: 2, outcome: 'interrupted', actual: 'Synthetic human interruption', checks: coverage,
      remaining: coverage.map(check => ({ checkId: check.id, reason: 'Interrupted before observation' })), observations: [], evidenceItemIds: [] } }).where(eq(schema.testRuns.id, run.id));
    await h.pass(f); await h.workers(f);
    const state = await h.state(f), review = state.tasks.find(row => row.spec.kind === 'review'); assert.ok(review);
    await db.update(schema.missionTasks).set({ state: 'completed' }).where(eq(schema.missionTasks.id, review.id));
    await db.update(schema.missionAttempts).set({ status: 'completed', finishedAt: new Date() }).where(and(eq(schema.missionAttempts.missionId, f.id), eq(schema.missionAttempts.kind, 'review')));
    const exactReview = { ...review, state: 'completed', spec: { ...review.spec, runIds: [run.id] } };
    const [next] = await claimed(f, (tx, mission) => proposeMissionComplements(tx, mission, exactReview)); assert.ok(next, 'Interrupted run has an actionable current typed browser gap before invalidation');
    await claimed(f, (tx, mission) => validateMissionComplement(tx, mission, next));
    const original = await h.row(schema.testRuns, run.id);
    await invalidate(f, task, attempt);
    await assert.rejects(claimed(f, (tx, mission) => validateMissionComplement(tx, mission, next)), error => error.data?.code === 'complement_stale');
    assert.deepEqual(await claimed(f, (tx, mission) => proposeMissionComplements(tx, mission, { ...exactReview, spec: { ...exactReview.spec, runIds: runs.slice(1).map(row => row.id) } })), []);
    const before = starts(f); await h.pass(f); await h.pass(f); assert.equal(starts(f), before);
    assert.equal((await h.row(schema.missionTasks, next.id)).state, 'blocked');
    assert.deepEqual(await h.row(schema.testRuns, run.id), original, 'No original result, evidence or check is rewritten');
  });
} finally { await h.close(); }
console.log(JSON.stringify({ checks, passed: checks.length, database: 'actual isolated PG', browser: 'synthetic transport', modelCalls: 0 }));
