import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { eq, sql } from 'drizzle-orm';
import { isolatedApp } from './helpers/isolated-app.mjs';

// Actual PostgreSQL, browser service, Chromium, PNG/JSON bytes and authored
// actions. Executor auth attributes are fixtures; this is not an Eve model test.
process.env.PAT_RUNTIME_SCOPE += `-browser-${randomUUID()}`;
process.env.AUTONOMOUS_MISSIONS_ENABLED = 'true'; process.env.MISSIONS_ENABLED = 'true';
assert.equal(process.env.BROWSER_SERVICE_URL, 'http://127.0.0.1:58092');
const app = await isolatedApp(), { db, schema } = app;
const { saveItem } = await import('../server/utils/workspaces.ts');
const control = await import('../server/utils/mission-control.ts');
const attempts = await import('../server/utils/mission-attempts.ts');
const { testRunAction } = await import('../server/utils/test-runs.ts');
const { browserAction, controlBrowser, disconnectBrowsers } = await import('../server/utils/browser.ts');
const { captureTestStep } = await import('../server/utils/test-captures.ts');
const { get, del, workspaceStorageToken } = await import('../server/utils/evidence-storage.ts');
const { buildReviewInput } = await import('../server/utils/result-assessments.ts');
const userId = randomUUID(), workspaceId = randomUUID(), threadId = randomUUID(), sessionId = randomUUID();
const passed = [];
let assignment, run, attempt, mission, task, release;
const pending = [];
const rejectStatus = (promise, status = 403) => assert.rejects(promise, error => error.statusCode === status);
const captures = () => db.select().from(schema.testCaptures).where(eq(schema.testCaptures.runId, run.id));
async function itemBytes(itemId) {
  const [item] = await db.select().from(schema.workspaceItems).where(eq(schema.workspaceItems.id, itemId));
  assert.ok(item); const bytes = Buffer.from(await new Response((await get(item.blobPath, { token: workspaceStorageToken(), access: 'private' })).stream).arrayBuffer());
  assert.equal(createHash('sha256').update(bytes).digest('hex'), item.provenance.sha256);
  return { item, bytes };
}
async function trace(result) {
  assert.ok(result.actionTrace, JSON.stringify(result));
  const saved = await itemBytes(result.actionTrace.itemId);
  assert.equal(saved.item.provenance.producer, 'browser-action'); assert.equal(saved.item.provenance.sourceId, run.id);
  return JSON.parse(saved.bytes);
}
const actor = () => ({ browserJobId: attempt.dispatchId, executorSessionId: sessionId, callId: randomUUID() });
const action = (input, override = {}) => browserAction(userId, threadId, { runId: run.id, ...input }, sessionId, { ...actor(), ...override });
async function waitForBrowserLock() {
  const key = `browser:${workspaceId}:${threadId}:${sessionId}`;
  for (let i = 0; i < 100; i++) {
    const [{ count }] = await db.execute(sql`select count(*)::int as count from pg_locks where locktype = 'advisory' and not granted and classid::bigint = ((hashtextextended(${key}, 0) >> 32) & 4294967295) and objid::bigint = (hashtextextended(${key}, 0) & 4294967295) and database = (select oid from pg_database where datname = current_database())`);
    if (count) return; await delay(20);
  }
  throw new Error('Expected browser lock contention');
}
try {
  await db.insert(schema.user).values({ id: userId, name: 'Browser proof', email: `${userId}@example.test` });
  await db.insert(schema.workspaces).values({ id: workspaceId, userId, name: 'Browser proof' });
  await db.insert(schema.threads).values({ id: threadId, workspaceId, userId, title: 'Browser proof' });
  const test = { id: randomUUID(), title: 'Actual navigation fixture', type: 'browser', preconditions: '', steps: 'Open products and check returns navigation', expected: 'The requested page is visible' };
  const plan = await saveItem(userId, workspaceId, { title: 'Browser proof', content: { kind: 'test_plan', sources: [], cases: [test] } });
  const caseKey = `${plan.id}:${test.id}`;
  mission = await control.acceptMission(userId, workspaceId, threadId, { requestId: randomUUID(), intent: 'verify', goal: 'Verify the controlled browser fixture', target: { kind: 'public_url', url: 'http://qa-fixture.test' }, caseKeys: [caseKey] });
  task = await db.transaction(async tx => { await control.lockMission(tx, mission.id); return control.addMissionTask(tx, mission, { operationId: randomUUID(), title: 'Browser fixture', spec: { kind: 'browser_tests', target: mission.config.target, caseKeys: [caseKey] } }); });
  const claimed = await attempts.claimMission(mission.id), lease = attempts.leaseIdentity(claimed);
  const reservation = await attempts.reserveMissionAttempt(lease, task.id, { resource: { kind: 'browser', poolKey: `isolated-browser-proof-${workspaceId}` } });
  assert.equal(reservation.status, 'reserved'); attempt = reservation.attempt;
  await attempts.markMissionDispatch(lease, attempt.id);
  await db.insert(schema.browserJobs).values({ id: attempt.dispatchId, threadId, runtime: process.env.PAT_RUNTIME_SCOPE, parentSessionId: randomUUID(), sessionId, task: 'Browser fixture', status: 'running', model: 'fixture', reasoning: 'low' });
  run = await testRunAction(userId, workspaceId, threadId, { action: 'start', requestId: randomUUID(), itemId: plan.id, caseId: test.id, expectedVersion: plan.version, environment: mission.config.target.environment, target: mission.config.target, mission: { missionId: mission.id, taskId: task.id } }, { execution: { attemptId: attempt.id, dispatchId: attempt.dispatchId } });

  // Actor/assignment resolution now rejects mismatched identities before the
  // browser lock and physical service, including before any returned alias.
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('An invalid actor must not reach the browser service'); };
  try {
    for (const override of [{ executorSessionId: randomUUID() }, { browserJobId: randomUUID() }]) {
      await assert.rejects(action({ action: 'open', url: 'http://qa-fixture.test' }, override), error => error.statusCode === 409
        && error.statusMessage === 'Den återlämnade webbläsaren saknar ett giltigt fortsatt körmandat.');
    }
  } finally { globalThis.fetch = originalFetch; }
  assert.equal((await db.select().from(schema.browserAssignments).where(eq(schema.browserAssignments.workspaceId, workspaceId))).length, 0);
  assert.equal((await captures()).length, 0);
  await rejectStatus(action({ action: 'open', url: 'https://outside.example' }));
  await rejectStatus(action({ action: 'open', url: 'http://qa-fixture.test', sessionId: randomUUID() }), 404);
  await rejectStatus(browserAction(userId, threadId, { action: 'open', url: 'http://qa-fixture.test', runId: run.id }));
  passed.push('Exact executor session, job, run, origin and browser assignment are required before actions');

  const firstActor = actor(), input = { action: 'open', url: 'http://qa-fixture.test', runId: run.id };
  const simultaneous = await Promise.all([browserAction(userId, threadId, input, sessionId, firstActor), browserAction(userId, threadId, input, sessionId, firstActor)]);
  const opened = simultaneous.find(result => result.status === 'ready'); assert.ok(opened, JSON.stringify(simultaneous));
  assert.equal(simultaneous.filter(result => result.status === 'outcome_unknown').length, 1);
  assignment = opened.sessionId;
  assert.equal((await captures()).length, 2);
  const firstTrace = await trace(opened); assert.equal(firstTrace.httpStatus, 200); assert.equal(firstTrace.action, 'open');
  assert.equal(firstTrace.execution.attemptId, attempt.id);
  assert.equal(opened.actionTrace.navigation.httpStatus, 200);
  assert.equal(opened.actionTrace.navigation.observedAt, firstTrace.finishedAt);
  assert.equal(opened.actionTrace.navigation.toUrl, firstTrace.toUrl);
  await itemBytes(opened.capture.itemId);
  passed.push('Concurrent replay performs one action and stores one hash-attested PNG/JSON pair');

  const products = opened.controls.find(value => value.label === 'Produkter'); assert.ok(products);
  let current = await action({ action: 'click', ref: products.ref });
  const navigation = await trace(current); assert.equal(navigation.fromUrl, 'http://qa-fixture.test/'); assert.equal(navigation.toUrl, 'http://qa-fixture.test/products'); assert.equal(navigation.httpStatus, 200); assert.equal(navigation.outcome, 'observed');
  assert.equal(current.actionTrace.navigation.httpStatus, navigation.httpStatus);
  assert.equal(current.actionTrace.navigation.fromUrl, navigation.fromUrl);
  passed.push('Actual click trace binds from/to URL, navigation response and observed DOM to the exact run');

  const field = current.controls.find(value => value.tag === 'input'); assert.ok(field);
  const privateInput = 'fixture-private-search-value';
  current = await action({ action: 'fill', ref: field.ref, text: privateInput });
  const fillTrace = await trace(current);
  assert.ok(!JSON.stringify(fillTrace).includes(privateInput));
  const { control: filledControl, observedAt: filledAt, ...fillPredicates } = fillTrace.filledField;
  assert.deepEqual(fillPredicates, { method: 'dom-value-and-css', valueMatchesRequested: true, nonEmpty: true, cssVisible: true, masking: 'not-detected', limitation: 'CSS visibility does not prove viewport position, occlusion or rendered text. Masking checks input type and text-security only.' });
  assert.equal(filledControl.tag, 'input'); assert.ok(Number.isFinite(Date.parse(filledAt)));
  assert.deepEqual(current.actionTrace.filledField, { ...fillPredicates, observedAt: filledAt });
  assert.ok(!JSON.stringify(current.actionTrace).includes(privateInput));
  assert.ok(!Object.hasOwn(current.actionTrace.filledField, 'control'));
  assert.equal(opened.actionTrace.filledField, undefined);
  assert.equal(current.actionTrace.navigation.httpStatus, null, 'A fill cannot inherit the earlier page response');
  const filled = current.controls.find(value => value.tag === 'input');
  current = await action({ action: 'press', ref: filled.ref, text: 'Enter' });
  const searchTrace = await trace(current); assert.ok(!JSON.stringify(searchTrace).includes(privateInput)); assert.match(searchTrace.toUrl, /REDACTED/);
  const returns = current.controls.find(value => value.label === 'Returer'); assert.ok(returns);
  current = await action({ action: 'click', ref: returns.ref });
  const defect = await trace(current); assert.equal(defect.httpStatus, 404); assert.equal(defect.toUrl, 'http://qa-fixture.test/returns');
  assert.equal(current.actionTrace.navigation.httpStatus, 404);
  assert.equal(current.actionTrace.navigation.toUrl, defect.toUrl);
  const inspected = await action({ action: 'inspect' });
  assert.equal(inspected.actionTrace.navigation.httpStatus, null, 'Inspect must not invent or reuse the last navigation status');
  assert.equal((await trace(inspected)).httpStatus, null);
  passed.push('Form values and query values are absent from traces; actual 404 is preserved as an observation');

  const otherAttempt = { ...attempt, id: randomUUID(), dispatchId: randomUUID(), attemptNo: 2 };
  await db.insert(schema.missionAttempts).values(otherAttempt);
  const foreignRun = { ...run, id: randomUUID(), requestId: randomUUID(), missionAttemptId: otherAttempt.id }; delete foreignRun.checks; delete foreignRun.executionCurrent;
  await db.insert(schema.testRuns).values(foreignRun);
  const before = (await captures()).length;
  await rejectStatus(action({ action: 'inspect', runId: foreignRun.id }));
  const noCapturePage = { screenshot: async () => { throw new Error('Must not inspect the page'); } };
  assert.equal((await captureTestStep(userId, workspaceId, threadId, 'inspect', noCapturePage)).capture, undefined);
  assert.equal((await captureTestStep(userId, workspaceId, threadId, 'inspect', noCapturePage, run.id)).capture, undefined);
  assert.equal((await captures()).length, before);
  passed.push('Cross-attempt and legacy implicit capture cannot contaminate autonomous runs');

  // Synthetic page fault barriers below isolate persistence behavior; the main
  // navigation/click proofs above use actual Chromium and actual screenshot bytes.
  // Deliberately inject additional historical/overlapping rows for capture
  // persistence faults. Real autonomous START now serializes unfinished cases;
  // the baseline above uses it and browser-entry.integration tests that boundary.
  const startExtra = async () => {
    const [original] = await db.select().from(schema.testRuns).where(eq(schema.testRuns.id, run.id));
    const [injected] = await db.insert(schema.testRuns).values({ ...original, id: randomUUID(), requestId: randomUUID() }).returning();
    return injected;
  };
  const traceOptions = { execution: { attemptId: attempt.id, dispatchId: attempt.dispatchId }, trace: { ...firstTrace, callId: randomUUID(), action: 'click', outcome: 'action_failed', observation: null } };
  const fakePage = { url: () => 'http://qa-fixture.test', title: async () => 'Synthetic fault barrier', locator: () => ({}) };
  const failedRun = await startExtra();
  const failedCapture = await captureTestStep(userId, workspaceId, threadId, 'click', { ...fakePage, screenshot: async () => { throw new Error('Synthetic image failure'); } }, failedRun.id, db, traceOptions);
  assert.ok(failedCapture.actionTrace);
  assert.equal(failedCapture.actionTrace.navigation.outcome, 'action_failed');
  assert.equal(failedCapture.actionTrace.navigation.httpStatus, traceOptions.trace.httpStatus); assert.ok(failedCapture.captureWarning); assert.equal(failedCapture.capture, undefined);
  const { bytes: png } = await itemBytes(opened.capture.itemId);
  const limitedRun = await startExtra();
  await db.insert(schema.testCaptures).values(Array.from({ length: 29 }, () => ({ id: randomUUID(), runId: limitedRun.id, title: 'Synthetic earlier receipt', url: 'http://qa-fixture.test', action: 'inspect', error: 'Synthetic earlier capture failure' })));
  const limited = await captureTestStep(userId, workspaceId, threadId, 'click', { ...fakePage, screenshot: async () => png }, limitedRun.id, db, traceOptions);
  assert.ok(limited.actionTrace); assert.equal(limited.capture, undefined);
  assert.equal((await db.select().from(schema.testCaptures).where(eq(schema.testCaptures.runId, limitedRun.id))).length, 30);
  passed.push('Synthetic image failure retains JSON action evidence; the shared 30-row budget prioritizes trace without exceeding its cap');

  const lateRun = await startExtra(); let captureEntered, releaseCapture;
  const atCapture = new Promise(done => { captureEntered = done; }), continueCapture = new Promise(done => { releaseCapture = done; });
  release = releaseCapture;
  const late = captureTestStep(userId, workspaceId, threadId, 'click', { ...fakePage, screenshot: async () => { captureEntered(); await continueCapture; return png; } }, lateRun.id, db, traceOptions); pending.push(late);
  await atCapture;
  const interrupted = { outcome: 'interrupted', actual: 'Synthetic fault barrier ended this run before capture persistence.', unverified: 'Not a functional test.', observations: [], evidenceItemIds: [] };
  await testRunAction(userId, workspaceId, threadId, { action: 'finish', runId: lateRun.id, result: interrupted }, { execution: { attemptId: attempt.id, dispatchId: attempt.dispatchId } });
  releaseCapture(); release = undefined;
  const lateResult = await late; assert.equal(lateResult.actionTrace, undefined); assert.equal(lateResult.capture, undefined);
  assert.equal((await db.select().from(schema.testCaptures).where(eq(schema.testCaptures.runId, lateRun.id))).length, 0);
  passed.push('Finishing during a synthetic screenshot barrier prevents both late JSON and PNG persistence');

  let entered;
  const acquired = new Promise(done => { entered = done; });
  const released = new Promise(done => { release = done; });
  const holding = db.transaction(async tx => { await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`browser:${workspaceId}:${threadId}:${sessionId}`}, 0))`); entered(); await released; }); pending.push(holding);
  await acquired;
  const delayed = action({ action: 'inspect' }).then(value => ({ value }), error => ({ error })); pending.push(delayed);
  await waitForBrowserLock();
  await control.controlMission(userId, workspaceId, threadId, { action: 'pause', missionId: mission.id, requestId: randomUUID(), expectedMandateRevision: mission.mandateRevision });
  release(); release = undefined;
  assert.equal((await delayed).error?.statusCode, 409); assert.equal((await captures()).length, before);
  passed.push('A pause while an action waits for the browser lock prevents execution after it acquires the lock');
  const final = await testRunAction(userId, workspaceId, threadId, { action: 'finish', runId: run.id, result: { outcome: 'interrupted', actual: 'The fixture observed navigation and its intentional 404 before a pause.', unverified: 'This was a harness test, not an independent assessment.', observations: [], evidenceItemIds: [] } }, { execution: { attemptId: attempt.id, dispatchId: attempt.dispatchId } });
  assert.equal(final.executionCurrent, false);
  const review = await buildReviewInput(workspaceId, run.id);
  assert.ok(review.evidence.some(value => value.provenance?.producer === 'browser-action'));
  passed.push('The finished run automatically exposes its trusted action traces to the reviewer');
  console.log(JSON.stringify({ status: 'passed', passed, database: 'actual isolated PostgreSQL', browser: 'actual Chromium', storage: 'actual PNG/JSON bytes', auth: 'synthetic executor attributes', model: false }));
} finally {
  release?.(); await Promise.allSettled(pending);
  if (assignment) await controlBrowser(userId, threadId, 'close', assignment).catch(() => {});
  await disconnectBrowsers();
  for (const item of await db.select().from(schema.workspaceItems).where(eq(schema.workspaceItems.workspaceId, workspaceId))) if (item.blobPath) await del(item.blobPath, { token: workspaceStorageToken() });
  await db.delete(schema.testCaptures).where(sql`${schema.testCaptures.runId} in (select id from pat_test_runs where workspace_id = ${workspaceId})`);
  await db.delete(schema.user).where(eq(schema.user.id, userId));
  await app.close();
}
