import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { registerHooks } from 'node:module';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createApp, createRouter, eventHandler, toNodeListener } from 'h3';
import { eq, sql } from 'drizzle-orm';
import { isolatedApp } from './helpers/isolated-app.mjs';

// Requires an explicitly isolated child environment. No app, browser, worker,
// provider or scheduler is started; only this process's loopback H3 listener.
assert.equal(process.env.GRUNDEN_API_TOKEN, '');
assert.match(process.env.PAT_RUNTIME_SCOPE ?? '', /^autonomy-test:/);
process.env.PAT_RUNTIME_SCOPE += `-test-intake-${randomUUID()}`;
process.env.MISSIONS_ENABLED = 'true'; process.env.AUTONOMOUS_MISSIONS_ENABLED = 'true';
process.env.RESULT_REVIEW_ENABLED = 'false';
const app = await isolatedApp(), { db, schema: S } = app;
let queueKicks = 0;
globalThis.testIntakeQueueFixture = () => { queueKicks++; return Promise.resolve(); };
const routeUrl = new URL('../server/api/internal/test-run.post.ts', import.meta.url).href;
const queueHook = registerHooks({ resolve(specifier, context, next) {
  if (context.parentURL === routeUrl && specifier === '../../utils/result-review-worker') return { url: 'data:text/javascript,export const processReviewQueue=()=>globalThis.testIntakeQueueFixture();', shortCircuit: true };
  return next(specifier, context);
} });
const control = await import('../server/utils/mission-control.ts');
const attempts = await import('../server/utils/mission-attempts.ts');
const { testRunAction } = await import('../server/utils/test-runs.ts');
const { saveItem } = await import('../server/utils/workspaces.ts');
const { missionAction, bindMissionSource } = await import('../server/utils/missions.ts');
const router = createRouter(); router.post('/api/internal/test-run', (await import('../server/api/internal/test-run.post.ts')).default);
const background = new Set(); let registeredBackgroundTasks = 0;
// Nitro supplies waitUntil in the actual app. Plain H3 needs this explicit test
// event adapter; every accepted promise is observed before fixture teardown.
const nitroEvent = eventHandler(event => {
  event.waitUntil = promise => { const task = Promise.resolve(promise); background.add(task); registeredBackgroundTasks++; void task.catch(() => {}); };
});
async function flushBackground() {
  while (background.size) {
    const batch = [...background], settled = await Promise.allSettled(batch);
    for (const task of batch) background.delete(task);
    const rejected = settled.filter(result => result.status === 'rejected');
    if (rejected.length) throw new AggregateError(rejected.map(result => result.reason), 'A test event.waitUntil task failed');
  }
}
const server = createServer(toNodeListener(createApp().use(nitroEvent).use(router))); server.listen(0, '127.0.0.1'); await once(server, 'listening');
const httpOrigin = `http://127.0.0.1:${server.address().port}`, originalFetch = globalThis.fetch;
globalThis.fetch = (url, options) => { assert.ok(String(url).startsWith(`${httpOrigin}/`), 'No external transport belongs in test intake regression'); return originalFetch(url, options); };
const owner = randomUUID(), stranger = randomUUID(), workspace = randomUUID(), thread = randomUUID(), otherThread = randomUUID();
const runtime = process.env.PAT_RUNTIME_SCOPE, contexts = [], passed = [];
const target = { kind: 'public_url', url: 'https://intake-fixture.example.test/' };
const result = { outcome: 'inconclusive', actual: 'Synthetic executor receipt; no browser was executed.', unverified: 'This contract fixture does not test a website.', observations: [], evidenceItemIds: [] };
let plan, testCase;
const row = async (table, id) => (await db.select().from(table).where(eq(table.id, id)))[0];
const reject = (promise, status = 409) => assert.rejects(promise, error => error.statusCode === status);
const startInput = () => ({ action: 'start', itemId: plan.id, caseId: testCase.id, expectedVersion: plan.version, requestId: randomUUID(), environment: 'Synthetic QA fixture', target: { environment: 'fixture', url: target.url, revision: 'synthetic-fixture' } });
async function api(input, status = 200, identity = {}) {
  const response = await fetch(`${httpOrigin}/api/internal/test-run`, { method: 'POST', headers: { authorization: `Bearer ${process.env.INTERNAL_API_SECRET}`, 'content-type': 'application/json' }, body: JSON.stringify({ userId: owner, threadId: thread, ...input, ...identity }) });
  const value = await response.json(); await flushBackground(); assert.equal(response.status, status, value.statusMessage ?? value.message); return value;
}
async function fixture() {
  const mission = await control.acceptMission(owner, workspace, thread, { requestId: randomUUID(), intent: 'verify', goal: 'Verify the selected saved browser case and report its observed result.', target, caseKeys: [`${plan.id}:${testCase.id}`] });
  const task = await db.transaction(async tx => { await control.lockMission(tx, mission.id); return control.addMissionTask(tx, mission, { operationId: randomUUID(), title: 'Synthetic selected case', spec: { kind: 'browser_tests', caseKeys: [`${plan.id}:${testCase.id}`], target: mission.config.target } }); });
  const claimed = await attempts.claimMission(mission.id); assert.ok(claimed); const lease = attempts.leaseIdentity(claimed);
  const reserved = await attempts.reserveMissionAttempt(lease, task.id, { resource: { kind: 'browser', poolKey: `synthetic-intake:${randomUUID()}` } }); assert.equal(reserved.status, 'reserved');
  const attempt = await attempts.markMissionDispatch(lease, reserved.attempt.id), sessionId = randomUUID();
  await db.insert(S.browserJobs).values({ id: attempt.dispatchId, threadId: thread, runtime, parentSessionId: randomUUID(), sessionId, task: 'Synthetic controller executor; never physically dispatched', status: 'running', model: 'fixture', reasoning: 'low' });
  const f = { mission, task, attempt, lease, worker: { browserJobId: attempt.dispatchId, executorSessionId: sessionId, callId: randomUUID() }, input: { ...startInput(), target: mission.config.target, mission: { missionId: mission.id, taskId: task.id } } }; contexts.push(f); return f;
}
async function state() {
  return { runs: await db.select().from(S.testRuns).where(eq(S.testRuns.workspaceId, workspace)), tasks: await db.select().from(S.missionTasks).innerJoin(S.missions, eq(S.missions.id, S.missionTasks.missionId)).where(eq(S.missions.workspaceId, workspace)),
    missions: await db.select().from(S.missions).where(eq(S.missions.workspaceId, workspace)), reviews: await db.select().from(S.resultAssessments).where(eq(S.resultAssessments.workspaceId, workspace)), reports: await db.select().from(S.missionReports).innerJoin(S.missions, eq(S.missions.id, S.missionReports.missionId)).where(eq(S.missions.workspaceId, workspace)) };
}
async function noMutation(fn) { const before = await state(); await fn(); assert.deepEqual(await state(), before); }
async function check(name, fn) { await fn(); passed.push(name); console.log(`PASS ${name}`); }
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function waitForLock(key, kind) {
  const end = Date.now() + 2000;
  while (Date.now() < end) {
    const hash = kind === 'content' ? sql`hashtextextended(${key},0)` : sql`hashtext(${key})::bigint`;
    const rows = await db.execute(sql`select pid from pg_locks where locktype='advisory' and not granted and objsubid=1
      and database=(select oid from pg_database where datname=current_database())
      and classid=((${hash} >> 32) & 4294967295)::oid and objid=(${hash} & 4294967295)::oid`);
    if (rows[0]) return rows[0].pid;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail(`The actual service did not wait on its ${kind} lock`);
}

try {
  await db.insert(S.user).values([{ id: owner, name: 'Intake contract fixture', email: `${owner}@example.test` }, { id: stranger, name: 'Other fixture owner', email: `${stranger}@example.test` }]);
  await db.insert(S.workspaces).values({ id: workspace, userId: owner, name: 'Synthetic internal intake contract' });
  await db.insert(S.threads).values([thread, otherThread].map(id => ({ id, userId: owner, workspaceId: workspace, title: 'Synthetic test intake' })));
  testCase = { id: randomUUID(), title: 'Synthetic saved plan case', type: 'browser', preconditions: '', steps: 'Observe the heading', expected: 'Heading is readable' };
  plan = await saveItem(owner, workspace, { title: 'Synthetic saved plan', content: { kind: 'test_plan', sources: [], cases: [testCase] } });

  await check('1. internal V/legacy starts and model-forged options fail without database effects', async () => {
    for (const extra of [{}, { requireAutonomousStart: false, execution: { attemptId: randomUUID(), dispatchId: randomUUID() } }, { mission: { missionId: randomUUID(), taskId: randomUUID() } }]) await noMutation(async () => { const denied = await api({ ...startInput(), ...extra }, 409); assert.match(denied.statusMessage, /qa_mission/); });
    const job = randomUUID(), session = randomUUID(); await db.insert(S.browserJobs).values({ id: job, threadId: thread, runtime, parentSessionId: randomUUID(), sessionId: session, task: 'Synthetic legacy worker', status: 'running', model: 'fixture', reasoning: 'low' });
    await noMutation(() => api({ ...startInput(), browserJobId: job, executorSessionId: session, callId: randomUUID() }, 409));
  });
  await check('2. exact current Iris admits once; wrong authority and stale mandates do not', async () => {
    const f = await fixture(); const [a, b] = await Promise.all([api({ ...f.input, ...f.worker }), api({ ...f.input, ...f.worker })]);
    assert.equal(a.id, b.id); assert.equal(a.missionAttemptId, f.attempt.id); assert.equal((await row(S.missionAttempts, f.attempt.id)).toolCalls, 1);
    assert.equal((await db.select().from(S.testRuns).where(eq(S.testRuns.requestId, f.input.requestId))).length, 1);
    await noMutation(() => api({ ...f.input, ...f.worker, executorSessionId: randomUUID() }, 409));
    await noMutation(() => api({ ...f.input, ...f.worker }, 404, { userId: stranger }));
    await noMutation(() => api({ ...f.input, ...f.worker }, 404, { threadId: otherThread }));
    await db.update(S.browserJobs).set({ runtime: `${runtime}-foreign` }).where(eq(S.browserJobs.id, f.attempt.dispatchId));
    await noMutation(() => api({ ...f.input, ...f.worker }, 404)); await db.update(S.browserJobs).set({ runtime }).where(eq(S.browserJobs.id, f.attempt.dispatchId));
    for (const patch of [{ mandateRevision: 0 }, { planRevision: 0 }, { cancelRequestedAt: new Date() }, { deadlineAt: new Date(0) }]) {
      const invalid = await fixture(); await db.update(S.missionAttempts).set(patch).where(eq(S.missionAttempts.id, invalid.attempt.id));
      await noMutation(() => api({ ...invalid.input, ...invalid.worker }, 409));
    }
  });
  await check('3. exact pre-flag receipt replays unchanged; changed identities and new bindings fail', async () => {
    process.env.AUTONOMOUS_MISSIONS_ENABLED = 'false'; const input = startInput(), run = await api(input); process.env.AUTONOMOUS_MISSIONS_ENABLED = 'true';
    const original = await row(S.testRuns, run.id); await noMutation(async () => assert.equal((await api(input)).id, run.id)); assert.deepEqual(await row(S.testRuns, run.id), original);
    for (const patch of [{ caseId: randomUUID() }, { expectedVersion: 2 }, { environment: 'changed' }, { target: { ...input.target, revision: 'changed' } }, { requestId: randomUUID() }, { mission: { missionId: randomUUID(), taskId: randomUUID() } }]) await noMutation(() => api({ ...input, ...patch }, 409));
    await noMutation(() => api(input, 409, { threadId: otherThread })); await noMutation(() => api(input, 404, { userId: stranger }));
    await db.update(S.testRuns).set({ runtime: `${runtime}-foreign` }).where(eq(S.testRuns.id, run.id)); await noMutation(() => api(input, 409));
    await db.update(S.testRuns).set({ runtime: null }).where(eq(S.testRuns.id, run.id)); await noMutation(async () => assert.equal((await api(input)).id, run.id));
    await db.update(S.testRuns).set({ runtime }).where(eq(S.testRuns.id, run.id));
    const manual = await missionAction(owner, workspace, thread, { action: 'create', requestId: randomUUID(), config: { title: 'Existing synthetic legacy mission', goal: 'Preserve an accepted fixture binding', scope: 'Synthetic fixture only', target: null, criteria: [{ id: 'saved', text: 'Preserve existing result' }], caseKeys: [] } });
    const task = await missionAction(owner, workspace, thread, { action: 'task', missionId: manual.id, requestId: randomUUID(), task: { title: 'Original legacy task', actor: 'browser', criterionIds: ['saved'] } });
    await bindMissionSource(owner, workspace, thread, { missionId: manual.id, taskId: task.id }, 'test', run.id);
    await noMutation(async () => assert.equal((await api({ ...input, mission: { missionId: manual.id, taskId: task.id } })).id, run.id));
  });
  await check('4. real content/request locks serialize replay; deleted receipt cannot become a new legacy run', async () => {
    const input = startInput(), run = await testRunAction(owner, workspace, thread, input), held = deferred(), release = deferred();
    const transaction = db.transaction(async tx => { await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`workspace-content:${workspace}`},0))`); held.resolve(); await release.promise; await tx.delete(S.testRuns).where(eq(S.testRuns.id, run.id)); });
    await held.promise; const pending = api(input, 409); void pending.catch(() => {});
    try { await waitForLock(`workspace-content:${workspace}`, 'content'); } finally { release.resolve(); await transaction; await pending; }
    assert.equal(await row(S.testRuns, run.id), undefined); assert.equal((await db.select().from(S.testRuns).where(eq(S.testRuns.requestId, input.requestId))).length, 0);
    const replayInput = startInput(), replay = await testRunAction(owner, workspace, thread, replayInput), heldRequest = deferred(), releaseRequest = deferred();
    const txRequest = db.transaction(async tx => { await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`test-run:${workspace}:${replayInput.requestId}`}))`); heldRequest.resolve(); await releaseRequest.promise; });
    await heldRequest.promise; const replayPending = api(replayInput); void replayPending.catch(() => {});
    try {
      const pid = await waitForLock(`test-run:${workspace}:${replayInput.requestId}`, 'request');
      const [heldContent] = await db.execute(sql`select count(*)::int as count from pg_locks where pid=${pid} and locktype='advisory' and granted and objsubid=1
        and classid=((hashtextextended(${`workspace-content:${workspace}`},0) >> 32) & 4294967295)::oid and objid=(hashtextextended(${`workspace-content:${workspace}`},0) & 4294967295)::oid`);
      assert.equal(heldContent.count, 1);
    } finally { releaseRequest.resolve(); await txRequest; assert.equal((await replayPending).id, replay.id); }
  });
  await check('5. legacy FINISH and late exact Iris receipts preserve immutable results', async () => {
    const run = await testRunAction(owner, workspace, thread, startInput()); const saved = await api({ action: 'finish', runId: run.id, result }); assert.deepEqual(saved.result, result);
    await noMutation(async () => assert.equal((await api({ action: 'finish', runId: run.id, result })).id, run.id));
    await noMutation(() => api({ action: 'finish', runId: run.id, result: { ...result, actual: 'Changed final receipt' } }, 409));
    const f = await fixture(), current = await api({ ...f.input, ...f.worker });
    await control.controlMission(owner, workspace, thread, { action: 'cancel', missionId: f.mission.id, requestId: randomUUID(), expectedMandateRevision: f.mission.mandateRevision });
    const late = await api({ action: 'finish', runId: current.id, result, ...f.worker }); assert.equal(late.executionCurrent, false);
    assert.equal((await db.select().from(S.resultAssessments).where(eq(S.resultAssessments.runId, current.id))).length, 0);
    await noMutation(() => api({ action: 'finish', runId: current.id, result }, 409));
  });
  await check('6. LIST/ASSESS keep ownership and Iris attempt scopes without model execution', async () => {
    const a = await fixture(), b = await fixture(), run = await api({ ...a.input, ...a.worker }); await api({ ...b.input, ...b.worker });
    const listed = await api({ action: 'list', itemId: plan.id, ...a.worker, callId: randomUUID() }); assert.deepEqual(listed.map(r => r.id), [run.id]);
    await noMutation(() => api({ action: 'list', itemId: plan.id }, 404, { userId: stranger }));
    const legacy = await testRunAction(owner, workspace, thread, startInput()); await api({ action: 'finish', runId: legacy.id, result });
    await api({ action: 'assess', runId: legacy.id }); const assessments = await db.select().from(S.resultAssessments).where(eq(S.resultAssessments.runId, legacy.id)); assert.equal(assessments.length, 1); assert.equal(assessments[0].status, 'queued');
    await noMutation(() => api({ action: 'assess', runId: run.id, ...a.worker }, 409)); assert.ok(queueKicks > 0); assert.ok(registeredBackgroundTasks > 0); assert.equal(background.size, 0);
  });
  await check('7. trusted service and flagoff retain legacy starts; kill switch cannot bypass enabled autonomy', async () => {
    const direct = await testRunAction(owner, workspace, thread, startInput()); assert.equal(direct.missionAttemptId, null);
    process.env.AUTONOMOUS_MISSIONS_ENABLED = 'false'; const legacy = await api(startInput()); assert.equal(legacy.missionAttemptId, null);
    process.env.AUTONOMOUS_MISSIONS_ENABLED = 'true'; process.env.MISSIONS_ENABLED = 'false';
    try { await noMutation(() => api(startInput(), 409)); } finally { process.env.MISSIONS_ENABLED = 'true'; }
  });
  await check('8. originals stay unadopted and only synthetic owned fixture rows are removed', async () => {
    const ordinary = await testRunAction(owner, workspace, thread, startInput()), f = await fixture();
    await reject(testRunAction(owner, workspace, thread, { ...f.input, requestId: ordinary.requestId }, { execution: { attemptId: f.attempt.id, dispatchId: f.attempt.dispatchId } }));
    assert.equal((await row(S.testRuns, ordinary.id)).missionAttemptId, null);
    assert.equal(contexts.every(c => c.attempt.runtime === runtime), true);
  });
  console.log(JSON.stringify({ status: 'passed', groups: passed.length, checks: passed, database: 'actual isolated PostgreSQL', transport: 'actual owned loopback H3', substitutes: ['declared saved plan', 'synthetic controller dispatch/job receipts', 'queue kick only; no review worker'], modelCalls: 0, physicalBrowserCalls: 0, fixtureRuntime: runtime }));
} finally {
  process.env.PAT_RUNTIME_SCOPE = runtime;
  server.close(); server.closeAllConnections(); await once(server, 'close');
  try { await flushBackground(); } finally {
    globalThis.fetch = originalFetch; queueHook.deregister(); delete globalThis.testIntakeQueueFixture;
    try { await db.delete(S.user).where(eq(S.user.id, owner)); await db.delete(S.user).where(eq(S.user.id, stranger)); } finally { await app.close(); }
  }
}
