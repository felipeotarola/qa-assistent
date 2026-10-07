import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { createApp, createRouter, toNodeListener } from 'h3';
import { eq, inArray, sql } from 'drizzle-orm';
import { APICallError } from 'ai';
import { isolatedApp } from './helpers/isolated-app.mjs';

// Real isolated PostgreSQL, H3 and authored physical model wrappers. All
// provider calls below are in-process deterministic functions, not LLM calls.
process.env.PAT_RUNTIME_SCOPE = `${process.env.PAT_RUNTIME_SCOPE}-pacing-${randomUUID()}`;
process.env.MISSIONS_ENABLED = 'true'; process.env.AUTONOMOUS_MISSIONS_ENABLED = 'true';
process.env.GRUNDEN_API_TOKEN = `synthetic-pacing-${randomUUID()}`;
process.env.GRUNDEN_MIN_REQUEST_INTERVAL_MS = '100';
const app = await isolatedApp(), { db, schema } = app;
const { paceProviderRequest } = await import('../server/utils/provider-pacing.ts');
const { waitForProviderTurn } = await import('../agent/lib/provider-pacing.ts');
const { meteredModel } = await import('../agent/lib/model-usage.ts');
const { withIrisModelBudget } = await import('../agent/lib/iris-admission.ts');
const { grundenModelSelection } = await import('../agent/lib/grunden.ts');
const { irisModelUsage } = await import('../shared/browser-job.ts');
const control = await import('../server/utils/mission-control.ts'), attempts = await import('../server/utils/mission-attempts.ts');
const { saveItem } = await import('../server/utils/workspaces.ts');
const router = createRouter();
router.post('/api/internal/provider-pacing', (await import('../server/api/internal/provider-pacing.post.ts')).default);
router.post('/api/internal/browser-job-event', (await import('../server/api/internal/browser-job-event.post.ts')).default);
const server = createServer(toNodeListener(createApp().use(router)));
server.listen(0, '127.0.0.1'); await once(server, 'listening');
const origin = `http://127.0.0.1:${server.address().port}`; process.env.APP_URL = origin;
const originalFetch = globalThis.fetch, owner = randomUUID(), buckets = new Set(), passed = [];
let intercept;
globalThis.fetch = async (url, options) => {
  if (intercept) return intercept(url, options);
  assert.ok(String(url).startsWith(`${origin}/`), 'No external requests belong in pacing tests');
  return originalFetch(url, options);
};
const row = async (table, id) => (await db.select().from(table).where(eq(table.id, id)))[0];
function request(action = 'reserve', model = 'glm-5.3', extra = {}) {
  const credentialHash = createHash('sha256').update(process.env.GRUNDEN_API_TOKEN).digest('hex');
  buckets.add(createHash('sha256').update(`grunden:v1:${credentialHash}:${model}`).digest('hex'));
  return { action, model, credentialHash, intervalMs: Number(process.env.GRUNDEN_MIN_REQUEST_INTERVAL_MS), ...extra };
}
async function reset(interval = 100) {
  intercept = undefined; process.env.GRUNDEN_MIN_REQUEST_INTERVAL_MS = String(interval);
  for (const model of ['glm-5.3', 'glm-5.3-flash']) request('reserve', model);
  await db.delete(schema.providerPacing).where(inArray(schema.providerPacing.bucketHash, [...buckets]));
}
async function check(name, fn) { await reset(); await fn(); passed.push(name); }
function physical(implementation) {
  let calls = 0;
  return { get calls() { return calls; }, model: { specificationVersion: 'v4', provider: 'synthetic', modelId: 'glm-5.3',
    async doGenerate() { calls++; if (implementation) return implementation(); return { warnings: [], content: [], finishReason: { unified: 'stop', raw: 'stop' }, usage: { raw: { prompt_tokens: 2, completion_tokens: 1 } } }; },
    async doStream() { throw new Error('Not used in this fixture'); },
  } };
}
async function browserFixture() {
  const workspace = randomUUID(), thread = randomUUID(), sessionId = randomUUID();
  await db.insert(schema.workspaces).values({ id: workspace, userId: owner, name: 'Pacing fixture' });
  await db.insert(schema.threads).values({ id: thread, userId: owner, workspaceId: workspace, title: 'Pacing fixture' });
  const caseId = randomUUID(), plan = await saveItem(owner, workspace, { title: 'Pacing fixture', content: { kind: 'test_plan', sources: [], cases: [{ id: caseId, title: 'Rubrik', type: 'browser', preconditions: '', steps: 'Öppna sidan', expected: 'Synlig rubrik' }] } });
  const caseKeys = [`${plan.id}:${caseId}`];
  const mission = await control.acceptMission(owner, workspace, thread, { requestId: randomUUID(), intent: 'explore', goal: 'Kontrollera rubrik', target: { kind: 'public_url', url: 'https://pacing.example.test/' }, caseKeys });
  const task = await db.transaction(async tx => { await control.lockMission(tx, mission.id); return control.addMissionTask(tx, mission, { operationId: randomUUID(), title: 'Iris', spec: { kind: 'browser_tests', caseKeys, planVersions: [{ itemId: plan.id, version: plan.version }], target: mission.config.target } }); });
  const lease = attempts.leaseIdentity(await attempts.claimMission(mission.id));
  const reserved = await attempts.reserveMissionAttempt(lease, task.id, { resource: { kind: 'browser', poolKey: `pacing:${randomUUID()}` } });
  assert.equal(reserved.status, 'reserved'); const attempt = await attempts.markMissionDispatch(lease, reserved.attempt.id);
  await db.insert(schema.browserJobs).values({ id: attempt.dispatchId, threadId: thread, runtime: process.env.PAT_RUNTIME_SCOPE, parentSessionId: `mission:${mission.id}`, sessionId, task: 'Fixture', model: 'glm-5.3', reasoning: 'low', status: 'running' });
  const auth = { authenticator: 'app', issuer: 'app', principalType: 'user', principalId: owner, attributes: { browserWorker: 'iris', browserJobId: attempt.dispatchId, browserThreadId: thread } };
  return { mission, attempt, lease, ctx: { channel: { kind: 'channel:iris' }, session: { id: sessionId, auth: { current: auth, initiator: auth } } }, event: { type: 'step.started', data: { sequence: 0, stepIndex: 0 } } };
}
const ledger = async f => irisModelUsage((await row(schema.missionAttempts, f.attempt.id)).toolCallIds);
try {
  await db.insert(schema.user).values({ id: owner, name: 'Pacing fixture', email: `${owner}@example.test` });
  await check('parallel app/Eve reservations admit only one shared credential/model start', async () => {
    await reset(6000); const input = request();
    const results = await Promise.all(Array.from({ length: 20 }, () => paceProviderRequest(input)));
    assert.equal(results.filter(r => r.allowed).length, 1);
    assert.ok(results.filter(r => !r.allowed).every(r => r.waitMs > 3000 && r.waitMs <= 6000));
    assert.equal((await paceProviderRequest(request('reserve', 'glm-5.3-flash'))).allowed, true);
  });
  await check('actual HTTP clients wait outside locks and separate consecutive admissions', async () => {
    await reset(100); const completed = [];
    await Promise.all(Array.from({ length: 4 }, async () => { await waitForProviderTurn('glm-5.3'); completed.push(performance.now()); }));
    completed.sort((a, b) => a - b);
    for (let i = 1; i < completed.length; i++) assert.ok(completed[i] - completed[i - 1] >= 75, 'Reservations are spaced by the database clock');
  });
  await check('bearer, credential and configured interval are checked before any slot', async () => {
    const input = request();
    const response = await originalFetch(`${origin}/api/internal/provider-pacing`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) });
    assert.equal(response.status, 401);
    await assert.rejects(paceProviderRequest({ ...input, credentialHash: '0'.repeat(64) }), e => e.statusCode === 503);
    await assert.rejects(paceProviderRequest({ ...input, intervalMs: 6000 }), e => e.statusCode === 503);
    assert.equal((await paceProviderRequest(input)).allowed, true);
  });
  await check('cooldown extends but never shortens an already shared Retry-After window', async () => {
    await paceProviderRequest(request('cooldown', 'glm-5.3', { delayMs: 27000 }));
    await paceProviderRequest(request('cooldown', 'glm-5.3', { delayMs: 1 }));
    const result = await paceProviderRequest(request()); assert.equal(result.allowed, false); assert.ok(result.waitMs > 26000);
    assert.equal((await paceProviderRequest(request('reserve', 'glm-5.3-flash'))).allowed, true);
  });
  await check('clock is refreshed after a contended lock instead of admitting a stale timestamp', async () => {
    const input = request(), bucket = createHash('sha256').update(`grunden:v1:${input.credentialHash}:${input.model}`).digest('hex');
    let entered, release; const ready = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
    const hold = db.transaction(async tx => { await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`provider-pacing:${bucket}`},0))`); entered(); await gate; });
    await ready; const pending = paceProviderRequest(input); await delay(150); release(); await hold;
    assert.equal((await pending).allowed, true);
    const result = await paceProviderRequest(input); assert.equal(result.allowed, false); assert.ok(result.waitMs > 50);
  });
  await check('cancelled actual waiter causes no model-start ledger or provider usage', async () => {
    const f = await browserFixture(); await reset(1000); await paceProviderRequest(request());
    const p = physical(), wrapped = withIrisModelBudget(p.model, f.event, f.ctx), abort = new AbortController();
    const pending = wrapped.doGenerate({ prompt: [], abortSignal: abort.signal }); setTimeout(() => abort.abort(), 25);
    await assert.rejects(pending); assert.equal(p.calls, 0); assert.equal((await ledger(f)).providerCalls, 0);
  });
  await check('Iris deadline changed while waiting is rechecked before its model-start receipt', async () => {
    const f = await browserFixture(); await reset(250); await paceProviderRequest(request());
    const p = physical(), wrapped = withIrisModelBudget(p.model, f.event, f.ctx);
    const pending = wrapped.doGenerate({ prompt: [] });
    await delay(25); await db.update(schema.missionAttempts).set({ deadlineAt: new Date(Date.now() - 1000) }).where(eq(schema.missionAttempts.id, f.attempt.id));
    await assert.rejects(pending, /no longer authorized/); assert.equal(p.calls, 0); assert.equal((await ledger(f)).providerCalls, 0);
  });
  await check('server workflow lease recheck after the wait prevents a physical model call', async () => {
    const f = await browserFixture(); await reset(250); await paceProviderRequest(request());
    const p = physical(), meter = meteredModel(p.model, async () => { await db.transaction(tx => attempts.claimedMission(tx, f.lease)); });
    const pending = meter.model.doGenerate({ prompt: [] });
    await delay(25); await db.update(schema.missions).set({ leaseUntil: new Date(Date.now() - 1000) }).where(eq(schema.missions.id, f.mission.id));
    await assert.rejects(pending); assert.equal(p.calls, 0); assert.equal(meter.usage().providerCalls, 0);
  });
  await check('lost reserve acknowledgement consumes a slot but starts no model and is not replayed', async () => {
    await reset(6000); let requests = 0;
    intercept = async (url, options) => { requests++; await originalFetch(url, options); throw new Error('Synthetic reply lost after DB commit'); };
    const p = physical(), meter = meteredModel(p.model); await assert.rejects(meter.model.doGenerate({ prompt: [] }), /reply lost/);
    assert.equal(requests, 1); assert.equal(p.calls, 0); assert.equal(meter.usage().providerCalls, 0);
    intercept = undefined; assert.equal((await paceProviderRequest(request())).allowed, false);
  });
  await check('physical 429 retains unknown accounting and shares cooldown with the next workflow', async () => {
    const error = new APICallError({ message: 'synthetic rejection', url: 'http://synthetic.invalid', requestBodyValues: {}, statusCode: 429, responseHeaders: { 'retry-after': '27' } });
    const p = physical(() => { throw error; }), meter = meteredModel(p.model);
    await assert.rejects(meter.model.doGenerate({ prompt: [] }), e => e === error);
    assert.equal(p.calls, 1); assert.equal(meter.usage().providerCalls, 1); assert.equal(meter.usage().totalTokens, null); assert.equal(meter.usage().unknownCalls, 1);
    const next = await paceProviderRequest(request()); assert.equal(next.allowed, false); assert.ok(next.waitMs > 26000);
  });
  await check('actual Iris429 keeps its durable unknown fence after the shared cooldown is gone', async () => {
    const f = await browserFixture();
    const error = new APICallError({ message: 'synthetic rejection', url: 'http://synthetic.invalid', requestBodyValues: {}, statusCode: 429, responseHeaders: { 'retry-after': '27' } });
    const p = physical(() => { throw error; });
    await assert.rejects(withIrisModelBudget(p.model, f.event, f.ctx).doGenerate({ prompt: [] }));
    assert.equal(p.calls, 1); assert.equal((await ledger(f)).providerCalls, 1); assert.equal((await ledger(f)).tokens, null);
    const next = await paceProviderRequest(request()); assert.equal(next.allowed, false); assert.ok(next.waitMs > 26000);
    await reset(); // Remove only this fixture's pacing bucket, not Iris history.
    const nextProvider = physical();
    await assert.rejects(withIrisModelBudget(nextProvider.model, f.event, f.ctx).doGenerate({ prompt: [] }));
    assert.equal(nextProvider.calls, 0); assert.equal((await ledger(f)).providerCalls, 1);
  });
  await check('authored Grunden selection plus Iris wrapper paces once before the physical ledger', async () => {
    const f = await browserFixture(), actions = []; let providerCalls = 0;
    intercept = async (url, options) => {
      if (String(url) === 'https://api.grunden.ai/v1/chat/completions') {
        providerCalls++; actions.push('provider');
        return new Response(JSON.stringify({ id: 'fixture', created: 0, model: 'glm-5.3', object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: 'Synthetic response' }, finish_reason: 'stop' }], usage: { prompt_tokens: 2, completion_tokens: 1 } }), { headers: { 'content-type': 'application/json' } });
      }
      assert.ok(String(url).startsWith(`${origin}/`)); const body = JSON.parse(options.body); actions.push(body.action ?? body.kind);
      return originalFetch(url, options);
    };
    const selection = grundenModelSelection('glm-5.3', 'low', false, true);
    await withIrisModelBudget(selection.model, f.event, f.ctx).doGenerate({ prompt: [] });
    assert.equal(providerCalls, 1); assert.deepEqual(actions, ['reserve', 'model_started', 'provider', 'model_finished']);
    assert.equal((await ledger(f)).tokens, 3);
  });
  console.log(JSON.stringify({ status: 'passed', checks: passed.length, database: 'actual isolated PostgreSQL', transport: 'authored H3; deterministic in-process provider, no LLM calls', passed }));
} finally {
  globalThis.fetch = originalFetch; server.close(); server.closeAllConnections(); await once(server, 'close');
  await db.delete(schema.providerPacing).where(inArray(schema.providerPacing.bucketHash, [...buckets]));
  await db.delete(schema.user).where(eq(schema.user.id, owner)); await app.close();
}
