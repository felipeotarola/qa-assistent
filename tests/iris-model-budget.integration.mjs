import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createApp, createRouter, toNodeListener } from 'h3';
import { eq } from 'drizzle-orm';
import { generateText, APICallError } from 'ai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { isolatedApp } from './helpers/isolated-app.mjs';

// Authored provider middleware + H3 route + PostgreSQL. The provider is local,
// deterministic and deliberately fails in selected checks; no model/browser.
process.env.PAT_RUNTIME_SCOPE = `${process.env.PAT_RUNTIME_SCOPE}-iris-budget-${randomUUID()}`;
process.env.MISSIONS_ENABLED = 'true'; process.env.AUTONOMOUS_MISSIONS_ENABLED = 'true';
const app = await isolatedApp(), { db, schema } = app;
const control = await import('../server/utils/mission-control.ts'), attempts = await import('../server/utils/mission-attempts.ts');
const { withIrisModelBudget } = await import('../agent/lib/iris-admission.ts');
const { recordBrowserJobEvent } = await import('../server/utils/browser-jobs.ts');
const { saveItem } = await import('../server/utils/workspaces.ts');
const { irisModelUsage, IRIS_MODEL_LEDGER_PREFIX: prefix, IRIS_MAX_MODEL_CALLS } = await import('../shared/browser-job.ts');
const router = createRouter(); router.post('/api/internal/browser-job-event', (await import('../server/api/internal/browser-job-event.post.ts')).default);
const server = createServer(toNodeListener(createApp().use(router))); server.listen(0, '127.0.0.1'); await once(server, 'listening');
const origin = `http://127.0.0.1:${server.address().port}`; process.env.APP_URL = origin;
const owner = randomUUID(), originalFetch = globalThis.fetch, passed = [], failures = [];
let requests = [], drop = null, dropAfter = null;
globalThis.fetch = async (url, options) => {
  assert.ok(String(url).startsWith(origin), 'No external requests in budget tests');
  const value = JSON.parse(options.body); requests.push(value);
  if (drop === value.kind) { drop = null; throw new Error('Synthetic callback unavailable'); }
  if (dropAfter === value.kind) { dropAfter = null; await originalFetch(url, options); throw new Error('Synthetic reply lost after commit'); }
  return originalFetch(url, options);
};
const row = async (table, id) => (await db.select().from(table).where(eq(table.id, id)))[0];
async function check(name, fn) { try { await fn(); passed.push(name); } catch (error) { failures.push({ name, message: error.message }); console.error(name, error.stack); } }
const usage = (input = 10, output = 5) => ({ inputTokens: { total: input, cacheRead: input === null ? undefined : 4 }, outputTokens: { total: output },
  raw: { prompt_tokens: input, completion_tokens: output, ...(input === null ? {} : { prompt_tokens_details: { cached_tokens: 4 } }) } });
const receipt = (input = 10, output = 5) => ({ inputTokens: input, outputTokens: output, cacheReadTokens: 4, cacheWriteTokens: null });
async function fixture() {
  const workspace = randomUUID(), thread = randomUUID(), sessionId = randomUUID();
  await db.insert(schema.workspaces).values({ id: workspace, userId: owner, name: 'Iris budget fixture' });
  await db.insert(schema.threads).values({ id: thread, userId: owner, workspaceId: workspace, title: 'Iris budget fixture' });
  const caseId = randomUUID(), plan = await saveItem(owner, workspace, { title: 'Budgetplan', content: { kind: 'test_plan', sources: [], cases: [{ id: caseId, title: 'Startsida', type: 'browser', preconditions: '', steps: 'Öppna sidan', expected: 'Rubrik synlig' }] } });
  const caseKeys = [`${plan.id}:${caseId}`];
  const mission = await control.acceptMission(owner, workspace, thread, { requestId: randomUUID(), intent: 'explore', goal: 'Inspektera sidan', target: { kind: 'public_url', url: 'https://budget.example.test/' }, caseKeys });
  const task = await db.transaction(async tx => { await control.lockMission(tx, mission.id); return control.addMissionTask(tx, mission, { operationId: randomUUID(), title: 'Iris', spec: { kind: 'browser_tests', caseKeys, target: mission.config.target } }); });
  const lease = attempts.leaseIdentity(await attempts.claimMission(mission.id));
  const reserved = await attempts.reserveMissionAttempt(lease, task.id, { resource: { kind: 'browser', poolKey: `fixture:${randomUUID()}` } });
  assert.equal(reserved.status, 'reserved'); assert.equal(reserved.attempt.reservedTokens, 1000000);
  const attempt = await attempts.markMissionDispatch(lease, reserved.attempt.id);
  await db.insert(schema.browserJobs).values({ id: attempt.dispatchId, threadId: thread, runtime: process.env.PAT_RUNTIME_SCOPE, parentSessionId: `mission:${mission.id}`, sessionId, task: 'Fixture', model: 'glm-5.3-flash', reasoning: 'low', status: 'running' });
  const auth = { authenticator: 'app', issuer: 'app', principalType: 'user', principalId: owner, attributes: { browserWorker: 'iris', browserJobId: attempt.dispatchId, browserThreadId: thread } };
  const ctx = { channel: { kind: 'channel:iris' }, session: { id: sessionId, auth: { current: auth, initiator: auth } } };
  const actor = { jobId: attempt.dispatchId, userId: owner, threadId: thread, sessionId };
  const event = { type: 'step.started', meta: { id: 'same-logical-event' }, data: { sequence: 0, stepIndex: 0, turnId: 'same-logical-turn' } };
  return { workspace, thread, mission, task, attempt, ctx, actor, event };
}
function model(f, implementation = {}) {
  const counters = { calls: 0, params: [] };
  const base = { specificationVersion: 'v4', provider: 'fixture', modelId: 'iris-budget',
    async doGenerate(params) { counters.calls++; counters.params.push(params); if (implementation.generate) return implementation.generate(); return { content: [], warnings: [], finishReason: { unified: 'stop', raw: 'stop' }, usage: usage() }; },
    async doStream(params) { counters.calls++; counters.params.push(params); return { stream: implementation.stream() }; },
  };
  return { model: withIrisModelBudget(base, f.event, f.ctx), counters };
}
// Exercise the real provider's usage conversion, which substitutes zero for
// fields missing from a partial wire receipt. All transport stays synthetic.
function compatibleModel(f, raw) {
  const counters = { calls: 0 };
  const provider = createOpenAICompatible({ name: 'isolated-fixture', baseURL: 'http://127.0.0.1:1/v1', apiKey: 'isolated-fixture', fetch: async (url, options) => {
    assert.equal(String(url), 'http://127.0.0.1:1/v1/chat/completions'); counters.calls++;
    const request = JSON.parse(options.body), base = { id: 'fixture', created: 0, model: 'fixture' };
    const reported = raw === undefined ? {} : { usage: raw };
    if (request.stream) return new Response(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: 'fixture' }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], ...reported })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
    return new Response(JSON.stringify({ ...base, object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: 'fixture' }, finish_reason: 'stop' }], ...reported }), { headers: { 'content-type': 'application/json' } });
  } });
  return { model: withIrisModelBudget(provider('fixture'), f.event, f.ctx), counters };
}
async function invokeCompatible(wrapped, streaming) {
  const params = { prompt: [{ role: 'user', content: [{ type: 'text', text: 'Local deterministic fixture only.' }] }] };
  if (!streaming) return wrapped.model.doGenerate(params);
  const result = await wrapped.model.doStream(params), parts = [];
  for await (const part of result.stream) parts.push(part);
  assert.equal(parts.some(part => part.type === 'error'), false);
  assert.equal(parts.some(part => part.type === 'finish'), true);
}
const ledger = async f => irisModelUsage((await row(schema.missionAttempts, f.attempt.id)).toolCallIds);
const call = (f, kind, modelCallId, extra = {}) => recordBrowserJobEvent({ ...f.actor, kind, modelCallId, ...extra });
const finish = (f, id, value = receipt()) => call(f, 'model_finished', id, { modelUsage: value, modelDurationMs: 20 });
try {
  await db.insert(schema.user).values({ id: owner, name: 'Iris budget fixture', email: `${owner}@example.test` });
  await check('physical calls sharing Eve turn and step have separate identities and measured usage', async () => {
    const f = await fixture(), wrapped = model(f);
    await wrapped.model.doGenerate({ prompt: [], maxOutputTokens: 50000 });
    await wrapped.model.doGenerate({ prompt: [], maxOutputTokens: 100 });
    const value = await ledger(f), saved = await row(schema.missionAttempts, f.attempt.id);
    assert.equal(value.providerCalls, 2); assert.equal(value.tokens, 30); assert.equal(value.cacheReadTokens, 8);
    assert.equal(saved.usage.tokens, 30); assert.equal(saved.toolCalls, 0);
    assert.deepEqual(wrapped.counters.params.map(params => params.maxOutputTokens), [8000, 100]);
    assert.equal(new Set(requests.filter(request => request.jobId === f.actor.jobId && request.kind === 'model_started').map(request => request.modelCallId)).size, 2);
  });
  await check('the 65th physical call is denied before reaching the provider even with zero-token outputs', async () => {
    const f = await fixture(), ids = [];
    for (let i = 0; i < IRIS_MAX_MODEL_CALLS; i++) { const callId = randomUUID(); ids.push(`${prefix}start:${callId}`, `${prefix}usage:${JSON.stringify({ callId, ...receipt(0, 0), durationMs: 1 })}`); }
    await db.update(schema.missionAttempts).set({ toolCallIds: ids }).where(eq(schema.missionAttempts.id, f.attempt.id));
    const wrapped = model(f); await assert.rejects(wrapped.model.doGenerate({ prompt: [] })); assert.equal(wrapped.counters.calls, 0);
  });
  await check('measured token overshoot is retained and stops the next call', async () => {
    const f = await fixture(), wrapped = model(f, { generate: () => ({ content: [], warnings: [], finishReason: { unified: 'stop' }, usage: usage(1000000, 30) }) });
    await wrapped.model.doGenerate({ prompt: [] }); assert.equal((await ledger(f)).tokens, 1000030);
    await assert.rejects(wrapped.model.doGenerate({ prompt: [] })); assert.equal(wrapped.counters.calls, 1);
  });
  await check('provider error or absent token fields leaves unknown usage and forbids another physical call', async () => {
    for (const generate of [() => { throw new Error('Synthetic provider outcome unknown'); }, () => ({ content: [], warnings: [], finishReason: { unified: 'stop' }, usage: usage(undefined, null) })]) {
      const f = await fixture(), wrapped = model(f, { generate });
      await wrapped.model.doGenerate({ prompt: [] }).catch(() => undefined);
      assert.equal((await ledger(f)).tokens, null); await assert.rejects(model(f).model.doGenerate({ prompt: [] })); assert.equal(wrapped.counters.calls, 1);
    }
  });
  for (const streaming of [false, true]) {
    const mode = streaming ? 'stream' : 'generate';
    await check(`actual compatible ${mode} preserves absent and partial wire usage as unknown`, async () => {
      for (const raw of [undefined, null, {}, { prompt_tokens: 100 }, { completion_tokens: 8 }, { prompt_tokens: null, completion_tokens: 8 }, { prompt_tokens: 100, completion_tokens: null }]) {
        const f = await fixture(), wrapped = compatibleModel(f, raw);
        await invokeCompatible(wrapped, streaming);
        const value = await ledger(f);
        assert.equal(value.tokens, null, `Missing wire fields must remain unknown: ${JSON.stringify(raw)}`);
        assert.equal(value.unknownCalls, 1);
        assert.equal(value.measurementCounts.cacheReadTokens, 0);
        assert.equal(value.measurementCounts.cacheWriteTokens, 0);
        await assert.rejects(invokeCompatible(wrapped, streaming)); assert.equal(wrapped.counters.calls, 1);
      }
    });
    await check(`actual compatible ${mode} accepts explicit zero measurements without inventing cache usage`, async () => {
      for (const raw of [{ prompt_tokens: 0, completion_tokens: 0 }, { prompt_tokens: 100, completion_tokens: 8, prompt_tokens_details: { cached_tokens: 0 } }, { prompt_tokens: 100, completion_tokens: 8, prompt_tokens_details: { cached_tokens: 5 } }]) {
        const f = await fixture(), wrapped = compatibleModel(f, raw);
        await invokeCompatible(wrapped, streaming); await invokeCompatible(wrapped, streaming);
        const value = await ledger(f);
        assert.equal(value.tokens, 2 * (raw.prompt_tokens + raw.completion_tokens)); assert.equal(value.knownCalls, 2);
        assert.equal(value.cacheReadTokens, 2 * (raw.prompt_tokens_details?.cached_tokens ?? 0));
        assert.equal(value.measurementCounts.cacheReadTokens, raw.prompt_tokens_details ? 2 : 0);
        assert.equal(value.measurementCounts.cacheWriteTokens, 0); assert.equal(wrapped.counters.calls, 2);
      }
    });
  }
  await check('normalized zero totals without an original compatible receipt remain unknown', async () => {
    const f = await fixture(), wrapped = model(f, { generate: () => ({ content: [], warnings: [], finishReason: { unified: 'stop' }, usage: { inputTokens: { total: 0, cacheRead: 0 }, outputTokens: { total: 0 } } }) });
    await wrapped.model.doGenerate({ prompt: [] }); assert.equal((await ledger(f)).tokens, null);
    await assert.rejects(wrapped.model.doGenerate({ prompt: [] })); assert.equal(wrapped.counters.calls, 1);
  });
  await check('lost completion callback prevents result return and further provider retries', async () => {
    const f = await fixture(), wrapped = model(f); drop = 'model_finished';
    await assert.rejects(wrapped.model.doGenerate({ prompt: [] }));
    await assert.rejects(wrapped.model.doGenerate({ prompt: [] })); assert.equal(wrapped.counters.calls, 1);
    await assert.rejects(model(f).model.doGenerate({ prompt: [] })); assert.equal((await ledger(f)).unknownCalls, 1);
  });
  await check('a lost admission reply cannot start a provider or silently renew its reservation', async () => {
    const f = await fixture(), wrapped = model(f); dropAfter = 'model_started';
    await assert.rejects(wrapped.model.doGenerate({ prompt: [] })); assert.equal(wrapped.counters.calls, 0);
    assert.equal((await ledger(f)).providerCalls, 1); assert.equal((await ledger(f)).tokens, null);
    const retried = model(f); await assert.rejects(retried.model.doGenerate({ prompt: [] })); assert.equal(retried.counters.calls, 0);
  });
  await check('actual AI SDK retry does not repeat a provider with an unknown first outcome', async () => {
    const f = await fixture(), wrapped = model(f, { generate: () => { throw new APICallError({ message: 'Synthetic retryable provider error', url: 'https://fixture.invalid/', requestBodyValues: {}, statusCode: 503, isRetryable: true }); } });
    await assert.rejects(generateText({ model: wrapped.model, prompt: 'Local deterministic fixture only.', maxRetries: 2 }));
    assert.equal(wrapped.counters.calls, 1); assert.equal((await ledger(f)).unknownCalls, 1);
  });
  await check('provider rate limits keep the real safe cause and unknown usage without an SDK retry', async () => {
    const f = await fixture(), wrapped = model(f, { generate: () => { throw new APICallError({ message: 'Private request values must not leak', url: 'https://fixture.invalid/', requestBodyValues: {}, statusCode: 429, isRetryable: true }); } });
    await assert.rejects(generateText({ model: wrapped.model, prompt: 'Synthetic rate limit', maxRetries: 2 }), error => /anropsgräns/.test(error.message) && !/Private request/.test(error.message));
    assert.equal(wrapped.counters.calls, 1); assert.equal((await ledger(f)).unknownCalls, 1); assert.equal((await ledger(f)).tokens, null);
  });
  await check('parallel starts admit only one physical call while its outcome is pending', async () => {
    const f = await fixture(), ids = [randomUUID(), randomUUID()];
    const outcomes = await Promise.allSettled(ids.map(id => call(f, 'model_started', id)));
    assert.equal(outcomes.filter(value => value.status === 'fulfilled').length, 1); assert.equal((await ledger(f)).providerCalls, 1);
  });
  await check('a repeated start never resends a provider and receipt replay is immutable', async () => {
    const f = await fixture(), id = randomUUID(); await call(f, 'model_started', id); await assert.rejects(call(f, 'model_started', id));
    await finish(f, id); await finish(f, id); assert.equal((await ledger(f)).tokens, 15);
    await assert.rejects(finish(f, id, receipt(99, 5))); await assert.rejects(finish(f, randomUUID()));
  });
  await check('wrong session, owner and runtime cannot write model admission or receipts', async () => {
    const f = await fixture(), id = randomUUID(); await call(f, 'model_started', id);
    for (const change of [{ sessionId: randomUUID() }, { userId: randomUUID() }, { threadId: randomUUID() }]) await assert.rejects(recordBrowserJobEvent({ ...f.actor, ...change, kind: 'model_finished', modelCallId: id, modelUsage: receipt(), modelDurationMs: 1 }));
    const runtime = process.env.PAT_RUNTIME_SCOPE; process.env.PAT_RUNTIME_SCOPE = `${runtime}-other`;
    try { await assert.rejects(finish(f, id)); } finally { process.env.PAT_RUNTIME_SCOPE = runtime; }
    assert.equal((await ledger(f)).tokens, null);
  });
  await check('pause revokes new calls but accepts original usage as historical accounting', async () => {
    const f = await fixture(), id = randomUUID(); await call(f, 'model_started', id);
    await control.controlMission(owner, f.workspace, f.thread, { action: 'pause', missionId: f.mission.id, expectedMandateRevision: 1, requestId: randomUUID() });
    await finish(f, id); assert.equal((await ledger(f)).tokens, 15);
    const wrapped = model(f); await assert.rejects(wrapped.model.doGenerate({ prompt: [] })); assert.equal(wrapped.counters.calls, 0);
  });
  await check('stream finish is durably accounted before being exposed to the harness', async () => {
    const f = await fixture(), wrapped = model(f, { stream: () => new ReadableStream({ start(controller) { controller.enqueue({ type: 'finish', usage: usage(25, 8), finishReason: { unified: 'stop' } }); controller.close(); } }) });
    const stream = await wrapped.model.doStream({ prompt: [] }), reader = stream.stream.getReader();
    assert.equal((await reader.read()).value.type, 'finish'); assert.equal((await ledger(f)).tokens, 33); assert.equal((await reader.read()).done, true);
  });
  await check('cancelled or prematurely closed streams leave unknown consumption and no automatic retry', async () => {
    for (const cancel of [true, false]) {
      const f = await fixture(), wrapped = model(f, { stream: () => new ReadableStream({ start(controller) { if (!cancel) controller.close(); } }) });
      const stream = await wrapped.model.doStream({ prompt: [] });
      if (cancel) await stream.stream.cancel(); else assert.equal((await stream.stream.getReader().read()).done, true);
      assert.equal((await ledger(f)).tokens, null); await assert.rejects(model(f).model.doGenerate({ prompt: [] }));
    }
  });
  await check('ordinary V sessions are not wrapped in Iris accounting or limits', async () => {
    const base = { specificationVersion: 'v4', modelId: 'v', provider: 'fixture' }, f = await fixture();
    const auth = { ...f.ctx.session.auth.current, attributes: {} };
    assert.equal(withIrisModelBudget(base, f.event, { channel: { kind: 'channel:web' }, session: { id: randomUUID(), auth: { current: auth, initiator: auth } } }), base);
  });
  console.log(JSON.stringify({ status: failures.length ? 'failed' : 'passed', checks: passed.length, failures, database: 'actual isolated PostgreSQL', api: 'authored H3 route and actual AI SDK middleware', provider: 'deterministic local, no paid model/browser' }));
  if (failures.length) process.exitCode = 1;
} finally {
  globalThis.fetch = originalFetch; server.close(); server.closeAllConnections(); await once(server, 'close');
  try { await db.delete(schema.user).where(eq(schema.user.id, owner)); } finally { await app.close(); }
}
