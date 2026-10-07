import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { and, eq, sql } from 'drizzle-orm';
import { controllerFixture } from './helpers/mission-controller-fixture.mjs';

// Actual isolated SQL and authored complement guards. Browser/model execution
// is synthetic; this does not establish unattended complement acceptance.
const h = await controllerFixture(), { db, schema } = h;
const { proposeMissionComplements, validateMissionComplement } = await import('../server/utils/mission-complements.ts');
const { runChecks } = await import('../shared/test-run.ts');
const checks = [];
async function check(name, fn) { await fn(); checks.push(name); }
async function prepared() {
  const f = await h.fixture(); await h.browserReady(f);
  const [started] = await h.finishBrowser(f), run = await h.row(schema.testRuns, started.id);
  const coverage = runChecks(run.snapshot).map(point => ({ id: point.id, status: 'unverified', actual: 'Synthetic omitted observation.' }));
  await db.update(schema.testRuns).set({ result: { schemaVersion: 2, outcome: 'inconclusive', actual: 'Synthetic partial execution.', checks: coverage,
    remaining: coverage.map(point => ({ checkId: point.id, reason: 'Synthetic missing observation.' })), observations: [], evidenceItemIds: [] } }).where(eq(schema.testRuns.id, run.id));
  await h.pass(f); await h.workers(f);
  const state = await h.state(f), review = state.tasks.find(task => task.spec.kind === 'review');
  await db.update(schema.missionTasks).set({ state: 'completed' }).where(eq(schema.missionTasks.id, review.id));
  await db.update(schema.missionAttempts).set({ status: 'completed', finishedAt: new Date() }).where(and(eq(schema.missionAttempts.missionId, f.id), eq(schema.missionAttempts.kind, 'review')));
  return { f, run: await h.row(schema.testRuns, run.id), review: { ...review, state: 'completed' } };
}
async function lease(f) {
  await db.update(schema.missions).set({ nextWakeAt: new Date(0) }).where(eq(schema.missions.id, f.id));
  return h.attempts.leaseIdentity(await h.attempts.claimMission(f.id));
}
async function claimed(f, operation) {
  const identity = await lease(f);
  try { return await db.transaction(async tx => operation(tx, await h.attempts.claimedMission(tx, identity))); }
  finally { await h.attempts.releaseMissionLease(identity, 0); }
}
const denied = error => error.statusCode === 409;
try {
  const base = await prepared();
  const [task] = await claimed(base.f, (tx, mission) => proposeMissionComplements(tx, mission, base.review));
  assert.ok(task);
  await check('each immutable source identity is checked, including every model-read hash and exact gap set', async () => {
    const replacements = { sourceTaskId: randomUUID(), sourceAttemptId: randomUUID(), runId: randomUUID(), assessmentId: randomUUID(),
      sourceHash: 'e'.repeat(64), inputHash: 'f'.repeat(64), reviewerVersion: 'legacy', planRevision: 2,
      caseKey: `${randomUUID()}:${randomUUID()}`, gapIds: ['a'.repeat(64)] };
    for (const [field, value] of Object.entries(replacements)) {
      const forged = structuredClone(task); forged.spec.complement[field] = value;
      await assert.rejects(claimed(base.f, (tx, mission) => validateMissionComplement(tx, mission, forged)), denied, field);
    }
    await claimed(base.f, (tx, mission) => validateMissionComplement(tx, mission, task));
  });
  await check('source attempts cannot cross runtime, cancellation, active execution or mandate/plan epochs', async () => {
    const original = await h.row(schema.missionAttempts, task.spec.complement.sourceAttemptId);
    for (const changed of [{ runtime: `${original.runtime}-other` }, { cancelRequestedAt: new Date() }, { status: 'running' },
      { mandateRevision: original.mandateRevision + 1 }, { planRevision: original.planRevision + 1 }]) {
      await db.update(schema.missionAttempts).set(changed).where(eq(schema.missionAttempts.id, original.id));
      try { await assert.rejects(claimed(base.f, (tx, mission) => validateMissionComplement(tx, mission, task)), denied); }
      finally { await db.update(schema.missionAttempts).set(Object.fromEntries(Object.keys(changed).map(key => [key, original[key]]))).where(eq(schema.missionAttempts.id, original.id)); }
    }
  });
  await check('same plan version does not hide edited checkpoint text', async () => {
    const plan = await h.row(schema.workspaceItems, base.run.itemId), content = structuredClone(plan.content);
    content.cases.find(testCase => testCase.id === base.run.caseId).expected += ' Changed requirement.';
    await db.update(schema.workspaceItems).set({ content }).where(eq(schema.workspaceItems.id, plan.id));
    try { await assert.rejects(claimed(base.f, (tx, mission) => validateMissionComplement(tx, mission, task)), denied); }
    finally { await db.update(schema.workspaceItems).set({ content: plan.content }).where(eq(schema.workspaceItems.id, plan.id)); }
  });
  await check('a foreign mission cannot admit the original complement task', async () => {
    const other = await h.fixture();
    await assert.rejects(claimed(other, (tx, mission) => validateMissionComplement(tx, mission, task)), denied);
  });
  await check('concurrent reconciliation under one lease commits one task and one decision event', async () => {
    const concurrent = await prepared(), identity = await lease(concurrent.f);
    try {
      const propose = () => db.transaction(async tx => proposeMissionComplements(tx, await h.attempts.claimedMission(tx, identity), concurrent.review));
      const results = await Promise.all([propose(), propose()]);
      assert.equal(results.flat().length, 1);
      const state = await h.state(concurrent.f), events = await h.rows(schema.missionEvents, concurrent.f.id);
      assert.equal(state.tasks.filter(row => row.supplementRound > 0).length, 1);
      assert.equal(events.filter(event => event.kind === 'complement_planned').length, 1);
    } finally { await h.attempts.releaseMissionLease(identity, 0); }
  });
  await check('controller lease expiring during the content-lock wait commits neither task nor event', async () => {
    const late = await prepared(), identity = await lease(late.f), deadline = new Date(Date.now() + 700);
    await db.update(schema.missions).set({ leaseUntil: deadline }).where(eq(schema.missions.id, late.f.id));
    let unlock, entered;
    const gate = new Promise(resolve => { unlock = resolve; }), acquired = new Promise(resolve => { entered = resolve; });
    const held = db.transaction(async tx => { await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`workspace-content:${late.f.workspace}`}, 0))`); entered(); await gate; });
    await acquired;
    const operation = db.transaction(async tx => proposeMissionComplements(tx, await h.attempts.claimedMission(tx, identity), late.review));
    const rejected = assert.rejects(operation, denied);
    try {
      const until = Date.now() + 5000;
      const key = `workspace-content:${late.f.workspace}`;
      while (!(await h.sql`select 1 from pg_locks where locktype='advisory' and not granted and classid::bigint=((hashtextextended(${key},0) >> 32) & 4294967295) and objid::bigint=(hashtextextended(${key},0) & 4294967295)`).length) {
        assert.ok(Date.now() < until, 'Complement proposal must wait on the actual held content lock'); await delay(10);
      }
      while (!(await h.sql`select clock_timestamp() >= ${deadline.toISOString()}::timestamptz as expired`)[0].expired) { assert.ok(Date.now() < until); await delay(10); }
    } finally { unlock(); await held; await rejected; await h.attempts.releaseMissionLease(identity, 0); }
    const state = await h.state(late.f), events = await h.rows(schema.missionEvents, late.f.id);
    assert.equal(state.tasks.filter(row => row.supplementRound > 0).length, 0);
    assert.equal(events.filter(event => event.kind.startsWith('complement_')).length, 0);
  });
} finally { await h.close(); }
console.log(JSON.stringify({ passed: checks.length, checks, models: 'synthetic only', database: 'actual isolated PostgreSQL' }));
