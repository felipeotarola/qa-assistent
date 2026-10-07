import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { controllerFixture } from './helpers/mission-controller-fixture.mjs';

// Real PostgreSQL, typed reviewer and task reconciliation. A completed review
// acknowledgement is injected before report creation; controller wiring and
// live browser complements are separate acceptance work.
const h = await controllerFixture(), { db, schema } = h;
const { proposeMissionComplements, validateMissionComplement } = await import('../server/utils/mission-complements.ts');
const { runChecks } = await import('../shared/test-run.ts');
const checks = [];
async function prepared() {
  const f = await h.fixture(); await h.browserReady(f);
  const [run] = await h.finishBrowser(f);
  const stored = await h.row(schema.testRuns, run.id);
  const coverage = runChecks(stored.snapshot).map(check => ({ id: check.id, status: 'unverified', actual: 'Synthetic missing observation' }));
  await db.update(schema.testRuns).set({ result: { schemaVersion: 2, outcome: 'inconclusive', actual: 'Synthetic partial run', checks: coverage,
    remaining: coverage.map(check => ({ checkId: check.id, reason: 'Synthetic omitted evidence' })), observations: [], evidenceItemIds: [] } }).where(eq(schema.testRuns.id, run.id));
  await h.pass(f); await h.workers(f);
  const state = await h.state(f), review = state.tasks.find(task => task.spec.kind === 'review');
  await db.update(schema.missionTasks).set({ state: 'completed' }).where(eq(schema.missionTasks.id, review.id));
  await db.update(schema.missionAttempts).set({ status: 'completed', finishedAt: new Date() }).where(and(eq(schema.missionAttempts.missionId, f.id), eq(schema.missionAttempts.kind, 'review')));
  return { f, run: await h.row(schema.testRuns, run.id), review: { ...review, state: 'completed' } };
}
async function claimed(f, operation) {
  await db.update(schema.missions).set({ nextWakeAt: new Date(0) }).where(eq(schema.missions.id, f.id));
  const mission = await h.attempts.claimMission(f.id), lease = h.attempts.leaseIdentity(mission);
  try { return await db.transaction(async tx => operation(tx, await h.attempts.claimedMission(tx, lease))); }
  finally { await h.attempts.releaseMissionLease(lease, 0); }
}
try {
  const { f, run, review } = await prepared();
  const [task] = await claimed(f, (tx, mission) => proposeMissionComplements(tx, mission, review));
  assert.ok(task); assert.equal(task.supplementRound, 1); assert.deepEqual(task.spec.caseKeys, [`${run.itemId}:${run.caseId}`]);
  assert.equal(task.spec.complement.gapIds.length, runChecks(run.snapshot).length);
  assert.equal(task.spec.complement.runId, run.id); assert.deepEqual(task.spec.target, run.target);
  checks.push('all missing checkpoints for one case create one exact unchanged-case complement');
  assert.deepEqual(await claimed(f, (tx, mission) => proposeMissionComplements(tx, mission, review)), []);
  assert.equal((await h.state(f)).tasks.filter(t => t.supplementRound > 0).length, 1);
  checks.push('new lease and repeated reconciliation cannot duplicate the saved logical round');
  await claimed(f, (tx, mission) => validateMissionComplement(tx, mission, task));
  const forged = structuredClone(task); forged.spec.complement.assessmentId = randomUUID();
  await assert.rejects(claimed(f, (tx, mission) => validateMissionComplement(tx, mission, forged)), error => error.statusCode === 409);
  checks.push('exact assessment binding is checked again before admission');
  const originalPlan = await h.row(schema.workspaceItems, run.itemId);
  await db.update(schema.workspaceItems).set({ version: originalPlan.version + 1 }).where(eq(schema.workspaceItems.id, originalPlan.id));
  await assert.rejects(claimed(f, (tx, mission) => validateMissionComplement(tx, mission, task)), error => error.statusCode === 409);
  await db.update(schema.workspaceItems).set({ version: originalPlan.version }).where(eq(schema.workspaceItems.id, originalPlan.id));
  checks.push('editing original plan prevents previously proposed continuation');
  const [assessment] = await db.select().from(schema.resultAssessments).where(eq(schema.resultAssessments.id, task.spec.complement.assessmentId));
  await db.update(schema.resultAssessments).set({ inputHash: 'f'.repeat(64) }).where(eq(schema.resultAssessments.id, assessment.id));
  await assert.rejects(claimed(f, (tx, mission) => validateMissionComplement(tx, mission, task)), error => error.statusCode === 409);
  await db.update(schema.resultAssessments).set({ inputHash: assessment.inputHash }).where(eq(schema.resultAssessments.id, assessment.id));
  checks.push('changed model-input fingerprint prevents continuation');
  const onlyReport = await h.fixture({ intent: 'report_only' });
  assert.deepEqual(await claimed(onlyReport, (tx, mission) => proposeMissionComplements(tx, mission, review)), []);
  checks.push('report-only cannot adopt another mission review or create a test');
  const limited = await prepared(), current = await h.row(schema.missions, limited.f.id);
  await db.update(schema.missions).set({ mandate: { ...current.mandate, limits: { ...current.mandate.limits, maxSupplementRounds: 0 } } }).where(eq(schema.missions.id, current.id));
  assert.deepEqual(await claimed(limited.f, (tx, mission) => proposeMissionComplements(tx, mission, limited.review)), []);
  const events = await db.select().from(schema.missionEvents).where(eq(schema.missionEvents.missionId, current.id));
  assert.equal(events.find(event => event.kind === 'complement_not_started').payload.reason, 'round_limit');
  checks.push('no complement allowance records its reason without another task');
} finally { await h.close(); }
console.log(JSON.stringify({ passed: checks.length, checks }));
