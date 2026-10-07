import { stampUserRequest, userTextHash } from '../shared/mission-request-context.ts';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { registerHooks } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import { createApp, createRouter, defineEventHandler, getRequestHeader, toNodeListener } from 'h3';
import { eq, sql } from 'drizzle-orm';
import { isolatedApp } from './helpers/isolated-app.mjs';

// P1b contract tests: actual PostgreSQL, authored H3 routes and service methods.
// Supabase's resolved session and executor receipts are synthetic; no model,
// browser, runner, scheduler drain or external network executes these missions.
process.env.PAT_RUNTIME_SCOPE = `${process.env.PAT_RUNTIME_SCOPE}-control-${randomUUID()}`;
process.env.MISSIONS_ENABLED = 'true'; process.env.AUTONOMOUS_MISSIONS_ENABLED = 'true';
process.env.ENV_VAULT_KEY = `isolated-mission-control-${randomUUID()}`;
const app = await isolatedApp(), { db, schema } = app;
const control = await import('../server/utils/mission-control.ts');
const attempts = await import('../server/utils/mission-attempts.ts');
const { saveItem } = await import('../server/utils/workspaces.ts');
const { reconcileMission } = await import('../server/utils/missions.ts');
const { saveVaultEntry } = await import('../server/utils/project-vault.ts');
const { grantEnvironmentConsent, environmentPlanHash } = await import('../server/utils/environment-consents.ts');
const { sandboxScope } = await import('../server/utils/sandbox-scope.ts');
const owners = [randomUUID(), randomUUID()], workspaces = [randomUUID(), randomUUID()], threads = [randomUUID(), randomUUID()];
const sessions = [randomUUID(), randomUUID()], runtime = process.env.PAT_RUNTIME_SCOPE;
const target = { kind: 'public_url', url: 'https://example.test/start' }, repo = { kind: 'repository', url: 'https://github.com/fixture/mission-control', ref: 'main' };
const background = [], controllerKicks = [];
globalThis.missionControlRouteKick = async missionId => { controllerKicks.push(missionId); };
const routeUrl = new URL('../server/api/internal/autonomy.post.ts', import.meta.url).href;
const routeHook = registerHooks({ resolve(specifier, context, next) {
  if (context.parentURL !== routeUrl || specifier !== '../../utils/mission-controller') return next(specifier, context);
  return { url: `data:text/javascript,${encodeURIComponent('export const runMissionController = globalThis.missionControlRouteKick;')}`, shortCircuit: true };
} });
const router = createRouter();
router.post('/api/workspaces/:id/autonomy', (await import('../server/api/workspaces/[id]/autonomy.post.ts')).default);
router.post('/api/internal/autonomy', (await import('../server/api/internal/autonomy.post.ts')).default);
const server = createServer(toNodeListener(createApp().use(defineEventHandler(event => {
  const owner = sessions.indexOf(getRequestHeader(event, 'cookie')?.replace('fixture-session=', '') ?? '');
  event.context.appSession = Promise.resolve(owner < 0 ? null : { user: { id: owners[owner] } });
  event.waitUntil = promise => { background.push(Promise.resolve(promise)); };
})).use(router)));
server.listen(0, '127.0.0.1'); await once(server, 'listening');
const origin = `http://127.0.0.1:${server.address().port}`, originalFetch = globalThis.fetch;
globalThis.fetch = (url, options) => { assert.ok(String(url).startsWith(`${origin}/`), 'No external execution belongs in P1b contract tests'); return originalFetch(url, options); };
const pending = [], releases = new Set(), passed = [], failures = [];
const rejectStatus = (promise, expected = 409) => assert.rejects(promise, error => error.statusCode === expected);
async function check(name, run) { try { await run(); passed.push(name); } catch (error) { failures.push({ name, message: error.message, stack: error.stack }); console.error(`FAILED ${name}: ${error.message}`); } }
const input = (extra = {}) => ({ requestId: randomUUID(), intent: 'explore', goal: 'Testa denna webbplats och rapportera sparat underlag', target, ...extra });
const mission = (extra = {}, owner = 0) => control.acceptMission(owners[owner], workspaces[owner], threads[owner], input(extra));
const row = async (table, id) => (await db.select().from(table).where(eq(table.id, id)))[0];
const children = (table, missionId) => db.select().from(table).where(eq(table.missionId, missionId));
const tasks = m => children(schema.missionTasks, m.id);
async function claim(m) { const value = await attempts.claimMission(m.id); assert.ok(value, 'Expected controller lease'); return attempts.leaseIdentity(value); }
async function task(m, spec = { kind: 'discovery', target }, extra = {}) {
  return db.transaction(async tx => {
    await control.lockMission(tx, m.id);
    const [current] = await tx.select().from(schema.missions).where(eq(schema.missions.id, m.id));
    return control.addMissionTask(tx, current, { operationId: randomUUID(), title: 'Synthetic control task', spec, ...extra });
  });
}
async function wait(m, taskIds, reason = 'clarification', extra = {}) {
  return db.transaction(async tx => { await control.lockMission(tx, m.id); return control.createMissionWait(tx, await row(schema.missions, m.id), { taskIds, reason, question: 'Vilket sparat krav ska granskas?', ...extra }); });
}
async function savedInspection(m) {
  // Stored synthetic executor receipt, not a free UUID or a real clone. Keep the
  // repository, runtime, mission source and pinned commit consistent while this
  // suite exercises admission/wait contracts without invoking an executor.
  const inspectedRunId = randomUUID(), expectedCommit = 'a'.repeat(40), observedAt = new Date().toISOString();
  const discovery = (await tasks(m)).find(t => t.spec.kind === 'discovery');
  const [repository] = await db.insert(schema.repositories).values({ id: randomUUID(), workspaceId: m.workspaceId, url: repo.url, ref: repo.ref })
    .onConflictDoUpdate({ target: [schema.repositories.workspaceId, schema.repositories.url], set: { ref: repo.ref } }).returning();
  const config = { url: repo.url, ref: repo.ref, script: 'auto', mode: 'inspect', workspaceId: m.workspaceId };
  await db.insert(schema.repositoryRuns).values({ id: inspectedRunId, repositoryId: repository.id, workspaceId: m.workspaceId, runtime,
    requestId: randomUUID(), bindingVersion: 1, missionBinding: { missionId: m.id, taskId: discovery.id }, config,
    job: { ...config, id: inspectedRunId, status: 'review', message: 'Synthetic inspection receipt for control contracts', logs: '', commit: expectedCommit,
      package: null, testExitCode: null, createdAt: observedAt, updatedAt: observedAt, finishedAt: observedAt,
      cleanup: { resourceId: inspectedRunId, confirmed: true, observedAt } } });
  await db.update(schema.missionTasks).set({ sources: [{ type: 'repository', id: inspectedRunId }], state: 'completed' }).where(eq(schema.missionTasks.id, discovery.id));
  return { inspectedRunId, expectedCommit };
}
const action = (m, type, extra = {}) => ({ action: type, missionId: m.id, requestId: randomUUID(), expectedMandateRevision: m.mandateRevision, ...extra });
const operate = (m, type, extra = {}, owner = 0) => control.controlMission(owners[owner], workspaces[owner], threads[owner], action(m, type, extra));
const receipt = (attempt, source, extra = {}) => ({ version: 1, dispatchId: attempt.dispatchId, sourceType: 'research', sourceId: source.id, status: 'completed', sequence: 1, receivedAt: new Date().toISOString(), ...extra });
let research, foreignResearch, caseKey;
async function operation(attempt, extra = {}) {
  return attempts.authorizeMissionOperation({ userId: owners[0], workspaceId: workspaces[0], attemptId: attempt.id, dispatchId: attempt.dispatchId, callId: randomUUID(), tool: 'research', input: { action: 'inspect', url: target.url }, url: target.url, ...extra });
}
async function api(value, { owner = 0, workspace = workspaces[owner], thread = threads[owner], expected = 200, internal = false, authenticated = true, requestContext } = {}) {
  const response = await fetch(`${origin}${internal ? '/api/internal/autonomy' : `/api/workspaces/${workspace}/autonomy`}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(authenticated ? internal ? { authorization: `Bearer ${process.env.INTERNAL_API_SECRET}` } : { cookie: `fixture-session=${sessions[owner]}` } : {}) }, body: JSON.stringify({ ...(internal ? { userId: owners[owner] } : {}), threadId: thread, ...(requestContext ? { requestContext } : {}), input: value }) });
  const result = await response.json(); assert.equal(response.status, expected, `Unexpected response: ${result.statusMessage ?? result.message ?? result.lifecycle}`);
  if (response.ok) for (const field of ['leaseToken', 'leaseUntil', 'mandate', 'admission', 'dispatchId', 'requestHash', 'toolCallIds']) assert.ok(!(field in result), `Private ${field} leaked to caller`);
  return result;
}
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
function barrier() { const entered = deferred(), released = deferred(); releases.add(released.resolve); return { entered: entered.promise, wait: async () => { entered.resolve(); await released.promise; }, release: () => { released.resolve(); releases.delete(released.resolve); } }; }
function track(promise) { pending.push(promise); return promise; }
async function bounded(promise, label) {
  const controller = new AbortController();
  try { return await Promise.race([promise, delay(10000, undefined, { signal: controller.signal }).then(() => { throw new Error(`Timeout: ${label}`); })]); }
  finally { controller.abort(); }
}
async function waiter(key) {
  for (let retry = 0; retry < 150; retry++) {
    const [{ count }] = await db.execute(sql`select count(*)::int as count from pg_locks where locktype = 'advisory' and not granted
      and classid::bigint = ((hashtextextended(${key}, 0) >> 32) & 4294967295)
      and objid::bigint = (hashtextextended(${key}, 0) & 4294967295)
      and database = (select oid from pg_database where datname = current_database())`);
    if (count) return; await delay(10);
  }
  throw new Error('Expected real advisory lock contention');
}

try {
  assert.equal(process.env.GRUNDEN_API_TOKEN, '');
  for (let owner = 0; owner < owners.length; owner++) {
    await db.insert(schema.user).values({ id: owners[owner], name: 'Mission control fixture', email: `${owners[owner]}@example.test` });
    await db.insert(schema.workspaces).values({ id: workspaces[owner], userId: owners[owner], name: 'Mission control fixture' });
    await db.insert(schema.threads).values({ id: threads[owner], userId: owners[owner], workspaceId: workspaces[owner], title: 'Mission control fixture' });
  }
  const evidence = owner => saveItem(owners[owner], workspaces[owner], { title: 'Saved synthetic research observation', content: { kind: 'text', text: 'Observed example page title and links in the fixture.' } }, db, { provenance: { version: 1, origin: 'tool', producer: 'research-page', sourceType: 'research', observedAt: new Date().toISOString(), url: target.url } });
  research = await evidence(0); foreignResearch = await evidence(1);
  const caseId = randomUUID(), plan = await saveItem(owners[0], workspaces[0], { title: 'Mission control test plan', content: { kind: 'test_plan', sources: [], cases: [{ id: caseId, title: 'A discovered link', type: 'browser', preconditions: '', steps: 'Click link', expected: 'Destination opens' }] } });
  caseKey = `${plan.id}:${caseId}`;

  await check('authored session/internal routes isolate identity and expose only public fields', async () => {
    const accepted = await api({ action: 'accept', ...input() }); assert.ok(accepted.id); assert.equal(accepted.lifecycle, 'accepted');
    const { saveChatEvents } = await import('../server/utils/chat-history.ts');
    const original = input(), rootSession = randomUUID(), turnId = 'turn_0', nonce = randomUUID();
    const requestEvent = { type: 'message.received', meta: { id: randomUUID(), at: new Date().toISOString() },
      data: { message: original.goal, parts: [{ type: 'text', text: original.goal }], sequence: 0, turnId } };
    requestEvent.data.userRequest = stampUserRequest(requestEvent, { userId: owners[0], threadId: threads[0], sessionId: rootSession, runtime, turnId },
      { browserUserInput: JSON.stringify({ version: 1, nonce, textSha256: userTextHash(original.goal) }) });
    await saveChatEvents(owners[0], threads[0], rootSession, [{ type: 'turn.started', meta: { id: randomUUID(), at: requestEvent.meta.at }, data: { sequence: 0, turnId } }, requestEvent], runtime);
    const requestContext = { sessionId: rootSession, turnId, nonce, runtime, priorUserMessageIds: [] };
    const { goal: _goal, ...internalInput } = original;
    const internal = await api({ action: 'accept', ...internalInput }, { internal: true, requestContext }); assert.ok(internal.missionId); assert.equal(internal.background, true);
    assert.deepEqual(controllerKicks, [internal.missionId]);
    const admitted = await row(schema.missions, internal.missionId);
    assert.equal(admitted.admission.goal, _goal);
    await api({ action: 'accept', ...input() }, { internal: true, requestContext, expected: 400 });
    await api({ action: 'accept', ...internalInput }, { internal: true, expected: 400 });
    assert.deepEqual(controllerKicks, [internal.missionId]);
    await api({ action: 'accept', ...input() }, { authenticated: false, expected: 401 });
    await api({ action: 'accept', ...input() }, { internal: true, authenticated: false, expected: 401 });
    await api({ action: 'accept', ...input() }, { thread: threads[1], expected: 404 });
    await api({ action: 'accept', ...input() }, { workspace: workspaces[1], expected: 404 });
    await api({ action: 'accept', ...input() }, { internal: true, thread: threads[1], expected: 404 });
  });

  await check('concurrent admission deduplicates exact input and rejects changed payload', async () => {
    const body = input(), admit = () => control.acceptMission(owners[0], workspaces[0], threads[0], body);
    const [a, b] = await Promise.all([admit(), admit()]); assert.equal(a.id, b.id);
    assert.equal((await tasks(a)).length, 1); assert.equal((await children(schema.missionEvents, a.id)).length, 1);
    await rejectStatus(control.acceptMission(owners[0], workspaces[0], threads[0], { ...body, goal: 'Different goal' }));
    await rejectStatus(control.acceptMission(owners[1], workspaces[0], threads[1], body), 404);
    await rejectStatus(control.acceptMission(owners[0], workspaces[0], threads[1], body), 404);
    process.env.AUTONOMOUS_MISSIONS_ENABLED = 'false';
    try { assert.equal((await admit()).id, a.id); await rejectStatus(mission(), 503); }
    finally { process.env.AUTONOMOUS_MISSIONS_ENABLED = 'true'; }
  });

  await check('runtime separation denies control, operations and adoption of other runtime missions', async () => {
    const m = await mission(), lease = await claim(m), reserved = await attempts.reserveMissionAttempt(lease, (await tasks(m))[0].id);
    process.env.PAT_RUNTIME_SCOPE = `${runtime}-other`;
    try {
      await rejectStatus(operate(m, 'pause'), 404); assert.equal(await attempts.claimMission(m.id), null);
      await rejectStatus(operation(reserved.attempt), 404);
    } finally { process.env.PAT_RUNTIME_SCOPE = runtime; }
    await rejectStatus(operate(m, 'pause', {}, 1), 404);
  });

  await check('report-only uses saved sources and cannot admit execution', async () => {
    const m = await mission({ intent: 'report_only', target: null, sourceRefs: [{ type: 'research', id: research.id }] });
    const [first] = await tasks(m); assert.equal(first.spec.kind, 'report'); assert.equal(first.results[0].sourceId, research.id);
    await rejectStatus(task(m), 403);
    const lease = await claim(m), reserved = await attempts.reserveMissionAttempt(lease, first.id);
    assert.equal(reserved.status, 'reserved'); await rejectStatus(operation(reserved.attempt), 403);
    await rejectStatus(mission({ intent: 'report_only', target: null }), 400);
    await rejectStatus(mission({ sourceRefs: [{ type: 'research', id: foreignResearch.id }] }), 404);
  });

  await check('typed task scope and immutable operation identity are rechecked server-side', async () => {
    const m = await mission({ caseKeys: [caseKey] });
    await rejectStatus(task(m, { kind: 'discovery', target: { kind: 'public_url', url: 'https://outside.example' } }), 403);
    await rejectStatus(task(m, { kind: 'browser_tests', target: { ...m.config.target, url: 'https://outside.example' }, caseKeys: [caseKey] }), 403);
    await rejectStatus(task(m, { kind: 'browser_tests', target: m.config.target, caseKeys: [`${randomUUID()}:${randomUUID()}`] }), 403);
    const operationId = randomUUID(), first = await task(m, { kind: 'planning', sourceRefs: [] }, { operationId });
    assert.equal((await task(m, { kind: 'planning', sourceRefs: [] }, { operationId })).id, first.id);
    await rejectStatus(task(m, { kind: 'planning', sourceRefs: [] }, { operationId, dependsOn: [(await tasks(m))[0].id] }));
    const browser = await task(m, { kind: 'browser_tests', target: m.config.target, caseKeys: [caseKey] }), lease = await claim(m);
    await rejectStatus(attempts.reserveMissionAttempt(lease, browser.id));
  });

  await check('two independent typed waits do not block an unrelated branch', async () => {
    const m = await mission(), a = await task(m), b = await task(m), independent = await task(m);
    const wa = await wait(m, [a.id]), wb = await wait(m, [b.id]);
    assert.equal((await wait(m, [a.id])).id, wa.id);
    const lease = await claim(m); assert.equal((await attempts.reserveMissionAttempt(lease, independent.id)).status, 'reserved');
    const answered = await operate(m, 'answer', { waitId: wa.id, answer: { kind: 'text', text: 'Kontrollera den sparade länken.' } });
    assert.equal(answered.lifecycle, 'running'); assert.equal((await row(schema.missionTasks, a.id)).state, 'pending'); assert.equal((await row(schema.missionTasks, b.id)).state, 'waiting');
    const expiredAt = new Date(Date.now() - 100);
    await db.update(schema.missionWaits).set({ deadlineAt: expiredAt }).where(eq(schema.missionWaits.id, wb.id));
    await db.transaction(async tx => { await control.lockMission(tx, m.id); await attempts.expireMissionWaits(tx, await row(schema.missions, m.id)); });
    assert.equal((await row(schema.missionTasks, b.id)).state, 'blocked'); assert.equal((await row(schema.missionTasks, independent.id)).state, 'running');
    assert.equal((await row(schema.missionTasks, b.id)).blockedReason, `Inget svar före sista svarstid (${expiredAt.toISOString()}). Historisk obesvarad väntfråga: ”${wb.definition.question}”`);
    await rejectStatus(operate(m, 'answer', { waitId: wb.id, answer: { kind: 'text', text: 'För sent' } }));
  });

  await check('text does not substitute for required configuration or authentication', async () => {
    const m = await mission(), a = await task(m), b = await task(m);
    for (const [current, reason] of [[a, 'configuration'], [b, 'authentication']]) {
      const w = await wait(m, [current.id], reason);
      await rejectStatus(operate(m, 'answer', { waitId: w.id, answer: { kind: 'text', text: 'Klart' } }), 400);
      assert.equal((await row(schema.missionWaits, w.id)).state, 'waiting');
    }
  });

  await check('another unanswered wait on the same branch still prevents execution', async () => {
    const m = await mission(), t = await task(m), first = await wait(m, [t.id]);
    await wait(m, [t.id], 'authentication');
    await operate(m, 'answer', { waitId: first.id, answer: { kind: 'text', text: 'Det ursprungliga kravet gäller.' } });
    assert.equal((await row(schema.missionTasks, t.id)).state, 'waiting');
    await rejectStatus(attempts.reserveMissionAttempt(await claim(m), t.id));
  });

  await check('answering another question cannot clear an already expired prerequisite', async () => {
    const m = await mission(), t = await task(m), first = await wait(m, [t.id], 'authentication'), second = await wait(m, [t.id]);
    await db.update(schema.missionWaits).set({ deadlineAt: new Date(Date.now() - 100) }).where(eq(schema.missionWaits.id, first.id));
    await db.transaction(async tx => { await control.lockMission(tx, m.id); await attempts.expireMissionWaits(tx, await row(schema.missions, m.id)); });
    assert.equal((await row(schema.missionTasks, t.id)).state, 'blocked');
    await operate(m, 'answer', { waitId: second.id, answer: { kind: 'text', text: 'Det ursprungliga kravet gäller.' } });
    assert.equal((await row(schema.missionTasks, t.id)).state, 'blocked');
    await rejectStatus(attempts.reserveMissionAttempt(await claim(m), t.id));
  });

  for (const resolution of ['decline', 'expiry']) await check(`a running attempt remains fenced after its user wait ends by ${resolution}`, async () => {
    const m = await mission(), lease = await claim(m), t = (await tasks(m))[0];
    const reserved = await attempts.reserveMissionAttempt(lease, t.id);
    await attempts.markMissionDispatch(lease, reserved.attempt.id);
    const w = await wait(m, [t.id], 'authentication');
    await rejectStatus(operation(reserved.attempt));
    if (resolution === 'decline') await operate(m, 'answer', { waitId: w.id, answer: { kind: 'decline', reason: 'Ingen inloggning i detta uppdrag.' } });
    else {
      await db.update(schema.missionWaits).set({ deadlineAt: new Date(Date.now() - 100) }).where(eq(schema.missionWaits.id, w.id));
      await db.transaction(async tx => { await control.lockMission(tx, m.id); await attempts.expireMissionWaits(tx, await row(schema.missions, m.id)); });
    }
    assert.equal((await row(schema.missionTasks, t.id)).state, 'blocked');
    await rejectStatus(operation(reserved.attempt));
  });

  await check('a configuration grant preserves other applicable waits and their original deadlines', async () => {
    const plan = { repoUrl: repo.url, root: '/workspace/mission-control', directory: '/workspace/mission-control', commit: 'a'.repeat(40), command: 'npm run dev', port: 3000, httpStatus: 500, variables: [{ name: 'APP_URL', required: true, reason: 'Fixture URL' }] };
    await saveVaultEntry(owners[0], workspaces[0], { repoUrl: repo.url, expectedRevision: 0, values: { APP_URL: 'https://fixture.configured.test' } });
    const jobId = randomUUID(), sessionKey = 'main';
    await db.insert(schema.setupJobs).values({ id: jobId, workspaceId: workspaces[0], threadId: threads[0], runtime, parentSessionId: randomUUID(), sessionKey, task: 'Saved fixture only', model: 'fixture', reasoning: 'fixture', status: 'needs_configuration', result: { jobId, id: sandboxScope(owners[0], threads[0], sessionKey).id, workspaceId: workspaces[0], status: 'needs_configuration', message: 'Fixture configuration plan', environment: plan, updatedAt: new Date().toISOString() } });
    const consent = await grantEnvironmentConsent(owners[0], workspaces[0], jobId, { requestId: randomUUID(), expectedPlanHash: environmentPlanHash(plan), expectedVaultRevision: 1, allowedNames: ['APP_URL'] });
    const m = await mission({ target: repo }), inspection = await savedInspection(m);
    const a = await task(m, { kind: 'environment_setup', phase: 'apply', repoUrl: repo.url, ref: repo.ref, ...inspection, sourceSetupJobId: jobId, planHash: environmentPlanHash(plan) }), b = await task(m, { kind: 'planning', sourceRefs: [] });
    const configuration = await wait(m, [a.id], 'configuration', { setupJobId: jobId }), clarification = await wait(m, [b.id]);
    const updated = await operate(m, 'answer', { waitId: configuration.id, answer: { kind: 'environment_consent', consentId: consent.id } });
    assert.equal(updated.mandateRevision, m.mandateRevision + 1);
    const unchangedDeadline = await row(schema.missionWaits, clarification.id);
    assert.equal(unchangedDeadline.deadlineAt.getTime(), clarification.deadlineAt.getTime());
    await operate(updated, 'answer', { waitId: clarification.id, answer: { kind: 'text', text: 'Det ursprungliga kravet gäller.' } });
    assert.equal((await row(schema.missionTasks, b.id)).state, 'pending');
  });

  await check('parallel reservations serialize against the shared admission budget', async () => {
    const m = await mission(), lease = await claim(m), units = await Promise.all([task(m), task(m), task(m)]);
    const results = await Promise.all(units.map(t => attempts.reserveMissionAttempt(lease, t.id)));
    assert.equal(results.filter(result => result.status === 'reserved').length, 2);
    assert.ok(results.find(result => result.status === 'deferred').reasons.includes('parallel_budget'));
    assert.equal((await children(schema.missionAttempts, m.id)).length, 2);
  });

  await check('unknown consumption remains charged after terminal receipts', async () => {
    const m = await mission();
    // Exercise a deliberately smaller persisted budget independently of new
    // default role allowances; old mandates are not upgraded by admission.
    const limits = { ...m.mandate.limits, maxTokens: 500000 }; delete limits.browserTokensPerAttempt;
    await db.update(schema.missions).set({ mandate: { ...m.mandate, limits } }).where(eq(schema.missions.id, m.id));
    const lease = await claim(m);
    for (let index = 0; index < 5; index++) {
      const t = await task(m), reserved = await attempts.reserveMissionAttempt(lease, t.id); assert.equal(reserved.status, 'reserved');
      await attempts.receiveMissionReceipt(reserved.attempt.id, receipt(reserved.attempt, research));
    }
    const t = await task(m), sixth = await attempts.reserveMissionAttempt(lease, t.id);
    assert.equal(sixth.status, 'deferred'); assert.ok(sixth.reasons.includes('token_budget')); assert.ok(sixth.reasons.includes('tool_budget'));
    assert.equal((await children(schema.missionAttempts, m.id)).length, 5);
    const report = await task(m, { kind: 'report', partial: true, sourceRefs: [{ type: 'research', id: research.id }] });
    assert.equal((await attempts.reserveMissionAttempt(lease, report.id)).status, 'reserved', 'Reporting has its own bounded reservation after execution is exhausted');
  });

  await check('underreported terminal usage cannot erase server-counted tool consumption', async () => {
    const m = await mission();
    await db.update(schema.missions).set({ mandate: { ...m.mandate, limits: { ...m.mandate.limits, maxToolCalls: 2, toolCallsPerAttempt: 2 } } }).where(eq(schema.missions.id, m.id));
    const lease = await claim(m), reserved = await attempts.reserveMissionAttempt(lease, (await tasks(m))[0].id);
    await operation(reserved.attempt); await operation(reserved.attempt);
    await attempts.receiveMissionReceipt(reserved.attempt.id, receipt(reserved.attempt, research), { tokens: 1, toolCalls: 0, durationMs: 1 });
    const later = await attempts.reserveMissionAttempt(lease, (await task(m)).id);
    assert.equal(later.status, 'deferred'); assert.ok(later.reasons.includes('tool_budget'));
  });

  await check('dependency readiness is authoritative and terminal failure is not successful completion', async () => {
    const m = await mission(), parent = await task(m), child = await task(m, { kind: 'planning', sourceRefs: [] }, { dependsOn: [parent.id] }), lease = await claim(m);
    assert.deepEqual((await attempts.reserveMissionAttempt(lease, child.id)).reasons, ['dependency']);
    await db.update(schema.missionTasks).set({ state: 'failed' }).where(eq(schema.missionTasks.id, parent.id));
    assert.deepEqual((await attempts.reserveMissionAttempt(lease, child.id)).reasons, ['dependency']);
    await db.update(schema.missionTasks).set({ dependencyRequirements: [{ taskId: parent.id, require: 'terminal' }] }).where(eq(schema.missionTasks.id, child.id));
    assert.equal((await attempts.reserveMissionAttempt(lease, child.id)).status, 'reserved');
  });

  await check('global autonomy switch blocks new work but still allows explicit cancellation', async () => {
    const m = await mission(), lease = await claim(m), reserved = await attempts.reserveMissionAttempt(lease, (await tasks(m))[0].id), waiting = await task(m);
    process.env.AUTONOMOUS_MISSIONS_ENABLED = 'false';
    try {
      await rejectStatus(operation(reserved.attempt)); await rejectStatus(attempts.reserveMissionAttempt(lease, waiting.id), 503);
      assert.equal((await operate(m, 'cancel')).lifecycle, 'cancelling');
    } finally { process.env.AUTONOMOUS_MISSIONS_ENABLED = 'true'; }
  });

  await check('operation replay binds full input and budgets distinct calls once', async () => {
    const m = await mission();
    await db.update(schema.missions).set({ mandate: { ...m.mandate, limits: { ...m.mandate.limits, maxToolCalls: 2, toolCallsPerAttempt: 2 } } }).where(eq(schema.missions.id, m.id));
    const lease = await claim(m), reserved = await attempts.reserveMissionAttempt(lease, (await tasks(m))[0].id), current = reserved.attempt;
    await attempts.markMissionDispatch(lease, current.id);
    const callId = randomUUID(); assert.equal((await operation(current, { callId })).replay, false); assert.equal((await operation(current, { callId })).replay, true);
    await rejectStatus(operation(current, { callId, input: { action: 'inspect', different: true } }));
    await rejectStatus(operation(current, { url: 'https://outside.example' }), 403);
    await rejectStatus(operation(current, { userId: owners[1] }), 404);
    await rejectStatus(operation(current, { tool: 'setup' }), 403);
    await operation(current); await rejectStatus(operation(current));
    assert.equal((await row(schema.missionAttempts, current.id)).toolCalls, 2);
  });

  await check('dispatch uncertainty retains identity and a receipt cannot forge another source or owner', async () => {
    const m = await mission(), lease = await claim(m), reserved = await attempts.reserveMissionAttempt(lease, (await tasks(m))[0].id), current = reserved.attempt;
    const dispatch = await attempts.markMissionDispatch(lease, current.id), unknown = await attempts.markMissionDispatch(lease, current.id, true);
    assert.equal(dispatch.dispatchId, unknown.dispatchId); assert.equal(unknown.status, 'dispatch_unknown');
    await rejectStatus(attempts.receiveMissionReceipt(current.id, receipt(current, foreignResearch)), 404);
    await rejectStatus(attempts.receiveMissionReceipt(current.id, receipt(current, research, { sourceType: 'material' })));
    const first = receipt(current, research, { status: 'running', sequence: 0 });
    assert.equal((await attempts.receiveMissionReceipt(current.id, first)).accepted, true);
    assert.equal((await attempts.receiveMissionReceipt(current.id, first)).stale, true);
    await rejectStatus(attempts.receiveMissionReceipt(current.id, { ...first, status: 'failed' }));
    await attempts.receiveMissionReceipt(current.id, receipt(current, research));
    assert.equal((await row(schema.missionTasks, reserved.task.id)).state, 'running', 'A terminal receipt is not proof of delivered QA');
  });

  await check('pause immediately revokes tools and late output cannot resume work', async () => {
    const m = await mission(), lease = await claim(m), reserved = await attempts.reserveMissionAttempt(lease, (await tasks(m))[0].id), current = reserved.attempt;
    await attempts.markMissionDispatch(lease, current.id);
    await attempts.receiveMissionReceipt(current.id, receipt(current, research, { status: 'running', sequence: 0 }));
    await reconcileMission(owners[0], workspaces[0], m.id);
    const saved = await row(schema.missionTasks, reserved.task.id); assert.ok(saved.results.length);
    const callId = randomUUID(); await operation(current, { callId });
    const pause = action(m, 'pause'), paused = await control.controlMission(owners[0], workspaces[0], threads[0], pause);
    assert.equal(paused.lifecycle, 'paused'); assert.equal(paused.mandateRevision, 2);
    assert.equal((await control.controlMission(owners[0], workspaces[0], threads[0], pause)).revision, paused.revision);
    await rejectStatus(control.controlMission(owners[0], workspaces[0], threads[0], { ...pause, reason: 'Changed reason' }));
    await rejectStatus(operation(current, { callId })); await rejectStatus(attempts.markMissionDispatch(lease, current.id));
    await rejectStatus(operate(paused, 'resume'));
    const late = await attempts.receiveMissionReceipt(current.id, receipt(current, research)); assert.equal(late.current, false);
    assert.equal((await row(schema.missions, m.id)).lifecycle, 'paused');
    const resumed = await operate(paused, 'resume'); assert.equal(resumed.lifecycle, 'accepted'); assert.equal(resumed.mandateRevision, 3); assert.equal(resumed.planRevision, 2);
    assert.notEqual(resumed.config.target.scope.id, m.config.target.scope.id);
    assert.deepEqual((await row(schema.missionTasks, reserved.task.id)).results, saved.results);
    await rejectStatus(operation(current));
  });

  await check('cancel invalidates existing waits, tools and stale leases before executor acknowledgement', async () => {
    const m = await mission(), lease = await claim(m), t = await task(m), w = await wait(m, [t.id]);
    const reserved = await attempts.reserveMissionAttempt(lease, (await tasks(m)).find(current => current.operationId === 'initial:1').id);
    const cancelled = await operate(m, 'cancel'); assert.equal(cancelled.lifecycle, 'cancelling');
    assert.ok((await row(schema.missionAttempts, reserved.attempt.id)).cancelRequestedAt);
    await rejectStatus(operation(reserved.attempt)); await rejectStatus(attempts.reserveMissionAttempt(lease, t.id));
    await rejectStatus(operate(cancelled, 'answer', { waitId: w.id, answer: { kind: 'text', text: 'Sent svar' } }));
    const late = await attempts.receiveMissionReceipt(reserved.attempt.id, receipt(reserved.attempt, research)); assert.equal(late.current, false);
    assert.equal((await row(schema.missions, m.id)).lifecycle, 'cancelling');
    assert.equal((await children(schema.missionAttempts, m.id)).length, 1);
  });

  await check('closed missions ignore late answers and explicit resume creates only one fresh scope', async () => {
    const m = await mission(), t = await task(m), w = await wait(m, [t.id]);
    // P2 owns controller closure. This fixture establishes its persisted state.
    await db.update(schema.missions).set({ lifecycle: 'closed', status: 'completed', closureReason: 'blocked', closedAt: new Date(), leaseToken: null, leaseUntil: null }).where(eq(schema.missions.id, m.id));
    await rejectStatus(operate(m, 'answer', { waitId: w.id, answer: { kind: 'text', text: 'Svaret kom efter avslut.' } }));
    const resume = action(m, 'resume'), first = await control.controlMission(owners[0], workspaces[0], threads[0], resume);
    const second = await control.controlMission(owners[0], workspaces[0], threads[0], resume);
    assert.equal(first.lifecycle, 'accepted'); assert.equal(first.planRevision, 2); assert.equal(first.mandateRevision, 2);
    assert.notEqual(first.config.target.scope.id, m.config.target.scope.id); assert.deepEqual(second.config.target, first.config.target);
    assert.equal((await tasks(m)).filter(current => current.operationId === 'initial:2').length, 1);
    assert.equal((await row(schema.missionWaits, w.id)).state, 'cancelled');
  });

  await check('expired physical claims are quarantined and human ownership prevents release', async () => {
    const poolKey = `fixture-pool-${randomUUID()}`, resource = { kind: 'otto', poolKey };
    const firstMission = await mission({ target: repo }), secondMission = await mission({ target: repo }, 1);
    const firstTask = await task(firstMission, { kind: 'environment_setup', phase: 'prepare', repoUrl: repo.url, ref: repo.ref, ...await savedInspection(firstMission) });
    const secondTask = await task(secondMission, { kind: 'environment_setup', phase: 'prepare', repoUrl: repo.url, ref: repo.ref, ...await savedInspection(secondMission) });
    const a = await attempts.reserveMissionAttempt(await claim(firstMission), firstTask.id, { resource }), leaseB = await claim(secondMission);
    assert.equal(a.status, 'reserved');
    const [held] = await children(schema.missionResourceClaims, firstMission.id);
    await db.update(schema.missionResourceClaims).set({ expiresAt: new Date(Date.now() - 100), runtime: `${runtime}-other` }).where(eq(schema.missionResourceClaims.id, held.id));
    assert.deepEqual((await attempts.reserveMissionAttempt(leaseB, secondTask.id, { resource })).reasons, ['resource_busy']);
    assert.equal((await row(schema.missionResourceClaims, held.id)).state, 'uncertain');
    await db.update(schema.missionResourceClaims).set({ owner: 'human', state: 'claimed', runtime }).where(eq(schema.missionResourceClaims.id, held.id));
    await db.update(schema.missionAttempts).set({ status: 'completed' }).where(eq(schema.missionAttempts.id, a.attempt.id));
    assert.deepEqual((await attempts.reserveMissionAttempt(leaseB, secondTask.id, { resource })).reasons, ['human_control']);
    assert.equal(await attempts.releaseMissionResource(a.attempt.id, null, true), false);
    await db.update(schema.missionResourceClaims).set({ owner: 'agent', executorResourceId: 'fixture-process' }).where(eq(schema.missionResourceClaims.id, held.id));
    assert.equal(await attempts.releaseMissionResource(a.attempt.id, 'wrong-process', true), false);
    assert.equal(await attempts.releaseMissionResource(a.attempt.id, 'fixture-process', false), false);
    assert.equal(await attempts.releaseMissionResource(a.attempt.id, 'fixture-process', true), true);
    assert.equal((await attempts.reserveMissionAttempt(leaseB, secondTask.id, { resource })).status, 'reserved');
  });

  for (const expiry of ['lease', 'deadline']) await check(`${expiry} expiring behind a held physical resource lock prevents late reservation`, async () => {
    const m = await mission({ caseKeys: [caseKey] }), t = await task(m, { kind: 'browser_tests', caseKeys: [caseKey], target: m.config.target }), lease = await claim(m);
    const poolKey = `fixture-barrier-${randomUUID()}`, resourceKey = `browser:${m.workspaceId}`, gate = barrier(), lockKey = `mission-resource:${poolKey}:${resourceKey}`;
    const holder = track(db.transaction(async tx => { await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`); await gate.wait(); }));
    await bounded(gate.entered, 'resource lock held');
    const expiresAt = new Date(Date.now() + 400);
    await db.update(schema.missions).set(expiry === 'lease' ? { leaseUntil: expiresAt } : { deadlineAt: expiresAt, mandate: { ...m.mandate, deadlineAt: expiresAt.toISOString() } }).where(eq(schema.missions.id, m.id));
    const pendingAttempt = track(attempts.reserveMissionAttempt(lease, t.id, { resource: { kind: 'browser', poolKey } }).then(value => ({ value }), error => ({ error })));
    try { await bounded(waiter(lockKey), 'reservation waits for physical lock'); await delay(450); }
    finally { gate.release(); }
    await bounded(holder, 'holder completes'); const outcome = await bounded(pendingAttempt, 'waiting reservation completes');
    if (expiry === 'lease') assert.equal(outcome.error?.statusCode, 409);
    else { assert.equal(outcome.value?.status, 'deferred'); assert.ok(outcome.value.reasons.includes('deadline')); }
    assert.equal((await children(schema.missionAttempts, m.id)).length, 0); assert.equal((await children(schema.missionResourceClaims, m.id)).length, 0);
    assert.equal((await row(schema.missionTasks, t.id)).state, 'pending');
  });

  console.log(JSON.stringify({ status: failures.length ? 'failed' : 'passed', checks: passed.length, failures: failures.map(({ name, message }) => ({ name, message })), database: 'actual isolated PostgreSQL', api: 'authored H3 session and internal routes', substitutes: ['resolved Supabase session', 'stored synthetic research receipt', 'route controller kick recorded without executing'], externalExecution: 'none' }));
  if (failures.length) { for (const failure of failures) console.error(failure.stack); process.exitCode = 1; }
} finally {
  for (const release of releases) release(); await Promise.allSettled(pending);
  globalThis.fetch = originalFetch; process.env.PAT_RUNTIME_SCOPE = runtime;
  server.close(); server.closeAllConnections(); await once(server, 'close');
  await Promise.allSettled(background); routeHook.deregister(); delete globalThis.missionControlRouteKick;
  try { for (const owner of owners) await db.delete(schema.user).where(eq(schema.user.id, owner)); }
  finally { await app.close(); }
}
