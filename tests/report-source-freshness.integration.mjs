import { reportFixtureObservations } from './helpers/report-check-fixture.mjs';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { registerHooks } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import { eq, sql } from 'drizzle-orm';
import { isolatedApp } from './helpers/isolated-app.mjs';

// Actual isolated SQL/files and authored queues. Model responses and their
// barriers are synthetic; this is not model or browser acceptance.
process.env.PAT_RUNTIME_SCOPE = `${process.env.PAT_RUNTIME_SCOPE}-source-proof-${randomUUID()}`;
const app = await isolatedApp(), { db, schema } = app;
const hooks = registerHooks({ resolve(specifier, context, next) {
  if (/(?:^|\/)result-reviewer(?:\.ts)?$/.test(specifier)) return { url: 'data:text/javascript,export const assessResult = (...args) => globalThis.sourceProofModels.review(...args);', shortCircuit: true };
  if (/(?:^|\/)mission-reporter(?:\.ts)?$/.test(specifier)) return { url: 'data:text/javascript,export const writeMissionReport = (...args) => globalThis.sourceProofModels.report(...args);', shortCircuit: true };
  return next(specifier, context);
} });
const { saveItem, saveFile } = await import('../server/utils/workspaces.ts');
const { testRunAction, reviewTestRun } = await import('../server/utils/test-runs.ts');
const { processReviewQueue } = await import('../server/utils/result-review-worker.ts');
const { missionAction, requestMissionReport } = await import('../server/utils/missions.ts');
const { processMissionReport } = await import('../server/utils/mission-reports.ts');
const { del, workspaceStorageToken } = await import('../server/utils/evidence-storage.ts');
const { MISSION_REPORT_VERSION, REPORT_POLICY_ERROR, hasCurrentReportPolicy } = await import('../shared/mission-report.ts');
const userId = randomUUID(), workspaceId = randomUUID(), threadId = randomUUID();
const target = { environment: 'Synthetic source-proof QA', url: 'https://source-fixture.example.test/', revision: 'fixture-v1' };
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
const files = [], pending = [], checks = [], releases = new Set();
const one = async (table, id) => (await db.select().from(table).where(eq(table.id, id)))[0];
let forcePartial = false;
let gate = null, reportCalls = 0, gatePhase = 'before-model';
function barrier() {
  let entered, release;
  const waiting = new Promise(done => { entered = done; }), released = new Promise(done => { release = done; });
  releases.add(release);
  return { entered: waiting, async wait() { entered(); await released; }, release() { releases.delete(release); release(); } };
}
async function bounded(promise, label) {
  const controller = new AbortController();
  try { return await Promise.race([promise, delay(10000, undefined, { signal: controller.signal }).then(() => { throw new Error(`Timed out: ${label}`); })]); }
  finally { controller.abort(); }
}
globalThis.sourceProofModels = {
  async review(input) {
    return { verdict: 'supported', summary: 'Synthetic checkpoint review', findings: input.requirements.map(check => {
      const ref = input.evidence.find(ref => ref.title === `proof-${check.id}.png`);
      assert.equal(ref?.readStatus, 'read');
      return { requirementId: check.id, verdict: 'supported', explanation: 'Synthetic saved proof', evidenceIds: [ref.id], suggestedNextStep: '', gap: null };
    }) };
  },
  async report(snapshot, read, _signal, options) {
    reportCalls++;
    const ref = snapshot.tasks.flatMap(task => task.sources.flatMap(source => source.evidence)).find(ref => ref.title === 'proof-step-1.png');
    const value = await read(ref.id), reads = new Map([[ref.id, value]]); assert.ok(value.image);
    if (gatePhase === 'after-model') await options.beforeModel();
    if (gate) await gate.wait();
    if (gatePhase === 'before-model') await options.beforeModel();
    return { draft: { summary: 'Synthetic report of the exact saved run', findings: snapshot.config.criteria.map(criterion => ({ criterionId: criterion.id,
      verdict: !forcePartial && snapshot.delivery.criteria.find(row => row.criterionId === criterion.id).complete ? 'supported' : 'needs_evidence', conclusion: 'Saved fixture observations', evidenceIds: [ref.id], observations: reportFixtureObservations(snapshot, criterion.id, [ref.id], 'The saved fixture image is read from the exact selected run.', reads), nextStep: '' })), limitations: [] },
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, steps: 1 } };
  },
};
async function fixture(outcome = 'passed') {
  const test = { id: randomUUID(), title: 'Exact saved source', type: 'browser', preconditions: '', steps: 'Click navigation', expected: 'Destination opens' };
  const plan = await saveItem(userId, workspaceId, { title: 'Source proof fixture', content: { kind: 'test_plan', sources: [], cases: [test] } });
  const run = await testRunAction(userId, workspaceId, threadId, { action: 'start', requestId: randomUUID(), itemId: plan.id, caseId: test.id, expectedVersion: plan.version, target, environment: target.environment });
  const evidence = [];
  for (const check of run.checks) {
    const item = await saveFile(userId, workspaceId, `proof-${check.id}.png`, 'image/png', png, threadId, db,
      { provenance: { version: 1, origin: 'tool', producer: 'test-capture', sourceType: 'test', sourceId: run.id, observedAt: new Date().toISOString(), url: target.url } });
    const saved = await one(schema.workspaceItems, item.id); files.push(saved.blobPath); evidence.push(saved);
    await db.insert(schema.testCaptures).values({ id: randomUUID(), runId: run.id, itemId: item.id, title: check.id, url: target.url, action: 'click' });
  }
  await testRunAction(userId, workspaceId, threadId, { action: 'finish', runId: run.id, result: { outcome, actual: 'Synthetic saved observation', unverified: '', observations: [], evidenceItemIds: evidence.map(item => item.id),
    checks: run.checks.map(check => ({ id: check.id, status: outcome === 'failed' ? 'mismatch' : 'verified', actual: 'Synthetic saved checkpoint' })) } });
  await processReviewQueue();
  const mission = await missionAction(userId, workspaceId, threadId, { action: 'create', requestId: randomUUID(), config: { title: 'Saved-source report', goal: 'Summarize this exact saved run', scope: 'Saved sources only',
    criteria: [{ id: 'saved', text: 'Review selected source', delivery: { kind: 'source', sourceTypes: ['test'], sourceRefs: [{ type: 'test', id: run.id }] } }], caseKeys: [], target, automaticReports: false } });
  const task = await missionAction(userId, workspaceId, threadId, { action: 'task', missionId: mission.id, requestId: randomUUID(), task: { title: 'Saved source', actor: 'main', criterionIds: ['saved'], dependsOn: [] } });
  await missionAction(userId, workspaceId, threadId, { action: 'attach', missionId: mission.id, taskId: task.id, sourceType: 'test', sourceId: run.id });
  const queued = await requestMissionReport(userId, workspaceId, mission.id), report = await one(schema.missionReports, queued.reportId), snapshot = await one(schema.missionSnapshots, report.snapshotId);
  assert.equal(hasCurrentReportPolicy(report.version, snapshot.input), true); assert.equal(snapshot.input.delivery.complete, true);
  return { mission, report, snapshot, run, plan, test, required: evidence.find(item => item.title === 'proof-expected.png') };
}
async function rejectAfterSnapshot(f, mutate, expectedStatus = 'queued') {
  gate = barrier(); const work = processMissionReport(); pending.push(work);
  await bounded(gate.entered, 'synthetic writer after its selected read');
  await mutate(); gate.release(); await bounded(work, 'final source validation'); gate = null;
  const row = await one(schema.missionReports, f.report.id);
  assert.equal(row.status, expectedStatus); assert.equal(row.document, null); assert.equal(row.itemId, null);
  await db.update(schema.missionReports).set({ status: 'failed', leaseToken: null, leaseUntil: null }).where(eq(schema.missionReports.id, row.id));
  return row;
}
async function oldInput(f) {
  const input = structuredClone(f.snapshot.input); input.delivery.schemaVersion = 1;
  await db.update(schema.missionSnapshots).set({ input }).where(eq(schema.missionSnapshots.id, f.report.snapshotId));
}
try {
  assert.equal(process.env.GRUNDEN_API_TOKEN, '');
  await db.insert(schema.user).values({ id: userId, name: 'Source proof fixture', email: `${userId}@example.test` });
  await db.insert(schema.workspaces).values({ id: workspaceId, userId, name: 'Source proof fixture' });
  await db.insert(schema.threads).values({ id: threadId, userId, workspaceId, title: 'Source proof fixture' });
  for (const outcome of ['passed', 'failed']) {
    const f = await fixture(outcome); await processMissionReport(); const result = await one(schema.missionReports, f.report.id);
    assert.equal(result.status, 'completed'); assert.equal(result.document.partial, false); assert.equal(result.document.tests.length, 1);
    assert.equal(result.document.tests[0].runId, f.run.id); assert.equal(result.document.tests[0].originalOutcome, outcome);
    assert.equal(result.readIds.length, 1); checks.push(`source-only ${outcome} result can finish QA without reading every checkpoint into the writer`);
  }
  for (const field of ['status', 'finishedAt', 'inputHash']) {
    const f = await fixture('failed'); forcePartial = true;
    const frozen = f.snapshot.input.tasks.flatMap(task => task.sources).find(source => source.sourceId === f.run.id);
    assert.equal(frozen.assessment.status, 'completed'); assert.ok(frozen.assessment.finishedAt); assert.equal(frozen.assessment.stale, false);
    await rejectAfterSnapshot(f, () => db.update(schema.resultAssessments).set(field === 'status' ? { status: 'failed' } : field === 'finishedAt' ? { finishedAt: null } : { inputHash: '0'.repeat(64) }).where(eq(schema.resultAssessments.id, frozen.assessment.id)));
    forcePartial = false; checks.push('partial copied review rejects changed ' + field + ' after its real file read');
  }
  const copied = await fixture('failed'); forcePartial = true; await processMissionReport(); forcePartial = false;
  const copiedReport = await one(schema.missionReports, copied.report.id);
  assert.equal(copiedReport.status, 'completed'); assert.equal(copiedReport.document.partial, true);
  const saved = copiedReport.document.findings[0].observations.filter(o => o.savedReview);
  assert.equal(saved.length, 1, 'Only the first fully read checkpoint is adopted');
  assert.equal(saved[0].savedReview.reportedStatus, 'mismatch'); assert.equal(saved[0].savedReview.reportedActual, 'Synthetic saved checkpoint');
  assert.equal(saved[0].savedReview.finding.explanation, 'Synthetic saved proof'); assert.equal(saved[0].savedReview.binding.runId, copied.run.id);
  assert.equal(copiedReport.document.tests[0].originalOutcome, 'failed');
  checks.push('actual partial JSONB copies the exact read saved finding and keeps the negative executor result');
  const missing = await fixture(); await rejectAfterSnapshot(missing, () => del(missing.required.blobPath, { token: workspaceStorageToken() }));
  checks.push('required checkpoint bytes not read by writer are revalidated for an exact source reference');
  const changed = await fixture(); await rejectAfterSnapshot(changed, () => saveItem(userId, workspaceId, { id: changed.plan.id, expectedVersion: changed.plan.version, title: changed.plan.title,
    content: { kind: 'test_plan', sources: [], cases: [{ ...changed.test, expected: 'Edited after report snapshot' }] } }));
  checks.push('source-only plan edit invalidates final complete delivery');
  const manual = await fixture(); await rejectAfterSnapshot(manual, () => reviewTestRun(userId, workspaceId, { runId: manual.run.id, requestId: randomUUID(), outcome: 'inconclusive', reason: 'Synthetic reservation after snapshot' }));
  checks.push('source-only manual reservation invalidates final complete delivery');
  const policy = await fixture(); const denied = await rejectAfterSnapshot(policy, () => oldInput(policy), 'failed');
  assert.equal(denied.error, REPORT_POLICY_ERROR); checks.push('changed persisted delivery policy is denied before physical model admission');
  const latePolicy = await fixture(); gatePhase = 'after-model';
  const lateDenied = await rejectAfterSnapshot(latePolicy, () => oldInput(latePolicy), 'failed'); gatePhase = 'before-model';
  assert.equal(lateDenied.error, REPORT_POLICY_ERROR); checks.push('policy change after model admission is denied under the final persistence lock');
  const old = await fixture(), before = reportCalls; await oldInput(old); await processMissionReport();
  const rejected = await one(schema.missionReports, old.report.id); assert.equal(rejected.status, 'failed'); assert.equal(rejected.error, REPORT_POLICY_ERROR); assert.equal(reportCalls, before);
  const replacement = await requestMissionReport(userId, workspaceId, old.mission.id); assert.notEqual(replacement.reportId, old.report.id);
  const next = await one(schema.missionReports, replacement.reportId); assert.equal(next.version, MISSION_REPORT_VERSION);
  assert.equal(hasCurrentReportPolicy(next.version, (await one(schema.missionSnapshots, next.snapshotId)).input), true);
  await processMissionReport(); assert.equal((await one(schema.missionReports, next.id)).status, 'completed');
  checks.push('old queued delivery policy cannot invoke a model or win cached reuse; a fresh snapshot is queued');
  const history = await fixture(); await processMissionReport(); await oldInput(history);
  await db.update(schema.missionReports).set({ version: '4' }).where(eq(schema.missionReports.id, history.report.id));
  const original = JSON.stringify(await one(schema.missionReports, history.report.id)), calls = reportCalls;
  await processMissionReport(); assert.equal(JSON.stringify(await one(schema.missionReports, history.report.id)), original); assert.equal(reportCalls, calls);
  checks.push('completed historical report and artifact remain unchanged');
  console.log(JSON.stringify({ status: 'passed', checks: checks.length, tested: checks, database: 'actual isolated PostgreSQL', storage: 'actual isolated file bytes', models: 'synthetic only' }));
} finally {
  for (const release of releases) release(); await Promise.allSettled(pending);
  for (const file of files) await del(file, { token: workspaceStorageToken() });
  try { await db.delete(schema.testCaptures).where(sql`${schema.testCaptures.runId} in (select id from pat_test_runs where workspace_id=${workspaceId})`); await db.delete(schema.user).where(eq(schema.user.id, userId)); }
  finally { hooks.deregister(); delete globalThis.sourceProofModels; await app.close(); }
}
