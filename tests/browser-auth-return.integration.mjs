import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import { controllerFixture } from './helpers/mission-controller-fixture.mjs';
import { runChecks } from '../shared/test-run.ts';
import { chromium } from 'playwright-core';

// Actual isolated PG + controller + START/FINISH/control/claim fences. External
// executor status and browser HTTP are synthetic, explicitly not AUTH acceptance.
assert.equal(process.env.GRUNDEN_API_TOKEN, '');
const physical = process.argv.includes('--chromium');
const originalFetch = globalThis.fetch;
if (physical) assert.equal(process.env.BROWSER_SERVICE_URL, 'http://127.0.0.1:58092');
const h = await controllerFixture(), { db, schema } = h;
const { testRunAction } = await import('../server/utils/test-runs.ts');
const { policyDigest } = await import('../server/utils/browser-mission-guard.ts');
const { browserAction, controlBrowser, disconnectBrowsers } = await import('../server/utils/browser.ts');
const { del, workspaceStorageToken } = await import('../server/utils/evidence-storage.ts');
const physicalSessions = [];
if (physical) {
  globalThis.fetch = (input, ...args) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    assert.equal(url.origin, process.env.BROWSER_SERVICE_URL, 'Only the existing isolated browser service may be called');
    return originalFetch(input, ...args);
  };
  const { vpsBrowserRequest } = await import('../server/utils/vps-browser.ts');
  h.scripts.vpsBrowserRequest = vpsBrowserRequest;
}
const basePlanner = h.scripts.planMission;
h.scripts.planMission = async (...args) => {
  const result = await basePlanner(...args);
  result.draft.cases = [0, 1, 2].map(index => ({ ...result.draft.cases[0], title: `Independent case ${index}` }));
  return result;
};
if (!physical) h.scripts.vpsBrowserRequest = async (path, method) => {
  assert.equal(method, 'DELETE'); assert.match(path, /^\/sessions\/[a-f0-9-]+$/);
  h.calls.push({ kind: 'provider:delete', path }); return { ok: true };
};
const passed = [];
let checkpoint = 'original continuation setup';
const execution = attempt => ({ execution: { attemptId: attempt.id, dispatchId: attempt.dispatchId } });
const start = (f, attempt, index) => {
  const [itemId, caseId] = f.task.spec.caseKeys[index].split(':');
  return testRunAction(h.owner, f.workspace, f.thread, { action: 'start', itemId, caseId, expectedVersion: f.task.spec.planVersions.find(plan => plan.itemId === itemId).version,
    requestId: randomUUID(), environment: f.task.spec.target.environment, target: f.task.spec.target, mission: { missionId: f.id, taskId: f.task.id } }, execution(attempt));
};
async function returned({ answer = true } = {}) {
  const f = await h.fixture(physical ? { target: { kind: 'public_url', url: 'http://qa-fixture.test/' } } : {}), ready = await h.browserReady(f);
  f.attempt = ready.attempts.find(row => row.kind === 'browser_tests'); f.task = ready.tasks.find(row => row.id === f.attempt.taskId);
  const agentId = `wrun_auth_${randomUUID()}`;
  await db.update(schema.browserJobs).set({ sessionId: agentId }).where(eq(schema.browserJobs.id, f.attempt.dispatchId));
  f.failed = await start(f, f.attempt, 0);
  await testRunAction(h.owner, f.workspace, f.thread, { action: 'finish', runId: f.failed.id, result: { schemaVersion: 2, outcome: 'failed', actual: 'Synthetic confirmed negative observation, preserved across login.', observations: [{ kind: 'defect', title: 'Observed mismatch', detail: 'The first original case is complete.' }], evidenceItemIds: [], remaining: [], checks: runChecks(f.failed.snapshot).map(check => ({ id: check.id, status: 'mismatch', actual: 'Synthetic observed mismatch.' })) } }, execution(f.attempt));
  f.interrupted = await start(f, f.attempt, 1);
  let sessionId = randomUUID();
  const mission = await h.row(schema.missions, f.id);
  const policy = { version: 1, allowedOrigins: mission.mandate.allowedOrigins, readOnly: true, deadlineAt: f.attempt.deadlineAt.toISOString() };
  if (physical) {
    const opened = await browserAction(h.owner, f.thread, { action: 'open', runId: f.interrupted.id, url: f.interrupted.snapshot.entryUrl }, agentId,
      { browserJobId: f.attempt.dispatchId, executorSessionId: agentId, callId: randomUUID() });
    assert.equal(opened.status, 'ready'); sessionId = opened.sessionId;
    physicalSessions.push({ threadId: f.thread, sessionId });
    [f.assignment] = await db.select().from(schema.browserAssignments).where(eq(schema.browserAssignments.sessionId, sessionId));
    const browser = await chromium.connectOverCDP(f.assignment.connectUrl);
    // Explicit synthetic setup in this new owned context: tests session
    // continuity, not login correctness or a real human-auth acceptance gate.
    await browser.contexts()[0].addCookies([{ name: 'auth-return-proof', value: 'retained-in-original-context', url: f.target.url }]);
    await browser.close();
    await controlBrowser(h.owner, f.thread, 'human', sessionId);
  } else {
    [f.assignment] = await db.insert(schema.browserAssignments).values({ id: randomUUID(), workspaceId: f.workspace, userId: h.owner, threadId: f.thread, agentId, sessionId,
      projectId: `self-hosted-policy-v1:${policyDigest(policy)}`, liveUrl: 'https://viewer.example.test/', control: 'human', expiresAt: f.attempt.deadlineAt }).returning();
  }
  await db.update(schema.missionResourceClaims).set({ owner: 'human', executorResourceId: sessionId }).where(eq(schema.missionResourceClaims.attemptId, f.attempt.id));
  f.wait = await db.transaction(async tx => {
    await h.control.lockMission(tx, f.id);
    return h.control.createMissionWait(tx, await h.missions.ownedMission(h.owner, f.workspace, f.id, tx), { reason: 'human_browser', taskIds: [f.task.id], question: 'Return this browser after the requested authentication.' });
  });
  await db.update(schema.browserJobs).set({ status: 'completed', updatedAt: new Date() }).where(eq(schema.browserJobs.id, f.attempt.dispatchId));
  await db.update(schema.missionAttempts).set({ usage: { tokens: 100, toolCalls: 1, durationMs: 1 } }).where(eq(schema.missionAttempts.id, f.attempt.id));
  await h.pass(f);
  f.originalAttempt = await h.row(schema.missionAttempts, f.attempt.id);
  f.originalRuns = await db.select().from(schema.testRuns).where(eq(schema.testRuns.missionAttemptId, f.attempt.id));
  if (!answer) return f;
  // Synthetic provider control receipt; the separate Chromium test exercises
  // the real service transition and retained cookie bytes.
  if (physical) await controlBrowser(h.owner, f.thread, 'agent', sessionId);
  else await db.update(schema.browserAssignments).set({ control: 'agent' }).where(eq(schema.browserAssignments.id, f.assignment.id));
  await h.control.controlMission(h.owner, f.workspace, f.thread, { action: 'answer', missionId: f.id, waitId: f.wait.id, expectedMandateRevision: mission.mandateRevision,
    requestId: randomUUID(), answer: { kind: 'browser_returned', sessionId } });
  return f;
}
try {
  const f = await returned(); await h.pass(f);
  checkpoint = 'physical session must survive terminal Iris return';
  assert.equal((await h.row(schema.browserAssignments, f.assignment.id)).sessionId, f.assignment.sessionId, 'The authenticated physical session must survive terminal Iris return');
  assert.ok(!h.calls.some(call => call.kind === 'provider:delete' && call.path.endsWith(f.assignment.sessionId)));
  const after = await h.state(f), next = after.attempts.find(row => row.kind === 'browser_tests' && row.id !== f.attempt.id);
  assert.ok(next); assert.equal(next.attemptNo, f.attempt.attemptNo + 1); assert.equal(next.deadlineAt.toISOString(), f.attempt.deadlineAt.toISOString());
  assert.equal(after.claims.length, 1); assert.equal(after.claims[0].attemptId, next.id); assert.equal(after.claims[0].executorResourceId, f.assignment.sessionId);
  assert.deepEqual(await h.row(schema.missionAttempts, f.attempt.id), f.originalAttempt);
  assert.deepEqual(await db.select().from(schema.testRuns).where(eq(schema.testRuns.missionAttemptId, f.attempt.id)), f.originalRuns);
  await assert.rejects(start(f, next, 0), error => error.statusCode === 409);
  const fresh = await start(f, next, 1); assert.notEqual(fresh.id, f.interrupted.id); assert.deepEqual(fresh.snapshot, f.interrupted.snapshot);
  assert.equal((await h.row(schema.testRuns, fresh.id)).browserEntryReceipt, null, 'No evidence or entry receipt is borrowed');
  passed.push('Original physical session and immutable outcomes retained; bounded fresh attempt covers only interrupted/unstarted cases');

  if (physical) {
    const newAgent = `wrun_auth_new_${randomUUID()}`;
    await db.update(schema.browserJobs).set({ sessionId: newAgent }).where(eq(schema.browserJobs.id, next.dispatchId));
    const observed = await browserAction(h.owner, f.thread, { action: 'open', runId: fresh.id, url: fresh.snapshot.entryUrl }, newAgent,
      { browserJobId: next.dispatchId, executorSessionId: newAgent, callId: randomUUID() });
    assert.equal(observed.status, 'ready'); assert.equal(observed.sessionId, f.assignment.sessionId);
    const assignment = await h.row(schema.browserAssignments, f.assignment.id);
    assert.equal(assignment.agentId, f.assignment.agentId, 'Original browser lock identity is unchanged');
    const browser = await chromium.connectOverCDP(assignment.connectUrl);
    try { assert.ok((await browser.contexts()[0].cookies(f.target.url)).some(cookie => cookie.name === 'auth-return-proof' && cookie.value === 'retained-in-original-context')); }
    finally { await browser.close(); }
    const stored = await h.row(schema.testRuns, fresh.id);
    assert.equal(stored.browserEntryReceipt.sessionId, f.assignment.sessionId);
    assert.equal(stored.missionAttemptId, next.id); assert.ok(stored.browserEntryReceipt.observedAt);
    passed.push('Actual Chromium keeps synthetic session cookie through real human/agent control and fresh current-run DOM observation');
  }

  for (const fault of physical ? [] : ['deadline', 'pause', 'cancel', 'wrong-session', 'wrong-runtime', 'changed-plan', 'missing-claim', 'preview', 'no-answer', 'late-answer']) {
    checkpoint = `negative fence: ${fault}`;
    const f = await returned({ answer: !['no-answer', 'late-answer'].includes(fault) });
    if (fault === 'no-answer' || fault === 'late-answer') {
      await db.update(schema.missionWaits).set({ deadlineAt: new Date(0) }).where(eq(schema.missionWaits.id, f.wait.id));
      // Explicit physical stop receipt through the real app cleanup path with
      // synthetic provider transport. Resource absence is not inferred.
      await controlBrowser(h.owner, f.thread, 'close', f.assignment.sessionId);
      if (fault === 'late-answer') {
        const mission = await h.row(schema.missions, f.id);
        await assert.rejects(h.control.controlMission(h.owner, f.workspace, f.thread, { action: 'answer', missionId: f.id, waitId: f.wait.id,
          expectedMandateRevision: mission.mandateRevision, requestId: randomUUID(), answer: { kind: 'browser_returned', sessionId: f.assignment.sessionId } }), error => error.statusCode === 409);
      }
    }
    if (fault === 'deadline') await db.update(schema.missionAttempts).set({ deadlineAt: new Date(0) }).where(eq(schema.missionAttempts.id, f.attempt.id));
    if (fault === 'pause' || fault === 'cancel') await h.operate(f, fault);
    if (fault === 'wrong-session') await db.update(schema.browserAssignments).set({ sessionId: randomUUID() }).where(eq(schema.browserAssignments.id, f.assignment.id));
    if (fault === 'wrong-runtime') await db.update(schema.browserJobs).set({ runtime: 'foreign-runtime' }).where(eq(schema.browserJobs.id, f.attempt.dispatchId));
    if (fault === 'changed-plan') await db.update(schema.workspaceItems).set({ version: f.task.spec.planVersions[0].version + 1 }).where(eq(schema.workspaceItems.id, f.task.spec.planVersions[0].itemId));
    if (fault === 'missing-claim') await db.delete(schema.missionResourceClaims).where(eq(schema.missionResourceClaims.attemptId, f.attempt.id));
    if (fault === 'preview') await db.update(schema.browserAssignments).set({ projectId: 'vps-preview-policy-v1:unsupported:invalid' }).where(eq(schema.browserAssignments.id, f.assignment.id));
    const before = h.calls.filter(call => call.missionId === f.id && call.kind === 'browser:start').length;
    await h.pass(f); await h.pass(f);
    assert.equal(h.calls.filter(call => call.missionId === f.id && call.kind === 'browser:start').length, before, `${fault}: no replacement or physical retry`);
    assert.deepEqual(await db.select().from(schema.testRuns).where(eq(schema.testRuns.missionAttemptId, f.attempt.id)), f.originalRuns);
    if (fault === 'no-answer' || fault === 'late-answer') {
      assert.equal((await h.row(schema.missionWaits, f.wait.id)).state, 'expired');
      assert.ok(h.calls.some(call => call.kind === 'provider:delete' && call.path.endsWith(f.assignment.sessionId)));
    }
    passed.push(`${fault} denies continuation without rewriting old runs`);
  }
} catch (error) {
  console.error(JSON.stringify({ failed: checkpoint, assertion: error?.name === 'AssertionError' ? { actual: error.actual, expected: error.expected, operator: error.operator } : null,
    class: error?.name ?? 'UnknownError', statusCode: error?.statusCode ?? null }));
  process.exitCode = 1;
} finally {
  console.log(JSON.stringify({ completedAssertions: passed, physical, cleanup: 'pending' }));
  for (const session of physicalSessions) await controlBrowser(h.owner, session.threadId, 'close', session.sessionId);
  if (physical) await disconnectBrowsers();
  const workspaces = await db.select().from(schema.workspaces).where(eq(schema.workspaces.userId, h.owner));
  for (const workspace of workspaces) {
    const items = await db.select().from(schema.workspaceItems).where(eq(schema.workspaceItems.workspaceId, workspace.id));
    for (const item of items) if (item.blobPath) await del(item.blobPath, { token: workspaceStorageToken() });
    const runs = await db.select({ id: schema.testRuns.id }).from(schema.testRuns).where(eq(schema.testRuns.workspaceId, workspace.id));
    if (runs.length) await db.delete(schema.testCaptures).where(inArray(schema.testCaptures.runId, runs.map(run => run.id)));
  }
  await h.close();
}
console.log(JSON.stringify({ suite: 'browser-auth-return', scope: physical ? 'actual PG/controller/Chromium; synthetic executor status and cookie setup; no model' : 'actual PG/controller; synthetic executor/browser transport; no model', passed }, null, 2));
