import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createApp, toNodeListener } from 'h3';
import { eq } from 'drizzle-orm';
import { isolatedApp } from './helpers/isolated-app.mjs';

// Actual PostgreSQL, route, ownership and budget checks. No model is involved.
process.env.PAT_RUNTIME_SCOPE += `-iris-workspace-${randomUUID()}`;
process.env.AUTONOMOUS_MISSIONS_ENABLED = 'true'; process.env.MISSIONS_ENABLED = 'true';
process.env.INTERNAL_API_SECRET = 'isolated-iris-workspace';
const app = await isolatedApp(), { db, schema } = app;
const { saveItem } = await import('../server/utils/workspaces.ts');
const control = await import('../server/utils/mission-control.ts');
const attempts = await import('../server/utils/mission-attempts.ts');
const handler = (await import('../server/api/internal/workspace.post.ts')).default;
const server = createServer(toNodeListener(createApp().use('/api/internal/workspace', handler)));
server.listen(0, '127.0.0.1'); await once(server, 'listening');
const userId = randomUUID(), otherUser = randomUUID(), workspaceId = randomUUID(), otherWorkspace = randomUUID(), threadId = randomUUID(), sessionId = randomUUID();
let attempt, mission, plan;
const checks = [];
async function request(input, trusted = {}, authenticated = true) {
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/internal/workspace`, { method: 'POST', headers: { 'content-type': 'application/json', ...(authenticated ? { authorization: `Bearer ${process.env.INTERNAL_API_SECRET}` } : {}) }, body: JSON.stringify({ userId, threadId, agentId: sessionId, browserJobId: attempt.dispatchId, executorSessionId: sessionId, callId: randomUUID(), input, ...trusted }) });
  return { status: response.status, body: await response.json() };
}
try {
  await db.insert(schema.user).values([{ id: userId, name: 'Iris workspace', email: `${userId}@example.test` }, { id: otherUser, name: 'Other user', email: `${otherUser}@example.test` }]);
  await db.insert(schema.workspaces).values([{ id: workspaceId, userId, name: 'Iris workspace' }, { id: otherWorkspace, userId: otherUser, name: 'Other workspace' }]);
  await db.insert(schema.threads).values({ id: threadId, workspaceId, userId, title: 'Iris scope' });
  const makeCase = title => ({ id: randomUUID(), title, type: 'browser', preconditions: '', steps: 'Read the public homepage', expected: 'The heading is visible' });
  const selected = makeCase('Selected'), excluded = makeCase('Not selected');
  plan = await saveItem(userId, workspaceId, { title: 'Frozen plan', content: { kind: 'test_plan', sources: [], cases: [selected, excluded] } });
  const unrelated = await saveItem(userId, workspaceId, { title: 'Private unrelated note', content: { kind: 'document', text: 'Do not expose this unrelated text.' } });
  const foreign = await saveItem(otherUser, otherWorkspace, { title: 'Other user plan', content: { kind: 'test_plan', sources: [], cases: [selected] } });
  const caseKey = `${plan.id}:${selected.id}`;
  mission = await control.acceptMission(userId, workspaceId, threadId, { requestId: randomUUID(), intent: 'verify', goal: 'Read one frozen plan', target: { kind: 'public_url', url: 'https://example.com' }, caseKeys: [caseKey] });
  const task = await db.transaction(async tx => { await control.lockMission(tx, mission.id); return control.addMissionTask(tx, mission, { operationId: randomUUID(), title: 'Read frozen case', spec: { kind: 'browser_tests', target: mission.config.target, caseKeys: [caseKey], planVersions: [{ itemId: plan.id, version: plan.version }] } }); });
  const lease = attempts.leaseIdentity(await attempts.claimMission(mission.id));
  const reservation = await attempts.reserveMissionAttempt(lease, task.id, { resource: { kind: 'browser', poolKey: `workspace-read-${workspaceId}` } }); assert.equal(reservation.status, 'reserved'); attempt = reservation.attempt;
  await attempts.markMissionDispatch(lease, attempt.id);
  await db.insert(schema.browserJobs).values({ id: attempt.dispatchId, threadId, runtime: process.env.PAT_RUNTIME_SCOPE, parentSessionId: randomUUID(), sessionId, task: 'Read frozen case', status: 'running', model: 'fixture', reasoning: 'low' });
  const read = { action: 'read', itemId: plan.id };
  let result = await request(read); assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.item.version, plan.version); assert.equal(result.body.historical, true); assert.equal(result.body.selectionOnly, true);
  assert.deepEqual(result.body.item.content.cases.map(value => value.id), [selected.id]);
  assert.deepEqual(Object.keys(result.body.item).sort(), ['content', 'id', 'title', 'version']);
  checks.push('Assigned immutable plan version is derived server-side and restricted to selected cases without unrelated item metadata');

  await saveItem(userId, workspaceId, { id: plan.id, expectedVersion: plan.version, title: 'Changed after dispatch', content: { ...plan.content, cases: [{ ...selected, title: 'New requirement' }, excluded] } });
  result = await request(read); assert.equal(result.status, 200); assert.equal(result.body.item.title, 'Frozen plan'); assert.equal(result.body.item.content.cases[0].title, 'Selected');
  assert.equal((await request({ ...read, version: 2 })).status, 403);
  checks.push('Later plan edits cannot replace the frozen requirements; requested newer versions are denied');

  for (const action of ['list', 'evidence', 'create', 'update', 'save_file', 'screenshot', 'link']) assert.equal((await request({ action, itemId: plan.id })).status, 403, action);
  assert.equal((await request({ action: 'read', itemId: unrelated.id })).status, 403);
  assert.equal((await request({ action: 'read', itemId: foreign.id })).status, 403);
  checks.push('All autonomous writes, workspace enumeration and unrelated or cross-workspace reads are denied');

  for (const trusted of [{ executorSessionId: randomUUID() }, { executorSessionId: undefined }, { agentId: 'main' }, { browserJobId: randomUUID() }, { callId: undefined }]) assert.equal((await request(read, trusted)).status, 403, JSON.stringify(trusted));
  await db.update(schema.browserJobs).set({ sessionId: null }).where(eq(schema.browserJobs.id, attempt.dispatchId));
  assert.equal((await request(read)).status, 403);
  await db.update(schema.browserJobs).set({ sessionId }).where(eq(schema.browserJobs.id, attempt.dispatchId));
  assert.equal((await request(read, {}, false)).status, 401);
  assert.equal((await request(read, { userId: otherUser })).status, 404);
  checks.push('Exact authenticated Iris session is required even when started-handler binding failed; missing API auth and other users fail');

  const callId = randomUUID();
  const [before] = await db.select().from(schema.missionAttempts).where(eq(schema.missionAttempts.id, attempt.id));
  assert.equal((await request(read, { callId })).status, 200); assert.equal((await request(read, { callId })).status, 200);
  const [after] = await db.select().from(schema.missionAttempts).where(eq(schema.missionAttempts.id, attempt.id)); assert.equal(after.toolCalls, before.toolCalls + 1);
  assert.equal((await request({ ...read, version: 1 }, { callId })).status, 409);
  checks.push('Read replay is safe and budgeted once; changed call input cannot reuse the receipt');

  await control.controlMission(userId, workspaceId, threadId, { action: 'pause', missionId: mission.id, requestId: randomUUID(), expectedMandateRevision: mission.mandateRevision });
  assert.equal((await request(read)).status, 409);
  checks.push('A paused mission cannot retrieve additional material');

  const legacyId = randomUUID(); await db.insert(schema.browserJobs).values({ id: legacyId, threadId, runtime: process.env.PAT_RUNTIME_SCOPE, parentSessionId: randomUUID(), sessionId, task: 'Legacy read', status: 'running', model: 'fixture', reasoning: 'low' });
  assert.equal((await request({ action: 'read', itemId: unrelated.id }, { browserJobId: legacyId })).status, 200);
  assert.equal((await request({ action: 'update', itemId: plan.id }, { browserJobId: legacyId })).status, 403);
  assert.equal((await request({ action: 'read', itemId: unrelated.id }, { browserJobId: undefined, executorSessionId: undefined, callId: undefined, agentId: 'main' })).status, 200);
  checks.push('Legacy Iris retains read compatibility but no writes; ordinary main-agent reads remain available');
  console.log(JSON.stringify({ status: 'passed', checks, database: 'actual isolated PostgreSQL', endpoint: 'actual authenticated internal H3 route', auth: 'synthetic executor context', model: false }));
} finally {
  await new Promise(resolve => server.close(resolve));
  await db.delete(schema.user).where(eq(schema.user.id, userId)); await db.delete(schema.user).where(eq(schema.user.id, otherUser));
  await app.close();
}
