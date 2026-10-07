import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createApp, createRouter, toNodeListener } from 'h3';
import { eq } from 'drizzle-orm';
import { isolatedApp } from './helpers/isolated-app.mjs';

// Actual isolated PostgreSQL and authored services. Test plans, scheduler leases
// and dispatch receipts are local fixtures; no browser, model or runner executes.
process.env.PAT_RUNTIME_SCOPE = `${process.env.PAT_RUNTIME_SCOPE}-observations-${randomUUID()}`;
process.env.MISSIONS_ENABLED = 'true'; process.env.AUTONOMOUS_MISSIONS_ENABLED = 'true';
const app = await isolatedApp(), { db, schema } = app;
const control = await import('../server/utils/mission-control.ts');
const attempts = await import('../server/utils/mission-attempts.ts');
const { testRunAction } = await import('../server/utils/test-runs.ts');
const { saveItem } = await import('../server/utils/workspaces.ts');
const { missionAction, bindMissionSource, publicMission, listMissions } = await import('../server/utils/missions.ts');
const owner = randomUUID(), workspace = randomUUID(), thread = randomUUID();
const target = { kind: 'public_url', url: 'https://observations.example.test/' };
const runtime = process.env.PAT_RUNTIME_SCOPE, originalFetch = globalThis.fetch;
const router = createRouter();
router.post('/api/internal/test-run', (await import('../server/api/internal/test-run.post.ts')).default);
const server = createServer(toNodeListener(createApp().use(router)));
server.listen(0, '127.0.0.1'); await once(server, 'listening');
const origin = `http://127.0.0.1:${server.address().port}`;
globalThis.fetch = (url, options) => { assert.ok(String(url).startsWith(`${origin}/`), 'No external network belongs in observation scope service tests'); return originalFetch(url, options); };
const passed = [], failures = [];
const reject = (promise, code = 409) => assert.rejects(promise, error => error.statusCode === code);
const row = async (table, id) => (await db.select().from(table).where(eq(table.id, id)))[0];
const rows = (table, missionId) => db.select().from(table).where(eq(table.missionId, missionId));
async function check(name, fn) { try { await fn(); passed.push(name); } catch (error) { failures.push({ name, message: error.message, stack: error.stack }); console.error(`FAILED ${name}: ${error.message}`); } }
let plan, cases, caseKeys;
async function fixture({ dispatch = true } = {}) {
  const mission = await control.acceptMission(owner, workspace, thread, { requestId: randomUUID(), intent: 'explore', goal: 'Kontrollera startsidan och spara underlag', target, caseKeys: [caseKeys[0]] });
  const task = await db.transaction(async tx => {
    await control.lockMission(tx, mission.id);
    return control.addMissionTask(tx, mission, { operationId: randomUUID(), title: 'Kontrollera startsidan', spec: { kind: 'browser_tests', caseKeys: [caseKeys[0]], target: mission.config.target } });
  });
  const claimed = await attempts.claimMission(mission.id); assert.ok(claimed);
  const lease = attempts.leaseIdentity(claimed);
  const reservation = await attempts.reserveMissionAttempt(lease, task.id, { resource: { kind: 'browser', poolKey: `scope-fixture:${randomUUID()}` } });
  assert.equal(reservation.status, 'reserved');
  const attempt = dispatch ? await attempts.markMissionDispatch(lease, reservation.attempt.id) : reservation.attempt;
  const input = { action: 'start', itemId: plan.id, caseId: cases[0].id, expectedVersion: plan.version, requestId: randomUUID(), environment: 'Publik webb', target: mission.config.target, mission: { missionId: mission.id, taskId: task.id } };
  return { mission, task, lease, attempt, input };
}
const execution = f => ({ execution: { attemptId: f.attempt.id, dispatchId: f.attempt.dispatchId } });
const start = (fixture, extra = {}, options = execution(fixture)) => testRunAction(owner, workspace, thread, { ...fixture.input, ...extra }, options);
const result = { outcome: 'inconclusive', actual: 'Synthetic partial observation from originating executor.', unverified: 'Fixture does not execute a browser.', observations: [], evidenceItemIds: [] };
const finish = (f, runId, options = execution(f)) => testRunAction(owner, workspace, thread, { action: 'finish', runId, result }, options);
async function browserJob(f) {
  f.executorSessionId = randomUUID();
  await db.insert(schema.browserJobs).values({ id: f.attempt.dispatchId, threadId: thread, runtime, parentSessionId: randomUUID(), sessionId: f.executorSessionId, task: 'Synthetic authorized browser task', status: 'running', model: 'fixture', reasoning: 'low' });
}
const worker = f => ({ browserJobId: f.attempt.dispatchId, executorSessionId: f.executorSessionId, callId: randomUUID() });
async function api(body, expected = 200) {
  const response = await fetch(`${origin}/api/internal/test-run`, { method: 'POST', headers: { authorization: `Bearer ${process.env.INTERNAL_API_SECRET}`, 'content-type': 'application/json' }, body: JSON.stringify({ userId: owner, threadId: thread, ...body }) });
  const value = await response.json(); assert.equal(response.status, expected, value.statusMessage ?? value.message); return value;
}
async function assertNoRun(requestId) { assert.equal((await db.select().from(schema.testRuns).where(eq(schema.testRuns.requestId, requestId))).length, 0); }
const operate = (m, action) => control.controlMission(owner, workspace, thread, { action, missionId: m.id, requestId: randomUUID(), expectedMandateRevision: m.mandateRevision });
function privateFieldsAbsent(value) {
  for (const field of ['leaseToken', 'leaseUntil', 'fence', 'mandate', 'admission', 'requestHash', 'dispatchId', 'toolCallIds', 'userId', 'runtime']) assert.ok(!(field in value), `Private field ${field} leaked`);
}

try {
  assert.equal(process.env.GRUNDEN_API_TOKEN, '');
  await db.insert(schema.user).values({ id: owner, name: 'Observation scope fixture', email: `${owner}@example.test` });
  await db.insert(schema.workspaces).values({ id: workspace, userId: owner, name: 'Observation scope fixture' });
  await db.insert(schema.threads).values({ id: thread, userId: owner, workspaceId: workspace, title: 'Observation scope fixture' });
  cases = ['Startsida', 'Ej valt testfall'].map(title => ({ id: randomUUID(), title, type: 'browser', preconditions: '', steps: 'Öppna startsidan', expected: 'Sidans rubrik är synlig' }));
  plan = await saveItem(owner, workspace, { title: 'Scope fixture plan', content: { kind: 'test_plan', sources: [], cases } });
  caseKeys = cases.map(c => `${plan.id}:${c.id}`);

  await check('only server admission creates observation identity, never a release claim', async () => {
    const a = await fixture(), b = await fixture();
    assert.equal(a.mission.config.target.revision, ''); assert.equal(a.mission.config.target.scope.kind, 'observation');
    assert.notEqual(a.mission.config.target.scope.id, b.mission.config.target.scope.id);
    assert.ok(Number.isFinite(Date.parse(a.mission.config.target.scope.capturedAt)));
    await reject(missionAction(owner, workspace, thread, { action: 'create', requestId: randomUUID(), config: a.mission.config }), 400);
  });
  await check('invented scope without mission cannot create a run', async () => {
    const f = await fixture(), input = { ...f.input, mission: undefined, target: { ...f.input.target, scope: { ...f.input.target.scope, id: randomUUID() } } };
    await reject(testRunAction(owner, workspace, thread, input)); await assertNoRun(input.requestId);
  });
  await check('missing, foreign-mission and invented task bindings cannot adopt an observation', async () => {
    const a = await fixture(), b = await fixture();
    for (const mission of [undefined, { missionId: randomUUID(), taskId: randomUUID() }, b.input.mission, { missionId: a.mission.id, taskId: b.task.id }]) {
      await reject(start(a, { mission })); await assertNoRun(a.input.requestId);
    }
  });
  await check('changed observation identity, time, URL and absent target are rejected', async () => {
    const f = await fixture();
    for (const value of [undefined, { ...f.input.target, scope: { ...f.input.target.scope, id: randomUUID() } }, { ...f.input.target, scope: { ...f.input.target.scope, capturedAt: new Date(0).toISOString() } }, { ...f.input.target, url: 'https://outside.example.test/' }]) await reject(start(f, { target: value }));
    await assertNoRun(f.input.requestId);
  });
  await check('new reserved attempt is not a dispatched executor', async () => {
    const f = await fixture({ dispatch: false }); await reject(start(f)); await assertNoRun(f.input.requestId);
  });
  await check('model payload cannot supply execution identity and exact dispatch identity is required', async () => {
    const f = await fixture();
    await reject(start(f, { execution: execution(f).execution, options: execution(f) }, {}));
    await reject(start(f, {}, { execution: { attemptId: f.attempt.id, dispatchId: randomUUID() } }));
    const other = await fixture(); await reject(start(f, {}, execution(other))); await assertNoRun(f.input.requestId);
  });
  for (const status of ['completed', 'failed', 'cancelled']) await check(`${status} attempt cannot create a new run`, async () => {
    const f = await fixture(); await db.update(schema.missionAttempts).set({ status }).where(eq(schema.missionAttempts.id, f.attempt.id));
    await reject(start(f)); await assertNoRun(f.input.requestId);
  });
  await check('uncertain dispatch preserves only the originating trusted execution binding', async () => {
    const f = await fixture(); await attempts.markMissionDispatch(f.lease, f.attempt.id, true);
    // The service option is adapter-owned. Transport uncertainty is not a
    // terminal executor outcome; it never replaces the exact attempt/dispatch.
    await reject(start(f, {}, {}));
    await reject(start(f, {}, { execution: { attemptId: f.attempt.id, dispatchId: randomUUID() } }));
    await assertNoRun(f.input.requestId);
    const [a, b] = await Promise.all([start(f), start(f)]);
    assert.equal(a.id, b.id); assert.equal(a.missionAttemptId, f.attempt.id); assert.equal(a.executionCurrent, true);
    assert.equal((await row(schema.missionAttempts, f.attempt.id)).status, 'dispatch_unknown');
  });
  for (const action of ['pause', 'cancel']) await check(`${action} revokes a dispatched attempt before any new run`, async () => {
    const f = await fixture(); await operate(f.mission, action); await reject(start(f)); await assertNoRun(f.input.requestId);
    assert.ok((await row(schema.missionAttempts, f.attempt.id)).cancelRequestedAt);
  });
  for (const [name, patch] of Object.entries({ expired: { deadlineAt: new Date(0) }, cancellation_requested: { cancelRequestedAt: new Date() }, old_mandate: { mandateRevision: 0 }, old_plan: { planRevision: 0 } })) await check(`${name} attempt cannot create a new run`, async () => {
    const f = await fixture(); await db.update(schema.missionAttempts).set(patch).where(eq(schema.missionAttempts.id, f.attempt.id));
    await reject(start(f)); await assertNoRun(f.input.requestId);
  });
  await check('wrong case and stale browser task are rejected', async () => {
    const f = await fixture(); await reject(start(f, { caseId: cases[1].id })); await assertNoRun(f.input.requestId);
    await db.update(schema.missionTasks).set({ planRevision: 0 }).where(eq(schema.missionTasks.id, f.task.id));
    await reject(start(f)); await assertNoRun(f.input.requestId);
  });
  await check('runtime mismatch cannot adopt a valid observation target', async () => {
    const f = await fixture(); process.env.PAT_RUNTIME_SCOPE = `${runtime}-other`;
    try { await reject(start(f)); await assertNoRun(f.input.requestId); } finally { process.env.PAT_RUNTIME_SCOPE = runtime; }
  });
  await check('current dispatched browser task starts once and internal binding preserves context', async () => {
    const f = await fixture(), [a, b] = await Promise.all([start(f), start(f)]); assert.equal(a.id, b.id);
    assert.deepEqual(a.target, f.mission.config.target); assert.equal(a.runtime, runtime); assert.equal(a.result, null);
    assert.equal(a.missionAttemptId, f.attempt.id); assert.equal(a.executionCurrent, true);
    await bindMissionSource(owner, workspace, thread, f.input.mission, 'test', a.id);
    await bindMissionSource(owner, workspace, thread, f.input.mission, 'test', a.id);
    const task = await row(schema.missionTasks, f.task.id); assert.deepEqual(task.sources, [{ type: 'test', id: a.id }]);
    assert.equal(task.results[0].context.missionId, f.mission.id); assert.equal(task.results[0].context.taskId, f.task.id);
    assert.equal(task.results[0].context.workspaceId, workspace); assert.equal(task.results[0].status, 'running');
  });
  await check('legacy mutations cannot alter controller-owned configuration, tasks or sources', async () => {
    const f = await fixture(), run = await start(f), before = await row(schema.missions, f.mission.id);
    await reject(missionAction(owner, workspace, thread, { action: 'update', missionId: f.mission.id, expectedRevision: before.revision, config: { ...before.config, target: null }, reason: 'Unexpected manual replacement', status: 'active' }));
    await reject(missionAction(owner, workspace, thread, { action: 'task', missionId: f.mission.id, requestId: randomUUID(), task: { title: 'Uncontrolled task', actor: 'browser', criterionIds: ['qa'] } }));
    await reject(missionAction(owner, workspace, thread, { action: 'attach', ...f.input.mission, sourceType: 'test', sourceId: run.id }));
    await reject(missionAction(owner, workspace, thread, { action: 'report', missionId: f.mission.id }));
    assert.deepEqual((await row(schema.missions, f.mission.id)).config, before.config);
    assert.equal((await rows(schema.missionTasks, f.mission.id)).length, 2); assert.deepEqual((await row(schema.missionTasks, f.task.id)).sources, []);
  });
  await check('immutable receipt remains readable after closure but fresh start and binding fail', async () => {
    const f = await fixture(), run = await start(f);
    // Inject terminal controller state directly: this suite tests the data-plane
    // guard, not the later scheduler's delivery/closure state machine.
    await db.update(schema.missions).set({ status: 'closed', lifecycle: 'closed', closedAt: new Date() }).where(eq(schema.missions.id, f.mission.id));
    const replay = await start(f); assert.equal(replay.id, run.id); assert.equal(replay.executionCurrent, false);
    await reject(start(f, {}, {}));
    await reject(start(f, { requestId: randomUUID() }));
    await reject(bindMissionSource(owner, workspace, thread, f.input.mission, 'test', run.id));
    await reject(start(f, { environment: 'Changed environment' }));
  });
  await check('stale physical worker cannot borrow a replacement attempt on the same task', async () => {
    const old = await fixture(), prior = await start(old);
    await db.update(schema.missionAttempts).set({ status: 'failed', finishedAt: new Date() }).where(eq(schema.missionAttempts.id, old.attempt.id));
    await db.delete(schema.missionResourceClaims).where(eq(schema.missionResourceClaims.attemptId, old.attempt.id));
    await db.update(schema.missionTasks).set({ state: 'pending' }).where(eq(schema.missionTasks.id, old.task.id));
    const reservation = await attempts.reserveMissionAttempt(old.lease, old.task.id, { resource: { kind: 'browser', poolKey: `replacement:${randomUUID()}` } });
    assert.equal(reservation.status, 'reserved');
    const next = { ...old, attempt: await attempts.markMissionDispatch(old.lease, reservation.attempt.id) };
    await reject(start(old, { requestId: randomUUID() }));
    await reject(start(next)); // same old request is owned by the old attempt
    const nextRun = await start(next, { requestId: randomUUID() }); assert.notEqual(nextRun.id, prior.id);
    await reject(finish(next, prior.id)); await reject(finish(old, nextRun.id));
    const replay = await start(old); assert.equal(replay.id, prior.id); assert.equal(replay.executionCurrent, false);
  });
  await check('late originating finish is immutable history and never queues a continuation', async () => {
    const f = await fixture(), run = await start(f); await operate(f.mission, 'cancel');
    await reject(finish(f, run.id, {}));
    const saved = await finish(f, run.id); assert.equal(saved.executionCurrent, false); assert.deepEqual(saved.result, result);
    assert.equal((await finish(f, run.id)).id, run.id);
    await reject(testRunAction(owner, workspace, thread, { action: 'assess', runId: run.id }, execution(f)));
    assert.equal((await db.select().from(schema.resultAssessments).where(eq(schema.resultAssessments.runId, run.id))).length, 0);
    assert.equal((await row(schema.missionTasks, f.task.id)).state, 'running');
    await reject(testRunAction(owner, workspace, thread, { action: 'finish', runId: run.id, result: { ...result, actual: 'Changed late result' } }, execution(f)));
  });
  await check('legacy runs remain unbound and cannot be adopted by an executor', async () => {
    const f = await fixture(), input = { ...f.input, mission: undefined, target: { environment: 'QA', url: target.url, revision: 'fixture-release' } };
    const run = await testRunAction(owner, workspace, thread, input); assert.equal(run.missionAttemptId, null);
    assert.equal((await testRunAction(owner, workspace, thread, input)).id, run.id);
    await reject(testRunAction(owner, workspace, thread, { ...input, mission: f.input.mission }, execution(f)));
  });
  await check('authored internal route derives attempt from server-owned browser job only', async () => {
    const f = await fixture(); await browserJob(f);
    await api({ ...f.input, execution: execution(f).execution }, 409);
    const run = await api({ ...f.input, mission: undefined, ...worker(f), execution: { attemptId: randomUUID(), dispatchId: randomUUID() } });
    assert.equal(run.missionAttemptId, f.attempt.id); assert.equal(run.executionCurrent, true);
    assert.deepEqual((await row(schema.missionTasks, f.task.id)).sources, [{ type: 'test', id: run.id }]);
    const other = await fixture(); await browserJob(other);
    await api({ ...f.input, ...worker(other) }, 409);
    await api({ ...f.input, ...worker(f), browserJobId: randomUUID() }, 404);
    await db.update(schema.missions).set({ status: 'closed', lifecycle: 'closed', closedAt: new Date() }).where(eq(schema.missions.id, f.mission.id));
    const historical = await api({ ...f.input, ...worker(f) }); assert.equal(historical.id, run.id); assert.equal(historical.executionCurrent, false);
    const late = await api({ action: 'finish', runId: run.id, result, ...worker(f) }); assert.equal(late.executionCurrent, false);
    await api({ action: 'assess', runId: run.id, ...worker(f) }, 409);
    await api({ action: 'finish', runId: run.id, result, ...worker(other) }, 409);
    assert.equal((await db.select().from(schema.resultAssessments).where(eq(schema.resultAssessments.runId, run.id))).length, 0);
  });
  await check('Iris test tools reject missing, null or replaced session binding and scope reads to the originating attempt', async () => {
    const a = await fixture(), b = await fixture(); await browserJob(a); await browserJob(b);
    await api({ ...a.input, browserJobId: a.attempt.dispatchId }, 409);
    await api({ ...a.input, ...worker(a), executorSessionId: b.executorSessionId }, 409);
    await db.update(schema.browserJobs).set({ sessionId: null }).where(eq(schema.browserJobs.id, a.attempt.dispatchId));
    await api({ ...a.input, ...worker(a) }, 409);
    await db.update(schema.browserJobs).set({ sessionId: a.executorSessionId }).where(eq(schema.browserJobs.id, a.attempt.dispatchId));
    const own = await api({ ...a.input, ...worker(a) }); await api({ ...b.input, ...worker(b) });
    const listed = await api({ action: 'list', itemId: plan.id, ...worker(a) }); assert.deepEqual(listed.map(run => run.id), [own.id]);
  });
  await check('uncertain HTTP acknowledgement permits the same verified Iris session, never a new session or dispatch', async () => {
    const f = await fixture(); await attempts.markMissionDispatch(f.lease, f.attempt.id, true);
    await api({ ...f.input, browserJobId: f.attempt.dispatchId, executorSessionId: randomUUID(), callId: randomUUID() }, 404);
    await browserJob(f);
    await db.update(schema.browserJobs).set({ status: 'dispatch_unknown', sessionId: null }).where(eq(schema.browserJobs.id, f.attempt.dispatchId));
    await api({ ...f.input, ...worker(f) }, 409);
    await db.update(schema.browserJobs).set({ sessionId: f.executorSessionId }).where(eq(schema.browserJobs.id, f.attempt.dispatchId));
    await api({ ...f.input, browserJobId: f.attempt.dispatchId, callId: randomUUID() }, 409);
    await api({ ...f.input, ...worker(f), executorSessionId: randomUUID() }, 409);
    await api({ ...f.input, ...worker(f), browserJobId: randomUUID() }, 404);
    const other = await fixture(); await browserJob(other);
    await api({ ...f.input, ...worker(other) }, 409);
    await assertNoRun(f.input.requestId);
    // The actual gateway encoded target as JSON; transport normalization must
    // preserve the same immutable request/run on a subsequent object replay.
    const run = await api({ ...f.input, target: JSON.stringify(f.input.target), ...worker(f) });
    const replay = await api({ ...f.input, ...worker(f) });
    assert.equal(replay.id, run.id); assert.equal(run.missionAttemptId, f.attempt.id); assert.equal(run.executionCurrent, true);
    assert.equal((await row(schema.missionAttempts, f.attempt.id)).toolCalls, 1);
    await api({ action: 'finish', runId: run.id, result, ...worker(f) });
    assert.deepEqual((await row(schema.testRuns, run.id)).result, result);
  });
  for (const revoked of ['pause', 'cancel', 'expired']) await check(`uncertain dispatch does not bypass ${revoked} through the actual Iris route`, async () => {
    const f = await fixture(); await browserJob(f); await attempts.markMissionDispatch(f.lease, f.attempt.id, true);
    await db.update(schema.browserJobs).set({ status: 'dispatch_unknown' }).where(eq(schema.browserJobs.id, f.attempt.dispatchId));
    if (revoked === 'expired') await db.update(schema.missionAttempts).set({ deadlineAt: new Date(0) }).where(eq(schema.missionAttempts.id, f.attempt.id));
    else await operate(f.mission, revoked);
    await api({ ...f.input, ...worker(f) }, 409); await assertNoRun(f.input.requestId);
  });
  await check('exhausted execution budget still saves and accounts one immutable FINISH receipt', async () => {
    const f = await fixture(); await browserJob(f); const run = await api({ ...f.input, ...worker(f) });
    assert.equal((await row(schema.missionAttempts, f.attempt.id)).toolCalls, 1);
    await api({ ...f.input, ...worker(f) }); assert.equal((await row(schema.missionAttempts, f.attempt.id)).toolCalls, 1);
    await db.update(schema.missionAttempts).set({ toolCalls: f.attempt.reservedToolCalls }).where(eq(schema.missionAttempts.id, f.attempt.id));
    await api({ ...f.input, requestId: randomUUID(), ...worker(f) }, 409);
    await api({ action: 'finish', runId: run.id, result, ...worker(f) });
    assert.equal((await row(schema.missionAttempts, f.attempt.id)).toolCalls, f.attempt.reservedToolCalls + 1);
    await api({ action: 'finish', runId: run.id, result, ...worker(f) });
    assert.equal((await row(schema.missionAttempts, f.attempt.id)).toolCalls, f.attempt.reservedToolCalls + 1);
    assert.deepEqual((await row(schema.testRuns, run.id)).result, result);
  });
  await check('new mission or resumed observation cannot reuse previous run identity', async () => {
    const a = await fixture(), run = await start(a), b = await fixture();
    await reject(start(b, { requestId: a.input.requestId }));
    assert.notEqual((await start(b)).id, run.id);
    await operate(a.mission, 'pause');
    // Synthetic executor acknowledgement; no physical browser was started.
    await db.update(schema.missionAttempts).set({ status: 'cancelled', finishedAt: new Date() }).where(eq(schema.missionAttempts.id, a.attempt.id));
    await db.delete(schema.missionResourceClaims).where(eq(schema.missionResourceClaims.attemptId, a.attempt.id));
    const renewed = await operate(await row(schema.missions, a.mission.id), 'resume');
    assert.notEqual(renewed.config.target.scope.id, a.input.target.scope.id);
    await reject(start(a, { target: renewed.config.target }));
    await reject(start(a, { requestId: randomUUID() }));
    assert.equal((await start(a)).id, run.id);
  });
  await check('public mission views omit authority and lease fields', async () => {
    const f = await fixture(), current = await row(schema.missions, f.mission.id); assert.ok(current.leaseToken); assert.ok(current.mandate);
    privateFieldsAbsent(publicMission(current));
    const listed = (await listMissions(owner, workspace)).missions.find(m => m.id === f.mission.id); assert.ok(listed); privateFieldsAbsent(listed);
    const read = await missionAction(owner, workspace, thread, { action: 'read', missionId: f.mission.id }); privateFieldsAbsent(read.mission);
    assert.equal(read.mission.config.target.scope.id, current.config.target.scope.id);
  });

  console.log(JSON.stringify({ status: failures.length ? 'failed' : 'passed', checks: passed.length, failures: failures.map(({ name, message }) => ({ name, message })), database: 'actual isolated PostgreSQL', services: 'authored admission, attempt, test-run and mission services', substitutes: ['saved test plan', 'executor dispatch state', 'terminal closure/acknowledgement fault injection'], externalExecution: 'none' }));
  if (failures.length) { for (const failure of failures) console.error(failure.stack); process.exitCode = 1; }
} finally {
  globalThis.fetch = originalFetch; process.env.PAT_RUNTIME_SCOPE = runtime;
  server.close(); server.closeAllConnections(); await once(server, 'close');
  try { await db.delete(schema.user).where(eq(schema.user.id, owner)); } finally { await app.close(); }
}
