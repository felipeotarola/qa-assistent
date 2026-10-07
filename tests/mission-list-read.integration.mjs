import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createApp, createRouter, defineEventHandler, getRequestHeader, toNodeListener } from 'h3';
import { eq } from 'drizzle-orm';
import { controllerFixture } from './helpers/mission-controller-fixture.mjs';

// Actual PostgreSQL + authored H3 routes and schedule handler. Session identity,
// report model and the parent notification receiver are synthetic. No live
// model, parent agent or external service is called.
assert.equal(process.env.GRUNDEN_API_TOKEN, '');
const nativeFetch = globalThis.fetch, h = await controllerFixture(), { db, schema } = h;
const session = randomUUID(), foreignSession = randomUUID(), foreignOwner = randomUUID();
const previousOrigin = process.env.APP_URL;
const router = createRouter();
router.get('/api/workspaces/:id/missions', (await import('../server/api/workspaces/[id]/missions.get.ts')).default);
router.post('/api/internal/mission-reports/drain', (await import('../server/api/internal/mission-reports/drain.post.ts')).default);
let background = 0, notifications = 0, drains = 0;
router.post('/workers/mission-report/notify', defineEventHandler(event => {
  assert.equal(getRequestHeader(event, 'authorization'), `Bearer ${process.env.INTERNAL_API_SECRET}`);
  notifications++; return { ok: true };
}));
const server = createServer(toNodeListener(createApp().use(defineEventHandler(event => {
  const cookie = getRequestHeader(event, 'cookie');
  event.context.appSession = Promise.resolve(cookie === `fixture-session=${session}` ? { user: { id: h.owner } }
    : cookie === `fixture-session=${foreignSession}` ? { user: { id: foreignOwner } } : null);
  event.waitUntil = () => { background++; throw new Error('GET must not schedule work'); };
  if (event.path === '/api/internal/mission-reports/drain') drains++;
})).use(router)));
server.listen(0, '127.0.0.1'); await once(server, 'listening');
const origin = `http://127.0.0.1:${server.address().port}`;
process.env.APP_URL = origin;
globalThis.fetch = (url, options) => { assert.ok(String(url).startsWith(`${origin}/`), 'External execution is forbidden'); return nativeFetch(url, options); };
const passed = [], failures = [];
async function check(name, run) { try { await run(); passed.push(name); } catch (error) { failures.push({ name, message: error.message, stack: error.stack }); console.error(`FAILED ${name}: ${error.message}`); } }
async function read(f, { authenticated = true, foreign = false, workspace = f.workspace, status = 200 } = {}) {
  const response = await fetch(`${origin}/api/workspaces/${workspace}/missions`, { headers: authenticated ? { cookie: `fixture-session=${foreign ? foreignSession : session}` } : {} });
  const body = await response.json(); assert.equal(response.status, status, body.statusMessage ?? body.message);
  assert.match(response.headers.get('cache-control'), /private, no-store/);
  return body;
}
async function legacy(f, automaticReports = false) {
  return h.missions.missionAction(h.owner, f.workspace, f.thread, { action: 'create', requestId: randomUUID(),
    config: { title: 'Historical report workflow', goal: 'Summarize saved observations.', scope: 'Saved evidence only', target: null, caseKeys: [], automaticReports,
      criteria: [{ id: 'source', text: 'Saved observations', delivery: { kind: 'source', sourceTypes: ['research'] } }] } });
}
async function persisted(f) {
  const state = {};
  state.missions = await db.select().from(schema.missions).where(eq(schema.missions.workspaceId, f.workspace));
  for (const name of ['missionTasks', 'missionAttempts', 'missionEvents', 'missionSnapshots', 'missionReports', 'missionWaits', 'missionResourceClaims']) {
    state[name] = [];
    for (const mission of state.missions) state[name].push(...await h.rows(schema[name], mission.id));
  }
  for (const name of ['workspaceItems', 'testRuns', 'resultAssessments', 'browserAssignments']) state[name] = await db.select().from(schema[name]).where(eq(schema[name].workspaceId, f.workspace));
  state.browserJobs = await db.select().from(schema.browserJobs).where(eq(schema.browserJobs.threadId, f.thread));
  return JSON.stringify(state, (_key, value) => Array.isArray(value) && value.every(v => v && typeof v === 'object' && 'id' in v) ? [...value].sort((a, b) => a.id.localeCompare(b.id)) : value);
}
try {
  await check('dirty legacy work stays unchanged on GET and existing scheduled drain still generates and notifies', async () => {
    const f = await h.fixture(), old = await legacy(f, true), past = new Date(Date.now() - 360000);
    await db.update(schema.missions).set({ dirtySince: past, reconciledAt: past, updatedAt: past }).where(eq(schema.missions.id, old.id));
    await db.insert(schema.chatRuntimes).values({ threadId: f.thread, runtime: process.env.PAT_RUNTIME_SCOPE, sessionId: `synthetic-parent-${randomUUID()}` });
    const before = await persisted(f), calls = h.calls.length;
    const list = await read(f); await read(f);
    assert.deepEqual(new Set(list.missions.map(m => m.id)), new Set([f.id, old.id]));
    assert.equal(await persisted(f), before); assert.equal(h.calls.length, calls);
    assert.equal(background, 0); assert.equal(drains, 0); assert.equal(notifications, 0);
    const schedule = (await import('../agent/schedules/mission-reports.ts')).default;
    assert.equal(schedule.cron, '* * * * *');
    const controlledBefore = await h.state(f);
    await schedule.run({});
    assert.equal(drains, 1);
    const reports = await h.rows(schema.missionReports, old.id);
    assert.equal(reports.length, 1, JSON.stringify({ calls: h.calls, mission: await h.row(schema.missions, old.id) }));
    assert.equal(reports[0].status, 'completed', reports[0].error); assert.equal(reports[0].notification, 'sent'); assert.ok(reports[0].itemId);
    assert.equal(notifications, 1);
    // An empty evidence set produces the existing deterministic partial report.
    assert.equal(h.calls.filter(call => call.kind === 'report:model').length, 0);
    assert.deepEqual(await h.state(f), controlledBefore, 'Legacy refresh must not adopt or advance controlled missions');
  });
  await check('active, waiting and completed controlled missions remain read-only', async () => {
    const active = await h.fixture(); await h.browserReady(active);
    const waiting = await h.fixture(), task = (await h.rows(schema.missionTasks, waiting.id))[0];
    await db.transaction(async tx => h.control.createMissionWait(tx, await h.row(schema.missions, waiting.id), { reason: 'clarification', taskIds: [task.id], question: 'Which requirement?' }));
    const complete = await h.fixture({ intent: 'report_only' }); await h.settle(complete);
    const calls = h.calls.length, notified = notifications, drained = drains;
    for (const f of [active, waiting, complete]) {
      const before = await persisted(f);
      for (let n = 0; n < 3; n++) assert.ok((await read(f)).missions.some(m => m.id === f.id));
      assert.equal(await persisted(f), before);
    }
    assert.equal(h.calls.length, calls); assert.equal(notifications, notified); assert.equal(drains, drained); assert.equal(background, 0);
  });
  await check('queued legacy and controlled reports are not claimed or processed by list reads', async () => {
    const f = await h.fixture({ intent: 'report_only' });
    await h.until(f, state => state.reports.some(report => report.status === 'queued'));
    const old = await legacy(f); await h.missions.requestMissionReport(h.owner, f.workspace, old.id);
    const before = await persisted(f), calls = h.calls.length;
    const list = await read(f); await read(f);
    assert.equal(list.missions.flatMap(m => m.reports).filter(r => r.status === 'queued').length, 2);
    assert.equal(await persisted(f), before); assert.equal(h.calls.length, calls); assert.equal(background, 0);
  });
  await check('closed historical mission and pending notification are not reconciled or notified by GET', async () => {
    const f = await h.fixture({ intent: 'report_only' }); await h.settle(f);
    const report = (await h.rows(schema.missionReports, f.id))[0], past = new Date(Date.now() - 120000);
    await db.update(schema.missions).set({ controllerVersion: null, dirtySince: past, reconciledAt: past, updatedAt: past }).where(eq(schema.missions.id, f.id));
    await db.update(schema.missionReports).set({ notification: 'pending' }).where(eq(schema.missionReports.id, report.id));
    const before = await persisted(f), notified = notifications, calls = h.calls.length;
    const result = await read(f); assert.equal(result.missions[0].status, 'closed'); assert.equal(result.missions[0].reports[0].status, 'completed');
    assert.equal(await persisted(f), before); assert.equal(notifications, notified); assert.equal(h.calls.length, calls); assert.equal(background, 0);
  });
  await check('unauthenticated and foreign-owner access cannot expose or mutate mission state', async () => {
    const f = await h.fixture(), before = await persisted(f);
    await read(f, { authenticated: false, status: 401 }); await read(f, { foreign: true, status: 404 });
    await read(f, { workspace: randomUUID(), status: 404 });
    assert.equal(await persisted(f), before); assert.equal(background, 0);
  });
  await check('workspace and runtime filters remain intact when admission is disabled', async () => {
    const f = await h.fixture(), other = await h.fixture(), runtime = process.env.PAT_RUNTIME_SCOPE, enabled = process.env.AUTONOMOUS_MISSIONS_ENABLED;
    assert.equal((await read(f)).missions.some(m => m.id === other.id), false);
    try {
      process.env.AUTONOMOUS_MISSIONS_ENABLED = 'false'; assert.ok((await read(f)).missions.some(m => m.id === f.id));
      process.env.PAT_RUNTIME_SCOPE = `${runtime}-different`; assert.deepEqual((await read(f)).missions, []);
    } finally { process.env.PAT_RUNTIME_SCOPE = runtime; process.env.AUTONOMOUS_MISSIONS_ENABLED = enabled; }
    assert.equal(background, 0);
  });
} finally {
  server.close(); server.closeAllConnections(); await once(server, 'close');
  if (previousOrigin === undefined) delete process.env.APP_URL; else process.env.APP_URL = previousOrigin;
  await h.close();
}
console.log(JSON.stringify({ suite: 'mission-list-read-api', passed: passed.length, failures }, null, 2));
if (failures.length) process.exitCode = 1;
