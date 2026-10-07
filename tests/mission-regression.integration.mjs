import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { isolatedApp } from './helpers/isolated-app.mjs';

// Isolated SQL/admission only: no model, browser, app runtime or queue drain.
process.env.PAT_RUNTIME_SCOPE = `${process.env.PAT_RUNTIME_SCOPE}-regression-${randomUUID()}`;
process.env.MISSIONS_ENABLED = 'true'; process.env.AUTONOMOUS_MISSIONS_ENABLED = 'true';
const app = await isolatedApp(), { db, schema } = app;
const { acceptMission, controlMission, lockMission, addMissionTask } = await import('../server/utils/mission-control.ts');
const attempts = await import('../server/utils/mission-attempts.ts');
const planner = await import('../server/utils/mission-planning.ts');
const { saveItem } = await import('../server/utils/workspaces.ts');
const { missionHash } = await import('../server/utils/mission-sources.ts');
const { currentMissionDelivery } = await import('../server/utils/missions.ts');
const { missionIntakeAdmissionSchema } = await import('../shared/mission-control.ts');
const owner = randomUUID(), workspaceId = randomUUID(), otherWorkspace = randomUUID(), threadId = randomUUID();
const originalFetch = globalThis.fetch; globalThis.fetch = () => { throw new Error('Network forbidden in regression binding test'); };
const runtime = process.env.PAT_RUNTIME_SCOPE, passed = [], failures = [];
const row = async (table, id) => (await db.select().from(table).where(eq(table.id, id)))[0];
const tasks = id => db.select().from(schema.missionTasks).where(eq(schema.missionTasks.missionId, id));
async function check(name, fn) { try { await fn(); passed.push(name); } catch (error) { failures.push({ name, message: error.message, stack: error.stack }); } }
async function plan() {
  const testCase = { id: randomUUID(), title: 'Visit service', type: 'browser', preconditions: '', steps: 'Open service. Inspect its status.', expected: 'A status is shown.', entryUrl: 'https://regression.example.test/a' };
  const item = await saveItem(owner, workspaceId, { title: 'Selected regression plan', content: { kind: 'test_plan', summary: '', cases: [testCase], sources: [] } });
  return { ...item, key: `${item.id}:${testCase.id}`, testCase };
}
async function run(p, options = {}) {
  const id = randomUUID(), startedAt = new Date(Date.now() - (options.ageMs ?? 120000)), finishedAt = options.unfinished ? null : new Date(startedAt.getTime() + 1000);
  const value = { id, workspaceId, runtime, itemId: p.id, caseId: p.testCase.id, planVersion: p.version, snapshot: p.testCase, environment: 'QA', target: { environment: 'QA', url: p.testCase.entryUrl, revision: 'version-a' }, threadId, requestId: randomUUID(), startedAt, finishedAt,
    result: options.unfinished ? null : { outcome: 'inconclusive', actual: 'Synthetic stored SQL fixture only.', unverified: 'No browser ran in this contract test.', observations: [], evidenceItemIds: [] }, ...options.patch };
  await db.insert(schema.testRuns).values(value); return value;
}
const request = (p, extra = {}) => ({ requestId: randomUUID(), intent: 'regression', goal: 'Run the selected plan again and compare the change.', target: { kind: 'public_url', url: 'https://regression.example.test/b' }, caseKeys: [p.key], ...extra });
const accept = input => acceptMission(owner, workspaceId, threadId, input);
const control = async (mission, action) => controlMission(owner, workspaceId, threadId, { action, missionId: mission.id, requestId: randomUUID(), expectedMandateRevision: (await row(schema.missions, mission.id)).mandateRevision });
const comparison = mission => mission.config.criteria.find(c => c.delivery?.kind === 'regression_comparison')?.delivery;
try {
  await db.insert(schema.user).values({ id: owner, name: 'Regression contract', email: `${owner}@example.test` });
  await db.insert(schema.workspaces).values([{ id: workspaceId, userId: owner, name: 'Regression' }, { id: otherWorkspace, userId: owner, name: 'Other' }]);
  await db.insert(schema.threads).values({ id: threadId, userId: owner, workspaceId, title: 'Regression' });
  await check('admission freezes the actual latest prior run and preserves the original request hash', async () => {
    const p = await plan(); await run(p, { ageMs: 200000 }); const a = await run(p);
    await saveItem(owner, workspaceId, { id: p.id, expectedVersion: 1, title: p.title, content: { ...p.content, cases: [{ ...p.testCase, entryUrl: 'https://regression.example.test/b' }] } });
    const input = request(p), mission = await accept(input), before = missionHash(await row(schema.testRuns, a.id));
    assert.equal(comparison(mission).baseline.runId, a.id); assert.equal(comparison(mission).baseline.planVersion, 1);
    assert.equal(mission.requestHash, missionHash(missionIntakeAdmissionSchema.parse(input)));
    assert.deepEqual((await tasks(mission.id))[0].sources, [{ type: 'test', id: a.id }]);
    assert.deepEqual(mission.admission.sourceRefs, []); assert.equal((await tasks(mission.id))[0].spec.kind, 'discovery');
    assert.equal((await currentMissionDelivery(db, mission.id)).delivery.cases[0].runId, null);
    assert.equal(missionHash(await row(schema.testRuns, a.id)), before);
  });
  await check('replay and explicit resume keep the original run even after newer B results exist', async () => {
    const p = await plan(), a = await run(p), input = request(p), original = await accept(input);
    await run(p, { ageMs: 30000 });
    const replay = await accept(input); assert.equal(replay.id, original.id); assert.equal(comparison(replay).baseline.runId, a.id);
    await control(original, 'pause'); const resumed = await control(original, 'resume');
    assert.equal(comparison(resumed).baseline.runId, a.id); assert.deepEqual(comparison(resumed), comparison(original));
    const current = (await tasks(resumed.id)).find(t => t.planRevision === resumed.planRevision);
    assert.deepEqual(current.sources, [{ type: 'test', id: a.id }]); assert.equal(current.spec.kind, 'discovery');
    assert.notEqual(resumed.config.target.scope.id, original.config.target.scope.id);
  });
  await check('other workspaces, runtimes, future finishes and unfinished runs are not automatically adopted', async () => {
    const p = await plan(), a = await run(p, { ageMs: 200000 });
    await run(p, { ageMs: 100000, patch: { runtime: `${runtime}-foreign` } });
    await run(p, { ageMs: 90000, patch: { workspaceId: otherWorkspace } });
    await run(p, { unfinished: true }); await run(p, { patch: { finishedAt: new Date(Date.now() + 3600000) } });
    assert.equal(comparison(await accept(request(p))).baseline.runId, a.id);
  });
  await check('missing or incompatible history never prevents creation of independent current QA', async () => {
    const p = await plan(), empty = await accept(request(p)); assert.equal(comparison(empty).baseline, null);
    assert.equal((await tasks(empty.id))[0].spec.kind, 'discovery');
    const a = await run(p);
    await saveItem(owner, workspaceId, { id: p.id, expectedVersion: 1, title: p.title, content: { ...p.content, cases: [{ ...p.testCase, expected: 'A changed requirement.' }] } });
    const changed = await accept(request(p)); assert.equal(comparison(changed).baseline.runId, a.id);
    assert.ok((await currentMissionDelivery(db, changed.id)).delivery.gaps.some(g => g.code === 'comparison_definition_changed'));
    assert.equal((await tasks(changed.id))[0].spec.kind, 'discovery');
  });
  await check('latest prior result is not cherry-picked for a favorable outcome or compatible requirement', async () => {
    const p = await plan(); await run(p, { ageMs: 200000 });
    const newer = await run(p, { patch: { snapshot: { ...p.testCase, expected: 'Different requirement' } } });
    assert.equal(comparison(await accept(request(p))).baseline.runId, newer.id);
  });
  await check('parallel replay selects once while changed request and foreign owner are denied', async () => {
    const p = await plan(); await run(p); const input = request(p), [a, b] = await Promise.all([accept(input), accept(input)]);
    assert.equal(a.id, b.id); assert.deepEqual(comparison(a), comparison(b)); assert.equal((await tasks(a.id)).length, 1);
    await assert.rejects(accept({ ...input, goal: 'Different request' }), e => e.statusCode === 409);
    await assert.rejects(acceptMission(randomUUID(), workspaceId, threadId, input));
    assert.equal((await db.select().from(schema.missions).where(and(eq(schema.missions.workspaceId, workspaceId), eq(schema.missions.requestId, input.requestId)))).length, 1);
  });
  await check('non-regression intents do not silently add baseline requirements or source refs', async () => {
    const p = await plan(); await run(p);
    for (const intent of ['explore', 'verify']) { const mission = await accept(request(p, { intent })); assert.equal(comparison(mission), undefined); assert.deepEqual((await tasks(mission.id))[0].sources, []); }
  });
  await check('selected-plan persistence preserves historical comparison and never gives its evidence to the new executor', async () => {
    const p = await plan(), a = await run(p), mission = await accept(request(p));
    const research = await saveItem(owner, workspaceId, { title: 'Current B discovery', threadId, content: { kind: 'text', text: JSON.stringify({ title: 'Current service', text: 'Current service', links: [] }) } }, db,
      { provenance: { version: 1, origin: 'tool', producer: 'research-page', sourceType: 'research', observedAt: new Date().toISOString(), url: mission.config.target.url } });
    const task = await db.transaction(async tx => {
      await lockMission(tx, mission.id);
      return addMissionTask(tx, mission, { operationId: `planning:${mission.planRevision}`, title: 'Plan selected current tests', spec: { kind: 'planning', sourceRefs: [{ type: 'research', id: research.id }] } });
    });
    const claimed = await attempts.claimMission(mission.id); assert.ok(claimed);
    const lease = attempts.leaseIdentity(claimed), reserved = await attempts.reserveMissionAttempt(lease, task.id, { usesModel: false });
    assert.equal(reserved.status, 'reserved');
    const prepared = await planner.prepareMissionPlanning(lease, reserved.attempt.id);
    assert.equal(prepared.status, 'prepared'); assert.equal(prepared.input.selectedCases[0].key, p.key);
    assert.deepEqual(prepared.input.sources, []); assert.ok(!JSON.stringify(prepared.input).includes(a.id));
    const published = await planner.persistMissionPlanning(lease, reserved.attempt.id, prepared.fingerprint, null, { tokens: 0, toolCalls: 0, durationMs: 0 });
    const current = await row(schema.missions, mission.id), browser = (await tasks(mission.id)).find(t => t.spec.kind === 'browser_tests');
    assert.deepEqual(comparison(current), comparison(mission)); assert.equal(comparison(current).baseline.runId, a.id);
    assert.deepEqual(browser.criterionIds, current.config.criteria.map(c => c.id));
    assert.deepEqual(browser.spec.planVersions, [{ itemId: p.id, version: 1 }]); assert.deepEqual(published.caseKeys, [p.key]);
    assert.ok(!JSON.stringify(browser.spec).includes(a.id)); assert.ok(!browser.sources.some(s => s.type === 'test'));
  });
} finally {
  globalThis.fetch = originalFetch;
  await db.delete(schema.user).where(eq(schema.user.id, owner)); await app.close();
}
console.log(JSON.stringify({ passed: passed.length, checks: passed, failures }, null, 2));
if (failures.length) process.exitCode = 1;
