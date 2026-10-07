import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { isolatedApp } from './helpers/isolated-app.mjs';
import { stampUserRequest, userTextHash } from '../shared/mission-request-context.ts';

// Root runs this only in the existing stopped, isolated PostgreSQL window.
// Inbound auth/event receipts are synthetic. No Eve/provider/controller starts.
assert.equal(process.env.GRUNDEN_API_TOKEN, '');
process.env.PAT_RUNTIME_SCOPE = `${process.env.PAT_RUNTIME_SCOPE}-request-${randomUUID()}`;
process.env.MISSIONS_ENABLED = 'true'; process.env.AUTONOMOUS_MISSIONS_ENABLED = 'true';
process.env.ENV_VAULT_KEY = `isolated-request-${randomUUID()}`;
const app = await isolatedApp(), { db, schema } = app;
const { saveChatEvents, resolveMissionRequest, priorRequestMessages } = await import('../server/utils/chat-history.ts');
const { acceptMission } = await import('../server/utils/mission-control.ts');
const owner = randomUUID(), otherOwner = randomUUID(), workspace = randomUUID(), thread = randomUUID();
const runtime = process.env.PAT_RUNTIME_SCOPE, sessionId = randomUUID(), oldSession = randomUUID();
const cases = [];
async function check(name, run) { await run(); cases.push(name); }
function receipt(text, sequence, overrides = {}) {
  const identity = { userId: owner, threadId: thread, sessionId, runtime, turnId: `turn_${sequence}`, ...overrides };
  const meta = { id: randomUUID(), at: new Date(Date.parse('2026-10-07T00:00:00Z') + sequence * 1000).toISOString() };
  const event = { type: 'message.received', meta, data: { message: text, parts: [{ type: 'text', text }], sequence, turnId: identity.turnId } };
  event.data.userRequest = stampUserRequest(event, identity, { browserUserInput: JSON.stringify({ version: 1, nonce: randomUUID(), textSha256: userTextHash(text) }) });
  const turn = { type: 'turn.started', meta: { ...meta, id: randomUUID() }, data: { sequence, turnId: identity.turnId } };
  return { identity, event, turn, context: { sessionId: identity.sessionId, runtime: identity.runtime, turnId: identity.turnId,
    nonce: event.data.userRequest.nonce, priorUserMessageIds: [] }, id: `${identity.sessionId}:${meta.id}` };
}
const persist = value => saveChatEvents(owner, thread, value.identity.sessionId, [value.turn, value.event], value.identity.runtime);
const originalText = 'Testa hjälpcentret. Öppna frågor, hantera saknad artikel och hitta tillbaka. Ändra inget.';
try {
  for (const id of [owner, otherOwner]) await db.insert(schema.user).values({ id, name: 'Request binding fixture', email: `${id}@example.test` });
  await db.insert(schema.workspaces).values({ id: workspace, userId: owner, name: 'Request binding fixture' });
  await db.insert(schema.threads).values({ id: thread, userId: owner, workspaceId: workspace, title: 'Request binding fixture' });
  const current = receipt(originalText, 2), prior = receipt('Krav från ett äldre runtime, inklusive återväg.', 1, { sessionId: oldSession, runtime: `${runtime}-old` });
  await persist(prior); await persist(current);

  await check('full original goal, immutable accepted source and idempotent admission', async () => {
    const bound = await resolveMissionRequest(owner, thread, current.context);
    assert.equal(bound.goal, originalText);
    const input = { requestId: randomUUID(), intent: 'explore', goal: bound.goal, target: { kind: 'public_url', url: 'https://example.test/help' } };
    const a = await acceptMission(owner, workspace, thread, input, bound.source);
    const b = await acceptMission(owner, workspace, thread, input, bound.source);
    assert.equal(a.id, b.id); assert.equal(a.admission.goal, originalText); assert.equal(a.config.goal, originalText);
    const events = await db.select().from(schema.missionEvents).where(eq(schema.missionEvents.missionId, a.id));
    assert.equal(events.length, 1); assert.deepEqual(events[0].payload.requestSource, bound.source);
    await assert.rejects(acceptMission(owner, workspace, thread, input, { ...bound.source, goalSha256: '0'.repeat(64) }), error => error.statusCode === 409);
    await persist(current); // Lost acknowledgement of the identical event is harmless.
    assert.deepEqual(await resolveMissionRequest(owner, thread, current.context), bound);
  });

  await check('earlier verified other-runtime text is optional context, current runtime remains exact', async () => {
    const bound = await resolveMissionRequest(owner, thread, { ...current.context, priorUserMessageIds: [prior.id] });
    assert.ok(bound.goal.includes(prior.event.data.message)); assert.ok(bound.goal.endsWith(originalText));
    assert.equal(bound.source.prior[0].runtime, prior.identity.runtime);
    const index = await priorRequestMessages(owner, thread, sessionId, runtime, current.context.turnId);
    assert.deepEqual(index.map(row => row.requestMessageId), [prior.id]);
    await assert.rejects(resolveMissionRequest(owner, thread, prior.context));
  });

  await check('foreign owner/thread/session/runtime and forged or unmarked references are rejected', async () => {
    await assert.rejects(resolveMissionRequest(otherOwner, thread, current.context));
    await assert.rejects(resolveMissionRequest(owner, randomUUID(), current.context));
    for (const patch of [{ sessionId: randomUUID() }, { runtime: `${runtime}-other` }, { turnId: 'turn_99' }, { nonce: randomUUID() }]) {
      await assert.rejects(resolveMissionRequest(owner, thread, { ...current.context, ...patch }));
    }
    const unmarked = receipt('Old archive is not new authority', 0, { sessionId: oldSession, runtime: prior.identity.runtime });
    delete unmarked.event.data.userRequest; await persist(unmarked);
    await assert.rejects(resolveMissionRequest(owner, thread, { ...current.context, priorUserMessageIds: [unmarked.id] }));
    await assert.rejects(resolveMissionRequest(owner, thread, { ...current.context, priorUserMessageIds: [randomUUID()] }));
  });

  await check('later turn invalidates an older admission, and future references cannot be selected', async () => {
    const next = receipt('New current message', 3); await persist(next);
    await assert.rejects(resolveMissionRequest(owner, thread, current.context));
    assert.equal((await resolveMissionRequest(owner, thread, next.context)).goal, next.event.data.message);
    const future = receipt('A future historical reference is invalid', 4, { sessionId: oldSession, runtime: prior.identity.runtime }); await persist(future);
    await assert.rejects(resolveMissionRequest(owner, thread, { ...next.context, priorUserMessageIds: [future.id] }));
  });

  await check('ambiguous registered root fails closed instead of trusting a thread header', async () => {
    const second = randomUUID(); await db.insert(schema.threads).values({ id: second, userId: owner, workspaceId: workspace, title: 'Synthetic duplicate root' });
    await db.insert(schema.chatRuntimes).values({ threadId: second, runtime, sessionId });
    try { await assert.rejects(priorRequestMessages(owner, thread, sessionId, runtime, 'turn_3')); }
    finally { await db.delete(schema.threads).where(eq(schema.threads.id, second)); }
  });

  await check('oversize current source remains saved intact but cannot admit a truncated goal', async () => {
    const large = receipt('x'.repeat(10001), 5); await persist(large);
    await assert.rejects(resolveMissionRequest(owner, thread, large.context));
    const [saved] = await db.select().from(schema.chatEvents).where(eq(schema.chatEvents.id, large.id));
    assert.equal(saved.event.data.message.length, 10001);
    const missions = await db.select().from(schema.missions).where(eq(schema.missions.workspaceId, workspace));
    assert.equal(missions.length, 1);
  });
  console.log(JSON.stringify({ status: 'passed', checks: cases.length, cases, database: 'actual isolated PostgreSQL',
    inboundReceipts: 'synthetic', providerCalls: 0, controllerCalls: 0, runtimeChanges: 0 }));
} finally {
  try { for (const id of [owner, otherOwner]) await db.delete(schema.user).where(eq(schema.user.id, id)); }
  finally { await app.close(); }
}
