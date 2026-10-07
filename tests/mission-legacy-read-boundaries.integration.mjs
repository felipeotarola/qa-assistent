import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createApp, createRouter, defineEventHandler, toNodeListener } from 'h3';
import { eq } from 'drizzle-orm';
import { controllerFixture } from './helpers/mission-controller-fixture.mjs';

// Authored internal routes/readers + actual isolated PostgreSQL. Preparation
// uses synthetic models/executors; reads must invoke none of them or write state.
assert.equal(process.env.GRUNDEN_API_TOKEN, '');
const nativeFetch = globalThis.fetch, h = await controllerFixture(), { db, schema } = h;
const router = createRouter();
router.post('/api/internal/mission', (await import('../server/api/internal/mission.post.ts')).default);
router.post('/api/internal/mission-report', (await import('../server/api/internal/mission-report.post.ts')).default);
let background = 0;
const server = createServer(toNodeListener(createApp().use(defineEventHandler(event => {
  event.waitUntil = () => { background++; throw new Error('Reading must not schedule work'); };
})).use(router)));
server.listen(0, '127.0.0.1'); await once(server, 'listening');
const origin = `http://127.0.0.1:${server.address().port}`;
globalThis.fetch = (url, options) => { assert.ok(String(url).startsWith(`${origin}/`)); return nativeFetch(url, options); };
const checks = [];
async function post(path, body, status = 200, authenticated = true) {
  const response = await fetch(`${origin}/api/internal/${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(authenticated ? { authorization: `Bearer ${process.env.INTERNAL_API_SECRET}` } : {}) }, body: JSON.stringify(body) });
  const value = await response.json(); assert.equal(response.status, status, value.statusMessage ?? value.message); return value;
}
const read = (f, status = 200) => post('mission', { userId: h.owner, threadId: f.thread, action: 'read', missionId: f.id }, status);
const report = (f, reportId, status = 200) => post('mission-report', { userId: h.owner, threadId: f.thread, reportId }, status);
async function persisted(f) {
  const state = await h.state(f);
  for (const name of ['missionEvents', 'missionSnapshots', 'missionWaits']) state[name] = await h.rows(schema[name], f.id);
  state.reviews = await db.select().from(schema.resultAssessments).where(eq(schema.resultAssessments.workspaceId, f.workspace));
  return JSON.stringify(state, (_key, value) => Array.isArray(value) && value.every(v => v && typeof v === 'object' && 'id' in v) ? [...value].sort((a, b) => a.id.localeCompare(b.id)) : value);
}
try {
  const f = await h.fixture(); await h.browserReady(f);
  const task = (await h.rows(schema.missionTasks, f.id)).find(task => task.sources.some(source => source.type === 'research'));
  const sourceId = task.sources.find(source => source.type === 'research').id, source = await h.row(schema.workspaceItems, sourceId);
  const changed = await h.saveItem(h.owner, f.workspace, { id: source.id, expectedVersion: source.version, title: 'Updated observed source', content: { kind: 'text', text: 'Fresh independently stored content.' } });
  const before = await persisted(f), calls = h.calls.length;
  for (let i = 0; i < 3; i++) {
    const view = await read(f), result = view.tasks.find(value => value.id === task.id).results.find(value => value.sourceId === sourceId);
    assert.equal(result.summary, changed.title); assert.equal(result.evidence[0].version, changed.version); assert.match(result.evidence[0].excerpt, /Fresh independently stored content/);
    assert.equal(view.mission.revision, (await h.row(schema.missions, f.id)).revision);
  }
  assert.equal(await persisted(f), before); assert.equal(h.calls.length, calls); assert.equal(background, 0);
  checks.push('autonomous legacy-tool reads return fresh versions without cache/revision/event/queue writes');

  await db.update(schema.workspaceItems).set({ deletedAt: new Date() }).where(eq(schema.workspaceItems.id, sourceId));
  const missingBefore = await persisted(f), missing = await read(f);
  const unavailable = missing.tasks.find(value => value.id === task.id).results.find(value => value.sourceId === sourceId);
  assert.equal(unavailable.status, 'unknown'); assert.equal(unavailable.evidence.length, 0);
  assert.equal(await persisted(f), missingBefore);
  checks.push('deleted autonomous source is returned as unknown without persisting a replacement');

  const old = await h.missions.missionAction(h.owner, f.workspace, f.thread, { action: 'create', requestId: randomUUID(), config: {
    title: 'Historical mission', goal: 'Read historical saved inputs.', scope: 'Saved sources only', target: null, caseKeys: [], automaticReports: false,
    criteria: [{ id: 'input', text: 'Saved source', delivery: { kind: 'source', sourceTypes: ['material'] } }],
  } });
  const oldBefore = await h.row(schema.missions, old.id); await read({ ...f, id: old.id });
  assert.ok((await h.row(schema.missions, old.id)).revision > oldBefore.revision);
  checks.push('historical mission tool-read compatibility retains its explicit reconciliation');

  const done = await h.fixture({ intent: 'report_only' }), final = await h.settle(done), saved = final.reports.find(value => value.status === 'completed');
  assert.ok(saved?.itemId);
  const snapshot = await h.row(schema.missionSnapshots, saved.snapshotId);
  assert.ok(final.mission.revision > snapshot.revision);
  const finalBefore = await persisted(done), finalCalls = h.calls.length;
  for (let i = 0; i < 2; i++) { assert.equal((await report(done, saved.id)).stale, false); await read(done); }
  assert.equal(await persisted(done), finalBefore); assert.equal(h.calls.length, finalCalls);
  checks.push('completed internal report stays fresh after controller closure and compatibility reads are pure');

  const selected = final.tasks.flatMap(task => task.sources).find(source => source.type === 'material');
  await db.update(schema.workspaceItems).set({ content: { kind: 'text', text: 'Same-version source correction' } }).where(eq(schema.workspaceItems.id, selected.id));
  const editedBefore = await persisted(done); assert.equal((await report(done, saved.id)).stale, true);
  assert.equal(await persisted(done), editedBefore);
  checks.push('internal report reader detects same-version changed source through fingerprint');

  await read({ ...done, thread: f.thread }, 404); await report(f, saved.id, 404);
  await post('mission', { userId: randomUUID(), threadId: done.thread, action: 'read', missionId: done.id }, 404);
  await post('mission-report', { userId: h.owner, threadId: done.thread, reportId: saved.id }, 401, false);
  assert.equal(background, 0); assert.equal(await persisted(done), editedBefore);
  checks.push('internal authorization and workspace boundaries survive both compatibility readers');
  console.log(JSON.stringify({ suite: 'mission-legacy-read-boundaries', passed: checks.length, checks }, null, 2));
} finally {
  globalThis.fetch = nativeFetch; server.close(); server.closeAllConnections(); await once(server, 'close'); await h.close();
}
