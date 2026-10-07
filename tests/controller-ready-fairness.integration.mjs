import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { controllerFixture } from './helpers/mission-controller-fixture.mjs';

// Actual isolated PostgreSQL, intake, reservation and controller. Acquisition,
// planning and browser transport are synthetic; no physical executor or model.
const h = await controllerFixture(), { db, schema } = h;
const { testRunAction } = await import('../server/utils/test-runs.ts');
const checks = [];
async function claim(missionId) {
  await db.update(schema.missions).set({ nextWakeAt: new Date(0) }).where(eq(schema.missions.id, missionId));
  const mission = await h.attempts.claimMission(missionId); assert.ok(mission);
  return h.attempts.leaseIdentity(mission);
}
async function fixture({ human = false } = {}) {
  const f = await h.fixture();
  const planned = await h.until(f, state => state.tasks.some(task => task.spec.kind === 'browser_tests'));
  const browser = planned.tasks.find(task => task.spec.kind === 'browser_tests');
  assert.equal(browser.state, 'pending');
  // A genuinely saved, separate observation can be reviewed independently of
  // the next browser task. It is not fabricated as a current QA approval.
  const [itemId, caseId] = browser.spec.caseKeys[0].split(':');
  const run = await testRunAction(h.owner, f.workspace, f.thread, { action: 'start', itemId, caseId,
    expectedVersion: browser.spec.planVersions[0].version, requestId: randomUUID(), environment: 'Fixture history',
    target: { environment: 'Fixture history', url: f.target.url, revision: 'fixture-original' } });
  await testRunAction(h.owner, f.workspace, f.thread, { action: 'finish', runId: run.id,
    result: { outcome: 'inconclusive', actual: 'Synthetic saved observation', unverified: 'No real browser used', observations: [], evidenceItemIds: [] } });
  const review = await db.transaction(async tx => {
    await h.control.lockMission(tx, f.id);
    return h.control.addMissionTask(tx, await h.row(schema.missions, f.id), { operationId: `independent-review:${randomUUID()}`,
      title: 'Review already saved independent observation', spec: { kind: 'review', runIds: [run.id] } });
  });
  // Use the real reservation path for a different mission's physical claim.
  const other = await h.control.acceptMission(h.owner, f.workspace, f.thread, { requestId: randomUUID(), intent: 'explore',
    goal: 'Another already authorized read-only browser assignment', target: f.target, caseKeys: browser.spec.caseKeys });
  const otherTask = await db.transaction(async tx => {
    await h.control.lockMission(tx, other.id);
    return h.control.addMissionTask(tx, other, { operationId: 'other-browser', title: 'Owned browser reservation',
      spec: { ...browser.spec, target: other.config.target } });
  });
  const lease = await claim(other.id);
  const reserved = await h.attempts.reserveMissionAttempt(lease, otherTask.id, { usesModel: true,
    resource: { kind: 'browser', poolKey: process.env.BROWSER_SERVICE_URL ?? 'browser-provider' } });
  assert.equal(reserved.status, 'reserved');
  await h.attempts.releaseMissionLease(lease, 0);
  const [resource] = await h.rows(schema.missionResourceClaims, other.id);
  if (human) await db.update(schema.missionResourceClaims).set({ owner: 'human' }).where(eq(schema.missionResourceClaims.id, resource.id));
  return { f, browser, review, run, other, otherAttempt: reserved.attempt, resource: await h.row(schema.missionResourceClaims, resource.id) };
}
async function check(name, body) { await body(); checks.push(name); }
async function anotherReview(data) {
  return db.transaction(async tx => {
    await h.control.lockMission(tx, data.f.id);
    return h.control.addMissionTask(tx, await h.row(schema.missions, data.f.id), { operationId: `another-review:${randomUUID()}`,
      title: 'Another independently permitted review', spec: { kind: 'review', runIds: [data.run.id] } });
  });
}
try {
  await check('busy earlier browser task does not starve a later independent review', async () => {
    const data = await fixture(), before = await h.state(data.f), calls = h.calls.length;
    const second = await anotherReview(data);
    await h.pass(data.f);
    const after = await h.state(data.f), review = after.attempts.find(attempt => attempt.taskId === data.review.id);
    assert.ok(review, 'Later independent review must be reserved despite the first task resource_busy');
    assert.equal(review.status, 'running'); assert.equal(after.attempts.length, before.attempts.length + 1);
    assert.equal(after.tasks.find(task => task.id === data.browser.id).state, 'pending');
    assert.equal(h.calls.slice(calls).filter(call => call.kind === 'browser:start').length, 0);
    assert.deepEqual(await h.row(schema.missionResourceClaims, data.resource.id), data.resource);
    assert.equal((await db.select().from(schema.resultAssessments).where(eq(schema.resultAssessments.runId, data.run.id))).length, 1);
    assert.equal(after.tasks.find(task => task.id === second.id).state, 'pending', 'At most one new task is dispatched per pass');
  });
  await check('human-owned earlier resource does not starve review or imply physical release', async () => {
    const data = await fixture({ human: true }), calls = h.calls.length;
    await h.pass(data.f);
    const after = await h.state(data.f);
    assert.ok(after.attempts.some(attempt => attempt.taskId === data.review.id));
    assert.equal(after.attempts.filter(attempt => attempt.kind === 'browser_tests').length, 0);
    assert.deepEqual(await h.row(schema.missionResourceClaims, data.resource.id), data.resource);
    assert.equal(h.calls.slice(calls).filter(call => ['browser:start', 'browser:control', 'provider:delete'].includes(call.kind)).length, 0);
  });
  await check('all temporary candidates stay pending without creating a final report', async () => {
    const data = await fixture();
    await db.update(schema.missionTasks).set({ state: 'cancelled' }).where(eq(schema.missionTasks.id, data.review.id));
    const before = await h.state(data.f);
    for (let i = 0; i < 2; i++) await h.pass(data.f);
    const after = await h.state(data.f);
    assert.equal(after.attempts.length, before.attempts.length);
    assert.equal(after.tasks.find(task => task.id === data.browser.id).state, 'pending');
    assert.equal(after.tasks.filter(task => task.spec.kind === 'report').length, 0);
    assert.notEqual(after.mission.lifecycle, 'closed'); assert.notEqual(after.mission.phase, 'report');
    assert.deepEqual(await h.row(schema.missionResourceClaims, data.resource.id), data.resource);
  });
  await check('temporary resource blockers do not starve a waiting branch interim report', async () => {
    const data = await fixture();
    const wait = await db.transaction(async tx => {
      await h.control.lockMission(tx, data.f.id);
      return h.control.createMissionWait(tx, await h.row(schema.missions, data.f.id), { reason: 'clarification',
        taskIds: [data.review.id], question: 'Clarify the already saved observation before this independent review.' });
    });
    await h.pass(data.f);
    let state = await h.state(data.f), interim = state.tasks.find(task => task.spec.purpose === 'interim');
    assert.ok(interim, 'Completed independent discovery plus a real wait can produce an interim task');
    await h.pass(data.f);
    state = await h.state(data.f);
    assert.ok(state.attempts.some(attempt => attempt.taskId === interim.id));
    assert.equal(state.tasks.filter(task => task.spec.kind === 'report').length, 1);
    assert.equal(state.reports.length, 1); assert.equal(state.reports[0].status, 'queued');
    assert.equal(state.tasks.find(task => task.id === data.browser.id).state, 'pending');
    assert.equal((await h.row(schema.missionWaits, wait.id)).state, 'waiting');
    assert.notEqual(state.mission.phase, 'report'); assert.notEqual(state.mission.lifecycle, 'closed');
    assert.deepEqual(await h.row(schema.missionResourceClaims, data.resource.id), data.resource);
  });
  await check('scanning later candidates does not bypass the persisted parallel limit', async () => {
    const data = await fixture(), second = await anotherReview(data), mission = await h.row(schema.missions, data.f.id);
    await db.update(schema.missions).set({ mandate: { ...mission.mandate, limits: { ...mission.mandate.limits, maxParallel: 1 } } }).where(eq(schema.missions.id, data.f.id));
    const lease = await claim(data.f.id), first = await h.attempts.reserveMissionAttempt(lease, data.review.id, { usesModel: true });
    assert.equal(first.status, 'reserved'); await h.attempts.releaseMissionLease(lease, 0);
    await h.pass(data.f); await h.pass(data.f);
    const after = await h.state(data.f);
    assert.equal(after.attempts.filter(attempt => ['reserved', 'dispatching', 'dispatch_unknown', 'running'].includes(attempt.status)).length, 1);
    assert.equal(after.attempts.find(attempt => attempt.id === first.attempt.id).status, 'running');
    assert.equal(after.tasks.find(task => task.id === second.id).state, 'pending');
    assert.equal(after.tasks.find(task => task.id === data.browser.id).state, 'pending');
    assert.equal(after.tasks.filter(task => task.spec.kind === 'report').length, 0);
    assert.deepEqual(await h.row(schema.missionResourceClaims, data.resource.id), data.resource);
  });
} finally { await h.close(); }
console.log(JSON.stringify({ passed: checks.length, checks }, null, 2));
