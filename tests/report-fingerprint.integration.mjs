import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import { controllerFixture } from './helpers/mission-controller-fixture.mjs';
import { missionReportWriterContext } from '../shared/mission-report-context.ts';

// Real isolated PostgreSQL, controller, source readers and report persistence.
// Controller executors/models are synthetic: this is freshness fault injection,
// not unattended provider/browser/scheduler acceptance.
assert.equal(process.env.GRUNDEN_API_TOKEN, '', 'This suite must not receive a model credential');
const h = await controllerFixture(), { db, schema } = h, passed = [], failures = [];
const { readOwnedReport } = await import('../server/utils/mission-reports.ts');
async function check(name, fn) {
  try { await fn(); passed.push(name); }
  catch (error) { failures.push({ name, message: error.message, stack: error.stack }); console.error(`FAILED ${name}: ${error.message}`); }
}
const stale = f => h.missions.missionReportIsStale(h.owner, f.workspace, f.snapshot);
async function finished(options = {}) {
  const f = await h.fixture({ intent: 'report_only' });
  if (options.plan) {
    const test = { id: randomUUID(), title: 'Selected checkpoint', type: 'browser', preconditions: '', steps: 'Open selected link', expected: 'Destination opens' };
    f.plan = await h.saveItem(h.owner, f.workspace, { title: 'Selected plan', content: { kind: 'test_plan', sources: [], cases: [test] } });
    const mission = await h.row(schema.missions, f.id);
    await db.update(schema.missions).set({ config: { ...mission.config, caseKeys: [`${f.plan.id}:${test.id}`] } }).where(eq(schema.missions.id, f.id));
  }
  const final = await h.settle(f);
  assert.equal(final.mission.lifecycle, 'closed');
  const report = final.reports.find(row => row.status === 'completed');
  assert.ok(report?.itemId, 'Actual worker must persist a completed report item');
  f.report = report;
  f.snapshot = (await h.row(schema.missionSnapshots, report.snapshotId)).input;
  f.source = final.tasks.flatMap(task => task.sources).find(source => source.type === 'material');
  assert.ok(f.source);
  assert.match(f.snapshot.inputFingerprint, /^[a-f0-9]{64}$/);
  assert.equal(await stale(f), false, 'Unmodified completed report starts fresh');
  return f;
}
async function persistedState(f) {
  const state = await h.state(f), more = {};
  for (const key of ['missionEvents', 'missionWaits', 'missionSnapshots']) more[key] = await h.rows(schema[key], f.id);
  more.items = await db.select().from(schema.workspaceItems).where(eq(schema.workspaceItems.workspaceId, f.workspace));
  more.versions = more.items.length ? await db.select().from(schema.workspaceItemVersions).where(inArray(schema.workspaceItemVersions.itemId, more.items.map(item => item.id))) : [];
  // Stable ordering exposes writes to timestamps, leases, queue state and events.
  return JSON.stringify({ ...state, ...more }, (_key, value) => Array.isArray(value) && value.every(row => row && typeof row === 'object' && 'id' in row) ? [...value].sort((a, b) => a.id.localeCompare(b.id)) : value);
}
async function finishedRun() {
  const f = await h.fixture();
  await h.browserReady(f);
  [f.run] = await h.finishBrowser(f);
  const final = await h.settle(f);
  f.report = final.reports.find(report => report.status === 'completed');
  assert.ok(f.report?.itemId);
  f.snapshot = (await h.row(schema.missionSnapshots, f.report.snapshotId)).input;
  assert.ok(f.snapshot.tasks.some(task => task.sources.some(source => source.sourceType === 'test' && source.sourceId === f.run.id)));
  assert.equal(await stale(f), false);
  return f;
}
try {
  await check('report_only stays fresh after real attempt_finished and closed events', async () => {
    const f = await finished(), events = await h.rows(schema.missionEvents, f.id);
    assert.ok(events.some(event => event.kind === 'attempt_finished' && event.revision > f.snapshot.revision));
    assert.ok(events.some(event => event.kind === 'closed' && event.revision > f.snapshot.revision));
    assert.ok((await h.row(schema.missions, f.id)).revision > f.snapshot.revision);
    assert.equal(await stale(f), false);
  });
  await check('repeated report and freshness reads change no state, event, snapshot or queue', async () => {
    const f = await finished(), before = await persistedState(f), calls = h.calls.length;
    for (let i = 0; i < 3; i++) {
      const owned = await readOwnedReport(h.owner, f.workspace, f.report.id);
      assert.equal(owned.report.status, 'completed');
      assert.equal(await h.missions.missionReportIsStale(h.owner, f.workspace, JSON.parse(JSON.stringify(owned.snapshot.input))), false);
    }
    assert.equal(await persistedState(f), before);
    assert.equal(h.calls.length, calls, 'Freshness must not invoke a worker or model');
  });
  await check('normal saved source version edit invalidates report', async () => {
    const f = await finished(), source = await h.row(schema.workspaceItems, f.source.id);
    await h.saveItem(h.owner, f.workspace, { id: source.id, expectedVersion: source.version, title: source.title, content: { kind: 'text', text: 'Changed saved observations' } });
    assert.equal(await stale(f), true);
  });
  await check('same-version source content change invalidates report without revision bump', async () => {
    const f = await finished(), before = await h.row(schema.missions, f.id);
    await db.update(schema.workspaceItems).set({ content: { kind: 'text', text: 'Changed bytes under unchanged item version' } }).where(eq(schema.workspaceItems.id, f.source.id));
    assert.equal((await h.row(schema.missions, f.id)).revision, before.revision);
    assert.equal(await stale(f), true);
  });
  await check('source title change is detected even when evidence content hash is unchanged', async () => {
    const f = await finished();
    await db.update(schema.workspaceItems).set({ title: 'A corrected observation title' }).where(eq(schema.workspaceItems.id, f.source.id));
    assert.equal(await stale(f), true);
  });
  for (const deletion of ['soft', 'hard']) await check(`${deletion}-deleted source is stale rather than fresh or an uncaught 404`, async () => {
    const f = await finished();
    if (deletion === 'soft') await db.update(schema.workspaceItems).set({ deletedAt: new Date() }).where(eq(schema.workspaceItems.id, f.source.id));
    else await db.delete(schema.workspaceItems).where(eq(schema.workspaceItems.id, f.source.id));
    assert.equal(await stale(f), true);
  });
  for (const mode of ['remove', 'replace', 'add']) await check(`source binding ${mode} is detected despite unchanged cached task results`, async () => {
    const f = await finished(), task = (await h.rows(schema.missionTasks, f.id)).find(row => row.sources.length);
    let sources = [];
    if (mode !== 'remove') {
      const item = await h.saveItem(h.owner, f.workspace, { title: 'Other saved input', content: { kind: 'text', text: 'Independent replacement or extra input' } });
      sources = [...(mode === 'add' ? task.sources : []), { type: 'material', id: item.id }];
    }
    await db.update(schema.missionTasks).set({ sources }).where(eq(schema.missionTasks.id, task.id));
    assert.deepEqual((await h.row(schema.missionTasks, task.id)).results, task.results);
    assert.equal(await stale(f), true);
  });
  for (const key of ['goal', 'target', 'criteria']) await check(`mission config ${key} edit invalidates report without event reconciliation`, async () => {
    const f = await finished(), mission = await h.row(schema.missions, f.id);
    const value = key === 'goal' ? 'A changed report objective' : key === 'target' ? { ...mission.config.target, url: 'https://different.example.test/' } : mission.config.criteria.map((criterion, index) => index === 0 ? { ...criterion, text: 'A changed acceptance requirement' } : criterion);
    await db.update(schema.missions).set({ config: { ...mission.config, [key]: value } }).where(eq(schema.missions.id, f.id));
    assert.equal(await stale(f), true);
  });
  for (const mode of ['content', 'version', 'delete']) await check(`selected plan ${mode} change invalidates report without rebinding material`, async () => {
    const f = await finished({ plan: true });
    const values = mode === 'content' ? { content: { ...f.plan.content, cases: f.plan.content.cases.map(test => ({ ...test, expected: 'A changed checkpoint expectation' })) } } : mode === 'version' ? { version: f.plan.version + 1 } : { deletedAt: new Date() };
    await db.update(schema.workspaceItems).set(values).where(eq(schema.workspaceItems.id, f.plan.id));
    assert.equal(await stale(f), true);
  });
  await check('unrelated workspace material does not make completed report stale', async () => {
    const f = await finished();
    const item = await h.saveItem(h.owner, f.workspace, { title: 'Unselected notes', content: { kind: 'text', text: 'Not evidence for this report' } });
    await h.saveItem(h.owner, f.workspace, { id: item.id, expectedVersion: item.version, title: item.title, content: { kind: 'text', text: 'Edited unrelated note' } });
    assert.equal(await stale(f), false);
  });
  await check('selected completed run and assessment remain fresh after controller closure', async () => {
    const f = await finishedRun();
    const assessment = f.snapshot.tasks.flatMap(task => task.sources).find(source => source.sourceId === f.run.id && source.assessment)?.assessment;
    assert.ok(assessment?.id);
    assert.equal((await h.row(schema.resultAssessments, assessment.id)).status, 'completed');
    assert.equal(await stale(f), false);
  });
  for (const field of ['status', 'finishedAt', 'inputHash']) await check('review ' + field + ' changes invalidate fingerprint without rewriting the historical report', async () => {
    const f = await finishedRun(), before = JSON.stringify(f.report), source = f.snapshot.tasks.flatMap(task => task.sources).find(source => source.sourceId === f.run.id && source.assessment);
    assert.equal(source.assessment.status, 'completed'); assert.ok(source.assessment.finishedAt); assert.match(source.assessment.inputHash, /^[a-f0-9]{64}$/);
    await db.update(schema.resultAssessments).set(field === 'status' ? { status: 'failed' } : field === 'finishedAt' ? { finishedAt: null } : { inputHash: '0'.repeat(64) }).where(eq(schema.resultAssessments.id, source.assessment.id));
    assert.equal(await stale(f), true); assert.equal(JSON.stringify(await h.row(schema.missionReports, f.report.id)), before);
  });
  await check('selected run result correction invalidates report', async () => {
    const f = await finishedRun(), run = await h.row(schema.testRuns, f.run.id);
    await db.update(schema.testRuns).set({ result: { ...run.result, actual: 'Corrected observation for the same run' } }).where(eq(schema.testRuns.id, run.id));
    assert.equal(await stale(f), true);
  });
  await check('manual run reservation invalidates report without requiring source reconciliation', async () => {
    const f = await finishedRun(), mission = await h.row(schema.missions, f.id);
    const { reviewTestRun } = await import('../server/utils/test-runs.ts');
    await reviewTestRun(h.owner, f.workspace, { runId: f.run.id, requestId: randomUUID(), outcome: 'failed', reason: 'A human reviewer recorded a concrete reservation.' });
    assert.equal((await h.row(schema.missions, f.id)).revision, mission.revision);
    assert.equal(await stale(f), true);
  });
  await check('selected assessment correction invalidates report', async () => {
    const f = await finishedRun();
    const assessment = f.snapshot.tasks.flatMap(task => task.sources).find(source => source.sourceId === f.run.id && source.assessment)?.assessment;
    assert.ok(assessment?.id);
    const saved = await h.row(schema.resultAssessments, assessment.id);
    await db.update(schema.resultAssessments).set({ assessment: { ...saved.assessment, summary: 'Updated reviewer explanation' } }).where(eq(schema.resultAssessments.id, assessment.id));
    assert.equal(await stale(f), true);
  });
  await check('owner, workspace and runtime boundaries deny both report and freshness access', async () => {
    const f = await finished(), other = await h.fixture({ intent: 'report_only' });
    await assert.rejects(readOwnedReport(randomUUID(), f.workspace, f.report.id), error => error.statusCode === 404);
    await assert.rejects(h.missions.missionReportIsStale(randomUUID(), f.workspace, f.snapshot), error => error.statusCode === 404);
    await assert.rejects(readOwnedReport(h.owner, other.workspace, f.report.id), error => error.statusCode === 404);
    await assert.rejects(h.missions.missionReportIsStale(h.owner, other.workspace, f.snapshot), error => error.statusCode === 404);
    const runtime = process.env.PAT_RUNTIME_SCOPE;
    try {
      process.env.PAT_RUNTIME_SCOPE = `${runtime}-other`;
      await assert.rejects(readOwnedReport(h.owner, f.workspace, f.report.id), error => error.statusCode === 404);
      await assert.rejects(stale(f), error => error.statusCode === 404);
    } finally { process.env.PAT_RUNTIME_SCOPE = runtime; }
  });
  await check('legacy snapshots retain conservative revision fallback', async () => {
    const f = await finished(), legacy = { ...f.snapshot };
    delete legacy.inputFingerprint;
    assert.equal(await h.missions.missionReportIsStale(h.owner, f.workspace, legacy), true);
    legacy.revision = (await h.row(schema.missions, f.id)).revision;
    assert.equal(await h.missions.missionReportIsStale(h.owner, f.workspace, legacy), false);
  });
  await check('saved snapshot JSON compaction deduplicates bindings without mutation or lost source identity', async () => {
    const f = await finished(), snapshot = JSON.parse(JSON.stringify(f.snapshot));
    const task = snapshot.tasks.find(task => task.sources.length), copied = structuredClone(task);
    copied.id = randomUUID();
    copied.criterionIds = ['a-second-criterion'];
    copied.sources = copied.sources.map(source => ({ ...source, context: { ...source.context, taskId: copied.id, criterionIds: copied.criterionIds } }));
    snapshot.tasks.push(copied);
    const before = JSON.stringify(snapshot), compact = missionReportWriterContext(snapshot, new Set(task.sources.flatMap(source => source.evidence.map(item => item.id))));
    assert.equal(JSON.stringify(snapshot), before);
    const matching = compact.sources.filter(source => source.sourceId === task.sources[0].sourceId);
    assert.equal(matching.length, 1);
    const source = matching[0];
    assert.ok(task.criterionIds.every(id => source.criterionIds.includes(id)));
    assert.ok(source.criterionIds.includes('a-second-criterion'));
    assert.equal(source.sourceRevision, task.sources[0].sourceRevision);
    assert.equal(source.sourceId, task.sources[0].sourceId);
    assert.ok(!('context' in source));
    assert.ok(source.evidence.every(evidence => !('excerpt' in evidence)));
    const withoutExcerpt = evidence => { const result = { ...evidence }; delete result.excerpt; return result; };
    assert.deepEqual(source.evidence.map(withoutExcerpt), task.sources[0].evidence.map(withoutExcerpt));
    assert.equal(JSON.parse(JSON.stringify(compact)).inputFingerprint, snapshot.inputFingerprint);
  });
} finally { await h.close(); }
console.log(JSON.stringify({ suite: 'report-fingerprint', passed: passed.length, checks: passed, failures }, null, 2));
if (failures.length) process.exitCode = 1;
