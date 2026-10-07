import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { controllerFixture } from './helpers/mission-controller-fixture.mjs';

// Actual local PostgreSQL, controller, queues and file bytes. Only provider
// generation is synthetic. No model credentials or external requests are used.
let modelCalls = 0, reviewBarrier;
globalThis.queueAdmissionReview = async (input, _attachments, _signal, onUsage) => {
  modelCalls++; onUsage?.(125);
  if (reviewBarrier) await reviewBarrier();
  return { verdict: 'needs_evidence', summary: 'Synthetic review', findings: input.requirements.map(r => ({ requirementId: r.id, verdict: 'needs_evidence', explanation: 'Synthetic fixture', evidenceIds: [], suggestedNextStep: 'Read more evidence', gap: { kind: 'missing_observation', capability: 'review', wantedEvidence: 'Read saved evidence of the original checkpoint.' } })) };
};
const h = await controllerFixture(), { db, schema } = h;
globalThis.missionControllerFixtureExecutors.assessResult = globalThis.queueAdmissionReview;
const { saveFile } = await import('../server/utils/workspaces.ts');
const { processReviewQueue } = await import('../server/utils/result-review-worker.ts');
const { processMissionReport, notifyMissionReports, refreshMissionReports } = await import('../server/utils/mission-reports.ts');
const { queueExecution, beginQueueModel, settleQueueModel } = await import('../server/utils/mission-review-admission.ts');
const { del, workspaceStorageToken } = await import('../server/utils/evidence-storage.ts');
const paths = [], runs = [], checks = [];
async function check(name, fn) { try { await fn(); checks.push(name); } catch (error) { console.error('FAILED', name, error); throw error; } }
async function reviewFixture() {
  const f = await h.fixture(); await h.browserReady(f);
  const [run] = await h.finishBrowser(f);
  runs.push(run.id);
  const item = await saveFile(h.owner, f.workspace, 'actual-fixture.txt', 'text/plain', Buffer.from('A synthetic saved browser observation.'), f.thread, db,
    { provenance: { version: 1, origin: 'tool', producer: 'test-capture', sourceType: 'test', sourceId: run.id, observedAt: new Date().toISOString(), url: f.target.url } });
  paths.push((await h.row(schema.workspaceItems, item.id)).blobPath);
  await db.insert(schema.testCaptures).values({ id: randomUUID(), runId: run.id, itemId: item.id, title: 'Fixture observation', url: f.target.url, action: 'click' });
  await db.update(schema.testRuns).set({ finishedAt: new Date(Date.now() + 1), result: { outcome: 'passed', actual: 'Synthetic execution', unverified: '', observations: [], evidenceItemIds: [item.id], checks: run.checks.map(c => ({ id: c.id, status: 'verified', actual: 'Synthetic observation' })) } }).where(eq(schema.testRuns.id, run.id));
  const s = await h.until(f, s => s.attempts.some(a => a.kind === 'review'));
  const [job] = await db.select().from(schema.resultAssessments).where(eq(schema.resultAssessments.runId, run.id));
  return { f, run, job, attempt: s.attempts.find(a => a.kind === 'review') };
}
async function reportFixture() {
  const f = await h.fixture(); await h.browserReady(f); await h.finishBrowser(f);
  await h.until(f, s => s.attempts.some(a => a.kind === 'review')); await processReviewQueue();
  const s = await h.until(f, s => s.reports.some(r => r.status === 'queued'));
  return { f, job: s.reports.find(r => r.status === 'queued'), attempt: s.attempts.find(a => a.kind === 'report') };
}
async function stopOthers() {
  await db.update(schema.resultAssessments).set({ status: 'failed' }).where(and(eq(schema.resultAssessments.runtime, process.env.PAT_RUNTIME_SCOPE), inArray(schema.resultAssessments.status, ['queued', 'running'])));
  for (const f of await db.select().from(schema.missions).where(eq(schema.missions.runtime, process.env.PAT_RUNTIME_SCOPE))) {
    await db.update(schema.missionReports).set({ status: 'failed' }).where(and(eq(schema.missionReports.missionId, f.id), eq(schema.missionReports.status, 'queued')));
  }
}
async function holdContent(workspaceId) {
  let enter, release;
  const entered = new Promise(resolve => { enter = resolve; }), gate = new Promise(resolve => { release = resolve; });
  const held = db.transaction(async tx => { await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`workspace-content:${workspaceId}`}, 0))`); enter(); await gate; });
  await entered; return async () => { release(); await held; };
}
async function untilDatabase(predicate, label) {
  const deadline = Date.now() + 10000;
  while (!await predicate()) { assert.ok(Date.now() < deadline, label); await delay(10); }
}
async function waitOnContent(workspaceId) {
  const key = `workspace-content:${workspaceId}`;
  await untilDatabase(async () => (await h.sql`select 1 from pg_locks where locktype='advisory' and not granted and classid::bigint=((hashtextextended(${key},0) >> 32) & 4294967295) and objid::bigint=(hashtextextended(${key},0) & 4294967295)`).length > 0, 'Worker waits on actual workspace-content lock');
}
try {
  assert.equal(process.env.GRUNDEN_API_TOKEN, '');
  await check('legacy report refresh leaves autonomous mission state and events untouched', async () => {
    const f = await h.fixture(), past = new Date(Date.now() - 120000);
    const legacy = await h.missions.missionAction(h.owner, f.workspace, f.thread, { action: 'create', requestId: randomUUID(), config: {
      title: 'Legacy fixture', goal: 'Read saved results', scope: 'Saved sources only', target: null, caseKeys: [], automaticReports: false,
      criteria: [{ id: 'source', text: 'Saved observations', delivery: { kind: 'source', sourceTypes: ['research'] } }],
    } });
    await db.update(schema.missions).set({ dirtySince: past, updatedAt: past, reconciledAt: past }).where(inArray(schema.missions.id, [f.id, legacy.id]));
    const before = await h.row(schema.missions, f.id), events = await h.rows(schema.missionEvents, f.id);
    assert.equal(await refreshMissionReports(f.workspace), true);
    assert.deepEqual(await h.row(schema.missions, f.id), before);
    assert.deepEqual(await h.rows(schema.missionEvents, f.id), events);
    assert.ok((await h.row(schema.missions, legacy.id)).reconciledAt > past, 'Legacy reconciliation still advances');
    assert.equal(await refreshMissionReports(f.workspace), false, 'Only the untouched autonomous mission is still due');
  });
  await check('paused autonomous review never claims or invokes the model', async () => {
    const { f, job } = await reviewFixture(), before = modelCalls;
    await h.operate(f, 'pause'); await processReviewQueue();
    assert.equal(modelCalls, before); assert.equal((await h.row(schema.resultAssessments, job.id)).status, 'queued');
    await stopOthers();
  });
  await check('flag-off blocks review and report models while preserving queued work', async () => {
    const report = await reportFixture(), review = await reviewFixture(), before = modelCalls, reports = h.calls.filter(c => c.kind === 'report:model').length;
    process.env.AUTONOMOUS_MISSIONS_ENABLED = 'false';
    try {
      await processReviewQueue(); await processMissionReport();
      assert.equal(modelCalls, before); assert.equal(h.calls.filter(c => c.kind === 'report:model').length, reports);
      assert.equal((await h.row(schema.resultAssessments, review.job.id)).status, 'queued'); assert.equal((await h.row(schema.missionReports, report.job.id)).status, 'queued');
    } finally { process.env.AUTONOMOUS_MISSIONS_ENABLED = 'true'; await stopOthers(); }
  });
  await check('current review records known tokens; markers do not spend execution tool calls', async () => {
    const { job, attempt } = await reviewFixture(), before = modelCalls;
    await processReviewQueue();
    assert.equal(modelCalls, before + 1); assert.equal((await h.row(schema.resultAssessments, job.id)).status, 'completed');
    const row = await h.row(schema.missionAttempts, attempt.id); assert.equal(row.usage.tokens, 125); assert.equal(row.toolCalls, 0);
  });
  await check('gapless new model output never persists as a current assessment and retries remain bounded', async () => {
    await stopOthers();
    const { run, job, attempt } = await reviewFixture(), before = modelCalls;
    const original = globalThis.missionControllerFixtureExecutors.assessResult;
    const originalRun = await h.row(schema.testRuns, run.id);
    globalThis.missionControllerFixtureExecutors.assessResult = async (...args) => {
      const result = await original(...args);
      return { ...result, findings: result.findings.map(finding => { const legacy = { ...finding }; delete legacy.gap; return legacy; }) };
    };
    try {
      for (let invocation = 1; invocation <= 2; invocation++) {
        await processReviewQueue();
        const saved = await h.row(schema.resultAssessments, job.id);
        assert.equal(saved.status, 'queued'); assert.equal(saved.assessment, null);
        assert.equal(saved.reviewerVersion, job.reviewerVersion); assert.equal(saved.attempts, invocation);
        assert.equal((await h.row(schema.missionAttempts, attempt.id)).usage.tokens, invocation * 125);
        await db.update(schema.resultAssessments).set({ nextAttemptAt: new Date(0) }).where(eq(schema.resultAssessments.id, job.id));
      }
      await processReviewQueue();
      const saved = await h.row(schema.resultAssessments, job.id);
      assert.equal(saved.status, 'failed'); assert.equal(saved.assessment, null);
      assert.equal(modelCalls, before + 2); assert.equal((await h.row(schema.missionAttempts, attempt.id)).usage.tokens, 250);
      assert.deepEqual((await h.row(schema.testRuns, run.id)).result, originalRun.result);
    } finally { globalThis.missionControllerFixtureExecutors.assessResult = original; await stopOthers(); }
  });
  await check('model result received after pause accounts usage but cannot publish assessment', async () => {
    const { f, job, attempt } = await reviewFixture();
    reviewBarrier = () => h.operate(f, 'pause');
    try { await processReviewQueue(); } finally { reviewBarrier = undefined; }
    const row = await h.row(schema.resultAssessments, job.id);
    assert.equal(row.status, 'queued'); assert.equal(row.assessment, null); assert.equal((await h.row(schema.missionAttempts, attempt.id)).usage.tokens, 125);
  });
  await check('closed and expired report jobs are rejected before provider invocation', async () => {
    for (const expired of [false, true]) {
      const { f, job, attempt } = await reportFixture(), count = h.calls.filter(c => c.kind === 'report:model').length;
      if (expired) await db.update(schema.missionAttempts).set({ deadlineAt: new Date(0) }).where(eq(schema.missionAttempts.id, attempt.id));
      else await db.update(schema.missions).set({ lifecycle: 'closed', status: 'closed' }).where(eq(schema.missions.id, f.id));
      await processMissionReport(); assert.equal(h.calls.filter(c => c.kind === 'report:model').length, count); assert.equal((await h.row(schema.missionReports, job.id)).status, 'failed');
    }
  });
  await check('report persists under current bound attempt and does not notify a parent chat', async () => {
    const { job, attempt } = await reportFixture(); await processMissionReport();
    assert.equal((await h.row(schema.missionReports, job.id)).status, 'completed'); assert.equal((await h.row(schema.missionAttempts, attempt.id)).usage.tokens, 40);
    await notifyMissionReports(); assert.equal((await h.row(schema.missionReports, job.id)).notification, 'recorded');
  });
  await check('already queued cancellation report remains within its delivery allowance', async () => {
    const { f, job } = await reportFixture(); await h.operate(f, 'cancel');
    assert.equal((await db.transaction(tx => queueExecution(tx, 'report', job.id))).status, 'allowed');
    await processMissionReport(); assert.equal((await h.row(schema.missionReports, job.id)).status, 'completed');
  });
  await check('late report model response after pause is accounted without publishing an artifact', async () => {
    const { f, job, attempt } = await reportFixture(), original = globalThis.missionControllerFixtureExecutors.writeMissionReport;
    globalThis.missionControllerFixtureExecutors.writeMissionReport = async (...args) => { await h.operate(f, 'pause'); return original(...args); };
    try { await processMissionReport(); } finally { globalThis.missionControllerFixtureExecutors.writeMissionReport = original; }
    const row = await h.row(schema.missionReports, job.id); assert.equal(row.status, 'queued'); assert.equal(row.itemId, null);
    assert.equal((await h.row(schema.missionAttempts, attempt.id)).usage.tokens, 40);
  });
  await check('report retry reserves a fresh bounded read allowance and retains prior measured usage', async () => {
    const { job, attempt } = await reportFixture(), original = globalThis.missionControllerFixtureExecutors.writeMissionReport, lease = randomUUID();
    await db.update(schema.missionReports).set({ status: 'running', attempts: 1, leaseToken: lease, leaseUntil: new Date(Date.now() + 60000) }).where(eq(schema.missionReports.id, job.id));
    const first = await beginQueueModel('report', job.id, 1, lease); await settleQueueModel(first.call, { tokens: 20, toolCalls: 58, durationMs: 1 });
    await db.update(schema.missionReports).set({ status: 'queued', leaseToken: null, leaseUntil: null }).where(eq(schema.missionReports.id, job.id));
    globalThis.missionControllerFixtureExecutors.writeMissionReport = async (...args) => {
      assert.equal(args[3].maxToolCalls, 60);
      const result = await original(...args); return { ...result, usage: { ...result.usage, toolCalls: 2 } };
    };
    try { await processMissionReport(); } finally { globalThis.missionControllerFixtureExecutors.writeMissionReport = original; }
    assert.equal((await h.row(schema.missionReports, job.id)).status, 'completed');
    assert.equal((await h.row(schema.missionAttempts, attempt.id)).usage.toolCalls, 60);
  });
  await check('restart after actual report model admission charges uncertainty and fences one saved artifact', async () => {
    const { f, job, attempt } = await reportFixture(), original = globalThis.missionControllerFixtureExecutors.writeMissionReport;
    let entered, release, invocations = 0;
    const started = new Promise(resolve => { entered = resolve; }), barrier = new Promise(resolve => { release = resolve; });
    globalThis.missionControllerFixtureExecutors.writeMissionReport = async (...args) => {
      await args[3].beforeModel(); invocations++;
      if (invocations === 1) { entered(); await barrier; }
      return original(...args);
    };
    const oldWorker = processMissionReport();
    try {
      await started;
      await db.update(schema.missionReports).set({ leaseUntil: new Date(0) }).where(eq(schema.missionReports.id, job.id));
      await processMissionReport();
      const winner = await h.row(schema.missionReports, job.id); assert.equal(winner.status, 'completed'); assert.ok(winner.itemId);
      release(); await oldWorker;
      const final = await h.row(schema.missionReports, job.id); assert.equal(final.itemId, winner.itemId); assert.equal(invocations, 2);
      assert.equal((await h.rows(schema.missionReports, f.id)).length, 1);
      const artifacts = await db.select().from(schema.workspaceItems).where(eq(schema.workspaceItems.workspaceId, f.workspace));
      assert.equal(artifacts.filter(item => item.title.endsWith('Klaras rapport')).length, 1);
      const measured = await h.row(schema.missionAttempts, attempt.id); assert.equal(measured.usage.tokens, null); assert.equal(measured.reservedTokens, 200000);
      assert.ok(measured.toolCallIds.some(id => id.startsWith('server:queue-model:charged-unknown:')));
    } finally { release(); await oldWorker; globalThis.missionControllerFixtureExecutors.writeMissionReport = original; }
  });
  await check('unknown report retries stop at three physical reservations within total delivery budget', async () => {
    const { job, attempt } = await reportFixture();
    for (const invocation of [1, 2, 3, 4]) {
      const lease = randomUUID();
      await db.update(schema.missionReports).set({ status: 'running', attempts: invocation, leaseToken: lease, leaseUntil: new Date(Date.now() + 60000) }).where(eq(schema.missionReports.id, job.id));
      const next = await beginQueueModel('report', job.id, invocation, lease);
      assert.equal(next.execution.status, invocation <= 3 ? 'allowed' : 'obsolete');
      if (next.call) await settleQueueModel(next.call, null);
    }
    const measured = await h.row(schema.missionAttempts, attempt.id);
    assert.equal(measured.reservedTokens, 300000); assert.equal(measured.reservedToolCalls, 180);
    assert.equal(measured.usage.tokens, null); assert.equal(measured.usage.toolCalls, null);
    await db.update(schema.missionReports).set({ status: 'failed', leaseToken: null, leaseUntil: null }).where(eq(schema.missionReports.id, job.id));
  });
  await check('report reader cannot start a writer or later model step after pause', async () => {
    const { f, job, attempt } = await reportFixture(), original = globalThis.missionControllerFixtureExecutors.writeMissionReport;
    let steps = 0;
    globalThis.missionControllerFixtureExecutors.writeMissionReport = async (...args) => {
      await args[3].beforeModel(); steps++;
      await h.operate(f, 'pause');
      await args[3].beforeModel(); steps++;
      return original(...args);
    };
    try { await processMissionReport(); } finally { globalThis.missionControllerFixtureExecutors.writeMissionReport = original; }
    assert.equal(steps, 1); assert.equal((await h.row(schema.missionReports, job.id)).status, 'queued');
    assert.equal((await h.row(schema.missionAttempts, attempt.id)).usage.tokens, null);
  });
  await check('claimed-before-model worker loss can recover without spending a model attempt', async () => {
    const { job } = await reviewFixture(), before = modelCalls;
    await db.update(schema.resultAssessments).set({ status: 'running', attempts: 8, leaseToken: randomUUID(), leaseUntil: new Date(0) }).where(eq(schema.resultAssessments.id, job.id));
    await processReviewQueue(); assert.equal(modelCalls, before + 1); assert.equal((await h.row(schema.resultAssessments, job.id)).status, 'completed');
  });
  await check('unknown sent model remains charged and is never blindly sent again', async () => {
    const { job, attempt } = await reviewFixture(), lease = randomUUID(), before = modelCalls;
    await db.update(schema.resultAssessments).set({ status: 'running', attempts: 1, leaseToken: lease, leaseUntil: new Date(Date.now() + 60000) }).where(eq(schema.resultAssessments.id, job.id));
    const admission = await beginQueueModel('review', job.id, 1, lease); assert.equal(admission.execution.status, 'allowed');
    await db.update(schema.resultAssessments).set({ leaseUntil: new Date(0) }).where(eq(schema.resultAssessments.id, job.id));
    await processReviewQueue(); assert.equal(modelCalls, before); assert.equal((await h.row(schema.resultAssessments, job.id)).status, 'failed');
    assert.equal((await h.row(schema.missionAttempts, attempt.id)).usage.tokens, null);
  });
  await check('known physical retries are bounded per queue job inside the logical attempt', async () => {
    const { job, attempt } = await reviewFixture(), lease = randomUUID();
    await db.update(schema.resultAssessments).set({ status: 'running', leaseToken: lease, leaseUntil: new Date(Date.now() + 60000) }).where(eq(schema.resultAssessments.id, job.id));
    for (const invocation of [1, 2]) { const next = await beginQueueModel('review', job.id, invocation, lease); assert.equal(next.execution.status, 'allowed'); await settleQueueModel(next.call, { tokens: 50, durationMs: 10 }); }
    const stopped = await beginQueueModel('review', job.id, 3, lease);
    assert.equal(stopped.execution.status, 'obsolete');
    assert.equal(stopped.execution.reason, 'Tillåtna modellförsök är förbrukade.');
    assert.equal((await h.row(schema.missionAttempts, attempt.id)).usage.tokens, 100);
  });
  await check('review admission rejects stale epoch, wrong principal and missing exact task binding', async () => {
    await stopOthers();
    const { job, attempt } = await reviewFixture(), task = await h.row(schema.missionTasks, attempt.taskId);
    const admission = () => db.transaction(tx => queueExecution(tx, 'review', job.id));
    assert.equal((await admission()).status, 'allowed');
    await db.update(schema.missionAttempts).set({ mandateRevision: attempt.mandateRevision + 1 }).where(eq(schema.missionAttempts.id, attempt.id));
    assert.equal((await admission()).status, 'obsolete');
    await db.update(schema.missionAttempts).set({ mandateRevision: attempt.mandateRevision }).where(eq(schema.missionAttempts.id, attempt.id));
    await db.update(schema.resultAssessments).set({ userId: randomUUID() }).where(eq(schema.resultAssessments.id, job.id));
    assert.equal((await admission()).status, 'obsolete');
    await db.update(schema.resultAssessments).set({ userId: job.userId }).where(eq(schema.resultAssessments.id, job.id));
    await db.update(schema.missionTasks).set({ sources: [] }).where(eq(schema.missionTasks.id, task.id));
    assert.equal((await admission()).status, 'obsolete');
    await stopOthers();
  });
  await check('a lost queue lease cannot admit a model even while its mission attempt is current', async () => {
    const { job, attempt } = await reviewFixture(), lease = randomUUID();
    await db.update(schema.resultAssessments).set({ status: 'running', leaseToken: lease, leaseUntil: new Date(0) }).where(eq(schema.resultAssessments.id, job.id));
    assert.equal((await beginQueueModel('review', job.id, 1, lease)).execution.status, 'obsolete');
    assert.equal((await h.row(schema.missionAttempts, attempt.id)).toolCallIds.length, 0);
    await db.update(schema.resultAssessments).set({ status: 'failed' }).where(eq(schema.resultAssessments.id, job.id));
  });
  await check('review execution deadline expiring during content-lock wait prevents final assessment', async () => {
    await stopOthers();
    const { f, job, attempt } = await reviewFixture(), deadline = new Date(Date.now() + 1500);
    await db.update(schema.missionAttempts).set({ deadlineAt: deadline }).where(eq(schema.missionAttempts.id, attempt.id));
    const release = await holdContent(f.workspace), worker = processReviewQueue();
    try {
      await waitOnContent(f.workspace);
      await untilDatabase(async () => (await h.sql`select clock_timestamp() >= ${deadline.toISOString()}::timestamptz as expired`)[0].expired, 'Execution deadline passes while queue lease is still live');
    } finally { await release(); await worker; }
    const saved = await h.row(schema.resultAssessments, job.id); assert.equal(saved.status, 'failed'); assert.equal(saved.assessment, null);
  });
  await check('report execution deadline expiring during content-lock wait leaves no report artifact', async () => {
    const { f, job, attempt } = await reportFixture(), deadline = new Date(Date.now() + 1500);
    await db.update(schema.missionAttempts).set({ deadlineAt: deadline }).where(eq(schema.missionAttempts.id, attempt.id));
    const release = await holdContent(f.workspace), worker = processMissionReport();
    try {
      await waitOnContent(f.workspace);
      await untilDatabase(async () => (await h.sql`select clock_timestamp() >= ${deadline.toISOString()}::timestamptz as expired`)[0].expired, 'Report deadline passes while queue lease is still live');
    } finally { await release(); await worker; }
    const saved = await h.row(schema.missionReports, job.id); assert.equal(saved.status, 'failed'); assert.equal(saved.itemId, null);
    const artifacts = await db.select().from(schema.workspaceItems).where(eq(schema.workspaceItems.workspaceId, f.workspace));
    assert.equal(artifacts.filter(item => item.title.endsWith('Klaras rapport')).length, 0);
  });
  await check('a full batch of paused reviews does not starve another mission', async () => {
    await stopOthers();
    const paused = await reviewFixture(); await h.operate(paused.f, 'pause');
    await db.update(schema.resultAssessments).set({ createdAt: new Date(0) }).where(eq(schema.resultAssessments.id, paused.job.id));
    await db.insert(schema.resultAssessments).values(Array.from({ length: 49 }, (_, i) => ({ ...paused.job, id: randomUUID(), sourceHash: `paused-${i}`, createdAt: new Date(0) })));
    const ready = await reviewFixture(), before = modelCalls;
    await processReviewQueue(); assert.equal(modelCalls, before);
    await processReviewQueue(); assert.equal(modelCalls, before + 1); assert.equal((await h.row(schema.resultAssessments, ready.job.id)).status, 'completed');
    await stopOthers();
  });
  await check('eight known model jobs share a bounded logical review reservation', async () => {
    const { job, attempt } = await reviewFixture();
    for (let i = 0; i < 8; i++) {
      const id = i === 0 ? job.id : randomUUID(), lease = randomUUID();
      if (i > 0) await db.insert(schema.resultAssessments).values({ ...job, id, sourceHash: `synthetic-source-${i}` });
      await db.update(schema.resultAssessments).set({ status: 'running', leaseToken: lease, leaseUntil: new Date(Date.now() + 60000) }).where(eq(schema.resultAssessments.id, id));
      const next = await beginQueueModel('review', id, 1, lease); assert.equal(next.execution.status, 'allowed');
      await settleQueueModel(next.call, { tokens: 1000, durationMs: 1 });
      await db.update(schema.resultAssessments).set({ status: 'completed' }).where(eq(schema.resultAssessments.id, id));
    }
    assert.equal((await h.row(schema.missionAttempts, attempt.id)).usage.tokens, 8000);
  });
  console.log(JSON.stringify({ passed: checks.length, checks, models: 'synthetic only', database: 'actual isolated PostgreSQL' }));
} finally {
  for (const runId of runs) await db.delete(schema.testCaptures).where(eq(schema.testCaptures.runId, runId));
  await Promise.all(paths.map(path => del(path, { token: workspaceStorageToken() }))); await h.close(); delete globalThis.queueAdmissionReview;
}
