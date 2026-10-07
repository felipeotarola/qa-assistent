import { reportFixtureObservations } from './helpers/report-check-fixture.mjs';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import { controllerFixture } from './helpers/mission-controller-fixture.mjs';

// Real isolated PostgreSQL, controller, result/review/report persistence and
// saved file reads. Planning, browser transport and models are synthetic.
const h = await controllerFixture(), { db, schema } = h, checks = [], files = [], captures = [];
const { testRunAction } = await import('../server/utils/test-runs.ts');
const { runChecks } = await import('../shared/test-run.ts');
const { saveFile } = await import('../server/utils/workspaces.ts');
const { del, workspaceStorageToken } = await import('../server/utils/evidence-storage.ts');
const originalPlanner = h.scripts.planMission;
h.scripts.planMission = async (...args) => {
  const result = await originalPlanner(...args), first = result.draft.cases[0];
  result.draft.cases = Array.from({ length: 2 }, (_, i) => ({ ...structuredClone(first), title: `Original case ${i + 1}` }));
  return result;
};
h.scripts.assessResult = async (input, attachments, _signal, onUsage) => {
  assert.ok(attachments.length); const proof = input.evidence.find(e => e.itemId && e.readStatus === 'read'); assert.ok(proof);
  onUsage?.(12, { providerCalls: 1, unknownCalls: 0, inputTokens: 10, outputTokens: 2, totalTokens: 12, cacheReadTokens: 0, cacheWriteTokens: null, durationMs: 1 });
  return { verdict: 'supported', summary: 'The synthetic saved bytes support the reported negative observation.', findings: input.requirements.map(r => ({ requirementId: r.id, verdict: 'supported', explanation: 'Synthetic model; actual saved bytes were read.', evidenceIds: [proof.id], suggestedNextStep: '', gap: null })) };
};
h.scripts.writeMissionReport = async (snapshot, read, _signal, options) => {
  await options.beforeModel(); const readIds = [], reads = new Map();
  const evidence = new Map(snapshot.tasks.flatMap(t => t.sources.flatMap(s => s.evidence)).map(e => [e.id, e]));
  for (const item of evidence.values()) if (item.origin === 'tool' && item.itemId) { const value = await read(item.id); reads.set(item.id, value); if (value.text && !value.unavailable && !value.limited) readIds.push(item.id); }
  const supported = snapshot.delivery.complete;
  return { draft: { summary: 'Synthetic QA report preserves product failures.', findings: snapshot.config.criteria.map(c => ({ criterionId: c.id, verdict: supported ? 'supported' : 'needs_evidence', conclusion: supported ? 'All original checks were executed; observed defects remain failed product outcomes.' : 'Original work remains incomplete.', evidenceIds: readIds, observations: reportFixtureObservations(snapshot, c.id, readIds, 'The saved fixture observations preserve the reported passed and failed product outcomes.', reads), nextStep: '' })), limitations: ['Synthetic executor/model; no real browser invoked.'] }, usage: { inputTokens: 20, outputTokens: 20, totalTokens: 40, toolCalls: readIds.length, steps: 1 } };
};
async function prepared() {
  const f = await h.fixture(), state = await h.browserReady(f), attempt = state.attempts.find(a => a.kind === 'browser_tests');
  return { f, attempt, task: state.tasks.find(t => t.id === attempt.taskId) };
}
async function runCase(f, attempt, task, key) {
  const [itemId, caseId] = key.split(':'), options = { execution: { attemptId: attempt.id, dispatchId: attempt.dispatchId } };
  const run = await testRunAction(h.owner, f.workspace, f.thread, { action: 'start', itemId, caseId, expectedVersion: task.spec.planVersions.find(p => p.itemId === itemId).version, requestId: randomUUID(), environment: task.spec.target.environment, target: task.spec.target, mission: { missionId: f.id, taskId: task.id } }, options);
  const proof = await saveFile(h.owner, f.workspace, 'synthetic-negative.txt', 'text/plain', Buffer.from('Synthetic independent observation: the requested navigation returned HTTP 404.'), f.thread, db, { provenance: { version: 1, origin: 'tool', producer: 'test-capture', sourceType: 'test', sourceId: run.id, observedAt: new Date().toISOString(), url: run.target.url } });
  files.push((await h.row(schema.workspaceItems, proof.id)).blobPath); const capture = randomUUID(); captures.push(capture);
  await db.insert(schema.testCaptures).values({ id: capture, runId: run.id, itemId: proof.id, title: 'Synthetic capture', action: 'inspect', url: run.target.url });
  await testRunAction(h.owner, f.workspace, f.thread, { action: 'finish', runId: run.id, result: { schemaVersion: 2, outcome: 'failed', actual: 'Synthetic reported product failure, HTTP 404.', checks: runChecks(run.snapshot).map(c => ({ id: c.id, status: c.id === 'expected' ? 'mismatch' : 'verified', actual: 'Synthetic actual observation.' })), remaining: [], observations: [], evidenceItemIds: [proof.id] } }, options);
  return run;
}
async function stop(attempt, status = 'failed') {
  await db.update(schema.missionAttempts).set({ usage: { tokens: 100, toolCalls: 2, durationMs: 1 } }).where(eq(schema.missionAttempts.id, attempt.id));
  await db.update(schema.browserJobs).set({ status, updatedAt: new Date() }).where(eq(schema.browserJobs.id, attempt.dispatchId));
}
const recovery = state => state.tasks.filter(t => t.operationId?.startsWith('browser-remainder:'));
async function check(name, fn) { await fn(); checks.push(name); console.log(`PASS ${name}`); }
async function readyForReport() {
  const value = await prepared(), { f, attempt, task } = value;
  value.originalRun = await runCase(f, attempt, task, task.spec.caseKeys[0]);
  await stop(attempt, 'completed'); await h.pass(f);
  const rest = recovery(await h.state(f))[0]; assert.ok(rest);
  await h.pass(f); const next = (await h.state(f)).attempts.find(row => row.taskId === rest.id); assert.ok(next);
  value.recoveredRun = await runCase(f, next, rest, rest.spec.caseKeys[0]); await stop(next, 'completed');
  for (let step = 0; step < 20; step++) {
    await h.workers(f); await h.pass(f); const state = await h.state(f);
    if (state.tasks.some(row => row.spec.kind === 'report')) {
      assert.equal(state.reports.length, 0, 'Fault injection must precede the real snapshot commit');
      const source = state.tasks.find(row => row.id === task.id);
      assert.equal(source.state, 'blocked'); assert.ok(source.blockedReason);
      const events = await h.rows(schema.missionEvents, f.id), event = events.find(row => row.kind === 'browser_remainder_planned'); assert.ok(event);
      return { ...value, rest, next, source, event };
    }
  }
  assert.fail('Synthetic integration did not reach pre-report window');
}
async function reportFor(value) {
  const state = await h.settle(value.f), report = state.reports.find(row => row.status === 'completed'); assert.ok(report);
  const snapshot = (await h.row(schema.missionSnapshots, report.snapshotId)).input;
  const source = await h.row(schema.missionTasks, value.source.id);
  assert.equal(source.state, value.source.state); assert.equal(source.blockedReason, value.source.blockedReason);
  assert.deepEqual(source.spec, value.source.spec);
  assert.deepEqual((await h.row(schema.testRuns, value.originalRun.id)).result, value.originalRun.result);
  return { state, report, snapshot };
}
try {
  await check('actual snapshot labels only a verified recovered task note as historical without changing the original failure or full coverage', async () => {
    const value = await readyForReport();
    // The returned start row predates FINISH; freeze the actual original result.
    value.originalRun = await h.row(schema.testRuns, value.originalRun.id);
    const { state, report, snapshot } = await reportFor(value);
    assert.equal(state.mission.closureReason, 'investigated'); assert.equal(snapshot.delivery.complete, true);
    assert.equal(report.document.partial, false); assert.ok(snapshot.delivery.cases.every(row => row.complete));
    const note = snapshot.gaps.find(text => text.startsWith(`Historisk notering för ${value.source.title}:`));
    assert.ok(note?.includes(value.source.blockedReason)); assert.ok(note.includes('hela urval'));
    assert.ok(report.document.limitations.includes(note));
    assert.ok(snapshot.gaps.some(text => text.includes('En agentrapport styrker inte ensam')), 'Source-local evidence limitations must remain');
    assert.ok(report.document.tests.every(row => row.originalOutcome === 'failed' && row.status === 'failed'));
    const frozen = JSON.stringify(snapshot); await h.pass(value.f);
    assert.equal(JSON.stringify((await h.row(schema.missionSnapshots, report.snapshotId)).input), frozen);
    assert.equal(await h.missions.missionReportIsStale(h.owner, value.f.workspace, snapshot), false);
    // Fault injection after publication changes only the immutable lineage input.
    // A future GET reports staleness; it never rewrites the original artifact.
    await db.update(schema.missionEvents).set({ payload: { ...value.event.payload, sourceSpecHash: '0'.repeat(64) } }).where(eq(schema.missionEvents.id, value.event.id));
    assert.equal(await h.missions.missionReportIsStale(h.owner, value.f.workspace, snapshot), true);
    assert.equal(JSON.stringify((await h.row(schema.missionSnapshots, report.snapshotId)).input), frozen);
  });
  await check('cache request never adopts a successful stale history projection and keeps its original snapshot immutable', async () => {
    const value = await readyForReport();
    await h.pass(value.f); await h.workers(value.f);
    const before = await h.state(value.f), old = before.reports.find(row => row.status === 'completed'); assert.ok(old);
    assert.notEqual(before.mission.lifecycle, 'closed');
    const snapshot = await h.row(schema.missionSnapshots, old.snapshotId), bytes = JSON.stringify(snapshot);
    await db.update(schema.missionEvents).set({ payload: { ...value.event.payload, sourceSpecHash: '0'.repeat(64) } }).where(eq(schema.missionEvents.id, value.event.id));
    assert.equal(await h.missions.missionReportIsStale(h.owner, value.f.workspace, snapshot.input), true);
    await db.update(schema.missions).set({ nextWakeAt: new Date(0) }).where(eq(schema.missions.id, value.f.id));
    const lease = h.attempts.leaseIdentity(await h.attempts.claimMission(value.f.id));
    try {
      const attempt = before.attempts.find(row => row.kind === 'report'); assert.ok(attempt);
      const next = await h.missions.requestMissionReport(h.owner, value.f.workspace, value.f.id, false, { ...lease, attemptId: attempt.id });
      assert.ok(next.reportId && next.reportId !== old.id); assert.equal(next.status, 'queued');
      const queued = await h.row(schema.missionReports, next.reportId), fresh = await h.row(schema.missionSnapshots, queued.snapshotId);
      assert.ok(fresh.revision > snapshot.revision); assert.notEqual(fresh.input.inputFingerprint, snapshot.input.inputFingerprint);
      assert.ok(fresh.input.gaps.includes(`${value.source.title}: ${value.source.blockedReason}`));
      assert.equal(JSON.stringify(await h.row(schema.missionSnapshots, old.snapshotId)), bytes);
      assert.deepEqual((await h.row(schema.missionReports, old.id)).document, old.document);
    } finally { await h.attempts.releaseMissionLease(lease, 0); }
  });
  for (const mode of ['missing_event', 'changed_hash', 'changed_epoch', 'unread_review', 'changed_plan']) {
    await check(`actual snapshot retains current limitation for ${mode}`, async () => {
      const value = await readyForReport(); value.originalRun = await h.row(schema.testRuns, value.originalRun.id);
      if (mode === 'missing_event') await db.delete(schema.missionEvents).where(eq(schema.missionEvents.id, value.event.id));
      if (mode === 'changed_hash') await db.update(schema.missionEvents).set({ payload: { ...value.event.payload, sourceSpecHash: '0'.repeat(64) } }).where(eq(schema.missionEvents.id, value.event.id));
      if (mode === 'changed_epoch') await db.update(schema.missionEvents).set({ payload: { ...value.event.payload, mandateRevision: value.event.payload.mandateRevision + 1 } }).where(eq(schema.missionEvents.id, value.event.id));
      if (mode === 'unread_review') {
        const rows = await db.select().from(schema.resultAssessments).where(eq(schema.resultAssessments.runId, value.recoveredRun.id));
        assert.equal(rows.length, 1);
        await db.update(schema.resultAssessments).set({ status: 'failed', assessment: null, error: 'Synthetic evidence review failure before snapshot' }).where(eq(schema.resultAssessments.id, rows[0].id));
      }
      if (mode === 'changed_plan') {
        const item = await h.row(schema.workspaceItems, value.task.spec.planVersions[0].itemId);
        await h.saveItem(h.owner, value.f.workspace, { id: item.id, expectedVersion: item.version, title: item.title,
          content: { ...item.content, summary: 'Synthetic changed plan after earlier execution' } });
      }
      const { snapshot } = await reportFor(value);
      assert.ok(snapshot.gaps.includes(`${value.source.title}: ${value.source.blockedReason}`));
      assert.ok(!snapshot.gaps.some(text => text.startsWith(`Historisk notering för ${value.source.title}:`)));
      if (['unread_review', 'changed_plan'].includes(mode)) assert.equal(snapshot.delivery.complete, false);
    });
  }
} finally {
  if (captures.length) await db.delete(schema.testCaptures).where(inArray(schema.testCaptures.id, captures));
  for (const path of files) await del(path, { token: workspaceStorageToken() });
  await h.close();
}
console.log(JSON.stringify({ passed: checks.length, checks, database: 'actual isolated PostgreSQL', models: 'synthetic', proof: 'report historical-label projection, no original rewrite' }));
