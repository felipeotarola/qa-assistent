import { reportFixtureObservations } from './helpers/report-check-fixture.mjs';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { registerHooks } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import { and, eq, sql } from 'drizzle-orm';
import { isolatedApp } from './helpers/isolated-app.mjs';

// Real PostgreSQL, authored queue/persistence code and actual isolated file bytes.
// Only model generation is replaced with deterministic fixtures and barriers.
// Run through helpers/run-isolated.mjs; never load the application's .env.
process.env.PAT_RUNTIME_SCOPE = `${process.env.PAT_RUNTIME_SCOPE}-queues-${randomUUID()}`;
const app = await isolatedApp();
const { db, schema } = app;
const modelHooks = registerHooks({ resolve(specifier, _context, next) {
  if (/(?:^|\/)result-reviewer(?:\.ts)?$/.test(specifier)) return { url: 'data:text/javascript,export const assessResult = (...args) => globalThis.provenanceQueueModels.review(...args);', shortCircuit: true };
  if (/(?:^|\/)mission-reporter(?:\.ts)?$/.test(specifier)) return { url: 'data:text/javascript,export const writeMissionReport = (...args) => globalThis.provenanceQueueModels.report(...args);', shortCircuit: true };
  return next(specifier, _context);
} });
const { saveItem, saveFile } = await import('../server/utils/workspaces.ts');
const { testRunAction } = await import('../server/utils/test-runs.ts');
const { requestReview, hashReview, listAssessments } = await import('../server/utils/result-assessments.ts');
const { processReviewQueue } = await import('../server/utils/result-review-worker.ts');
const { missionAction, requestMissionReport } = await import('../server/utils/missions.ts');
const { processMissionReport } = await import('../server/utils/mission-reports.ts');
const { del, workspaceStorageToken } = await import('../server/utils/evidence-storage.ts');
const { REVIEWER_VERSION, REVIEW_POLICY_ERROR } = await import('../shared/result-assessment.ts');
const { MISSION_REPORT_VERSION, REPORT_POLICY_ERROR } = await import('../shared/mission-report.ts');

const userId = randomUUID(), workspaceId = randomUUID(), threadId = randomUUID();
const runtime = process.env.PAT_RUNTIME_SCOPE;
const target = { environment: 'isolated synthetic fixture', url: 'https://example.test', revision: 'fixture-commit' };
const files = [], pending = [], releases = new Set();
let checks = 0, reviewCalls = 0, reportCalls = 0, reviewBarrier, reportBarrier;
let reportDiagnosticMode = null;
const diagnosticUsage = { providerCalls: 1, unknownCalls: 0, inputTokens: 31, outputTokens: 7, totalTokens: 38, cacheReadTokens: 0, cacheWriteTokens: null, durationMs: 1 };
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
function barrier() {
  const entered = deferred(), released = deferred(); releases.add(released.resolve);
  return { entered: entered.promise, async wait() { entered.resolve(); await released.promise; }, release() { released.resolve(); releases.delete(released.resolve); } };
}
async function bounded(promise, label) {
  const controller = new AbortController();
  try { return await Promise.race([promise, delay(10000, undefined, { signal: controller.signal }).then(() => { throw new Error(`Timed out: ${label}`); })]); }
  finally { controller.abort(); }
}
async function waitFor(predicate, label) {
  await bounded((async () => { while (!await predicate()) await delay(10); })(), label);
}
globalThis.provenanceQueueModels = {
  async review(input) {
    reviewCalls++;
    if (reviewBarrier) await reviewBarrier.wait();
    const evidence = input.evidence.find(e => e.readStatus === 'read');
    assert.ok(evidence, 'Synthetic model receives actual read bytes');
    return { verdict: 'supported', summary: 'Synthetic model fixture only', findings: input.requirements.map(r => ({ requirementId: r.id, verdict: 'supported', explanation: 'Synthetic fixture matches', evidenceIds: [evidence.id], suggestedNextStep: '', gap: null })) };
  },
  async report(snapshot, read, _signal, options) {
    reportCalls++;
    const evidence = snapshot.tasks.flatMap(t => t.sources.flatMap(s => s.evidence));
    const reads = new Map();
    for (const ref of evidence) { const value = await read(ref.id); reads.set(ref.id, value); assert.ok(value.text, 'Report reads saved actual text'); }
    if (reportBarrier) await reportBarrier.wait();
    if (reportDiagnosticMode) options.onUsage(diagnosticUsage, evidence.length);
    if (reportDiagnosticMode === 'unknown-error') throw new Error('private-fixture-marker-not-for-logs');
    return { draft: { summary: 'Synthetic model report only', findings: snapshot.config.criteria.map(c => ({ criterionId: c.id, verdict: 'supported', conclusion: 'Synthetic fixture matches', evidenceIds: [evidence[0].id], observations: reportFixtureObservations(snapshot, c.id, [evidence[0].id], 'The actually read fixture bytes match the saved synthetic observation.', reads), nextStep: '' })), limitations: [] }, usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, steps: 1 } };
  },
};
const one = async (table, id) => (await db.select().from(table).where(eq(table.id, id)))[0];
const runReview = async runId => (await db.select().from(schema.resultAssessments).where(and(eq(schema.resultAssessments.runId, runId), eq(schema.resultAssessments.reviewerVersion, REVIEWER_VERSION))))[0];
async function finishedRun(withEvidence = false) {
  const testCase = { id: randomUUID(), title: 'Synthetic navigation', type: 'browser', preconditions: '', steps: 'Click navigation', expected: 'Target visible' };
  const plan = await saveItem(userId, workspaceId, { title: 'Synthetic plan', content: { kind: 'test_plan', sources: [], cases: [testCase] } });
  const run = await testRunAction(userId, workspaceId, threadId, { action: 'start', itemId: plan.id, caseId: testCase.id, expectedVersion: plan.version, requestId: randomUUID(), target, environment: target.environment });
  let evidence;
  if (withEvidence) {
    const observedAt = new Date().toISOString();
    evidence = await saveFile(userId, workspaceId, 'synthetic-capture.txt', 'text/plain', Buffer.from('Synthetic fixture: navigation clicked and target visible'), threadId, db, { provenance: { version: 1, origin: 'tool', producer: 'test-capture', sourceType: 'test', sourceId: run.id, observedAt, url: target.url } });
    files.push((await one(schema.workspaceItems, evidence.id)).blobPath);
    await db.insert(schema.testCaptures).values({ id: randomUUID(), runId: run.id, itemId: evidence.id, title: 'Synthetic capture', url: target.url, action: 'click' });
  }
  const result = { outcome: 'passed', actual: 'Synthetic executor claim', unverified: '', observations: [], evidenceItemIds: evidence ? [evidence.id] : [], checks: run.checks.map(c => ({ id: c.id, status: 'verified', actual: 'Synthetic observation' })) };
  await testRunAction(userId, workspaceId, threadId, { action: 'finish', runId: run.id, result });
  return { run, evidence, result, review: await runReview(run.id) };
}
async function reportFixture(withEvidence = false) {
  const mission = await missionAction(userId, workspaceId, threadId, { action: 'create', requestId: randomUUID(), config: { title: 'Synthetic report', goal: 'Check saved fixture', scope: 'Saved fixture only', criteria: [{ id: 'source', text: 'Saved source supports the fixture', delivery: { kind: 'source', sourceTypes: ['research'] } }], target: null, caseKeys: [], automaticReports: false } });
  let evidence;
  if (withEvidence) {
    evidence = await saveItem(userId, workspaceId, { title: 'Synthetic research', content: { kind: 'text', text: 'Synthetic observed source' }, threadId }, db, { provenance: { version: 1, origin: 'tool', producer: 'research-page', sourceType: 'research', observedAt: new Date().toISOString(), url: target.url } });
    const task = await missionAction(userId, workspaceId, threadId, { action: 'task', missionId: mission.id, requestId: randomUUID(), task: { title: 'Read fixture', actor: 'main', criterionIds: ['source'], dependsOn: [] } });
    await missionAction(userId, workspaceId, threadId, { action: 'attach', missionId: mission.id, taskId: task.id, sourceType: 'research', sourceId: evidence.id });
  }
  const queued = await requestMissionReport(userId, workspaceId, mission.id);
  return { mission, evidence, report: await one(schema.missionReports, queued.reportId) };
}
async function holdWorkspace(mutate) {
  const entered = deferred(), release = deferred(); releases.add(release.resolve);
  const transaction = db.transaction(async tx => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`workspace-content:${workspaceId}`}, 0))`);
    if (mutate) await mutate(tx);
    entered.resolve();
    await release.promise;
  });
  pending.push(transaction);
  await bounded(entered.promise, 'fixture acquires content lock');
  return { async release() { release.resolve(); releases.delete(release.resolve); await transaction; } };
}
async function waitForContentWaiter() {
  const key = `workspace-content:${workspaceId}`;
  await waitFor(async () => {
    const rows = await app.sql`select 1 from pg_locks where locktype = 'advisory' and not granted and classid::bigint = ((hashtextextended(${key},0) >> 32) & 4294967295) and objid::bigint = (hashtextextended(${key},0) & 4294967295)`;
    return rows.length > 0;
  }, 'queue waits on actual PostgreSQL content lock');
}
async function expireWhileWaiting(table, id) {
  // Deadline occurs after the worker's transaction begins. now() would retain
  // that earlier transaction time; clock_timestamp() must reject late writes.
  const until = new Date(Date.now() + 120);
  await db.update(table).set({ leaseUntil: until }).where(eq(table.id, id));
  await waitFor(async () => (await app.sql`select clock_timestamp() >= ${until.toISOString()}::timestamptz as expired`)[0].expired, 'lease expires by database wall clock');
}
async function stopQueued(table, id) { await db.update(table).set({ status: 'failed', leaseToken: null, leaseUntil: null }).where(eq(table.id, id)); }

try {
  assert.equal(process.env.GRUNDEN_API_TOKEN, '', 'No live model credential');
  // The app pool uses UTC. Verify the final lease predicate independently of
  // session timezone as well; this reproduces the naive timestamp comparison bug.
  await db.transaction(async tx => {
    await tx.execute(sql`set local time zone 'Europe/Berlin'`);
    const future = new Date(Date.now() + 240000).toISOString(), past = new Date(Date.now() - 240000).toISOString();
    const [probe] = await tx.execute(sql`select (${future}::timestamp at time zone 'UTC') > clock_timestamp() as live, (${past}::timestamp at time zone 'UTC') > clock_timestamp() as expired, ${future}::timestamp > clock_timestamp() as implicit_comparison`);
    assert.equal(probe.live, true); assert.equal(probe.expired, false); assert.equal(probe.implicit_comparison, false);
  }); checks++;
  await db.insert(schema.user).values({ id: userId, name: 'Queue fixture', email: `${userId}@example.test` });
  await db.insert(schema.workspaces).values({ id: workspaceId, userId, name: 'Queue fixture' });
  await db.insert(schema.threads).values({ id: threadId, userId, workspaceId, title: 'Queue fixture' });

  const empty = await finishedRun();
  assert.equal(empty.review.input.schemaVersion, 2);
  await processReviewQueue();
  const emptyReview = await one(schema.resultAssessments, empty.review.id);
  assert.equal(emptyReview.status, 'completed'); assert.equal(emptyReview.assessment.verdict, 'needs_evidence'); assert.equal(emptyReview.model, 'deterministic-rules'); assert.equal(reviewCalls, 0);
  assert.deepEqual((await one(schema.testRuns, empty.run.id)).result, empty.result); checks++;

  const old = await finishedRun();
  const oldInput = { ...old.review.input, schemaVersion: 1 };
  await db.update(schema.resultAssessments).set({ reviewerVersion: '1', input: oldInput, sourceHash: hashReview(oldInput), inputHash: hashReview(oldInput) }).where(eq(schema.resultAssessments.id, old.review.id));
  await processReviewQueue();
  assert.equal((await one(schema.resultAssessments, old.review.id)).error, REVIEW_POLICY_ERROR);
  const fresh = await runReview(old.run.id); assert.notEqual(fresh.id, old.review.id); assert.equal(fresh.input.schemaVersion, 2); assert.equal(fresh.status, 'completed'); assert.equal(fresh.assessment.verdict, 'needs_evidence'); checks++;

  const historicalInput = { ...emptyReview.input, schemaVersion: 1 };
  await db.update(schema.resultAssessments).set({ reviewerVersion: '1', input: historicalInput, sourceHash: hashReview(historicalInput), inputHash: hashReview(historicalInput) }).where(eq(schema.resultAssessments.id, emptyReview.id));
  const historicalReview = await one(schema.resultAssessments, emptyReview.id);
  await requestReview(userId, workspaceId, empty.run.id); await processReviewQueue();
  assert.deepEqual(await one(schema.resultAssessments, emptyReview.id), historicalReview);
  assert.equal((await listAssessments(userId, workspaceId, empty.run.id)).find(r => r.id === emptyReview.id).stale, true); checks++;

  const positive = await finishedRun(true); await processReviewQueue();
  assert.equal((await one(schema.resultAssessments, positive.review.id)).assessment.verdict, 'supported'); assert.equal(reviewCalls, 1); checks++;

  const changing = await finishedRun(true); reviewBarrier = barrier();
  const reviewing = processReviewQueue(); pending.push(reviewing); await bounded(reviewBarrier.entered, 'mock reviewer reads evidence');
  const editing = await holdWorkspace(tx => tx.update(schema.workspaceItems).set({ provenance: { version: 1, origin: 'agent', producer: 'agent-authored', observedAt: null } }).where(eq(schema.workspaceItems.id, changing.evidence.id)));
  reviewBarrier.release(); await waitForContentWaiter(); await editing.release(); await bounded(reviewing, 'review freshness rejection'); reviewBarrier = null;
  const changedReview = await one(schema.resultAssessments, changing.review.id);
  assert.equal(changedReview.status, 'queued'); assert.equal(changedReview.assessment, null); assert.deepEqual((await one(schema.testRuns, changing.run.id)).result, changing.result); await stopQueued(schema.resultAssessments, changing.review.id); checks++;

  const late = await finishedRun(true); reviewBarrier = barrier();
  const lateReview = processReviewQueue(); pending.push(lateReview); await bounded(reviewBarrier.entered, 'late reviewer barrier');
  const reviewLock = await holdWorkspace(); reviewBarrier.release(); await waitForContentWaiter();
  await expireWhileWaiting(schema.resultAssessments, late.review.id); await reviewLock.release(); await bounded(lateReview, 'expired review exit'); reviewBarrier = null;
  const expiredReview = await one(schema.resultAssessments, late.review.id); assert.equal(expiredReview.status, 'running'); assert.equal(expiredReview.assessment, null); await stopQueued(schema.resultAssessments, late.review.id); checks++;

  const emptyReport = await reportFixture(); await processMissionReport();
  const savedEmpty = await one(schema.missionReports, emptyReport.report.id);
  assert.equal(savedEmpty.status, 'completed'); assert.equal(savedEmpty.model, 'deterministic-rules'); assert.ok(savedEmpty.document.findings.every(f => f.verdict === 'needs_evidence')); assert.equal(reportCalls, 0);
  assert.equal((await one(schema.workspaceItems, savedEmpty.itemId)).provenance.producer, 'agent-authored'); checks++;

  const positiveReport = await reportFixture(true); await processMissionReport();
  const supportedReport = await one(schema.missionReports, positiveReport.report.id);
  assert.equal(supportedReport.status, 'completed'); assert.equal(supportedReport.document.findings[0].verdict, 'supported'); assert.equal(supportedReport.document.findings[0].observations.length, 1); assert.match(supportedReport.document.findings[0].observations[0].originLabel, /oberoende verktygsunderlag/); assert.equal(supportedReport.readReceipts.length, 1); assert.equal(reportCalls, 1); checks++;

  // Real SQL/files, synthetic writer: failure must keep read/usage diagnostics
  // without saving a report or exposing untrusted exception text.
  const diagnosticsReport = await reportFixture(true);
  const diagnosticsSnapshot = await one(schema.missionSnapshots, diagnosticsReport.report.snapshotId);
  diagnosticsSnapshot.input.delivery.complete = false;
  diagnosticsSnapshot.input.delivery.criteria[0].complete = false;
  await db.update(schema.missionSnapshots).set({ input: diagnosticsSnapshot.input }).where(eq(schema.missionSnapshots.id, diagnosticsSnapshot.id));
  const warnings = [], warn = console.warn;
  console.warn = (...args) => { warnings.push(args); };
  try {
    reportDiagnosticMode = 'invalid-delivery'; await processMissionReport();
    const rejected = await one(schema.missionReports, diagnosticsReport.report.id);
    assert.equal(rejected.status, 'queued'); assert.equal(rejected.document, null); assert.equal(rejected.itemId, null);
    assert.equal(rejected.readReceipts.length, 1); assert.equal(rejected.readReceipts[0].limited, false);
    assert.equal(rejected.usage.totalTokens, 38); assert.equal(rejected.usage.inputTokens, 31); assert.equal(rejected.usage.outputTokens, 7);
    assert.ok(warnings.some(entry => entry[1]?.reason === 'Supported finding requires complete criterion delivery'));
    await stopQueued(schema.missionReports, rejected.id); checks++;

    const unknown = await reportFixture(true); reportDiagnosticMode = 'unknown-error';
    await processMissionReport(); const unknownRow = await one(schema.missionReports, unknown.report.id);
    assert.equal(unknownRow.document, null); assert.equal(unknownRow.readReceipts.length, 1); assert.equal(unknownRow.usage.totalTokens, 38);
    assert.ok(warnings.some(entry => entry[1]?.reason === 'generation_or_storage_error'));
    assert.ok(!JSON.stringify({ warnings, error: unknownRow.error }).includes('private-fixture-marker'));
    await stopQueued(schema.missionReports, unknownRow.id); checks++;

    const obsolete = await reportFixture(true); reportBarrier = barrier();
    const obsoleteWork = processMissionReport(); pending.push(obsoleteWork); await bounded(reportBarrier.entered, 'diagnostic lease fence');
    await db.update(schema.missionReports).set({ leaseUntil: new Date(Date.now() - 1000) }).where(eq(schema.missionReports.id, obsolete.report.id));
    const beforeFailure = await one(schema.missionReports, obsolete.report.id);
    reportBarrier.release(); await bounded(obsoleteWork, 'obsolete diagnostic writer'); reportBarrier = null;
    assert.deepEqual(await one(schema.missionReports, obsolete.report.id), beforeFailure, 'Expired writer cannot overwrite receipts, usage or state');
    await stopQueued(schema.missionReports, obsolete.report.id); checks++;
  } finally { console.warn = warn; reportDiagnosticMode = null; }

  const oldReport = await reportFixture();
  const oldSnapshot = await one(schema.missionSnapshots, oldReport.report.snapshotId);
  await db.update(schema.missionSnapshots).set({ input: { ...oldSnapshot.input, schemaVersion: 1 } }).where(eq(schema.missionSnapshots.id, oldSnapshot.id));
  await db.update(schema.missionReports).set({ version: '1' }).where(eq(schema.missionReports.id, oldReport.report.id));
  await processMissionReport();
  assert.equal((await one(schema.missionReports, oldReport.report.id)).error, REPORT_POLICY_ERROR);
  const [currentReport] = await db.select().from(schema.missionReports).where(and(eq(schema.missionReports.missionId, oldReport.mission.id), eq(schema.missionReports.version, MISSION_REPORT_VERSION)));
  assert.ok(currentReport); assert.equal((await one(schema.missionSnapshots, currentReport.snapshotId)).input.schemaVersion, 2);
  await processMissionReport(); assert.equal((await one(schema.missionReports, currentReport.id)).status, 'completed'); checks++;

  const historicalSnapshot = await one(schema.missionSnapshots, savedEmpty.snapshotId);
  await db.update(schema.missionSnapshots).set({ input: { ...historicalSnapshot.input, schemaVersion: 1 } }).where(eq(schema.missionSnapshots.id, historicalSnapshot.id));
  await db.update(schema.missionReports).set({ version: '1' }).where(eq(schema.missionReports.id, savedEmpty.id));
  const historicalReport = await one(schema.missionReports, savedEmpty.id), historicalItem = await one(schema.workspaceItems, savedEmpty.itemId);
  const next = await requestMissionReport(userId, workspaceId, emptyReport.mission.id); assert.notEqual(next.reportId, savedEmpty.id);
  await processMissionReport(); assert.deepEqual(await one(schema.missionReports, savedEmpty.id), historicalReport); assert.deepEqual(await one(schema.workspaceItems, savedEmpty.itemId), historicalItem); checks++;

  const changingReport = await reportFixture(true); reportBarrier = barrier();
  const reporting = processMissionReport(); pending.push(reporting); await bounded(reportBarrier.entered, 'mock reporter reads source');
  const sourceEdit = await holdWorkspace(tx => saveItem(userId, workspaceId, { id: changingReport.evidence.id, expectedVersion: changingReport.evidence.version, title: 'Changed source', content: { kind: 'text', text: 'Agent-written replacement' } }, tx, { provenance: { version: 1, origin: 'agent', producer: 'agent-authored', observedAt: null } }));
  reportBarrier.release(); await waitForContentWaiter(); await sourceEdit.release(); await bounded(reporting, 'report freshness rejection'); reportBarrier = null;
  const staleReport = await one(schema.missionReports, changingReport.report.id); assert.equal(staleReport.status, 'queued'); assert.equal(staleReport.itemId, null); assert.equal(staleReport.document, null); await stopQueued(schema.missionReports, staleReport.id); checks++;

  const lateReport = await reportFixture(true); reportBarrier = barrier();
  const reportingLate = processMissionReport(); pending.push(reportingLate); await bounded(reportBarrier.entered, 'late reporter barrier');
  const itemsBefore = await db.select({ id: schema.workspaceItems.id }).from(schema.workspaceItems).where(eq(schema.workspaceItems.workspaceId, workspaceId));
  const reportLock = await holdWorkspace(); reportBarrier.release(); await waitForContentWaiter();
  await expireWhileWaiting(schema.missionReports, lateReport.report.id); await reportLock.release(); await bounded(reportingLate, 'expired report exit'); reportBarrier = null;
  const expiredReport = await one(schema.missionReports, lateReport.report.id); assert.equal(expiredReport.status, 'running'); assert.equal(expiredReport.document, null); assert.equal(expiredReport.itemId, null);
  const itemsAfter = await db.select({ id: schema.workspaceItems.id }).from(schema.workspaceItems).where(eq(schema.workspaceItems.workspaceId, workspaceId)); assert.equal(itemsAfter.length, itemsBefore.length, 'Expired report leaves no orphan material'); await stopQueued(schema.missionReports, expiredReport.id); checks++;

  console.log(JSON.stringify({ status: 'passed', checks, database: 'actual isolated PostgreSQL', storage: 'actual isolated filesystem', model: 'deterministic mock only, no network calls', runtime, tested: ['deterministic needs_evidence', 'current queue positive', 'pending old-policy regeneration', 'historical completed rows unchanged', 'actual lock wait + freshness rejection', 'wall-clock lease expiry prevents late commits and orphan reports'] }));
} finally {
  for (const release of releases) release();
  await Promise.allSettled(pending);
  for (const file of files) await del(file, { token: workspaceStorageToken() });
  try {
    await db.delete(schema.testCaptures).where(sql`${schema.testCaptures.runId} in (select id from pat_test_runs where workspace_id = ${workspaceId})`);
    await db.delete(schema.user).where(eq(schema.user.id, userId));
  } finally { modelHooks.deregister(); await app.close(); delete globalThis.provenanceQueueModels; }
}
