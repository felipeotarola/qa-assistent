import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { registerHooks } from 'node:module';
import { createApp, createRouter, defineEventHandler, getQuery, getRequestHeader, toNodeListener } from 'h3';
import { eq } from 'drizzle-orm';
import { controllerFixture } from './helpers/mission-controller-fixture.mjs';

// Actual PostgreSQL and authored H3/listing code. Auth and fixture executors
// are synthetic. Queue imports fail closed so a regressed GET cannot run work.
assert.equal(process.env.GRUNDEN_API_TOKEN, '');
const nativeFetch = globalThis.fetch, h = await controllerFixture(), { db, schema } = h;
globalThis.getQuery = getQuery;
let queueCalls = 0, background = 0;
globalThis.forbiddenAssessmentGetWork = () => { queueCalls++; throw new Error('GET must not execute queue work'); };
const routeUrl = new URL('../server/api/workspaces/[id]/assessments.get.ts', import.meta.url).href;
const hooks = registerHooks({ resolve(specifier, context, next) {
  if (context.parentURL === routeUrl && /result-review-(worker|notifications)$/.test(specifier)) {
    const name = specifier.endsWith('worker') ? 'processReviewQueue' : 'notifyReviewedResults';
    return { url: `data:text/javascript,${encodeURIComponent(`export const ${name}=globalThis.forbiddenAssessmentGetWork`)}`, shortCircuit: true };
  }
  return next(specifier, context);
} });
const session = randomUUID(), foreign = randomUUID(), router = createRouter();
router.get('/api/workspaces/:id/assessments', (await import(routeUrl)).default);
const server = createServer(toNodeListener(createApp().use(defineEventHandler(event => {
  const cookie = getRequestHeader(event, 'cookie');
  event.context.appSession = Promise.resolve(cookie === `fixture-session=${session}` ? { user: { id: h.owner } }
    : cookie === `fixture-session=${foreign}` ? { user: { id: foreign } } : null);
  event.waitUntil = () => { background++; throw new Error('GET must not schedule work'); };
})).use(router)));
server.listen(0, '127.0.0.1'); await once(server, 'listening');
const origin = `http://127.0.0.1:${server.address().port}`;
globalThis.fetch = (url, options) => { assert.ok(String(url).startsWith(`${origin}/`), 'External execution is forbidden'); return nativeFetch(url, options); };
const checks = [];
async function read(f, { runId, cookie = session, status = 200 } = {}) {
  const response = await fetch(`${origin}/api/workspaces/${f.workspace}/assessments${runId ? `?runId=${runId}` : ''}`, { headers: cookie ? { cookie: `fixture-session=${cookie}` } : {} });
  const body = await response.json(); assert.equal(response.status, status, body.statusMessage ?? body.message);
  assert.equal(response.headers.get('cache-control'), 'private, no-store'); return body;
}
async function persisted(f) {
  const state = await h.state(f);
  for (const name of ['testRuns', 'resultAssessments']) state[name] = await db.select().from(schema[name]).where(eq(schema[name].workspaceId, f.workspace));
  state.events = await h.rows(schema.missionEvents, f.id);
  return JSON.stringify(state);
}
try {
  const f = await h.fixture(); await h.browserReady(f); const [run] = await h.finishBrowser(f);
  await h.until(f, state => state.attempts.some(attempt => attempt.kind === 'review'));
  const [job] = await db.select().from(schema.resultAssessments).where(eq(schema.resultAssessments.runId, run.id));
  assert.ok(job);
  for (const controlled of [true, false]) {
    if (!controlled) await db.update(schema.testRuns).set({ missionAttemptId: null }).where(eq(schema.testRuns.id, run.id));
    for (const status of ['queued', 'running', 'completed']) {
      await db.update(schema.resultAssessments).set({ status, notification: controlled ? 'recorded' : 'pending',
        leaseUntil: status === 'running' ? new Date(0) : null, finishedAt: status === 'completed' ? new Date(0) : null }).where(eq(schema.resultAssessments.id, job.id));
      const before = await persisted(f), calls = h.calls.length;
      for (let i = 0; i < 2; i++) {
        const body = await read(f, { runId: run.id });
        assert.equal(body.assessments.length, 1); assert.equal(body.assessments[0].status, status);
      }
      assert.equal(await persisted(f), before); assert.equal(h.calls.length, calls);
      assert.equal(queueCalls, 0); assert.equal(background, 0);
      checks.push(`${controlled ? 'controlled' : 'legacy'} ${status} GET is read-only, including expired leases and pending notifications`);
    }
  }
  const before = await persisted(f);
  await read(f, { cookie: null, status: 401 }); await read(f, { cookie: foreign, status: 404 });
  assert.deepEqual((await read(f, { runId: randomUUID() })).assessments, []);
  assert.equal(await persisted(f), before); assert.equal(queueCalls, 0); assert.equal(background, 0);
  checks.push('ordinary session authorization and run filter remain intact without queue effects');
  console.log(JSON.stringify({ suite: 'assessment-list-read', passed: checks.length, checks }, null, 2));
} finally {
  globalThis.fetch = nativeFetch;
  server.close(); server.closeAllConnections(); await once(server, 'close');
  hooks.deregister(); delete globalThis.forbiddenAssessmentGetWork; await h.close();
}
