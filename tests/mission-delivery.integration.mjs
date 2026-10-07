import { reportFixtureObservations } from './helpers/report-check-fixture.mjs';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { registerHooks } from 'node:module';
import { eq, sql } from 'drizzle-orm';
import { isolatedApp } from './helpers/isolated-app.mjs';

// Real database, authored services and file reads; deterministic model responses.
// This exercises structural delivery, not unattended model acceptance.
process.env.PAT_RUNTIME_SCOPE = `${process.env.PAT_RUNTIME_SCOPE}-delivery-${randomUUID()}`;
const app = await isolatedApp(), { db, schema } = app;
const hooks = registerHooks({ resolve(specifier, _context, next) {
  if (/(?:^|\/)result-reviewer(?:\.ts)?$/.test(specifier)) return { url: 'data:text/javascript,export const assessResult = (...args) => globalThis.deliveryModels.review(...args);', shortCircuit: true };
  if (/(?:^|\/)mission-reporter(?:\.ts)?$/.test(specifier)) return { url: 'data:text/javascript,export const writeMissionReport = (...args) => globalThis.deliveryModels.report(...args);', shortCircuit: true };
  return next(specifier, _context);
} });
const { saveItem, saveFile } = await import('../server/utils/workspaces.ts');
const { testRunAction, reviewTestRun } = await import('../server/utils/test-runs.ts');
const { processReviewQueue } = await import('../server/utils/result-review-worker.ts');
const { missionAction, requestMissionReport, bindMissionSource } = await import('../server/utils/missions.ts');
const { processMissionReport } = await import('../server/utils/mission-reports.ts');
const { sharedReportDocument } = await import('../shared/report-sharing.ts');
const { del, workspaceStorageToken } = await import('../server/utils/evidence-storage.ts');
const { REVIEWER_VERSION } = await import('../shared/result-assessment.ts');
const userId = randomUUID(), workspaceId = randomUUID(), threadId = randomUUID(), files = [];
const target = { environment: 'isolated structural fixture', url: 'https://example.test', revision: 'fixture-v1' };
const one = async (table, id) => (await db.select().from(table).where(eq(table.id, id)))[0];
let checks = 0;
globalThis.deliveryModels = {
  async review(input) {
    const evidence = input.evidence.find(e => e.readStatus === 'read' && e.provenance?.producer === 'test-capture');
    assert.ok(evidence);
    return { verdict: 'supported', summary: 'Synthetic observations supported', findings: input.requirements.map(r => ({ requirementId: r.id, verdict: 'supported', explanation: 'Synthetic fixture matches', evidenceIds: [evidence.id], suggestedNextStep: '', gap: null })) };
  },
  async report(snapshot, read) {
    const evidence = snapshot.tasks.flatMap(t => t.sources.filter(s => s.sourceType === 'test').flatMap(s => s.evidence.filter(e => e.provenance?.producer === 'test-capture')));
    const reads = new Map();
    for (const e of evidence) { const value = await read(e.id); reads.set(e.id, value); assert.ok(value.text); }
    return { draft: { summary: 'Synthetic QA report', findings: snapshot.config.criteria.map(c => ({ criterionId: c.id, verdict: snapshot.delivery.criteria.find(d => d.criterionId === c.id).complete ? 'supported' : 'needs_evidence', conclusion: 'Observed fixture results', evidenceIds: evidence.map(e => e.id), observations: reportFixtureObservations(snapshot, c.id, evidence.map(e => e.id), 'The saved fixture observations show the original reported outcomes.', reads), nextStep: '' })), limitations: [] }, usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, steps: 1 } };
  },
};
try {
  assert.equal(process.env.GRUNDEN_API_TOKEN, '');
  await db.insert(schema.user).values({ id: userId, name: 'Delivery fixture', email: `${userId}@example.test` });
  await db.insert(schema.workspaces).values({ id: workspaceId, userId, name: 'Delivery fixture' });
  await db.insert(schema.threads).values({ id: threadId, userId, workspaceId, title: 'Delivery fixture' });
  const cases = Array.from({ length: 3 }, (_, index) => ({ id: randomUUID(), title: `Synthetic case ${index + 1}`, type: 'browser', preconditions: '', steps: 'Click the visible link', expected: 'Destination opens' }));
  const plan = await saveItem(userId, workspaceId, { title: 'Three cases', content: { kind: 'test_plan', sources: [], cases } });
  const caseKeys = cases.map(c => `${plan.id}:${c.id}`);
  const config = { title: 'Fixture QA', goal: 'Verify all selected cases', scope: 'Fixture only', criteria: [{ id: 'navigation', text: 'Inspect navigation', delivery: { kind: 'test_cases', caseKeys } }], caseKeys, target, automaticReports: false };
  const mission = await missionAction(userId, workspaceId, threadId, { action: 'create', requestId: randomUUID(), config });
  const task = await missionAction(userId, workspaceId, threadId, { action: 'task', missionId: mission.id, requestId: randomUUID(), task: { title: 'Execute selected cases', actor: 'browser', criterionIds: ['navigation'], dependsOn: [] } });
  const binding = { missionId: mission.id, taskId: task.id };
  const irisId = randomUUID();
  await db.insert(schema.browserJobs).values({ id: irisId, threadId, runtime: process.env.PAT_RUNTIME_SCOPE, parentSessionId: 'synthetic', task: 'Synthetic browser task', status: 'completed', report: 'All done', model: 'fixture', reasoning: 'low' });
  await bindMissionSource(userId, workspaceId, threadId, binding, 'browser', irisId);
  const runs = [];
  async function finishCase(index, failed = false) {
    const run = await testRunAction(userId, workspaceId, threadId, { action: 'start', requestId: randomUUID(), itemId: plan.id, caseId: cases[index].id, expectedVersion: plan.version, target, environment: target.environment });
    await bindMissionSource(userId, workspaceId, threadId, binding, 'test', run.id);
    const capture = await saveFile(userId, workspaceId, `case-${index}.txt`, 'text/plain', Buffer.from(failed ? 'Clicked link; destination returned HTTP 500' : 'Clicked link; destination opened'), threadId, db, { provenance: { version: 1, origin: 'tool', producer: 'test-capture', sourceType: 'test', sourceId: run.id, observedAt: new Date().toISOString(), url: target.url } });
    files.push((await one(schema.workspaceItems, capture.id)).blobPath);
    await db.insert(schema.testCaptures).values({ id: randomUUID(), runId: run.id, itemId: capture.id, title: 'Actual saved fixture bytes', url: target.url, action: 'click' });
    const result = { outcome: failed ? 'failed' : 'passed', actual: failed ? 'HTTP 500 after click' : 'Destination opened', unverified: '', observations: failed ? [{ title: 'HTTP error', detail: 'Destination returned 500', kind: 'defect' }] : [], evidenceItemIds: [capture.id], checks: run.checks.map((c, i) => ({ id: c.id, status: failed && i === run.checks.length - 1 ? 'mismatch' : 'verified', actual: 'Synthetic saved observation' })) };
    await testRunAction(userId, workspaceId, threadId, { action: 'finish', runId: run.id, result });
    await processReviewQueue(); runs.push({ ...run, capture, result });
  }
  const read = () => missionAction(userId, workspaceId, threadId, { action: 'read', missionId: mission.id });
  const report = async () => {
    const queued = await requestMissionReport(userId, workspaceId, mission.id);
    await processMissionReport();
    const saved = await one(schema.missionReports, queued.reportId);
    assert.equal(saved.status, 'completed', saved.error);
    return { saved, snapshot: (await one(schema.missionSnapshots, saved.snapshotId)).input };
  };
  await finishCase(0); await finishCase(1);
  let current = await read();
  assert.equal(current.delivery.complete, false);
  assert.equal(current.delivery.cases.filter(c => c.complete).length, 2);
  assert.ok(current.delivery.gaps.some(g => g.caseKey === caseKeys[2] && g.code === 'run_missing')); checks++;
  const review = current.tasks[0].results.find(s => s.sourceType === 'test').assessment;
  assert.equal(review.reviewerVersion, REVIEWER_VERSION); assert.ok(review.id && review.sourceHash); assert.equal(review.findings.length, runs[0].checks.length); checks++;
  const partial = await report();
  assert.equal(partial.snapshot.delivery.complete, false); assert.equal(partial.saved.document.partial, true); assert.equal(partial.saved.document.findings[0].verdict, 'needs_evidence'); checks++;
  await finishCase(2, true);
  current = await read(); assert.equal(current.delivery.complete, true); checks++;
  const complete = await report();
  assert.notEqual(complete.saved.id, partial.saved.id); assert.equal(complete.snapshot.delivery.complete, true);
  assert.equal(complete.saved.document.partial, false); assert.equal(complete.saved.document.findings[0].verdict, 'supported');
  assert.ok(complete.saved.document.tests.some(t => t.originalOutcome === 'failed' && t.status === 'failed')); assert.equal((await one(schema.testRuns, runs[2].id)).result.outcome, 'failed'); checks++;
  assert.deepEqual((await one(schema.missionSnapshots, partial.saved.snapshotId)).input, partial.snapshot); checks++;
  const publicReport = sharedReportDocument({ ...complete.saved.document, futureInternal: { secret: 'private' }, criteria: [{ ...complete.saved.document.criteria[0], delivery: config.criteria[0].delivery }] }, []);
  assert.equal(publicReport.futureInternal, undefined); assert.deepEqual(publicReport.criteria, [{ id: 'navigation', text: 'Inspect navigation' }]); assert.ok(publicReport.evidence.every(e => e.itemId === null)); checks++;
  await reviewTestRun(userId, workspaceId, { runId: runs[0].id, requestId: randomUUID(), outcome: 'inconclusive', reason: 'Synthetic reviewer disputes this observation' });
  current = await read(); assert.equal(current.delivery.complete, false); assert.ok(current.delivery.gaps.some(g => g.code === 'manual_review_unresolved')); checks++;
  const disputed = await report(); assert.equal(disputed.saved.document.partial, true); assert.equal(disputed.saved.document.findings[0].verdict, 'needs_evidence'); checks++;
  await reviewTestRun(userId, workspaceId, { runId: runs[0].id, requestId: randomUUID(), outcome: 'passed', reason: 'Synthetic reservation resolved with saved observations' });
  assert.equal((await read()).delivery.complete, true); checks++;
  const changedCases = cases.map((c, i) => i === 0 ? { ...c, expected: 'A changed requirement' } : c);
  await saveItem(userId, workspaceId, { id: plan.id, expectedVersion: plan.version, title: plan.title, content: { kind: 'test_plan', sources: [], cases: changedCases } });
  current = await read(); assert.equal(current.delivery.complete, false); assert.ok(current.delivery.gaps.some(g => g.caseKey === caseKeys[0] && ['run_stale', 'run_missing'].includes(g.code))); checks++;
  const changed = await report(); assert.equal(changed.saved.document.partial, true); assert.notEqual(changed.saved.id, complete.saved.id); checks++;
  console.log(JSON.stringify({ status: 'passed', checks, database: 'actual isolated PostgreSQL', storage: 'actual isolated files', models: 'deterministic fixtures; no network', tested: ['terminal Iris is not delivery', 'full assessment projection', 'two-of-three partial report', 'verified defect completes QA', 'frozen snapshots', 'public allowlist', 'changed requirement invalidates coverage'] }));
} finally {
  for (const path of files) await del(path, { token: workspaceStorageToken() });
  try { await db.delete(schema.testCaptures).where(sql`${schema.testCaptures.runId} in (select id from pat_test_runs where workspace_id = ${workspaceId})`); await db.delete(schema.user).where(eq(schema.user.id, userId)); }
  finally { hooks.deregister(); delete globalThis.deliveryModels; await app.close(); }
}
