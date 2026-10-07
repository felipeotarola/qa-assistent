import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createApp, createRouter, defineEventHandler, getQuery, getRequestHeader, toNodeListener } from 'h3';
import { eq } from 'drizzle-orm';
import { controllerFixture } from './helpers/mission-controller-fixture.mjs';
import { IRIS_MODEL_LEDGER_PREFIX } from '../shared/browser-job.ts';

// Actual PostgreSQL + authored session GET routes. Supabase's resolved session
// and fixture setup executors are synthetic; GET must never invoke them.
assert.equal(process.env.GRUNDEN_API_TOKEN, '');
const nativeFetch = globalThis.fetch, h = await controllerFixture(), { db, schema } = h;
globalThis.getQuery = getQuery;
const session = randomUUID(), foreignSession = randomUUID(), foreignOwner = randomUUID();
const router = createRouter();
router.get('/api/workspaces/:id/autonomy', (await import('../server/api/workspaces/[id]/autonomy.get.ts')).default);
router.get('/api/workspaces/:id/autonomy/:missionId', (await import('../server/api/workspaces/[id]/autonomy/[missionId].get.ts')).default);
let background = 0;
const server = createServer(toNodeListener(createApp().use(defineEventHandler(event => {
  const cookie = getRequestHeader(event, 'cookie');
  event.context.appSession = Promise.resolve(cookie === `fixture-session=${session}` ? { user: { id: h.owner } }
    : cookie === `fixture-session=${foreignSession}` ? { user: { id: foreignOwner } } : null);
  event.waitUntil = () => { background++; throw new Error('GET must not schedule work'); };
})).use(router)));
server.listen(0, '127.0.0.1'); await once(server, 'listening');
const origin = `http://127.0.0.1:${server.address().port}`;
globalThis.fetch = (url, options) => { assert.ok(String(url).startsWith(`${origin}/`), 'External execution is forbidden'); return nativeFetch(url, options); };
const passed = [], failures = [];
async function check(name, run) { try { await run(); passed.push(name); } catch (error) { failures.push({ name, message: error.message, stack: error.stack }); console.error(`FAILED ${name}: ${error.message}`); } }
async function read(f, { list = false, query = '', authenticated = true, foreign = false, workspace = f.workspace, missionId = f.id, status = 200 } = {}) {
  const response = await fetch(`${origin}/api/workspaces/${workspace}/autonomy${list ? '' : `/${missionId}`}${query}`, { headers: authenticated ? { cookie: `fixture-session=${foreign ? foreignSession : session}` } : {} });
  const body = await response.json(); assert.equal(response.status, status, body.statusMessage ?? body.message);
  assert.match(response.headers.get('cache-control'), /private, no-store/);
  return body;
}
async function persisted(f) {
  const state = await h.state(f);
  for (const name of ['missionEvents', 'missionSnapshots', 'missionWaits']) state[name] = await h.rows(schema[name], f.id);
  for (const name of ['workspaceItems', 'testRuns', 'resultAssessments', 'browserAssignments']) state[name] = await db.select().from(schema[name]).where(eq(schema[name].workspaceId, f.workspace));
  state.browserJobs = await db.select().from(schema.browserJobs).where(eq(schema.browserJobs.threadId, f.thread));
  return JSON.stringify(state, (_key, value) => Array.isArray(value) && value.every(v => v && typeof v === 'object' && 'id' in v) ? [...value].sort((a, b) => a.id.localeCompare(b.id)) : value);
}
async function finished() {
  const f = await h.fixture({ intent: 'report_only' }); await h.settle(f); const saved = await h.state(f);
  f.report = saved.reports.find(report => report.status === 'completed');
  f.source = saved.tasks.flatMap(task => task.sources).find(source => source.type === 'material');
  assert.ok(f.report?.itemId); return f;
}
try {
  await check('session GET returns a bounded mission summary and numeric detail with original thread routing', async () => {
    const f = await h.fixture(), calls = h.calls.length;
    const detail = await read(f), list = await read(f, { list: true });
    assert.equal(detail.mission.id, f.id); assert.equal(detail.mission.threadId, f.thread);
    assert.equal(list.missions[0].threadId, f.thread); assert.equal(list.hasMore, false);
    assert.equal(detail.telemetry.attempts.logical, 0); assert.equal(detail.telemetry.tokens.total, 0);
    assert.equal(detail.telemetry.model.measured.inputTokens, null); assert.equal(detail.telemetry.monetaryCost, null);
    assert.equal(detail.telemetry.timing.modelMs, null); assert.equal(detail.telemetry.timing.heartbeatAgeMs, null);
    assert.equal(h.calls.length, calls); assert.equal(background, 0);
  });
  await check('unauthenticated and wrong-owner requests are denied before data is exposed', async () => {
    const f = await h.fixture();
    for (const list of [true, false]) {
      await read(f, { list, authenticated: false, status: 401 });
      await read(f, { list, foreign: true, status: 404 });
    }
  });
  await check('workspace and runtime boundaries exclude missions and telemetry', async () => {
    const f = await h.fixture(), other = await h.fixture();
    await read(f, { workspace: other.workspace, status: 404 });
    const previous = process.env.PAT_RUNTIME_SCOPE;
    try { process.env.PAT_RUNTIME_SCOPE = `${previous}-different`; await read(f, { status: 404 }); assert.deepEqual((await read(f, { list: true })).missions, []); }
    finally { process.env.PAT_RUNTIME_SCOPE = previous; }
  });
  await check('GET rejects malformed routing and unbounded or unknown list queries', async () => {
    const f = await h.fixture();
    await read(f, { workspace: 'invalid', status: 400 }); await read(f, { missionId: 'invalid', status: 400 });
    for (const query of ['?limit=0', '?limit=51', '?limit=1.2', '?limit=wat', '?limit=2&limit=3', '?runtime=other']) await read(f, { list: true, query, status: 400 });
    await read(f, { list: true, authenticated: false, query: '?limit=bad', status: 401 });
  });
  await check('list limit is applied before projection and exposes hasMore without foreign missions', async () => {
    const f = await h.fixture();
    for (let n = 0; n < 2; n++) await h.control.acceptMission(h.owner, f.workspace, f.thread, { requestId: randomUUID(), intent: 'explore', goal: 'Additional saved mission', target: f.target });
    const page = await read(f, { list: true, query: '?limit=2' }); assert.equal(page.missions.length, 2); assert.equal(page.hasMore, true);
    const all = await read(f, { list: true, query: '?limit=3' }); assert.equal(all.missions.length, 3); assert.equal(all.hasMore, false);
  });
  await check('measured provider tokens are not counted twice or expanded with cached input', async () => {
    const f = await h.fixture(), ready = await h.browserReady(f), attempt = ready.attempts.find(a => a.kind === 'browser_tests'), callId = randomUUID();
    await db.update(schema.missionAttempts).set({ toolCalls: 2, usage: { tokens: 25, toolCalls: 2, durationMs: 11 }, toolCallIds: [
      `${IRIS_MODEL_LEDGER_PREFIX}start:${callId}`,
      `${IRIS_MODEL_LEDGER_PREFIX}usage:${JSON.stringify({ callId, inputTokens: 20, outputTokens: 5, cacheReadTokens: 15, cacheWriteTokens: null, durationMs: 11 })}`,
    ] }).where(eq(schema.missionAttempts.id, attempt.id));
    const detail = await read(f), state = await h.state(f);
    assert.equal(detail.telemetry.tokens.total, state.attempts.reduce((sum, a) => sum + a.usage.tokens, 0));
    assert.deepEqual(detail.telemetry.model.measured, { inputTokens: 20, outputTokens: 5, cacheReadTokens: 15, cacheWriteTokens: null, durationMs: 11 });
    assert.equal(detail.telemetry.model.providers.tracked, 1); assert.equal(detail.telemetry.model.providers.total, null);
    const text = JSON.stringify(detail);
    for (const value of [attempt.id, attempt.dispatchId, attempt.operationId, callId, 'toolCallIds', 'leaseToken', 'readReceipts', 'requestHash', 'server:iris-model:', 'executorResourceId']) assert.equal(text.includes(value), false, value);
  });
  await check('unknown provider result remains unknown and retains its reservation in detail', async () => {
    const f = await h.fixture(), ready = await h.browserReady(f), attempt = ready.attempts.find(a => a.kind === 'browser_tests');
    await db.update(schema.missionAttempts).set({ usage: null, toolCallIds: [`${IRIS_MODEL_LEDGER_PREFIX}start:${randomUUID()}`] }).where(eq(schema.missionAttempts.id, attempt.id));
    const { telemetry } = await read(f);
    assert.equal(telemetry.tokens.total, null); assert.equal(telemetry.tokens.unknownAttempts, 1); assert.equal(telemetry.model.providers.unknownTokens, 1);
    assert.equal(telemetry.model.measured.inputTokens, null); assert.ok(telemetry.budget.work.chargedTokens >= attempt.reservedTokens);
  });
  await check('GET inventory includes only selected run reviews and keeps old-runtime physical claims visible', async () => {
    const f = await h.fixture(); await h.browserReady(f); const runs = await h.finishBrowser(f);
    const { enqueueReview } = await import('../server/utils/result-assessments.ts');
    await db.transaction(async tx => enqueueReview(tx, h.owner, f.workspace, runs[0].id, f.thread));
    const state = await h.state(f), assessment = (await db.select().from(schema.resultAssessments).where(eq(schema.resultAssessments.workspaceId, f.workspace)))[0];
    assert.ok(assessment);
    await db.insert(schema.resultAssessments).values({ ...assessment, id: randomUUID(), runtime: `${assessment.runtime}-other`, inputHash: randomUUID(), sourceHash: randomUUID() });
    await db.update(schema.missionResourceClaims).set({ owner: 'human', runtime: 'older-physical-runtime', expiresAt: new Date(0) }).where(eq(schema.missionResourceClaims.id, state.claims[0].id));
    const { telemetry, mission } = await read(f);
    assert.equal(telemetry.reviews.total, 1); assert.equal(telemetry.resources.pending, 1); assert.equal(telemetry.resources.humanOwned, 1);
    assert.equal(mission.resources.held, 1); assert.equal(mission.cleanupPending, true);
  });
  await check('report freshness tracks selected content, not lifecycle revision or unrelated workspace material', async () => {
    const f = await finished();
    assert.equal((await read(f)).mission.report.freshness, 'current');
    await h.saveItem(h.owner, f.workspace, { title: 'Unrelated material', content: { kind: 'text', text: 'Not selected in the report' } });
    assert.equal((await read(f)).mission.report.freshness, 'current');
    const source = await h.row(schema.workspaceItems, f.source.id);
    await h.saveItem(h.owner, f.workspace, { id: source.id, expectedVersion: source.version, title: source.title, content: { kind: 'text', text: 'Changed selected content' } });
    assert.equal((await read(f)).mission.report.freshness, 'stale');
    assert.equal((await read(f, { list: true })).missions[0].report.freshness, 'stale');
    await db.update(schema.workspaceItems).set({ deletedAt: new Date() }).where(eq(schema.workspaceItems.id, f.report.itemId));
    assert.equal((await read(f)).mission.report.itemId, null);
  });
  await check('repeated GETs of active, waiting and completed work perform no writes, queueing or execution', async () => {
    const active = await h.fixture(); await h.browserReady(active);
    const waiting = await h.fixture(), task = (await h.rows(schema.missionTasks, waiting.id))[0];
    await db.transaction(async tx => h.control.createMissionWait(tx, await h.row(schema.missions, waiting.id), { reason: 'clarification', taskIds: [task.id], question: 'Which saved requirement?' }));
    const complete = await finished(), calls = h.calls.length;
    for (const f of [active, waiting, complete]) {
      const before = await persisted(f);
      for (let n = 0; n < 2; n++) { await read(f); await read(f, { list: true }); }
      assert.equal(await persisted(f), before);
    }
    assert.equal(h.calls.length, calls); assert.equal(background, 0);
  });
  await check('disabled admission preserves read access and does not revive historical manual missions', async () => {
    const f = await h.fixture(), previous = process.env.AUTONOMOUS_MISSIONS_ENABLED;
    try { process.env.AUTONOMOUS_MISSIONS_ENABLED = 'false'; assert.equal((await read(f)).mission.id, f.id); }
    finally { process.env.AUTONOMOUS_MISSIONS_ENABLED = previous; }
    await db.update(schema.missions).set({ controllerVersion: null }).where(eq(schema.missions.id, f.id));
    await read(f, { status: 404 }); assert.deepEqual((await read(f, { list: true })).missions, []);
  });
} finally {
  server.close(); server.closeAllConnections(); await once(server, 'close');
  await h.close(); delete globalThis.getQuery;
}
console.log(JSON.stringify({ suite: 'autonomy-read-api', passed: passed.length, failures }, null, 2));
if (failures.length) process.exitCode = 1;
