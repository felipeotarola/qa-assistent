import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { controllerFixture } from './helpers/mission-controller-fixture.mjs';

// Actual isolated PostgreSQL, control endpoint services and browser locks.
// No provider, model or real browser operation is used by these fault probes.
assert.equal(process.env.GRUNDEN_API_TOKEN, '');
const h = await controllerFixture(), { db, schema } = h;
const { controlBrowser, browserAction } = await import('../server/utils/browser.ts');
const { policyDigest } = await import('../server/utils/browser-mission-guard.ts');
const providerRequests = [], providerSessions = new Set(), providerRequest = h.scripts.vpsBrowserRequest;
h.scripts.vpsBrowserRequest = (path, method, ...args) => {
  providerRequests.push({ path, method });
  if (method === 'POST') {
    const match = /^\/sessions\/([a-f0-9-]{36})\/(human|agent)\?scoped=1$/.exec(path);
    assert.ok(match && providerSessions.has(match[1]), 'Synthetic control receipt must name this test owner\'s exact session');
    return {};
  }
  return providerRequest(path, method, ...args);
};
const failures = [], passed = [];
async function check(name, fn) { try { await fn(); passed.push(name); } catch (error) { failures.push({ name, message: error.message, stack: error.stack }); console.error(`FAILED ${name}: ${error.message}`); } }
async function original() {
  const f = await h.fixture(), ready = await h.browserReady(f); f.attempt = ready.attempts.find(a => a.kind === 'browser_tests');
  const agentId = `wrun_test_${randomUUID()}`, sessionId = randomUUID();
  const mission = await h.row(schema.missions, f.id);
  const policy = { version: 1, allowedOrigins: [...mission.mandate.allowedOrigins].sort(), readOnly: true, deadlineAt: f.attempt.deadlineAt.toISOString() };
  await db.update(schema.browserJobs).set({ sessionId: agentId }).where(eq(schema.browserJobs.id, f.attempt.dispatchId));
  [f.assignment] = await db.insert(schema.browserAssignments).values({ id: randomUUID(), workspaceId: f.workspace, userId: h.owner,
    threadId: f.thread, agentId, sessionId, projectId: `self-hosted-policy-v1:${policyDigest(policy)}`,
    control: 'agent', liveUrl: 'https://viewer.example.test/', expiresAt: f.attempt.deadlineAt }).returning();
  providerSessions.add(sessionId);
  await db.update(schema.missionResourceClaims).set({ owner: 'human', executorResourceId: sessionId }).where(eq(schema.missionResourceClaims.attemptId, f.attempt.id));
  f.wait = await makeWait(f);
  return f;
}
async function makeWait(f, options = {}) {
  return db.transaction(async tx => {
    await h.control.lockMission(tx, f.id);
    const mission = await h.missions.ownedMission(h.owner, f.workspace, f.id, tx);
    return h.control.createMissionWait(tx, mission, { reason: 'human_browser', question: 'Lämna tillbaka testets webbläsare.', taskIds: [f.attempt.taskId], ...options });
  });
}
async function answer(f, sessionId = f.assignment.sessionId, overrides = {}) {
  return h.control.controlMission(h.owner, f.workspace, f.thread, { action: 'answer', missionId: f.id, waitId: f.wait.id,
    expectedMandateRevision: (await h.row(schema.missions, f.id)).mandateRevision, requestId: randomUUID(), answer: { kind: 'browser_returned', sessionId }, ...overrides });
}
const denied = promise => assert.rejects(promise, error => error.statusCode === 409);
async function addBrowser(f, options = {}) {
  const [row] = await db.insert(schema.browserAssignments).values({ id: randomUUID(), workspaceId: f.workspace, userId: h.owner, threadId: f.thread,
    agentId: `other_${randomUUID()}`, sessionId: randomUUID(), control: 'agent', liveUrl: 'https://viewer.example.test/', expiresAt: new Date(Date.now() + 600_000), ...options }).returning();
  return row;
}
async function untilBrowserLocked(f) {
  const end = Date.now() + 3000;
  while (Date.now() < end) {
    const held = await db.transaction(async tx => {
      const [row] = await tx.execute(sql`select pg_try_advisory_xact_lock(hashtextextended(${`browser:${f.workspace}:${f.thread}:${f.assignment.agentId}`},0)) as acquired`);
      return !row.acquired;
    });
    if (held) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail('Expected actual browser lock acquisition');
}
try {
  await check('a different returned browser in the same workspace cannot answer this wait', async () => {
    const f = await original(), other = await addBrowser(f);
    await denied(answer(f, other.sessionId)); assert.equal((await h.row(schema.missionWaits, f.wait.id)).state, 'waiting');
  });
  await check('the exact original browser return is accepted without changing the physical claim', async () => {
    const f = await original(), claims = await h.rows(schema.missionResourceClaims, f.id);
    const result = await answer(f); assert.equal(result.lifecycle, 'running');
    assert.equal((await h.row(schema.missionWaits, f.wait.id)).state, 'answered');
    assert.equal((await h.row(schema.missionTasks, f.attempt.taskId)).state, 'pending');
    assert.deepEqual(await h.rows(schema.missionResourceClaims, f.id), claims);
  });
  await check('a physically returned session still needs its exact outstanding resource claim', async () => {
    const f = await original();
    await db.delete(schema.missionResourceClaims).where(eq(schema.missionResourceClaims.attemptId, f.attempt.id));
    await denied(answer(f));
  });
  for (const terminal of ['completed', 'failed']) await check(`an Iris ${terminal} turn while waiting can return control and start a new bounded attempt`, async () => {
    const f = await original();
    await controlBrowser(h.owner, f.thread, 'human', f.assignment.sessionId);
    // Synthetic provider receipt; models are not invoked by this fixture.
    await db.update(schema.missionAttempts).set({ usage: { tokens: 100, toolCalls: 1, durationMs: 10 } }).where(eq(schema.missionAttempts.id, f.attempt.id));
    await db.update(schema.browserJobs).set({ status: terminal }).where(eq(schema.browserJobs.id, f.attempt.dispatchId));
    await h.pass(f);
    const stopped = await h.row(schema.missionAttempts, f.attempt.id);
    assert.equal(stopped.status, terminal); assert.equal((await h.row(schema.missionTasks, f.attempt.taskId)).state, 'waiting');
    const claims = await h.rows(schema.missionResourceClaims, f.id); assert.equal(claims.length, 1);
    await denied(answer(f));
    await controlBrowser(h.owner, f.thread, 'agent', f.assignment.sessionId);
    await answer(f);
    assert.equal((await h.row(schema.missionTasks, f.attempt.taskId)).state, 'pending');
    await h.pass(f);
    const after = await h.state(f), own = after.attempts.filter(attempt => attempt.kind === 'browser_tests');
    assert.equal(own.length, 2); assert.deepEqual(await h.row(schema.missionAttempts, f.attempt.id), stopped, 'No reopening or rewriting the original attempt');
    const next = own.find(attempt => attempt.id !== f.attempt.id);
    assert.equal(next.attemptNo, f.attempt.attemptNo + 1); assert.notEqual(next.dispatchId, f.attempt.dispatchId);
    assert.equal(next.deadlineAt.toISOString(), f.attempt.deadlineAt.toISOString());
    assert.equal(after.claims.length, 1); assert.equal(after.claims[0].attemptId, next.id);
    assert.equal(after.claims[0].id, claims[0].id); assert.equal(after.claims[0].executorResourceId, f.assignment.sessionId);
    const retained = await h.row(schema.browserAssignments, f.assignment.id);
    assert.equal(retained.sessionId, f.assignment.sessionId); assert.equal(retained.agentId, f.assignment.agentId);
    assert.equal(retained.projectId, f.assignment.projectId); assert.equal(retained.expiresAt.toISOString(), f.assignment.expiresAt.toISOString());
    assert.ok(!providerRequests.some(request => request.method === 'DELETE' && request.path === `/sessions/${f.assignment.sessionId}`));
    assert.ok(h.calls.some(call => call.kind === 'browser:start' && call.attemptId === next.id));
    assert.ok((await h.row(schema.missions, f.id)).mandate.limits.maxOperationAttempts >= next.attemptNo);
  });
  await check('a logically failed executor without a physical terminal receipt cannot attest return', async () => {
    const f = await original();
    await db.update(schema.missionAttempts).set({ status: 'failed', finishedAt: new Date() }).where(eq(schema.missionAttempts.id, f.attempt.id));
    await db.update(schema.browserJobs).set({ status: 'dispatch_unknown' }).where(eq(schema.browserJobs.id, f.attempt.dispatchId));
    await denied(answer(f));
  });
  await check('another workspace browser cannot answer', async () => {
    const f = await original(), other = await h.fixture(), browser = await addBrowser(other);
    await denied(answer(f, browser.sessionId));
  });
  for (const field of ['runtime', 'threadId', 'sessionId']) await check(`mismatched browser job ${field} cannot attest return`, async () => {
    const f = await original(), value = field === 'threadId' ? (await h.fixture()).thread : `other-${randomUUID()}`;
    await db.update(schema.browserJobs).set({ [field]: value }).where(eq(schema.browserJobs.id, f.attempt.dispatchId));
    await denied(answer(f));
  });
  for (const field of ['runtime', 'mandateRevision', 'planRevision', 'cancelRequestedAt', 'deadlineAt', 'status']) await check(`obsolete attempt ${field} cannot attest return`, async () => {
    const f = await original(), value = field === 'runtime' ? 'another-runtime' : field === 'status' ? 'cancelled' : field === 'cancelRequestedAt' ? new Date() : field === 'deadlineAt' ? new Date(0) : f.attempt[field] - 1;
    await db.update(schema.missionAttempts).set({ [field]: value }).where(eq(schema.missionAttempts.id, f.attempt.id));
    await denied(answer(f));
  });
  await check('a later attempt cannot replace the browser named by the older wait occurrence', async () => {
    const f = await original();
    await db.update(schema.missionAttempts).set({ createdAt: new Date(f.wait.createdAt.getTime() + 10_000), attemptNo: f.attempt.attemptNo + 1 }).where(eq(schema.missionAttempts.id, f.attempt.id));
    await denied(answer(f));
  });
  await check('a newer retry prevents acknowledging either the old or substituted browser for the original wait', async () => {
    const f = await original(), dispatchId = randomUUID(), other = await addBrowser(f);
    const job = await h.row(schema.browserJobs, f.attempt.dispatchId);
    await db.update(schema.missionAttempts).set({ status: 'completed', finishedAt: new Date() }).where(eq(schema.missionAttempts.id, f.attempt.id));
    await db.insert(schema.missionAttempts).values({ ...f.attempt, id: randomUUID(), dispatchId, attemptNo: f.attempt.attemptNo + 1, createdAt: new Date(f.wait.createdAt.getTime() + 1), updatedAt: new Date() });
    await db.insert(schema.browserJobs).values({ ...job, id: dispatchId, sessionId: other.agentId, createdAt: new Date(), updatedAt: new Date() });
    await denied(answer(f)); await denied(answer(f, other.sessionId));
  });
  for (const field of ['executorResourceId', 'runtime', 'workspaceId']) await check(`mismatched physical claim ${field} cannot attest return`, async () => {
    const f = await original(), value = field === 'workspaceId' ? (await h.fixture()).workspace : randomUUID();
    await db.update(schema.missionResourceClaims).set({ [field]: value }).where(eq(schema.missionResourceClaims.attemptId, f.attempt.id));
    await denied(answer(f));
  });
  await check('human ownership, expired assignment, and wrong owner each deny return', async () => {
    for (const change of [{ control: 'human' }, { expiresAt: new Date(0) }]) {
      const f = await original(); await db.update(schema.browserAssignments).set(change).where(eq(schema.browserAssignments.id, f.assignment.id)); await denied(answer(f));
    }
    const f = await original(), userId = randomUUID();
    await db.insert(schema.user).values({ id: userId, email: `${userId}@example.test`, name: 'Other test owner' });
    try { await db.update(schema.browserAssignments).set({ userId }).where(eq(schema.browserAssignments.id, f.assignment.id)); await denied(answer(f)); }
    finally { await db.delete(schema.user).where(eq(schema.user.id, userId)); }
  });
  await check('non-browser and multi-task questions cannot be answered by one browser receipt', async () => {
    const f = await original();
    await db.update(schema.missionWaits).set({ definition: { ...f.wait.definition, reason: 'authentication' } }).where(eq(schema.missionWaits.id, f.wait.id));
    await denied(answer(f));
    await db.update(schema.missionWaits).set({ definition: { ...f.wait.definition, taskIds: [f.attempt.taskId, randomUUID()] } }).where(eq(schema.missionWaits.id, f.wait.id));
    await denied(answer(f));
  });
  await check('answer schema rejects forged executor identity and non-session identifiers', async () => {
    const f = await original();
    await assert.rejects(answer(f, f.assignment.sessionId, { answer: { kind: 'browser_returned', sessionId: f.assignment.sessionId, attemptId: f.attempt.id } }));
    await assert.rejects(answer(f, 'not-a-session-uuid'));
    assert.equal((await h.row(schema.missionWaits, f.wait.id)).state, 'waiting');
  });
  await check('browser lock contention denies promptly rather than inverting mission/content lock order', async () => {
    const f = await original();
    await db.transaction(async tx => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`browser:${f.workspace}:${f.thread}:${f.assignment.agentId}`},0))`);
      const started = Date.now(); await denied(answer(f)); assert.ok(Date.now() - started < 3000);
    });
    await answer(f);
  });
  await check('actual controlBrowser takeover serialized before return cannot be acknowledged', async () => {
    const f = await original(); await controlBrowser(h.owner, f.thread, 'human', f.assignment.sessionId); await denied(answer(f));
    await controlBrowser(h.owner, f.thread, 'agent', f.assignment.sessionId); await answer(f);
  });
  await check('in-flight actual takeover wins browser lock before answer, without a deadlock', async () => {
    const f = await original(); let takeover;
    await db.transaction(async tx => {
      // Hold only the assignment row: controlBrowser takes its browser lock and
      // then pauses on the row write. The answer must fail its try-lock promptly.
      await tx.execute(sql`select id from pat_browser_assignments where id = ${f.assignment.id} for update`);
      takeover = controlBrowser(h.owner, f.thread, 'human', f.assignment.sessionId);
      await untilBrowserLocked(f); await denied(answer(f));
    });
    await takeover;
    assert.equal((await h.row(schema.missionWaits, f.wait.id)).state, 'waiting');
    assert.equal((await h.row(schema.browserAssignments, f.assignment.id)).control, 'human');
  });
  await check('answer holds the browser lock through commit before a later actual takeover proceeds', async () => {
    const f = await original(); let returned, takeover;
    await db.transaction(async tx => {
      await tx.execute(sql`select id from pat_mission_waits where id = ${f.wait.id} for update`);
      returned = answer(f); await untilBrowserLocked(f);
      takeover = controlBrowser(h.owner, f.thread, 'human', f.assignment.sessionId);
      assert.equal((await h.row(schema.browserAssignments, f.assignment.id)).control, 'agent');
    });
    await returned; await takeover;
    assert.equal((await h.row(schema.missionWaits, f.wait.id)).state, 'answered');
    assert.equal((await h.row(schema.browserAssignments, f.assignment.id)).control, 'human');
  });
  await check('a new takeover after return remains fenced at each autonomous operation', async () => {
    const f = await original(); await answer(f); await controlBrowser(h.owner, f.thread, 'human', f.assignment.sessionId);
    await assert.rejects(browserAction(h.owner, f.thread, { action: 'inspect' }, f.assignment.agentId,
      { browserJobId: f.attempt.dispatchId, executorSessionId: f.assignment.agentId, callId: randomUUID() }), error => error.statusCode === 409);
    assert.equal((await h.row(schema.browserAssignments, f.assignment.id)).control, 'human');
  });
  await check('a later takeover creates exactly one new current wait after the first was answered', async () => {
    const f = await original(), requestId = randomUUID(); await answer(f, f.assignment.sessionId, { requestId });
    const again = await makeWait(f); assert.notEqual(again.id, f.wait.id); assert.equal(again.state, 'waiting');
    const repeats = await Promise.all([makeWait(f), makeWait(f), makeWait(f)]); assert.ok(repeats.every(w => w.id === again.id));
    await answer(f, f.assignment.sessionId, { requestId });
    assert.equal((await h.row(schema.missionWaits, again.id)).state, 'waiting', 'A retried old receipt cannot answer the new occurrence');
    assert.equal((await h.rows(schema.missionWaits, f.id)).filter(w => w.state === 'waiting').length, 1);
    assert.equal((await h.row(schema.missionWaits, f.wait.id)).state, 'answered');
  });
  await check('expired or declined task does not acquire a fresh wait deadline', async () => {
    for (const state of ['expired', 'cancelled']) {
      const f = await original();
      await db.update(schema.missionWaits).set({ state }).where(eq(schema.missionWaits.id, f.wait.id));
      await db.update(schema.missionTasks).set({ state: 'blocked' }).where(eq(schema.missionTasks.id, f.attempt.taskId));
      await assert.rejects(makeWait(f), error => error.statusCode === 400);
      assert.equal((await h.rows(schema.missionWaits, f.id)).length, 1);
    }
  });
} finally { await h.close(); }
console.log(JSON.stringify({ suite: 'mission-browser-return', passed: passed.length, failures }, null, 2));
if (failures.length) process.exitCode = 1;
