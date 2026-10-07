import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright-core';
import { eq } from 'drizzle-orm';
import { isolatedApp } from './helpers/isolated-app.mjs';

// Actual isolated PostgreSQL, locks and service code. Only the browser provider
// and CDP connection are substituted; no browser pool or live model is touched.
process.env.PAT_RUNTIME_SCOPE += `-physical-binding-${randomUUID()}`;
process.env.AUTONOMOUS_MISSIONS_ENABLED = 'true'; process.env.MISSIONS_ENABLED = 'true';
const app = await isolatedApp(), { db, schema } = app;
const { saveItem } = await import('../server/utils/workspaces.ts');
const control = await import('../server/utils/mission-control.ts');
const attempts = await import('../server/utils/mission-attempts.ts');
const { testRunAction } = await import('../server/utils/test-runs.ts');
const { browserAction } = await import('../server/utils/browser.ts');
const { bindBrowserPhysicalSession, policyDigest } = await import('../server/utils/browser-mission-guard.ts');
const { withBrowserLock } = await import('../server/utils/browser-lock.ts');
const userId = randomUUID(), workspaceId = randomUUID(), threadId = randomUUID(), agentId = randomUUID(), physicalId = randomUUID();
const url = 'http://qa-fixture.test/', checks = [];
const originalFetch = globalThis.fetch, originalConnect = chromium.connectOverCDP;
let mission, task, attempt, policy, actor, assignment, claim, run, providerCreates = 0, cdpCalls = 0;
const fetches = [];
const readClaim = async () => (await db.select().from(schema.missionResourceClaims).where(eq(schema.missionResourceClaims.attemptId, attempt.id)))[0];
const readAttempt = async () => (await db.select().from(schema.missionAttempts).where(eq(schema.missionAttempts.id, attempt.id)))[0];
const bind = (overrides = {}) => bindBrowserPhysicalSession(overrides.userId ?? userId, overrides.workspaceId ?? workspaceId, overrides.threadId ?? threadId,
  overrides.agentId ?? agentId, overrides.actor ?? actor, overrides.execution ?? { attemptId: attempt.id, dispatchId: attempt.dispatchId }, overrides.physicalId ?? physicalId, overrides.policy ?? policy);
const locked = fn => withBrowserLock(`browser:${workspaceId}:${threadId}:${agentId}`, fn);
const denied = operation => assert.rejects(operation, error => [403, 404, 409].includes(error.statusCode));
async function rejectMutation(table, id, mutation, restore, name) {
  const before = await readClaim();
  await db.update(table).set(mutation).where(eq(table.id, id));
  try { await denied(locked(() => bind())); }
  finally { await db.update(table).set(restore).where(eq(table.id, id)); }
  assert.deepEqual(await readClaim(), before);
  checks.push(name);
}
try {
  globalThis.fetch = async (raw, options = {}) => {
    const request = new URL(raw); fetches.push({ path: request.pathname, method: options.method });
    assert.equal(request.origin, process.env.BROWSER_SERVICE_URL);
    if (request.pathname === '/sessions' && options.method === 'POST') {
      providerCreates++; policy = JSON.parse(options.body).policy;
      return Response.json({ sessionId: physicalId, policyVersion: 1, policyDigest: policyDigest(policy),
        connectUrl: 'http://127.0.0.1:1/synthetic-cdp', liveUrl: 'http://127.0.0.1:1/synthetic-view', expiresAt: policy.deadlineAt });
    }
    assert.equal(request.pathname, `/sessions/${physicalId}`); assert.equal(options.method, 'GET');
    return Response.json({ sessionId: physicalId, policyVersion: 1, policyDigest: policyDigest(policy) });
  };
  chromium.connectOverCDP = async () => {
    cdpCalls++; assert.equal((await readClaim()).executorResourceId, physicalId, 'Persist physical binding before any CDP command');
    throw new Error('Synthetic CDP boundary: no physical browser action');
  };
  await db.insert(schema.user).values({ id: userId, name: 'Physical binding', email: `${userId}@example.test` });
  await db.insert(schema.workspaces).values({ id: workspaceId, userId, name: 'Physical binding' });
  await db.insert(schema.threads).values({ id: threadId, workspaceId, userId, title: 'Physical binding' });
  const test = { id: randomUUID(), title: 'Inspect fixture', type: 'browser', preconditions: '', steps: 'Open the page', expected: 'Page observed', entryUrl: url };
  const plan = await saveItem(userId, workspaceId, { title: 'Physical binding', content: { kind: 'test_plan', sources: [], cases: [test] } });
  const caseKeys = [`${plan.id}:${test.id}`];
  mission = await control.acceptMission(userId, workspaceId, threadId, { requestId: randomUUID(), intent: 'verify', goal: 'Inspect the fixture website.', target: { kind: 'public_url', url }, caseKeys });
  task = await db.transaction(async tx => { await control.lockMission(tx, mission.id); return control.addMissionTask(tx, mission, { operationId: randomUUID(), title: 'Physical binding', spec: { kind: 'browser_tests', target: mission.config.target, caseKeys } }); });
  const lease = attempts.leaseIdentity(await attempts.claimMission(mission.id));
  attempt = (await attempts.reserveMissionAttempt(lease, task.id, { resource: { kind: 'browser', poolKey: `binding-${workspaceId}` } })).attempt;
  await attempts.markMissionDispatch(lease, attempt.id);
  await db.insert(schema.browserJobs).values({ id: attempt.dispatchId, threadId, runtime: process.env.PAT_RUNTIME_SCOPE, parentSessionId: randomUUID(), sessionId: agentId, task: 'Physical binding', status: 'running', model: 'fixture', reasoning: 'low' });
  actor = { browserJobId: attempt.dispatchId, executorSessionId: agentId, callId: randomUUID() };
  run = await testRunAction(userId, workspaceId, threadId, { action: 'start', requestId: randomUUID(), itemId: plan.id, caseId: test.id, expectedVersion: plan.version,
    environment: mission.config.target.environment, target: mission.config.target, mission: { missionId: mission.id, taskId: task.id } }, { execution: { attemptId: attempt.id, dispatchId: attempt.dispatchId } });
  assert.equal((await readClaim()).executorResourceId, null);
  const input = { action: 'open', url, runId: run.id };
  const result = await browserAction(userId, threadId, input, agentId, actor);
  assert.equal(result.status, 'action_failed'); assert.equal(providerCreates, 1); assert.equal(cdpCalls, 1);
  claim = await readClaim(); assert.equal(claim.executorResourceId, physicalId); assert.equal(claim.owner, 'agent'); assert.equal(claim.state, 'claimed');
  checks.push('First OPEN binds the provider-created physical session before CDP even when CDP fails; the reservation is retained');
  assignment = (await db.select().from(schema.browserAssignments).where(eq(schema.browserAssignments.sessionId, physicalId)))[0];
  const usage = await readAttempt();
  await locked(() => bind()); await locked(() => bind());
  assert.deepEqual(await readClaim(), claim); assert.equal((await readAttempt()).toolCalls, usage.toolCalls);
  const replay = await browserAction(userId, threadId, input, agentId, actor);
  assert.equal(replay.status, 'outcome_unknown'); assert.equal(providerCreates, 1); assert.equal(cdpCalls, 1);
  checks.push('Idempotent binding and operation replay neither change the receipt nor recharge or repeat the browser action');
  const beforeExpiry = fetches.length;
  await db.update(schema.browserAssignments).set({ expiresAt: new Date(0) }).where(eq(schema.browserAssignments.id, assignment.id));
  await denied(browserAction(userId, threadId, input, agentId, { ...actor, callId: randomUUID() }));
  await db.update(schema.browserAssignments).set({ expiresAt: assignment.expiresAt }).where(eq(schema.browserAssignments.id, assignment.id));
  assert.equal(fetches.length, beforeExpiry); assert.equal(providerCreates, 1); assert.equal(cdpCalls, 1);
  checks.push('An expired original session cannot trigger DELETE/POST replacement effects before the ID-change denial');
  await denied(bind()); checks.push('Binding requires an already-held browser lock');
  for (const changed of [{ userId: randomUUID() }, { workspaceId: randomUUID() }, { threadId: randomUUID() }, { agentId: randomUUID() }, { physicalId: randomUUID() },
    { actor: { ...actor, executorSessionId: randomUUID() } }, { execution: { attemptId: attempt.id, dispatchId: randomUUID() } }]) await denied(locked(() => bind(changed)));
  assert.deepEqual(await readClaim(), claim); checks.push('Other owner, workspace, thread, executor, dispatch and physical session cannot bind the claim');
  await rejectMutation(schema.browserJobs, attempt.dispatchId, { sessionId: randomUUID() }, { sessionId: agentId }, 'A different saved job session cannot adopt the claim');
  await rejectMutation(schema.browserJobs, attempt.dispatchId, { runtime: 'autonomy-test:other' }, { runtime: process.env.PAT_RUNTIME_SCOPE }, 'A different runtime cannot bind the claim');
  await rejectMutation(schema.browserAssignments, assignment.id, { control: 'human' }, { control: 'agent' }, 'Human control is never overwritten by a physical binding');
  await rejectMutation(schema.browserAssignments, assignment.id, { projectId: 'self-hosted-policy-v1:invalid' }, { projectId: assignment.projectId }, 'A stale provider policy receipt cannot be bound');
  const replacement = randomUUID(); await db.update(schema.browserAssignments).set({ sessionId: replacement }).where(eq(schema.browserAssignments.id, assignment.id));
  await denied(locked(() => bind({ physicalId: replacement }))); await db.update(schema.browserAssignments).set({ sessionId: physicalId }).where(eq(schema.browserAssignments.id, assignment.id));
  assert.deepEqual(await readClaim(), claim); checks.push('Even a saved replacement assignment cannot change a non-null physical claim ID');
  await rejectMutation(schema.missionAttempts, attempt.id, { mandateRevision: attempt.mandateRevision + 1 }, { mandateRevision: attempt.mandateRevision }, 'Old mandate epochs cannot bind');
  await rejectMutation(schema.missionAttempts, attempt.id, { planRevision: attempt.planRevision + 1 }, { planRevision: attempt.planRevision }, 'Old plan revisions cannot bind');
  await rejectMutation(schema.missionAttempts, attempt.id, { status: 'completed' }, { status: 'dispatching' }, 'Terminal attempts cannot bind');
  await rejectMutation(schema.missionAttempts, attempt.id, { cancelRequestedAt: new Date() }, { cancelRequestedAt: null }, 'Cancelled attempts cannot bind');
  await rejectMutation(schema.missionAttempts, attempt.id, { deadlineAt: new Date(0) }, { deadlineAt: attempt.deadlineAt }, 'Expired attempts cannot bind');
  await rejectMutation(schema.missions, mission.id, { lifecycle: 'paused' }, { lifecycle: 'running' }, 'Paused missions cannot bind');
  await rejectMutation(schema.missionResourceClaims, claim.id, { fence: claim.fence + 1 }, { fence: claim.fence }, 'A mismatched claim fence cannot bind');
  await rejectMutation(schema.missionResourceClaims, claim.id, { leaseToken: randomUUID() }, { leaseToken: claim.leaseToken }, 'A mismatched claim lease cannot bind');
  await rejectMutation(schema.missionResourceClaims, claim.id, { state: 'uncertain' }, { state: 'claimed' }, 'Uncertain cleanup is not silently converted into an active claim');

  // Interleave revocation after the caller acquired its browser lock but before
  // the binder gets the mission lock. No physical effect or ID is persisted.
  await db.update(schema.missionResourceClaims).set({ executorResourceId: null }).where(eq(schema.missionResourceClaims.id, claim.id));
  let entered, release; const reached = new Promise(done => { entered = done; }), proceed = new Promise(done => { release = done; });
  const revoke = db.transaction(async tx => {
    await control.lockMission(tx, mission.id); entered(); await proceed;
    await tx.update(schema.missions).set({ mandateRevision: mission.mandateRevision + 1 }).where(eq(schema.missions.id, mission.id));
  });
  await reached; const late = locked(() => bind()); const rejected = denied(late); release(); await revoke; await rejected;
  assert.equal((await readClaim()).executorResourceId, null); assert.equal(providerCreates, 1); assert.equal(cdpCalls, 1);
  checks.push('Concurrent mandate revocation wins before the physical binding commits; browser→mission lock order does not deadlock');
  console.log(JSON.stringify({ passed: checks.length, checks, database: 'actual isolated PostgreSQL', browser: 'synthetic provider/CDP boundaries; no physical browser or model', providerCreates, cdpCalls, fetches }, null, 2));
} finally {
  globalThis.fetch = originalFetch; chromium.connectOverCDP = originalConnect;
  await db.delete(schema.user).where(eq(schema.user.id, userId)); await app.close();
}
