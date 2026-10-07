import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { controllerFixture } from './helpers/mission-controller-fixture.mjs';

// Actual isolated PostgreSQL, saved research bytes and authored controller /
// writer queue. Browser, acquisition and model output are explicit synthetics.
const h = await controllerFixture(), { db, schema } = h;
const { proposeInterimReport, interimReportContext } = await import('../server/utils/mission-interim-report.ts');
const { processMissionReport } = await import('../server/utils/mission-reports.ts');
const { queueExecution, beginQueueModel, settleQueueModel } = await import('../server/utils/mission-review-admission.ts');
const checks = [], initialWriter = h.scripts.writeMissionReport;
const modelCount = () => h.calls.filter(call => call.kind === 'report:model').length;
async function check(name, run) {
  try { await run(); checks.push(name); }
  catch (error) { console.error('FAILED', name, error); throw error; }
  finally {
    h.scripts.writeMissionReport = initialWriter;
    for (const mission of await db.select().from(schema.missions).where(eq(schema.missions.runtime, process.env.PAT_RUNTIME_SCOPE))) {
      await db.update(schema.missionReports).set({ status: 'failed', leaseToken: null, leaseUntil: null }).where(and(eq(schema.missionReports.missionId, mission.id), inArray(schema.missionReports.status, ['queued', 'running'])));
    }
  }
}
async function waitingFixture(options = {}) {
  const f = await h.fixture(); await h.pass(f); // Real saved synthetic research.
  const state = await h.state(f), discovery = state.tasks.find(task => task.spec.kind === 'discovery');
  const wait = await db.transaction(async tx => {
    await h.control.lockMission(tx, f.id);
    let mission = await h.row(schema.missions, f.id);
    if (options.maxReportAttempts) {
      [mission] = await tx.update(schema.missions).set({ mandate: { ...mission.mandate, limits: { ...mission.mandate.limits, maxReportAttempts: options.maxReportAttempts } } }).where(eq(schema.missions.id, f.id)).returning();
    }
    const task = await h.control.addMissionTask(tx, mission, { operationId: `plan:${mission.planRevision}`, title: 'Planera ett avgränsat QA-urval',
      spec: { kind: 'planning', sourceRefs: discovery.sources.filter(ref => ref.type === 'research') }, dependsOn: [discovery.id], criterionIds: discovery.criterionIds });
    return h.control.createMissionWait(tx, mission, { reason: 'clarification', taskIds: [task.id], question: 'Vilken del ska prioriteras efter det redan sparade underlaget?' });
  });
  return { f, wait, original: await h.row(schema.missions, f.id) };
}
async function queuedFixture(options) {
  const data = await waitingFixture(options);
  const state = await h.until(data.f, state => state.reports.some(report => report.status === 'queued'));
  const task = state.tasks.find(task => task.spec.purpose === 'interim'), attempt = state.attempts.find(attempt => attempt.taskId === task.id);
  return { ...data, task, attempt, report: state.reports.find(report => report.id === attempt.executorResourceId) };
}
async function answer(data, decline = false) {
  return h.control.controlMission(h.owner, data.f.workspace, data.f.thread, { action: 'answer', missionId: data.f.id,
    expectedMandateRevision: (await h.row(schema.missions, data.f.id)).mandateRevision, requestId: randomUUID(), waitId: data.wait.id,
    answer: decline ? { kind: 'decline', reason: 'Finish with saved material.' } : { kind: 'text', text: 'Continue the original bounded navigation check.' } });
}
async function claim(f) {
  await db.update(schema.missions).set({ nextWakeAt: new Date(0) }).where(eq(schema.missions.id, f.id));
  const claimed = await h.attempts.claimMission(f.id); assert.ok(claimed); return h.attempts.leaseIdentity(claimed);
}
async function holdContent(workspace) {
  let ready, release; const entered = new Promise(resolve => { ready = resolve; }), gate = new Promise(resolve => { release = resolve; });
  const holder = db.transaction(async tx => { await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`workspace-content:${workspace}`},0))`); ready(); await gate; });
  await entered; return async () => { release(); await holder; };
}
async function contentWait(workspace) {
  const key = `workspace-content:${workspace}`, deadline = Date.now() + 10000;
  while (!(await h.sql`select 1 from pg_locks where locktype='advisory' and not granted and classid::bigint=((hashtextextended(${key},0) >> 32) & 4294967295) and objid::bigint=(hashtextextended(${key},0) & 4294967295)`).length) {
    assert.ok(Date.now() < deadline, 'Expected real content lock wait'); await delay(10);
  }
}
try {
  await check('waiting branch produces one partial report; answer continues to distinct final delivery', async () => {
    const data = await queuedFixture(), { f, wait, original } = data;
    await processMissionReport(); await h.pass(f);
    let state = await h.state(f), interim = await h.row(schema.missionReports, data.report.id);
    assert.equal(interim.status, 'completed'); assert.equal(interim.document.partial, true); assert.match(interim.document.title, /^Delrapport · /);
    assert.ok(interim.document.limitations.some(value => value.includes('Väntar på svar')));
    assert.notEqual(state.mission.lifecycle, 'closed'); assert.notEqual(state.mission.phase, 'report');
    assert.equal(state.mission.reportDeadlineAt, null); assert.equal(+state.mission.deadlineAt, +original.deadlineAt);
    assert.equal((await h.row(schema.missionWaits, wait.id)).state, 'waiting');
    for (let i = 0; i < 3; i++) await h.pass(f);
    assert.equal((await h.state(f)).tasks.filter(task => task.spec.purpose === 'interim').length, 1);
    await answer(data); await h.browserReady(f); await h.finishBrowser(f); state = await h.settle(f);
    assert.equal(state.mission.lifecycle, 'closed'); assert.equal(state.reports.length, 2);
    const final = state.reports.find(report => report.id !== interim.id);
    assert.equal(final.status, 'completed'); assert.notEqual(final.snapshotId, interim.snapshotId); assert.doesNotMatch(final.document.title, /^Delrapport/);
    assert.equal((await h.row(schema.missionReports, interim.id)).document.summary, interim.document.summary);
  });
  await check('single final allowance does not create an interim task or spend report budget', async () => {
    const { f } = await waitingFixture({ maxReportAttempts: 1 }); await h.pass(f); await h.pass(f);
    const state = await h.state(f); assert.equal(state.tasks.filter(task => task.spec.kind === 'report').length, 0); assert.equal(state.attempts.filter(attempt => attempt.kind === 'report').length, 0);
  });
  await check('no finished independent source means no interim; concurrent proposals create only one', async () => {
    const data = await waitingFixture(), state = await h.state(data.f), source = state.tasks.find(task => task.spec.kind === 'discovery');
    await db.update(schema.missionTasks).set({ sources: [], results: [] }).where(eq(schema.missionTasks.id, source.id));
    const lease = await claim(data.f);
    try {
      assert.equal(await proposeInterimReport(lease), null);
      await db.update(schema.missionTasks).set({ sources: source.sources }).where(eq(schema.missionTasks.id, source.id));
      const values = await Promise.all([proposeInterimReport(lease), proposeInterimReport(lease)]);
      assert.equal(values.filter(Boolean).length, 1);
      assert.equal((await h.state(data.f)).tasks.filter(task => task.spec.purpose === 'interim').length, 1);
    } finally { await h.attempts.releaseMissionLease(lease, 0); }
  });
  await check('interim failure has no automatic retry and cannot close or suppress final report', async () => {
    const data = await queuedFixture({ maxReportAttempts: 2 }); let invocations = 0;
    h.scripts.writeMissionReport = async () => { invocations++; throw new Error('Synthetic unknown provider result'); };
    await processMissionReport(); await processMissionReport(); await h.pass(data.f); await h.pass(data.f);
    assert.equal(invocations, 1); assert.equal((await h.row(schema.missionReports, data.report.id)).status, 'failed'); assert.notEqual((await h.state(data.f)).mission.lifecycle, 'closed');
    h.scripts.writeMissionReport = initialWriter;
    await answer(data, true); const state = await h.settle(data.f);
    assert.equal(state.reports.length, 2); assert.equal(state.reports.filter(report => report.status === 'completed').length, 1);
    const failed = await h.row(schema.missionAttempts, data.attempt.id); assert.equal(failed.usage.tokens, null);
    assert.ok(state.attempts.some(attempt => attempt.kind === 'report' && attempt.id !== failed.id && attempt.status === 'completed'));
  });
  await check('answer before queue claim suppresses optional model and preserves work admission', async () => {
    const data = await queuedFixture(), before = modelCount(); await answer(data); await processMissionReport();
    assert.equal(modelCount(), before); assert.equal((await h.row(schema.missionReports, data.report.id)).status, 'failed');
    await h.pass(data.f); assert.notEqual((await h.state(data.f)).mission.lifecycle, 'closed');
    assert.ok((await h.state(data.f)).attempts.some(attempt => attempt.kind === 'planning'));
  });
  await check('in-flight answer retains measured usage but cannot save stale progress artifact', async () => {
    const data = await queuedFixture();
    h.scripts.writeMissionReport = async (...args) => { await answer(data); return initialWriter(...args); };
    await processMissionReport();
    const report = await h.row(schema.missionReports, data.report.id); assert.equal(report.status, 'failed'); assert.equal(report.itemId, null);
    assert.equal((await h.row(schema.missionAttempts, data.attempt.id)).usage.tokens, 40);
    await h.pass(data.f); assert.notEqual((await h.state(data.f)).mission.lifecycle, 'closed');
  });
  await check('deadline elapsed while final persistence waits for content lock rejects publication', async () => {
    const data = await queuedFixture(), release = await holdContent(data.f.workspace), work = processMissionReport();
    try {
      await contentWait(data.f.workspace);
      await db.update(schema.missionWaits).set({ deadlineAt: new Date(0) }).where(eq(schema.missionWaits.id, data.wait.id));
    } finally { await release(); await work; }
    const report = await h.row(schema.missionReports, data.report.id); assert.equal(report.status, 'failed'); assert.equal(report.itemId, null);
    assert.equal((await h.row(schema.missionAttempts, data.attempt.id)).usage.tokens, 40);
  });
  await check('flag-off prevents model start; pause cancels only the obsolete interim queue', async () => {
    const data = await queuedFixture(), before = modelCount(); process.env.AUTONOMOUS_MISSIONS_ENABLED = 'false';
    try { await processMissionReport(); assert.equal(modelCount(), before); assert.equal((await h.row(schema.missionReports, data.report.id)).status, 'queued'); }
    finally { process.env.AUTONOMOUS_MISSIONS_ENABLED = 'true'; }
    await h.operate(data.f, 'pause'); await h.pass(data.f);
    assert.equal((await h.state(data.f)).mission.lifecycle, 'paused'); assert.equal((await h.row(schema.missionReports, data.report.id)).status, 'failed');
    assert.equal((await h.row(schema.missionAttempts, data.attempt.id)).status, 'cancelled');
    await processMissionReport(); assert.equal(modelCount(), before);
  });
  await check('current cancellation cannot use final-report exception for an interim model', async () => {
    const data = await queuedFixture(); await h.operate(data.f, 'cancel');
    assert.equal((await db.transaction(tx => queueExecution(tx, 'report', data.report.id))).status, 'obsolete');
    const before = modelCount(); await processMissionReport(); assert.equal(modelCount(), before);
    await h.pass(data.f); assert.equal((await h.row(schema.missionAttempts, data.attempt.id)).status, 'cancelled');
  });
  await check('interim retry after lost queue lease is rejected even with available final allowance', async () => {
    const data = await queuedFixture({ maxReportAttempts: 2 }), token = randomUUID();
    await db.update(schema.missionReports).set({ status: 'running', attempts: 1, leaseToken: token, leaseUntil: new Date(Date.now() + 60000) }).where(eq(schema.missionReports.id, data.report.id));
    const first = await beginQueueModel('report', data.report.id, 1, token); assert.ok(first.call);
    await settleQueueModel(first.call, null);
    await db.update(schema.missionReports).set({ leaseToken: randomUUID(), attempts: 2 }).where(eq(schema.missionReports.id, data.report.id));
    const report = await h.row(schema.missionReports, data.report.id);
    const retry = await beginQueueModel('report', data.report.id, 2, report.leaseToken); assert.equal(retry.call, null); assert.equal(retry.execution.status, 'obsolete');
  });
  await check('plan revision, owner and runtime mismatches cannot adopt an old interim request', async () => {
    const data = await queuedFixture();
    const mission = await h.row(schema.missions, data.f.id);
    await assert.rejects(db.transaction(tx => interimReportContext(tx, { ...mission, planRevision: mission.planRevision + 1 }, data.task)), error => error.statusCode === 409);
    await assert.rejects(db.transaction(tx => interimReportContext(tx, { ...mission, runtime: 'wrong-runtime' }, data.task)), error => error.statusCode === 409);
    const lease = await claim(data.f);
    const other = randomUUID(); await db.insert(schema.user).values({ id: other, name: 'Other owner', email: `${other}@example.test` });
    try {
      await db.update(schema.workspaces).set({ userId: other }).where(eq(schema.workspaces.id, data.f.workspace));
      assert.equal((await db.transaction(tx => queueExecution(tx, 'report', data.report.id))).status, 'obsolete');
      await assert.rejects(proposeInterimReport(lease), error => error.statusCode === 404);
    } finally {
      await db.update(schema.workspaces).set({ userId: h.owner }).where(eq(schema.workspaces.id, data.f.workspace));
      await db.delete(schema.user).where(eq(schema.user.id, other));
    }
    await assert.rejects(proposeInterimReport({ ...lease, mandateRevision: lease.mandateRevision + 1 }), error => error.statusCode === 409);
    await h.attempts.releaseMissionLease(lease, 0);
  });
  console.log(JSON.stringify({ checks: checks.length, passed: checks, scope: 'Actual isolated PostgreSQL/controller/queue; synthetic provider and browser; no live acceptance.' }, null, 2));
} finally { await h.close(); }
