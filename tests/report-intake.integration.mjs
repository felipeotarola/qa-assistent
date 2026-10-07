import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { isolatedApp } from './helpers/isolated-app.mjs';

// Actual isolated PostgreSQL and authored admission/run/source services. The
// observations are synthetic saved results; no model, browser or worker runs.
process.env.PAT_RUNTIME_SCOPE = `${process.env.PAT_RUNTIME_SCOPE}-report-intake-${randomUUID()}`;
process.env.MISSIONS_ENABLED = 'true'; process.env.AUTONOMOUS_MISSIONS_ENABLED = 'true';
const app = await isolatedApp(), { db, schema } = app;
const { acceptMission, controlMission } = await import('../server/utils/mission-control.ts');
const { saveItem } = await import('../server/utils/workspaces.ts');
const { testRunAction } = await import('../server/utils/test-runs.ts');
const { missionHash } = await import('../server/utils/mission-sources.ts');
const { missionAdmissionSchema } = await import('../shared/mission-control.ts');
const { currentMissionDelivery, missionAction } = await import('../server/utils/missions.ts');
const owner = randomUUID(), workspace = randomUUID(), thread = randomUUID(), otherWorkspace = randomUUID(), otherThread = randomUUID();
const runtime = process.env.PAT_RUNTIME_SCOPE, target = { environment: 'Fixture QA', url: 'https://report-intake.example.test/', revision: 'commit-a' };
const originalFetch = globalThis.fetch; globalThis.fetch = () => { throw new Error('Network is forbidden in report-intake integration'); };
const passed = [], failures = [];
const row = async (table, id) => (await db.select().from(table).where(eq(table.id, id)))[0];
const tasks = id => db.select().from(schema.missionTasks).where(eq(schema.missionTasks.missionId, id));
async function check(name, fn) { try { await fn(); passed.push(name); } catch (error) { failures.push({ name, message: error.message, stack: error.stack }); console.error(`FAILED ${name}: ${error.message}`); } }
async function plan(count = 1) {
  const cases = Array.from({ length: count }, (_, n) => ({ id: randomUUID(), title: `Saved case ${n + 1}`, type: 'browser', preconditions: '', steps: 'Open the public page', expected: 'The expected page is visible' }));
  const item = await saveItem(owner, workspace, { title: 'Report intake plan', content: { kind: 'test_plan', summary: '', sources: [], cases } });
  return { ...item, cases, keys: cases.map(test => `${item.id}:${test.id}`) };
}
async function run(plan, index = 0, options = {}) {
  const value = options.target === undefined ? target : options.target;
  const started = await testRunAction(owner, workspace, thread, { action: 'start', itemId: plan.id, caseId: plan.cases[index].id, expectedVersion: plan.version, requestId: randomUUID(), environment: value?.environment ?? 'Unknown', ...(value ? { target: value } : {}) });
  if (!options.unfinished) await testRunAction(owner, workspace, thread, { action: 'finish', runId: started.id,
    result: { outcome: 'inconclusive', actual: 'Synthetic saved observation.', unverified: 'No real browser was used by this fixture.', observations: [], evidenceItemIds: [] } });
  if (options.patch) await db.update(schema.testRuns).set(options.patch).where(eq(schema.testRuns.id, started.id));
  return row(schema.testRuns, started.id);
}
const request = (plan, extra = {}) => ({ requestId: randomUUID(), intent: 'report_only', goal: 'Sammanställ vad de sparade testresultaten visar.', target: null, caseKeys: plan?.keys ?? [], ...extra });
const accept = input => acceptMission(owner, workspace, thread, input);
const controls = async (mission, action) => controlMission(owner, workspace, thread, { action, missionId: mission.id, requestId: randomUUID(), expectedMandateRevision: (await row(schema.missions, mission.id)).mandateRevision });
async function executionCounts() { return { attempts: (await db.select().from(schema.missionAttempts).innerJoin(schema.missions, eq(schema.missionAttempts.missionId, schema.missions.id)).where(eq(schema.missions.workspaceId, workspace))).length,
  reviews: (await db.select().from(schema.resultAssessments).where(eq(schema.resultAssessments.workspaceId, workspace))).length,
  runs: (await db.select().from(schema.testRuns).where(eq(schema.testRuns.workspaceId, workspace))).length }; }

try {
  await db.insert(schema.user).values({ id: owner, name: 'Report intake', email: `${owner}@example.test` });
  await db.insert(schema.workspaces).values([{ id: workspace, userId: owner, name: 'Report intake' }, { id: otherWorkspace, userId: owner, name: 'Other report scope' }]);
  await db.insert(schema.threads).values([{ id: thread, userId: owner, workspaceId: workspace, title: 'Report intake' }, { id: otherThread, userId: owner, workspaceId: otherWorkspace, title: 'Other report scope' }]);

  await check('generated QA criteria assess the work without making report persistence its own prerequisite', async () => {
    const goal = 'Testa https://report-intake.example.test och spara rapporten i Material. Bevisa att rapporten är sparad.';
    const input = { requestId: randomUUID(), intent: 'explore', goal, target: { kind: 'public_url', url: target.url } };
    const mission = await accept(input);
    assert.equal(mission.config.goal, goal); assert.equal(mission.admission.goal, goal);
    assert.equal(mission.requestHash, missionHash(missionAdmissionSchema.parse(input)));
    assert.equal(mission.config.criteria.length, 1); assert.equal(mission.config.criteria[0].id, 'qa');
    assert.doesNotMatch(mission.config.criteria[0].text, /rapport|Material/);
    assert.match(mission.config.criteria[0].text, /underbyggt negativt utfall/);
    assert.match(mission.config.criteria[0].text, /otestade eller oklara delar är leveransluckor/);
    assert.equal((await tasks(mission.id))[0].spec.kind, 'discovery');
  });
  await check('selected-case and source report criteria retain their exact scope without copying the output request', async () => {
    const p = await plan(), selected = await run(p);
    const refs = [{ type: 'test', id: selected.id }], goal = 'Skriv en rapport i Material och verifiera att rapporten finns sparad.';
    const mission = await accept(request(p, { goal, sourceRefs: refs }));
    assert.equal(mission.config.goal, goal); assert.equal(mission.admission.goal, goal);
    assert.deepEqual(mission.config.criteria.map(c => c.delivery), [
      { kind: 'test_cases', caseKeys: p.keys }, { kind: 'source', sourceTypes: ['test'], sourceRefs: refs },
    ]);
    for (const criterion of mission.config.criteria) assert.doesNotMatch(criterion.text, /rapport|Material/);
    assert.match(mission.config.criteria[0].text, /befintliga/);
    const [task] = await tasks(mission.id); assert.equal(task.spec.kind, 'report');
    assert.deepEqual(mission.mandate.allowedTaskKinds, ['review', 'report']);
    const sourceOnly = await accept(request(null, { goal, sourceRefs: refs }));
    assert.equal(sourceOnly.config.criteria.length, 1);
    assert.deepEqual(sourceOnly.config.criteria[0].delivery.sourceRefs, refs);
    assert.doesNotMatch(sourceOnly.config.criteria[0].text, /rapport|Material/);
  });
  await check('replaying an existing admission preserves its original custom criterion verbatim', async () => {
    const p = await plan(), input = request(p), mission = await accept(input);
    const config = { ...mission.config, criteria: [{ ...mission.config.criteria[0], text: 'Explicit original criterion: preserve this report requirement.' }] };
    await db.update(schema.missions).set({ config }).where(eq(schema.missions.id, mission.id));
    const replay = await accept(input);
    assert.equal(replay.id, mission.id); assert.deepEqual(replay.config, config);
    assert.equal((await tasks(mission.id)).length, 1);
  });
  await check('legacy custom criteria remain intact when a new autonomous mission is admitted', async () => {
    const config = { title: 'Explicit legacy criterion', goal: 'A deliberately custom report contract.', scope: 'Saved fixtures',
      criteria: [{ id: 'custom', text: 'The report must contain the explicitly requested audit details.' }], caseKeys: [], target: null, automaticReports: false };
    const legacy = await missionAction(owner, workspace, thread, { action: 'create', requestId: randomUUID(), config });
    await accept({ requestId: randomUUID(), intent: 'explore', goal: 'Testa sidan och skriv en rapport.', target: { kind: 'public_url', url: target.url } });
    assert.deepEqual((await row(schema.missions, legacy.id)).config, config);
  });
  await check('caseKeys-only admission freezes latest finished runs and derives their original target without execution', async () => {
    const p = await plan(2), old = await run(p, 0), latest = await run(p, 0), second = await run(p, 1);
    await db.update(schema.testRuns).set({ finishedAt: new Date('2026-01-01T00:00:00Z') }).where(eq(schema.testRuns.id, old.id));
    const before = await executionCounts(), input = request(p), mission = await accept(input), [task] = await tasks(mission.id);
    assert.deepEqual(mission.admission.sourceRefs, [{ type: 'test', id: latest.id }, { type: 'test', id: second.id }]);
    assert.deepEqual(task.sources, mission.admission.sourceRefs); assert.deepEqual(task.spec.sourceRefs, task.sources);
    assert.deepEqual(task.results.map(s => s.sourceId), [latest.id, second.id]); assert.deepEqual(mission.config.target, target);
    assert.equal(mission.requestHash, missionHash(missionAdmissionSchema.parse(input))); assert.equal(task.spec.kind, 'report');
    assert.match(mission.config.scope, /frystes/); assert.deepEqual(await executionCounts(), before);
    assert.deepEqual(mission.mandate.allowedTaskKinds, ['review', 'report']);
  });
  await check('explicit references are preserved and auto-selected runs are deduplicated', async () => {
    const p = await plan(), selected = await run(p), item = await saveItem(owner, workspace, { title: 'Existing notes', content: { kind: 'text', text: 'Independent source selection fixture.' } });
    const input = request(p, { sourceRefs: [{ type: 'material', id: item.id }, { type: 'test', id: selected.id }] });
    const mission = await accept(input), [task] = await tasks(mission.id);
    assert.deepEqual(mission.admission.sourceRefs, input.sourceRefs); assert.equal(task.results.length, 2);
    assert.deepEqual(mission.config.criteria[1].delivery.sourceRefs, input.sourceRefs);
  });
  await check('source-only report requires both exact run IDs, not just their common source type', async () => {
    const p = await plan(2), a = await run(p, 0), b = await run(p, 1), before = await executionCounts();
    const refs = [{ type: 'test', id: a.id }, { type: 'test', id: b.id }];
    const mission = await accept(request(null, { sourceRefs: refs })), [task] = await tasks(mission.id);
    assert.deepEqual(mission.config.criteria[0].delivery.sourceRefs, refs);
    await db.update(schema.missionTasks).set({ sources: [refs[0]] }).where(eq(schema.missionTasks.id, task.id));
    const { delivery } = await currentMissionDelivery(db, mission.id);
    assert.equal(delivery.complete, false); assert.ok(delivery.gaps.some(gap => gap.code === 'source_missing' && gap.sourceId === b.id));
    assert.deepEqual(await executionCounts(), before);
  });
  await check('source-only metrics load the selected run definitions and preserve incomplete originals', async () => {
    const p = await plan(), original = await run(p);
    const mission = await accept(request(null, { sourceRefs: [{ type: 'test', id: original.id }] }));
    await run(p); // Not selected: a newer result must not replace the original.
    const before = await executionCounts();
    const delivery = await currentMissionDelivery(db, mission.id);
    assert.equal(delivery.delivery.complete, false);
    assert.ok(delivery.delivery.gaps.some(gap => gap.sourceId === original.id && gap.code === 'result_incomplete'));
    assert.ok(!delivery.delivery.gaps.some(gap => gap.code === 'run_stale'), 'The existing selected plan was loaded despite empty caseKeys');
    assert.deepEqual((await tasks(mission.id))[0].sources, [{ type: 'test', id: original.id }]);
    assert.deepEqual(await executionCounts(), before);
    const oldExpected = original.snapshot.expected;
    await saveItem(owner, workspace, { id: p.id, expectedVersion: p.version, title: p.title, content: { ...p.content, cases: [{ ...p.cases[0], expected: 'Different expected behavior' }] } });
    const changed = await currentMissionDelivery(db, mission.id);
    assert.ok(changed.delivery.gaps.some(gap => gap.code === 'run_stale'));
    assert.equal((await row(schema.testRuns, original.id)).snapshot.expected, oldExpected);
  });
  await check('unfinished, foreign-runtime, unknown-runtime and foreign-workspace results are not auto-selected', async () => {
    const p = await plan(), valid = await run(p);
    await run(p, 0, { unfinished: true });
    await run(p, 0, { patch: { runtime: `${runtime}-other`, finishedAt: new Date('2099-01-01T00:00:00Z') } });
    await run(p, 0, { patch: { runtime: null, finishedAt: new Date('2099-01-02T00:00:00Z') } });
    await run(p, 0, { patch: { workspaceId: otherWorkspace, threadId: otherThread, finishedAt: new Date('2099-01-03T00:00:00Z') } });
    const mission = await accept(request(p)); assert.deepEqual(mission.admission.sourceRefs, [{ type: 'test', id: valid.id }]);
  });
  await check('mixed test targets keep source identities but do not fabricate a common target', async () => {
    const p = await plan(2), a = await run(p, 0), other = { ...target, revision: 'commit-b' }, b = await run(p, 1, { target: other });
    const mission = await accept(request(p, { target: { kind: 'public_url', url: 'https://unverified.example.test/' } })), [task] = await tasks(mission.id);
    assert.equal(mission.config.target, null); assert.deepEqual(task.results.map(s => s.target), [target, other]);
    assert.deepEqual(task.sources.map(s => s.id), [a.id, b.id]); assert.equal(task.spec.partial, true); assert.match(mission.config.scope, /olika mål/);
  });
  await check('unknown historical targets remain unknown even if the report request supplies a URL', async () => {
    const p = await plan(); await run(p, 0, { target: null });
    const mission = await accept(request(p, { target: { kind: 'public_url', url: target.url } }));
    assert.equal(mission.config.target, null); assert.match(mission.config.scope, /saknar känd målidentitet/);
  });
  await check('missing finished runs stay explicit gaps with a runnable partial report and no new work', async () => {
    const p = await plan(2); await run(p, 1, { unfinished: true }); const before = await executionCounts();
    const mission = await accept(request(p)), [task] = await tasks(mission.id);
    assert.deepEqual(mission.admission.sourceRefs, []); assert.equal(task.state, 'pending'); assert.equal(task.spec.kind, 'report'); assert.equal(task.spec.partial, true);
    assert.match(task.blockedReason, /2 valda testfall saknar/); assert.deepEqual(await executionCounts(), before);
    assert.equal((await currentMissionDelivery(db, mission.id)).delivery.complete, false);
  });
  await check('same-request replay keeps frozen run IDs after a newer result appears and rejects changed input', async () => {
    const p = await plan(), first = await run(p), input = request(p), mission = await accept(input);
    const newer = await run(p); assert.notEqual(newer.id, first.id);
    const replay = await accept(input); assert.equal(replay.id, mission.id); assert.deepEqual(replay.admission.sourceRefs, [{ type: 'test', id: first.id }]);
    await assert.rejects(accept({ ...input, goal: 'Changed report request' }), error => error.statusCode === 409);
    assert.equal((await tasks(mission.id)).length, 1);
  });
  await check('resume restores frozen report sources and results without selecting a newer run or observation scope', async () => {
    const p = await plan(), original = await run(p), input = request(p, { target: { kind: 'public_url', url: target.url } }), mission = await accept(input);
    await controls(mission, 'pause'); await run(p);
    const before = await executionCounts(), resumed = await controls(mission, 'resume');
    const task = (await tasks(mission.id)).find(t => t.planRevision === resumed.planRevision);
    assert.deepEqual(task.sources, [{ type: 'test', id: original.id }]); assert.deepEqual(task.results.map(s => s.sourceId), [original.id]);
    assert.deepEqual(resumed.config.target, target); assert.deepEqual(resumed.admission.sourceRefs, mission.admission.sourceRefs);
    assert.equal(task.spec.kind, 'report'); assert.deepEqual(await executionCounts(), before);
  });
  await check('a result absent at admission is not silently adopted on resume', async () => {
    const p = await plan(), mission = await accept(request(p)); await controls(mission, 'pause'); await run(p);
    const resumed = await controls(mission, 'resume'), task = (await tasks(mission.id)).find(t => t.planRevision === resumed.planRevision);
    assert.deepEqual(task.sources, []); assert.equal(task.spec.partial, true); assert.match(task.blockedReason, /saknar en avslutad körning/);
  });
  await check('changed current plan remains an explicit historical-version gap without replacing its saved run', async () => {
    const p = await plan(), original = await run(p), mission = await accept(request(p)); await controls(mission, 'pause');
    await saveItem(owner, workspace, { id: p.id, expectedVersion: p.version, title: p.title, content: { ...p.content, cases: [{ ...p.cases[0], expected: 'New requirement' }] } });
    const resumed = await controls(mission, 'resume'), task = (await tasks(mission.id)).find(t => t.planRevision === resumed.planRevision);
    assert.deepEqual(task.sources, [{ type: 'test', id: original.id }]); assert.equal(task.spec.partial, true); assert.match(resumed.config.scope, /annan testplansversion/);
    assert.equal((await row(schema.testRuns, original.id)).snapshot.expected, p.cases[0].expected);
    assert.equal((await currentMissionDelivery(db, mission.id)).delivery.complete, false);
  });
  await check('source-only report resume also restores explicitly selected material', async () => {
    const item = await saveItem(owner, workspace, { title: 'Existing material', content: { kind: 'text', text: 'Saved input only.' } });
    const input = request(null, { sourceRefs: [{ type: 'material', id: item.id }] }), mission = await accept(input);
    await controls(mission, 'pause'); const resumed = await controls(mission, 'resume'), task = (await tasks(mission.id)).find(t => t.planRevision === resumed.planRevision);
    assert.deepEqual(task.sources, input.sourceRefs); assert.equal(task.results[0].sourceId, item.id); assert.equal(resumed.config.target, null);
  });
  await check('parallel replay freezes one selection and creates one report task', async () => {
    const p = await plan(); await run(p); const input = request(p);
    const [a, b] = await Promise.all([accept(input), accept(input)]); assert.equal(a.id, b.id); assert.deepEqual(a.admission.sourceRefs, b.admission.sourceRefs);
    assert.equal((await tasks(a.id)).length, 1);
    assert.equal((await db.select().from(schema.missions).where(and(eq(schema.missions.workspaceId, workspace), eq(schema.missions.requestId, input.requestId)))).length, 1);
  });
} finally {
  globalThis.fetch = originalFetch;
  await db.delete(schema.user).where(eq(schema.user.id, owner)); await app.close();
}
console.log(JSON.stringify({ passed: passed.length, checks: passed, failures }, null, 2));
if (failures.length) process.exitCode = 1;
