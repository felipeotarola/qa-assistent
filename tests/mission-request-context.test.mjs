import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { registerHooks } from 'node:module';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { browserUserInputMarker, browserInputMarker, stampUserRequest, bindMissionRequest,
  trustedRequestMessage, userTextHash, priorUserMessageIdsSchema } from '../shared/mission-request-context.ts';
import { createMessageReceivedEvent } from '../node_modules/eve/dist/src/protocol/message.js';

const owner = randomUUID(), threadId = randomUUID(), runtime = 'test:request-binding';
const identity = { userId: owner, threadId, sessionId: 'root-session', runtime, turnId: 'turn_2' };
const http = (message, path = '/eve/v1/session', method = 'POST') => new Request(`http://localhost${path}`, {
  method, ...(method === 'POST' ? { body: JSON.stringify({ message }) } : {}),
});
async function saved(message = 'Testa sidan och dess återväg.', changes = {}) {
  const scope = { ...identity, ...changes };
  const marker = await browserUserInputMarker(http(message));
  const event = { ...createMessageReceivedEvent({ message, sequence: 2, turnId: scope.turnId }),
    meta: { id: randomUUID(), at: '2026-10-07T00:00:02.000Z' } };
  event.data.userRequest = stampUserRequest(event, scope, { browserUserInput: marker });
  return { id: `${scope.sessionId}:${event.meta.id}`, sessionId: scope.sessionId, runtime: scope.runtime, event };
}
const context = row => ({ sessionId: row.sessionId, turnId: row.event.data.turnId, runtime: row.runtime,
  nonce: row.event.data.userRequest.nonce, priorUserMessageIds: [] });

test('HTTP string and multimodal text match actual installed Eve receipt; body remains readable', async () => {
  for (const message of [' Full\nuser text. ', [{ type: 'text', text: 'Första\nkravet' },
    { type: 'file', filename: 'not-a-goal.txt', mediaType: 'text/plain', data: 'Zml4dHVyZQ==' }, { type: 'text', text: 'Andra kravet' }]]) {
    const req = http(message), marker = await browserUserInputMarker(req);
    assert.deepEqual((await req.json()).message, message);
    const row = await saved(message);
    assert.ok(marker && row.event.data.userRequest);
    const result = bindMissionRequest([row], owner, threadId, context(row));
    assert.equal(result.goal, typeof message === 'string' ? message : 'Första\nkravet\nAndra kravet');
    assert.equal(result.source.current.textSha256, userTextHash(result.goal));
    assert.doesNotMatch(result.goal, /not-a-goal|fixture/);
  }
});

test('stream/reconnect/control/empty inputs mint no authority; HTTP retry does not alter saved turn binding', async () => {
  for (const [path, method] of [['/eve/v1/session/id/stream', 'GET'], ['/eve/v1/session/id', 'GET'],
    ['/eve/v1/session/id/cancel', 'POST'], ['/eve/v1/session/id/reset', 'POST']]) {
    assert.equal(await browserUserInputMarker(http('same', path, method)), '');
  }
  assert.equal(await browserUserInputMarker(new Request('http://localhost/eve/v1/session/id', { method: 'POST', body: JSON.stringify({ inputResponses: [{}] }) })), '');
  assert.equal(await browserUserInputMarker(http([{ type: 'file', mediaType: 'text/plain', data: 'x' }])), '');
  const row = await saved('same'), original = context(row);
  const retry = JSON.parse(await browserUserInputMarker(http('same')));
  assert.notEqual(retry.nonce, original.nonce);
  assert.equal(bindMissionRequest([row], owner, threadId, original).goal, 'same');
  assert.throws(() => bindMissionRequest([row], owner, threadId, { ...original, nonce: retry.nonce }));
});

test('notification/worker auth and text/turn substitution cannot stamp user authority', async () => {
  const row = await saved(), marker = JSON.stringify({ version: 1, nonce: randomUUID(), textSha256: userTextHash(row.event.data.message) });
  for (const flag of ['browserWorker', 'browserNotification', 'setupNotification', 'resultReviewNotification']) {
    assert.equal(browserInputMarker({ browserUserInput: marker, [flag]: 'true' }), null);
    assert.equal(stampUserRequest(row.event, identity, { browserUserInput: marker, [flag]: 'true' }), null);
  }
  assert.equal(stampUserRequest(row.event, { ...identity, turnId: 'turn_3' }, { browserUserInput: marker }), null);
  assert.equal(stampUserRequest(row.event, identity, { browserUserInput: JSON.stringify({ version: 1, nonce: randomUUID(), textSha256: '0'.repeat(64) }) }), null);
  assert.equal(browserInputMarker({ browserMessageId: randomUUID() }), null);
});

test('exact original and selected earlier full text survive; unrelated history is not selected', async () => {
  const original = await saved('Krav med "citat"\noch återväg.', { sessionId: 'old-root', runtime: 'old-runtime', turnId: 'turn_0' });
  original.event.data.sequence = 0; original.event.meta.at = '2026-10-07T00:00:00.000Z';
  const unrelated = await saved('Gör något helt annat.', { turnId: 'turn_1' }); unrelated.event.meta.at = '2026-10-07T00:00:01.000Z';
  const current = await saved('Testa enligt det tidigare kravet.');
  const result = bindMissionRequest([original, unrelated, current], owner, threadId, { ...context(current), priorUserMessageIds: [original.id] });
  assert.ok(result.goal.includes(original.event.data.message)); assert.ok(result.goal.endsWith(current.event.data.message));
  assert.doesNotMatch(result.goal, /helt annat/); assert.equal(result.source.prior[0].runtime, 'old-runtime');
  assert.equal(bindMissionRequest([original, current], owner, threadId, context(current)).goal, current.event.data.message);
});

test('foreign owners/threads/runtime, future references, unmarked legacy and ambiguous receipts fail closed', async () => {
  const row = await saved(), ctx = context(row);
  for (const [user, thread, patch] of [[randomUUID(), threadId, {}], [owner, randomUUID(), {}],
    [owner, threadId, { runtime: 'wrong-runtime' }], [owner, threadId, { turnId: 'wrong-turn' }], [owner, threadId, { sessionId: 'wrong-root' }]]) {
    assert.throws(() => bindMissionRequest([row], user, thread, { ...ctx, ...patch }));
  }
  const prior = await saved('Legacy'); delete prior.event.data.userRequest;
  assert.throws(() => bindMissionRequest([row, prior], owner, threadId, { ...ctx, priorUserMessageIds: [prior.id] }));
  const future = await saved('Future'); future.event.meta.at = '2026-10-07T00:00:03.000Z';
  assert.throws(() => bindMissionRequest([row, future], owner, threadId, { ...ctx, priorUserMessageIds: [future.id] }));
  assert.throws(() => bindMissionRequest([row, structuredClone(row)], owner, threadId, ctx));
  assert.equal(priorUserMessageIdsSchema.safeParse([row.id, row.id]).success, false);
  const changed = structuredClone(row); changed.event.data.parts[0].text = 'Substituted';
  assert.equal(trustedRequestMessage(changed, owner, threadId), null);
});

test('10000 exact characters allowed; larger current or combined text is rejected without truncation', async () => {
  const row = await saved('x'.repeat(10000)); assert.equal(bindMissionRequest([row], owner, threadId, context(row)).goal.length, 10000);
  const over = await saved('x'.repeat(10001)); assert.throws(() => bindMissionRequest([over], owner, threadId, context(over)));
  const prior = await saved('prior', { turnId: 'turn_1' }); prior.event.data.sequence = 1; prior.event.meta.at = '2026-10-07T00:00:01.000Z';
  assert.throws(() => bindMissionRequest([row, prior], owner, threadId, { ...context(row), priorUserMessageIds: [prior.id] }));
});

// The installed Eve tool definition is used; only post-success local state and
// internal transport are stubbed. No model, server, or external request runs.
const hooks = registerHooks({ resolve(specifier, ctx, next) {
  if (ctx.parentURL?.endsWith('/agent/channels/eve.ts') && specifier === '../../shared/supabase') {
    return { url: `data:text/javascript,export const createRequestSupabase=()=>({auth:{getUser:async()=>({data:{user:{id:${JSON.stringify(owner)},user_metadata:{}}}})}});`, shortCircuit: true };
  }
  if (ctx.parentURL?.endsWith('/agent/hooks/chat-history.ts') && specifier === 'eve/context') {
    return { url: 'data:text/javascript,export const defineState=(_key,init)=>{let state=init();return {get:()=>state,update:fn=>{state=fn(state);}}};', shortCircuit: true };
  }
  if (ctx.parentURL?.endsWith('/agent/tools/qa_mission.ts') && specifier === '../lib/codex-turn') {
    return { url: 'data:text/javascript,export const codexTurn={update:()=>{}};', shortCircuit: true };
  }
  if (specifier.startsWith('.') && ctx.parentURL?.startsWith('file:')) {
    const url = new URL(`${specifier}.ts`, ctx.parentURL);
    if (existsSync(fileURLToPath(url))) return { url: url.href, shortCircuit: true };
  }
  return next(specifier, ctx);
} });
const { default: tool } = await import('../agent/tools/qa_mission.ts');
const { default: channel } = await import('../agent/channels/eve.ts');
const { default: historyHook } = await import('../agent/hooks/chat-history.ts');
hooks.deregister();
test('installed Eve schema removes model goal and execute sends only code-owned current identity', async () => {
  const input = { intent: 'explore', target: { kind: 'public_url', url: 'https://example.test' } };
  assert.equal(tool.inputSchema.safeParse({ ...input, goal: 'model paraphrase' }).success, false);
  const native = z.toJSONSchema(tool.inputSchema, { io: 'input' });
  assert.equal(native.additionalProperties, false); assert.equal(native.properties.goal, undefined);
  assert.equal(native.properties.priorUserMessageIds.maxItems, 8);
  const parsed = tool.inputSchema.parse(input); assert.deepEqual(parsed.priorUserMessageIds, []);
  const row = await saved(), marker = row.event.data.userRequest;
  const ctx = { callId: 'call', session: { id: row.sessionId, turn: { id: row.event.data.turnId }, auth: { current: {
    authenticator: 'app', principalId: owner, attributes: { browserThreadId: threadId,
      browserUserInput: JSON.stringify({ version: 1, nonce: marker.nonce, textSha256: marker.textSha256 }) },
  } } } };
  const originalFetch = globalThis.fetch, oldOrigin = process.env.APP_URL, oldSecret = process.env.INTERNAL_API_SECRET; process.env.INTERNAL_API_SECRET = 'synthetic-request-test'; process.env.APP_URL = 'http://127.0.0.1:39999';
  let calls = 0;
  globalThis.fetch = async (_url, init) => {
    calls++; const body = JSON.parse(init.body); assert.equal(body.input.goal, undefined);
    assert.equal(body.requestContext.sessionId, row.sessionId); assert.equal(body.requestContext.turnId, ctx.session.turn.id);
    assert.equal(body.requestContext.nonce, marker.nonce); assert.deepEqual(body.requestContext.priorUserMessageIds, []);
    return Response.json({ missionId: 'synthetic' });
  };
  try {
    await tool.execute(parsed, ctx); assert.equal(calls, 1);
    for (const patch of [{ parent: {} }, { auth: { current: { ...ctx.session.auth.current, attributes: { browserThreadId: threadId } } } }]) {
      await assert.rejects(tool.execute(parsed, { ...ctx, session: { ...ctx.session, ...patch } }));
    }
    assert.equal(calls, 1);
  } finally { globalThis.fetch = originalFetch; if (oldSecret === undefined) delete process.env.INTERNAL_API_SECRET; else process.env.INTERNAL_API_SECRET = oldSecret; if (oldOrigin === undefined) delete process.env.APP_URL; else process.env.APP_URL = oldOrigin; }
});

test('actual Eve HTTP send route supplies body-bound auth without consuming or changing the message', async () => {
  const route = channel.routes.find(route => route.method === 'POST' && route.path === '/eve/v1/session/:sessionId');
  assert.ok(route);
  for (const message of ['Original wording', [{ type: 'text', text: 'First' }, { type: 'file', mediaType: 'text/plain', data: 'Zml4dHVyZQ==' }, { type: 'text', text: 'Second' }]]) {
    let sent;
    const response = await route.handler(http(message, '/eve/v1/session/root-session'), {
      params: { sessionId: 'root-session' }, attachSession: sessionId => ({ send: async (actual, options) => {
        sent = { sessionId, actual, options }; return { sessionId, status: 'accepted' };
      } }),
    });
    assert.equal(response.status, 202); assert.deepEqual(sent.actual, message);
    assert.equal(sent.options.auth.principalId, owner);
    const marker = browserInputMarker(sent.options.auth.attributes);
    assert.ok(marker); assert.equal(marker.textSha256, userTextHash(typeof message === 'string' ? message : 'First\nSecond'));
  }
});

test('archive boundary persists exact turn receipt before work and retains the same event on lost acknowledgement', async () => {
  const row = await saved(), originalFetch = globalThis.fetch, oldSecret = process.env.INTERNAL_API_SECRET;
  process.env.INTERNAL_API_SECRET = 'synthetic-request-test';
  const source = row.event.data.userRequest;
  const ctx = { session: { id: row.sessionId, turn: { id: row.event.data.turnId }, auth: { current: {
    authenticator: 'app', principalId: owner, attributes: { browserThreadId: threadId,
      browserUserInput: JSON.stringify({ version: 1, nonce: source.nonce, textSha256: source.textSha256 }) },
  } } } };
  const batches = [];
  globalThis.fetch = async (_url, init) => {
    batches.push(JSON.parse(init.body)); return Response.json({}, { status: batches.length === 1 ? 503 : 200 });
  };
  try {
    const event = structuredClone(row.event); delete event.data.userRequest;
    await historyHook.events['*']({ type: 'turn.started', data: { turnId: source.turnId, sequence: 2 }, meta: { id: randomUUID(), at: row.event.meta.at } }, ctx);
    assert.equal(batches.length, 0);
    await assert.rejects(historyHook.events['*'](event, ctx), /Could not save/);
    await historyHook.events['*'](event, ctx);
    assert.deepEqual(batches[0], batches[1]); assert.equal(batches[1].events.length, 2);
    assert.equal(batches[1].events[1].data.userRequest.nonce, source.nonce);
    assert.equal(batches[1].events[1].data.userRequest.textSha256, userTextHash(row.event.data.message));
  } finally { globalThis.fetch = originalFetch; if (oldSecret === undefined) delete process.env.INTERNAL_API_SECRET; else process.env.INTERNAL_API_SECRET = oldSecret; }
});
