import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { registerHooks } from 'node:module';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createApp, createRouter, toNodeListener } from 'h3';
import { eq, sql } from 'drizzle-orm';
import { isolatedApp } from './helpers/isolated-app.mjs';

// Real PostgreSQL + authored H3 callback and authored channel handlers. Eve's
// durable session surface is deterministic here; no real model/browser runs.
process.env.PAT_RUNTIME_SCOPE = `${process.env.PAT_RUNTIME_SCOPE}-iris-${randomUUID()}`;
process.env.MISSIONS_ENABLED = 'true'; process.env.AUTONOMOUS_MISSIONS_ENABLED = 'true';
const app = await isolatedApp(), { db, schema } = app;
let providerCalls = 0;
globalThis.irisFixtureSelection = () => ({ model: { specificationVersion: 'v4', provider: 'fixture', modelId: 'iris', doGenerate: async () => { providerCalls++; return { content: [], warnings: [], finishReason: { unified: 'stop', raw: 'stop' }, usage: { inputTokens: { total: 5 }, outputTokens: { total: 2 }, raw: { prompt_tokens: 5, completion_tokens: 2 } } }; }, doStream: async () => { providerCalls++; return {}; } }, modelContextWindowTokens: 1000 });
const definitionHook = registerHooks({ resolve(specifier, context, next) {
  if (specifier.startsWith('#shared/') && /[/\\]eve[/\\]dist[/\\]/.test(context.parentURL ?? '')) return { url: new URL(`../node_modules/eve/dist/src/shared/${specifier.slice(8)}`, import.meta.url).href, shortCircuit: true };
  if (specifier === 'eve/channels') return { url: 'data:text/javascript,export const defineChannel = value => value; export const POST = (path,handler) => ({path,handler});', shortCircuit: true };
  if (specifier === './lib/grunden' && context.parentURL?.endsWith('/agent/agent.ts')) return { url: 'data:text/javascript,export const grundenModelSelection = (...args) => globalThis.irisFixtureSelection(...args);', shortCircuit: true };
  return next(specifier, context);
} });
const channel = (await import('../agent/channels/iris.ts')).default;
const authoredAgent = (await import('../agent/agent.ts')).default;
const { callAdapterEventHandler } = await import('../node_modules/eve/dist/src/channel/adapter.js');
const { ContextContainer, contextStorage } = await import('../node_modules/eve/dist/src/context/container.js');
const { AuthKey, InitiatorAuthKey, SessionIdKey } = await import('../node_modules/eve/dist/src/context/keys.js');
const { ChannelKey } = await import('../node_modules/eve/dist/src/runtime/sessions/runtime-context-keys.js');
const { dispatchDynamicModelEvent, getActiveDynamicModelSelection } = await import('../node_modules/eve/dist/src/context/dynamic-model-lifecycle.js');
const route = channel.routes.find(value => value.path === '/eve/v1/workers/iris');
const { browserJobAction, recordBrowserJobEvent, listBrowserJobs } = await import('../server/utils/browser-jobs.ts');
const control = await import('../server/utils/mission-control.ts'), attempts = await import('../server/utils/mission-attempts.ts');
const { saveItem } = await import('../server/utils/workspaces.ts');
const { readIrisSnapshot } = await import('../shared/browser-job.ts');
const router = createRouter(); router.post('/api/internal/browser-job-event', (await import('../server/api/internal/browser-job-event.post.ts')).default);
const server = createServer(toNodeListener(createApp().use(router))); server.listen(0, '127.0.0.1'); await once(server, 'listening');
const origin = `http://127.0.0.1:${server.address().port}`; process.env.APP_URL = origin;
const originalFetch = globalThis.fetch, owner = randomUUID(), runtime = process.env.PAT_RUNTIME_SCOPE;
const sessions = new Map(), scenarios = new Map(), sends = new Map(); let notifications = 0, cancels = 0, callbackFailures = 0;
const passed = [], failures = [];
const row = async (table, id) => (await db.select().from(table).where(eq(table.id, id)))[0];
const rejected = (promise, status = 409) => assert.rejects(promise, error => error.statusCode === status);
const invoke = (f, action = 'start', extra = {}) => browserJobAction(owner, f.thread, { action, jobId: f.attempt.dispatchId, ...(action === 'start' ? { task: 'Kontrollera det valda testfallet.', mission: { missionId: f.mission.id, taskId: f.task.id } } : {}), ...extra });
async function check(name, fn) { try { await fn(); passed.push(name); } catch (error) { failures.push({ name, message: error.message, stack: error.stack }); console.error(`FAILED ${name}: ${error.message}`); } }
function sessionHandle(value) { return {
  id: value.id, getStreamTailIndex: async () => value.events.length - 1,
  getEventStream: async ({ startIndex }) => new ReadableStream({ start(controller) { for (const event of value.events.slice(startIndex)) controller.enqueue(event); controller.close(); } }),
  cancel: async () => { cancels++; return { status: 'accepted', sessionId: value.id }; },
}; }
const surfaces = {
  resolveSession: async jobId => sessions.has(jobId) ? sessionHandle(sessions.get(jobId)) : undefined,
  from: jobId => ({ send: async (_task, options) => {
    sends.set(jobId, (sends.get(jobId) ?? 0) + 1);
    if (scenarios.get(jobId) === 'die-after-admission') throw new Error('Synthetic worker died before session creation');
    const value = { id: randomUUID(), events: [{ type: 'turn.started', data: { sequence: 0, turnId: randomUUID() } }], state: structuredClone(channel.state), auth: options.auth };
    sessions.set(jobId, value);
    await channel.events['turn.started'](value.events[0].data, { state: value.state }, { session: { id: value.id, auth: { current: options.auth } } });
    assert.equal((await row(schema.browserJobs, jobId)).sessionId, value.id, 'Session must bind before first tool');
    return sessionHandle(value);
  } }),
};
globalThis.fetch = async (url, options) => {
  assert.ok(String(url).startsWith(origin), 'No external requests in lifecycle fixtures');
  if (String(url).endsWith('/eve/v1/workers/iris/notify')) { notifications++; return Response.json({ ok: true }); }
  if (String(url).endsWith('/eve/v1/workers/iris')) {
    const body = JSON.parse(options.body), scenario = scenarios.get(body.jobId);
    // A separate SQL transaction can acquire the job lock during HTTP.
    await db.transaction(async tx => { const [lock] = await tx.execute(sql`select pg_try_advisory_xact_lock(hashtextextended(${`iris-job:${body.jobId}`}, 0)) as ok`); assert.equal(lock.ok, true); });
    if (scenario === 'die-before-admission' && body.action === 'start') throw new Error('Synthetic request never reached worker');
    const response = await route.handler(new Request(url, options), surfaces);
    if (scenario === 'lost-http-reply' && body.action === 'start') throw new Error('Synthetic lost reply');
    return response;
  }
  if (String(url).endsWith('/api/internal/browser-job-event') && callbackFailures) { callbackFailures--; return new Response('Synthetic callback unavailable', { status: 503 }); }
  return originalFetch(url, options);
};
async function fixture() {
  const workspace = randomUUID(), thread = randomUUID(), caseId = randomUUID();
  await db.insert(schema.workspaces).values({ id: workspace, userId: owner, name: 'Iris fixture' });
  await db.insert(schema.threads).values({ id: thread, userId: owner, workspaceId: workspace, title: 'Iris fixture' });
  const plan = await saveItem(owner, workspace, { title: 'Iris plan', content: { kind: 'test_plan', sources: [], cases: [{ id: caseId, title: 'Startsida', type: 'browser', preconditions: '', steps: 'Öppna sidan', expected: 'Rubrik synlig' }] } });
  const caseKeys = [`${plan.id}:${caseId}`], target = { kind: 'public_url', url: 'https://iris.example.test/' };
  const mission = await control.acceptMission(owner, workspace, thread, { requestId: randomUUID(), intent: 'explore', goal: 'Kontrollera sidan', target, caseKeys });
  const task = await db.transaction(async tx => { await control.lockMission(tx, mission.id); return control.addMissionTask(tx, mission, { operationId: randomUUID(), title: 'Iris task', spec: { kind: 'browser_tests', caseKeys, target: mission.config.target } }); });
  const claimed = await attempts.claimMission(mission.id), lease = attempts.leaseIdentity(claimed);
  const reserved = await attempts.reserveMissionAttempt(lease, task.id, { resource: { kind: 'browser', poolKey: `iris-fixture:${randomUUID()}` } });
  assert.equal(reserved.status, 'reserved');
  return { workspace, thread, mission, task, lease, attempt: await attempts.markMissionDispatch(lease, reserved.attempt.id) };
}
async function settle(f, status = 'completed', callbacks = true) {
  const value = sessions.get(f.attempt.dispatchId), channelContext = { state: value.state };
  value.events.push({ type: 'message.completed', data: { message: 'Saved synthetic observations.' } });
  if (callbacks) await channel.events['message.completed'](value.events.at(-1).data, channelContext);
  const type = `turn.${status}`; value.events.push({ type, data: { sequence: 0, turnId: 'fixture-turn', message: 'Synthetic failure' } });
  if (callbacks) await channel.events[type](value.events.at(-1).data, channelContext);
  value.events.push({ type: 'session.waiting', data: { wait: 'next-user-message' } });
  if (callbacks) await channel.events['session.waiting'](value.events.at(-1).data, channelContext);
}
async function modelStep(session, { sequence = 0, stepIndex = 0, auth = session.auth, initial = session.auth, kind = 'channel:iris' } = {}) {
  const ctx = new ContextContainer(); ctx.set(AuthKey, auth); ctx.set(InitiatorAuthKey, initial); ctx.set(SessionIdKey, session.id); ctx.set(ChannelKey, { kind });
  return contextStorage.run(ctx, async () => {
    const priorNodeEnv = process.env.NODE_ENV, priorMock = process.env.EVE_MOCK_AUTHORED_MODELS;
    // Exercise the installed real-selection branch, with our local deterministic
    // provider above; Eve's NODE_ENV=test shortcut strips provider instances.
    process.env.NODE_ENV = 'development'; delete process.env.EVE_MOCK_AUTHORED_MODELS;
    try {
      await dispatchDynamicModelEvent({ ctx, event: { type: 'step.started', data: { sequence, turnId: 'turn_0', stepIndex } }, messages: [],
        dynamicModel: { sourceKind: 'module', sourceId: 'iris-agent', logicalPath: 'agent/agent.ts', eventNames: ['step.started'] },
        scope: { moduleMap: { nodes: { __root__: { modules: { 'iris-agent': { default: authoredAgent } } } } } },
      });
    } catch (error) { assert.equal(getActiveDynamicModelSelection(ctx), null); throw error; }
    finally { if (priorNodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = priorNodeEnv; if (priorMock === undefined) delete process.env.EVE_MOCK_AUTHORED_MODELS; else process.env.EVE_MOCK_AUTHORED_MODELS = priorMock; }
    const selected = getActiveDynamicModelSelection(ctx); assert.ok(selected?.model); await selected.model.doGenerate({});
  });
}
try {
  await db.insert(schema.user).values({ id: owner, name: 'Iris lifecycle fixture', email: `${owner}@example.test` });
  await check('parallel starts admit one source.send and bind session before tools', async () => {
    const f = await fixture(), [a, b] = await Promise.all([invoke(f), invoke(f)]); assert.equal(a.id, b.id); assert.equal(sends.get(a.id), 1);
    const current = await row(schema.browserJobs, a.id); assert.equal(current.status, 'running'); assert.ok(current.sessionId);
    assert.ok(!('dispatchLeaseToken' in a)); assert.ok(!('dispatchLeaseUntil' in a));
    assert.equal((await invoke(f)).sessionId, current.sessionId); assert.equal(sends.get(a.id), 1);
    await rejected(invoke(f, 'start', { task: 'Different task' }));
  });
  await check('status catches up from durable terminal events after lost callback without a new turn', async () => {
    const f = await fixture(); await invoke(f); await settle(f, 'completed', false);
    assert.equal((await row(schema.browserJobs, f.attempt.dispatchId)).status, 'running');
    const result = await invoke(f, 'status'); assert.equal(result.status, 'completed'); assert.equal(result.report, 'Saved synthetic observations.');
    assert.equal(sends.get(result.id), 1); assert.equal(notifications, 0);
    assert.equal((await invoke(f)).status, 'completed'); assert.equal(sends.get(result.id), 1);
  });
  await check('cancel acceptance stays nonterminal until actual cancelled plus waiting events', async () => {
    const f = await fixture(); await invoke(f); const before = cancels;
    assert.equal((await invoke(f, 'cancel')).status, 'cancelling'); assert.equal(cancels, before + 1);
    const value = sessions.get(f.attempt.dispatchId); value.events.push({ type: 'turn.cancelled', data: {} });
    assert.equal((await invoke(f, 'status')).status, 'cancelling');
    value.events.push({ type: 'session.waiting', data: {} }); assert.equal((await invoke(f, 'status')).status, 'cancelled');
  });
  await check('missing HTTP reply recovers the same durable session', async () => {
    const f = await fixture(); scenarios.set(f.attempt.dispatchId, 'lost-http-reply');
    const result = await invoke(f); assert.equal(result.status, 'running'); assert.equal(sends.get(result.id), 1);
    await db.update(schema.missionAttempts).set({ status: 'dispatch_unknown' }).where(eq(schema.missionAttempts.id, f.attempt.id));
    await modelStep(sessions.get(result.id));
    scenarios.delete(result.id); assert.equal((await invoke(f, 'status')).sessionId, result.sessionId); assert.equal(sends.get(result.id), 1);
  });
  await check('crash before channel admission retries only same ID after lease expiry', async () => {
    const f = await fixture(); scenarios.set(f.attempt.dispatchId, 'die-before-admission');
    assert.equal((await invoke(f)).status, 'dispatch_unknown'); assert.equal(sends.get(f.attempt.dispatchId), undefined);
    const pending = await row(schema.browserJobs, f.attempt.dispatchId), oldToken = pending.dispatchLeaseToken;
    scenarios.delete(pending.id); await db.update(schema.browserJobs).set({ dispatchLeaseUntil: new Date(0) }).where(eq(schema.browserJobs.id, pending.id));
    assert.equal((await invoke(f, 'status')).retryableDispatch, true); assert.equal(sends.get(pending.id), undefined);
    assert.equal((await invoke(f)).status, 'running'); assert.equal(sends.get(pending.id), 1);
    const late = await recordBrowserJobEvent({ kind: 'dispatch', jobId: pending.id, userId: owner, threadId: f.thread, dispatchLeaseToken: oldToken }); assert.equal(late.allowed, false);
  });
  await check('unknown channel admission never blindly sends twice even without an Eve session', async () => {
    const f = await fixture(); scenarios.set(f.attempt.dispatchId, 'die-after-admission'); const first = await invoke(f);
    assert.equal(first.status, 'dispatch_unknown'); assert.equal(first.retryableDispatch, false); assert.equal(sends.get(first.id), 1);
    scenarios.delete(first.id); await db.update(schema.browserJobs).set({ dispatchLeaseUntil: new Date(0) }).where(eq(schema.browserJobs.id, first.id));
    assert.equal((await invoke(f)).status, 'dispatch_unknown'); assert.equal(sends.get(first.id), 1);
    assert.equal((await invoke(f, 'cancel')).status, 'cancelling');
  });
  await check('cancel before admission proves no-start and rejects the late HTTP token', async () => {
    const f = await fixture(); scenarios.set(f.attempt.dispatchId, 'die-before-admission'); await invoke(f);
    const before = await row(schema.browserJobs, f.attempt.dispatchId); assert.equal((await invoke(f, 'cancel')).status, 'cancelled');
    const late = await recordBrowserJobEvent({ kind: 'dispatch', jobId: before.id, userId: owner, threadId: f.thread, dispatchLeaseToken: before.dispatchLeaseToken }); assert.equal(late.allowed, false); assert.equal(sends.get(before.id), undefined);
  });
  await check('pausing after dispatch reservation revokes channel admission and session startup', async () => {
    const f = await fixture(); scenarios.set(f.attempt.dispatchId, 'die-before-admission'); await invoke(f);
    const before = await row(schema.browserJobs, f.attempt.dispatchId);
    await control.controlMission(owner, f.workspace, f.thread, { action: 'pause', requestId: randomUUID(), missionId: f.mission.id, expectedMandateRevision: 1 });
    assert.equal((await recordBrowserJobEvent({ kind: 'dispatch', jobId: before.id, userId: owner, threadId: f.thread, dispatchLeaseToken: before.dispatchLeaseToken })).allowed, false);
    await rejected(recordBrowserJobEvent({ kind: 'started', jobId: before.id, userId: owner, threadId: f.thread, sessionId: randomUUID() }));
    assert.equal(sends.get(before.id), undefined);
  });
  await check('executor session, caller and runtime identities cannot be substituted', async () => {
    const a = await fixture(), b = await fixture(); await invoke(a);
    await rejected(recordBrowserJobEvent({ kind: 'receipt', jobId: a.attempt.dispatchId, userId: owner, threadId: a.thread, sessionId: randomUUID() }));
    await rejected(browserJobAction(owner, b.thread, { action: 'status', jobId: a.attempt.dispatchId }), 404);
    process.env.PAT_RUNTIME_SCOPE = `${runtime}-other`; try { await rejected(invoke(a, 'status'), 404); } finally { process.env.PAT_RUNTIME_SCOPE = runtime; }
    const result = (await listBrowserJobs(owner, a.workspace))[0]; assert.ok(!('dispatchLeaseToken' in result));
  });
  await check('actual channel terminal callback persists once and suppresses autonomous parent notification', async () => {
    const f = await fixture(); await invoke(f); await settle(f); await settle(f);
    const result = await invoke(f, 'status'); assert.equal(result.status, 'completed'); assert.equal(notifications, 0);
    await recordBrowserJobEvent({ kind: 'settled', jobId: result.id, userId: owner, threadId: f.thread, sessionId: result.sessionId, status: 'failed', report: 'Late conflicting terminal' });
    assert.equal((await row(schema.browserJobs, result.id)).status, 'completed'); assert.equal((await row(schema.browserJobs, result.id)).report, 'Saved synthetic observations.');
  });
  await check('failed callback still leaves terminal durable events available for recovery', async () => {
    const f = await fixture(); await invoke(f); callbackFailures = 2; await settle(f, 'failed');
    assert.equal((await row(schema.browserJobs, f.attempt.dispatchId)).status, 'running');
    assert.equal((await invoke(f, 'status')).status, 'failed'); assert.equal(notifications, 0);
  });
  await check('snapshot ignores a lone cancellation event and bounds reads to a captured tail', async () => {
    const value = { id: randomUUID(), events: [{ type: 'turn.cancelled', data: {} }] };
    assert.equal((await readIrisSnapshot(sessionHandle(value))).status, 'running');
    value.events.push({ type: 'session.waiting', data: {} }); assert.equal((await readIrisSnapshot(sessionHandle(value))).status, 'cancelled');
    value.events = Array.from({ length: 700 }, () => ({ type: 'message.appended', data: {} }));
    value.events.push({ type: 'turn.completed', data: {} }, { type: 'session.waiting', data: {} });
    const snapshot = await readIrisSnapshot(sessionHandle(value)); assert.equal(snapshot.status, 'completed'); assert.equal(snapshot.truncated, true); assert.equal(snapshot.observedTail, 701);
  });
  await check('worker and callback HTTP surfaces require internal authentication', async () => {
    const f = await fixture();
    const response = await route.handler(new Request(`${origin}/eve/v1/workers/iris`, { method: 'POST', body: JSON.stringify({ action: 'start', jobId: f.attempt.dispatchId, userId: owner, threadId: f.thread, task: 'Ignored', model: 'fixture', reasoning: 'low' }) }), surfaces);
    assert.equal(response.status, 401); assert.equal(sends.get(f.attempt.dispatchId), undefined);
    const callback = await originalFetch(`${origin}/api/internal/browser-job-event`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'settled', jobId: f.attempt.dispatchId, userId: owner, threadId: f.thread, sessionId: randomUUID(), status: 'completed' }) });
    assert.equal(callback.status, 401);
  });
  await check('legacy ad hoc lifecycle remains compatible and notifies parent at most once', async () => {
    const f = await fixture(), jobId = randomUUID(), prior = notifications;
    const job = await browserJobAction(owner, f.thread, { action: 'start', jobId, task: 'Explicit ad hoc browser work', parentSessionId: 'fixture-parent' });
    assert.equal(job.status, 'running');
    const legacy = { ...f, attempt: { ...f.attempt, dispatchId: jobId } }; await settle(legacy); await settle(legacy);
    assert.equal((await browserJobAction(owner, f.thread, { action: 'status', jobId })).status, 'completed');
    assert.equal(notifications, prior + 1); assert.equal(sends.get(jobId), 1);
  });
  await check('installed Eve swallows channel errors but its real dynamic resolver rejects a second queued turn before provider', async () => {
    const f = await fixture(); await invoke(f);
    const session = sessions.get(f.attempt.dispatchId);
    const event = { type: 'turn.started', data: { sequence: 1, turnId: 'turn_1' } };
    const adapter = { kind: 'channel:iris', 'turn.started': data => channel.events['turn.started'](data, { state: session.state }, { session: { id: session.id, auth: { current: session.auth } } }) };
    assert.equal(await callAdapterEventHandler(adapter, event, {}), event, 'Installed Eve deliberately swallows channel callback errors');
    const before = providerCalls;
    await assert.rejects(modelStep(session, { sequence: 1 }), error => error.code === 'EVE_DYNAMIC_MODEL_SELECTION_FAILED');
    assert.equal(providerCalls, before);
    assert.equal(sends.get(f.attempt.dispatchId), 1);
  });
  await check('real dynamic resolver accepts original turn and stops after mandate cancellation', async () => {
    const f = await fixture(); await invoke(f); const session = sessions.get(f.attempt.dispatchId), before = providerCalls;
    for (const stepIndex of [0, 1, 2]) await modelStep(session, { stepIndex });
    assert.equal(providerCalls, before + 3);
    assert.equal((await row(schema.missionAttempts, f.attempt.id)).usage.tokens, 21, 'All three physical synthetic calls have known wire usage');
    await control.controlMission(owner, f.workspace, f.thread, { action: 'cancel', requestId: randomUUID(), missionId: f.mission.id, expectedMandateRevision: 1 });
    await assert.rejects(modelStep(session), error => error.code === 'EVE_DYNAMIC_MODEL_SELECTION_FAILED');
    assert.equal(providerCalls, before + 3);
  });
  await check('immutable Iris channel cannot escape admission through omitted or substituted turn auth', async () => {
    const f = await fixture(); await invoke(f); const session = sessions.get(f.attempt.dispatchId), before = providerCalls;
    for (const auth of [null, { ...session.auth, attributes: {} }, { ...session.auth, principalId: randomUUID() }, { ...session.auth, attributes: { ...session.auth.attributes, browserJobId: randomUUID() } }]) {
      await assert.rejects(modelStep(session, { auth }), error => error.code === 'EVE_DYNAMIC_MODEL_SELECTION_FAILED');
    }
    await assert.rejects(modelStep(session, { initial: null }), error => error.code === 'EVE_DYNAMIC_MODEL_SELECTION_FAILED');
    await assert.rejects(modelStep(session, { kind: 'http' }), error => error.code === 'EVE_DYNAMIC_MODEL_SELECTION_FAILED');
    assert.equal(providerCalls, before);
  });
  await check('unavailable admission callback fails closed before provider, while ordinary chat remains compatible', async () => {
    const f = await fixture(); await invoke(f); const session = sessions.get(f.attempt.dispatchId), before = providerCalls;
    callbackFailures = 1; await assert.rejects(modelStep(session), error => error.code === 'EVE_DYNAMIC_MODEL_SELECTION_FAILED');
    assert.equal(providerCalls, before);
    await modelStep(session, { auth: null, initial: null, kind: 'http', sequence: 4 }); assert.equal(providerCalls, before + 1);
  });
  await check('a branch awaiting human browser control cannot make another model call', async () => {
    const f = await fixture(); await invoke(f); const session = sessions.get(f.attempt.dispatchId), before = providerCalls;
    await db.transaction(async tx => { await control.lockMission(tx, f.mission.id); await control.createMissionWait(tx, await row(schema.missions, f.mission.id), { reason: 'human_browser', taskIds: [f.task.id], question: 'Lämna tillbaka webbläsaren.' }); });
    await assert.rejects(modelStep(session), error => error.code === 'EVE_DYNAMIC_MODEL_SELECTION_FAILED');
    assert.equal(providerCalls, before);
  });
  await check('disabled autonomy denies pending dispatch and model steps but allows status and stop receipts', async () => {
    const pending = await fixture(); scenarios.set(pending.attempt.dispatchId, 'die-before-admission'); await invoke(pending);
    const beforeJob = await row(schema.browserJobs, pending.attempt.dispatchId), live = await fixture(); await invoke(live);
    const session = sessions.get(live.attempt.dispatchId), beforeCalls = providerCalls;
    process.env.AUTONOMOUS_MISSIONS_ENABLED = 'false';
    try {
      assert.equal((await recordBrowserJobEvent({ kind: 'dispatch', jobId: beforeJob.id, userId: owner, threadId: pending.thread, dispatchLeaseToken: beforeJob.dispatchLeaseToken })).allowed, false);
      await assert.rejects(modelStep(session), error => error.code === 'EVE_DYNAMIC_MODEL_SELECTION_FAILED');
      assert.equal(providerCalls, beforeCalls); assert.equal(sends.get(beforeJob.id), undefined);
      assert.equal((await invoke(live, 'status')).status, 'running');
      assert.equal((await invoke(live, 'cancel')).status, 'cancelling');
      await settle(live, 'cancelled'); assert.equal((await invoke(live, 'status')).status, 'cancelled');
    } finally { process.env.AUTONOMOUS_MISSIONS_ENABLED = 'true'; }
  });
  console.log(JSON.stringify({ status: failures.length ? 'failed' : 'passed', checks: passed.length, failures: failures.map(({ name, message }) => ({ name, message })), database: 'actual isolated PostgreSQL', api: 'authored H3 callback + authored Iris channel + installed Eve adapter/dynamic model lifecycle', substitutes: ['deterministic Eve Session/from surfaces and durable event arrays', 'deterministic model provider'], modelOrBrowserExecution: 'local deterministic provider only; no real model or browser' }));
  if (failures.length) { for (const failure of failures) console.error(failure.stack); process.exitCode = 1; }
} finally {
  globalThis.fetch = originalFetch; process.env.PAT_RUNTIME_SCOPE = runtime;
  delete globalThis.irisFixtureSelection;
  server.close(); server.closeAllConnections(); await once(server, 'close'); definitionHook.deregister();
  try { await db.delete(schema.user).where(eq(schema.user.id, owner)); } finally { await app.close(); }
}
