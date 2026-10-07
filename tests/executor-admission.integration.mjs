import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createApp, createRouter, toNodeListener } from 'h3';
import { eq } from 'drizzle-orm';
import { isolatedApp } from './helpers/isolated-app.mjs';

// Real isolated PostgreSQL and authored HTTP callback. Linux effects and
// model calls are not executed by this admission boundary test.
process.env.PAT_RUNTIME_SCOPE += `-executor-${randomUUID()}`;
process.env.AUTONOMOUS_MISSIONS_ENABLED = 'true'; process.env.MISSIONS_ENABLED = 'true';
const h = await isolatedApp(), { db, schema } = h;
const control = await import('../server/utils/mission-control.ts');
const attempts = await import('../server/utils/mission-attempts.ts');
const { buildMissionExecution } = await import('../server/utils/mission-executor-admission.ts');
const owner = randomUUID(), workspace = randomUUID(), thread = randomUUID(), checks = [];
const row = async (table, id) => (await db.select().from(table).where(eq(table.id, id)))[0];
const router = createRouter().post('/api/internal/autonomy/executor/admit', (await import('../server/api/internal/autonomy/executor/admit.post.ts')).default);
const server = createServer(toNodeListener(createApp().use(router)));
server.listen(0, '127.0.0.1'); await once(server, 'listening');
const origin = `http://127.0.0.1:${server.address().port}`, originalFetch = globalThis.fetch;
globalThis.fetch = (url, options) => { assert.ok(String(url).startsWith(`${origin}/`)); return originalFetch(url, options); };
async function api(input, status = 200, authorized = true) {
  const response = await fetch(`${origin}/api/internal/autonomy/executor/admit`, { method: 'POST', headers: { 'content-type': 'application/json', ...(authorized ? { authorization: `Bearer ${process.env.INTERNAL_API_SECRET}` } : {}) }, body: JSON.stringify(input) });
  const value = await response.json(); assert.equal(response.status, status, value.statusMessage);
  if (status === 200) { assert.equal(response.headers.get('cache-control'), 'no-store'); assert.equal(value.allowed, true); }
  return value;
}
try {
  await db.insert(schema.user).values({ id: owner, name: 'Executor boundary', email: `${owner}@example.test` });
  await db.insert(schema.workspaces).values({ id: workspace, userId: owner, name: 'Executor boundary' });
  await db.insert(schema.threads).values({ id: thread, workspaceId: workspace, userId: owner, title: 'Executor boundary' });
  const mission = await control.acceptMission(owner, workspace, thread, { requestId: randomUUID(), intent: 'explore', goal: 'Inspect repository and report verified checks', target: { kind: 'repository', url: 'https://github.com/fixture/example', ref: 'main' } });
  const [task] = await db.select().from(schema.missionTasks).where(eq(schema.missionTasks.missionId, mission.id));
  const claimed = await attempts.claimMission(mission.id), lease = attempts.leaseIdentity(claimed);
  const reservation = await attempts.reserveMissionAttempt(lease, task.id, { resource: { kind: 'otto', poolKey: `synthetic-pool:${mission.id}` } });
  assert.equal(reservation.status, 'reserved');
  const attempt = await attempts.markMissionDispatch(lease, reservation.attempt.id);
  await db.update(schema.missionAttempts).set({ executorResourceId: attempt.dispatchId }).where(eq(schema.missionAttempts.id, attempt.id));
  await db.update(schema.missionResourceClaims).set({ executorResourceId: attempt.dispatchId }).where(eq(schema.missionResourceClaims.attemptId, attempt.id));
  const input = { execution: buildMissionExecution(claimed, attempt), resourceId: attempt.dispatchId, operationId: 'repo:inspect', kind: 'repository.inspect', payloadHash: 'a'.repeat(64) };
  const receipt = await api(input);
  assert.equal(receipt.attemptId, attempt.id); assert.equal(receipt.resourceId, input.resourceId);
  assert.ok(Date.parse(receipt.validUntil) <= Date.now() + 5_000);
  assert.equal((await row(schema.missionAttempts, attempt.id)).toolCalls, 1);
  checks.push('exact live owner/runtime/task/attempt/resource binding admits a bounded HTTP receipt');
  await api(input); assert.equal((await row(schema.missionAttempts, attempt.id)).toolCalls, 1);
  await api({ ...input, payloadHash: 'b'.repeat(64) }, 409);
  await api({ ...input, kind: 'repository.command' }, 409);
  checks.push('exact retry rechecks authority without double charging; changed payload or operation kind denied');
  await api(input, 401, false); await api({ ...input, userId: owner }, 400);
  checks.push('public callers and extra authority fields denied at the HTTP boundary');
  for (const key of ['runtime', 'missionId', 'taskId', 'attemptId', 'dispatchId', 'mandateRevision', 'planRevision', 'requestHash', 'deadlineAt']) {
    const forged = structuredClone(input);
    forged.execution[key] = key === 'runtime' ? 'foreign-runtime' : key.endsWith('Revision') ? 2 : key === 'requestHash' ? 'f'.repeat(64) : key === 'deadlineAt' ? new Date(Date.now() + 86400000).toISOString() : randomUUID();
    await api(forged, 409);
  }
  await api({ ...input, resourceId: randomUUID() }, 409);
  await api({ ...input, operationId: 'invalid:kind', kind: 'codex.turn' }, 403);
  checks.push('forged identity, epoch, hash, resource, deadline extension and executor kind are rejected');
  await db.update(schema.missionAttempts).set({ reservedToolCalls: 1 }).where(eq(schema.missionAttempts.id, attempt.id));
  await api({ ...input, operationId: 'repo:second' }, 409); await api(input);
  checks.push('exhausted budget denies new effects while allowing the exact current receipt replay');
  await db.update(schema.missionResourceClaims).set({ state: 'uncertain' }).where(eq(schema.missionResourceClaims.attemptId, attempt.id));
  await api(input, 409);
  await db.update(schema.missionResourceClaims).set({ state: 'claimed' }).where(eq(schema.missionResourceClaims.attemptId, attempt.id));
  checks.push('uncertain cleanup/resource ownership never authorizes another effect');
  process.env.AUTONOMOUS_MISSIONS_ENABLED = 'false'; await api(input, 409); process.env.AUTONOMOUS_MISSIONS_ENABLED = 'true';
  await control.controlMission(owner, workspace, thread, { action: 'pause', missionId: mission.id, requestId: randomUUID(), expectedMandateRevision: mission.mandateRevision });
  await api(input, 409);
  checks.push('feature disable and explicit pause revoke cached/replayed executor admission');
} finally {
  globalThis.fetch = originalFetch; await new Promise(resolve => server.close(resolve));
  await db.delete(schema.user).where(eq(schema.user.id, owner)); await h.close();
}
console.log(JSON.stringify({ passed: checks.length, checks }));
