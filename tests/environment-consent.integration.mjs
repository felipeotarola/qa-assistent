import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { createApp, createRouter, defineEventHandler, getRequestHeader, toNodeListener } from 'h3';
import { eq, sql } from 'drizzle-orm';
import { isolatedApp } from './helpers/isolated-app.mjs';

// Actual routes, authorization helpers, encryption and PostgreSQL transactions.
// Only Supabase's resolved session is substituted. No external worker or model.
process.env.PAT_RUNTIME_SCOPE = `${process.env.PAT_RUNTIME_SCOPE}-consent-${randomUUID()}`;
process.env.ENV_VAULT_KEY = `isolated-environment-consent-${randomUUID()}`;
const app = await isolatedApp(), { db, schema } = app;
const { requireSessionUserId } = await import('../server/utils/session.ts');
globalThis.requireSessionUserId = requireSessionUserId;
const { environmentConsentStatus, environmentPlanHash, grantEnvironmentConsent, revokeEnvironmentConsent, authorizeEnvironmentConsent } = await import('../server/utils/environment-consents.ts');
const { saveVaultEntry, environmentVaultScope } = await import('../server/utils/project-vault.ts');
const { sandboxScope } = await import('../server/utils/sandbox-scope.ts');
const { ENVIRONMENT_CONSENT_DEFAULT_MS, ENVIRONMENT_CONSENT_MAX_MS } = await import('../shared/project-environment-consent.ts');
const owners = [randomUUID(), randomUUID()], workspaces = [randomUUID(), randomUUID()], threads = [randomUUID(), randomUUID()];
const sessionTokens = [randomUUID(), randomUUID()], runtime = process.env.PAT_RUNTIME_SCOPE;
const credentials = { APP_URL: 'https://isolated.example.test', API_KEY: `isolated-value-${randomUUID()}` };
const repoUrl = 'https://github.com/fixture/consent';
const plan = { repoUrl, root: '/workspace/consent', directory: '/workspace/consent/web', commit: 'a'.repeat(40), command: 'npm run dev -- --host 0.0.0.0', port: 3000, httpStatus: 500, variables: [{ name: 'APP_URL', required: true, reason: 'Fixture required URL' }, { name: 'API_KEY', required: false, reason: 'Fixture optional API' }] };
const router = createRouter();
router.get('/workspaces/:id/setup-jobs/:jobId/consent', (await import('../server/api/workspaces/[id]/setup-jobs/[jobId]/consent.get.ts')).default);
router.post('/workspaces/:id/setup-jobs/:jobId/consent', (await import('../server/api/workspaces/[id]/setup-jobs/[jobId]/consent.post.ts')).default);
router.post('/workspaces/:id/environment-consents/:consentId/revoke', (await import('../server/api/workspaces/[id]/environment-consents/[consentId]/revoke.post.ts')).default);
const server = createServer(toNodeListener(createApp().use(defineEventHandler(event => {
  const owner = sessionTokens.indexOf(getRequestHeader(event, 'cookie')?.replace('fixture-session=', '') ?? '');
  event.context.appSession = Promise.resolve(owner < 0 ? null : { user: { id: owners[owner] } });
})).use(router)));
server.listen(0, '127.0.0.1'); await once(server, 'listening');
const origin = `http://127.0.0.1:${server.address().port}`;
const originalFetch = globalThis.fetch;
globalThis.fetch = (url, options) => {
  assert.ok(String(url).startsWith(`${origin}/`), 'No external network is part of consent handling');
  return originalFetch(url, options);
};
const pending = [], releases = new Set();
let checks = 0;
const rejectStatus = (promise, expected = 409) => assert.rejects(promise, error => error.statusCode === expected);
function noValues(value) {
  const text = JSON.stringify(value);
  for (const secret of Object.values(credentials)) assert.ok(!text.includes(secret), 'Credentials must never appear in metadata or authorization');
  assert.ok(!text.includes('sealedValues'));
}
async function api(path, body, { owner = 0, expected = 200, internal = false } = {}) {
  const response = await fetch(`${origin}${path}`, { method: body ? 'POST' : 'GET', headers: { ...(owner >= 0 ? { cookie: `fixture-session=${sessionTokens[owner]}` } : {}), ...(internal ? { authorization: `Bearer ${process.env.INTERNAL_API_SECRET}` } : {}), 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const result = await response.json();
  assert.equal(response.status, expected, `Unexpected response: ${result.statusMessage ?? result.status}`);
  assert.equal(response.headers.get('cache-control'), 'no-store'); noValues(result);
  return result;
}
const route = (job, workspace = workspaces[0]) => `/workspaces/${workspace}/setup-jobs/${job.id}/consent`;
const revokeRoute = consent => `/workspaces/${workspaces[0]}/environment-consents/${consent.id}/revoke`;
async function job(overrides = {}, owner = 0) {
  const id = randomUUID(), threadId = threads[owner], sessionKey = 'main';
  const result = { jobId: id, id: sandboxScope(owners[owner], threadId, sessionKey).id, workspaceId: workspaces[owner], status: 'needs_configuration', message: 'Synthetic verified startup plan', environment: structuredClone(plan), updatedAt: new Date().toISOString(), ...overrides.result };
  const row = { id, threadId, workspaceId: workspaces[owner], runtime, parentSessionId: randomUUID(), sessionKey, task: 'Fixture setup, no execution', model: 'fixture', reasoning: 'fixture', status: 'needs_configuration', ...overrides, result };
  await db.insert(schema.setupJobs).values(row); return row;
}
const grantInput = (vaultRevision = 1, extra = {}) => ({ requestId: randomUUID(), expectedPlanHash: environmentPlanHash(plan), expectedVaultRevision: vaultRevision, allowedNames: ['APP_URL', 'API_KEY'], ...extra });
const authorization = (consent, setup) => ({ consentId: consent.id, consentRevision: consent.revision, setupJobId: setup.id, expectedPlanHash: consent.planHash, vaultRevision: consent.vaultRevision });
const deadline = () => new Date(Date.now() + 3600000);
const authorize = (consent, setup, options = {}) => authorizeEnvironmentConsent(owners[0], workspaces[0], authorization(consent, setup), { deadline: deadline(), ...options });
const grant = (setup, revision = 1, extra = {}, connection = db) => grantEnvironmentConsent(owners[0], workspaces[0], setup.id, grantInput(revision, extra), connection);
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
function barrier() { const entered = deferred(), released = deferred(); releases.add(released.resolve); return { entered: entered.promise, wait: async () => { entered.resolve(); await released.promise; }, release: () => { released.resolve(); releases.delete(released.resolve); } }; }
async function bounded(promise, label) {
  const controller = new AbortController();
  try { return await Promise.race([promise, delay(10000, undefined, { signal: controller.signal }).then(() => { throw new Error(`Timeout: ${label}`); })]); }
  finally { controller.abort(); }
}
function track(promise) { pending.push(promise); return promise; }
async function lockWaiter() {
  for (let retry = 0; retry < 100; retry++) {
    const [{ waiting }] = await db.execute(sql`select count(*)::int as waiting from pg_locks where locktype = 'advisory' and not granted and database = (select oid from pg_database where datname = current_database())`);
    if (waiting) return;
    await delay(20);
  }
  throw new Error('Expected actual PostgreSQL advisory-lock waiter');
}
const lockScope = environmentVaultScope(workspaces[0], repoUrl);

try {
  assert.equal(process.env.GRUNDEN_API_TOKEN, '');
  for (let owner = 0; owner < owners.length; owner++) {
    await db.insert(schema.user).values({ id: owners[owner], name: 'Consent fixture', email: `${owners[owner]}@example.test` });
    await db.insert(schema.workspaces).values({ id: workspaces[owner], userId: owners[owner], name: 'Consent fixture' });
    await db.insert(schema.threads).values({ id: threads[owner], userId: owners[owner], workspaceId: workspaces[owner], title: 'Consent fixture' });
  }
  const setup = await job(), fresh = await job(), outsider = await job({}, 1);
  await api(route(setup), grantInput(), { owner: -1, expected: 401 });
  await api(route(setup), grantInput(), { owner: -1, internal: true, expected: 401 });
  await api(route(setup), undefined, { owner: 1, expected: 404 }); checks++;

  await saveVaultEntry(owners[0], workspaces[0], { repoUrl, expectedRevision: 0, values: credentials });
  assert.equal((await db.select().from(schema.environmentConsents).where(eq(schema.environmentConsents.workspaceId, workspaces[0]))).length, 0);
  const initial = await api(route(setup));
  assert.equal(initial.vaultRevision, 1); assert.deepEqual(initial.configuredNames, ['API_KEY', 'APP_URL']); assert.equal(initial.planHash, environmentPlanHash(plan)); assert.equal(initial.consents.length, 0); checks++;

  for (const changed of [{ values: credentials }, { plan }, { userId: owners[1] }]) await api(route(setup), grantInput(1, changed), { expected: 400 });
  for (const changed of [{ expectedPlanHash: 'b'.repeat(64) }, { expectedVaultRevision: 2 }, { allowedNames: ['API_KEY'] }, { allowedNames: ['APP_URL', 'OTHER_KEY'] }, { expiresAt: new Date(Date.now() - 1000).toISOString() }, { expiresAt: new Date(Date.now() + ENVIRONMENT_CONSENT_MAX_MS + 60000).toISOString() }]) await api(route(setup), grantInput(1, changed), { expected: 409 }); checks++;

  const body = grantInput(), consent = await api(route(setup), body);
  assert.equal(consent.status, 'active'); assert.equal(consent.revision, 1); assert.equal(Date.parse(consent.expiresAt) - Date.parse(consent.createdAt), ENVIRONMENT_CONSENT_DEFAULT_MS);
  assert.deepEqual((await api(route(setup), body)).id, consent.id);
  await api(route(setup), { ...body, allowedNames: ['APP_URL'] }, { expected: 409 });
  assert.equal((await db.select().from(schema.environmentConsents).where(eq(schema.environmentConsents.workspaceId, workspaces[0]))).length, 1); checks++;

  const boundedDeadline = deadline();
  const allowed = await authorize(consent, fresh, { deadline: boundedDeadline }); noValues(allowed);
  assert.equal(allowed.validUntil, boundedDeadline.toISOString()); assert.equal(allowed.commit, plan.commit); assert.equal(allowed.setupJobId, fresh.id); assert.deepEqual(allowed.allowedNames, ['API_KEY', 'APP_URL']);
  assert.equal((await authorize(consent, fresh, { deadline: new Date(Date.now() + ENVIRONMENT_CONSENT_MAX_MS) })).validUntil, consent.expiresAt); checks++;
  await rejectStatus(authorize(consent, fresh, { deadline: new Date(Date.now() - 1) }));
  await rejectStatus(authorizeEnvironmentConsent(owners[1], workspaces[0], authorization(consent, fresh), { deadline: deadline() }), 404);
  await rejectStatus(authorize(consent, outsider), 404);
  for (const changed of [{ consentRevision: 2 }, { expectedPlanHash: 'c'.repeat(64) }, { vaultRevision: 2 }]) await rejectStatus(authorizeEnvironmentConsent(owners[0], workspaces[0], { ...authorization(consent, fresh), ...changed }, { deadline: deadline() })); checks++;

  const wrongRuntime = await job({ runtime: `${runtime}-other` }), noPlan = await job({ result: { environment: undefined } }), forgedOwner = await job({ result: { id: randomUUID() } }), busy = await job({ status: 'running' });
  await api(route(wrongRuntime), grantInput(), { expected: 404 });
  await api(route(noPlan), grantInput(), { expected: 409 });
  await api(route(forgedOwner), grantInput(), { expected: 409 });
  await api(route(busy), grantInput(), { expected: 409 });
  assert.equal((await api(route(noPlan))).plan, null); checks++;

  for (const changed of [{ command: 'npm run other' }, { commit: 'b'.repeat(40) }, { port: 4000 }, { directory: '/workspace/consent' }, { repoUrl: 'https://github.com/fixture/other' }, { variables: [{ name: 'APP_URL', required: true, reason: 'Only URL' }] }]) {
    const altered = await job({ result: { environment: { ...plan, ...changed } } });
    await rejectStatus(authorize(consent, altered));
  }
  const reordered = await job({ result: { environment: { ...plan, processId: randomUUID(), httpStatus: 200, variables: [...plan.variables].reverse() } } });
  assert.equal((await authorize(consent, reordered)).planHash, consent.planHash); checks++;

  await api(revokeRoute(consent), { expectedRevision: 2 }, { expected: 409 });
  await api(revokeRoute(consent), { expectedRevision: 1 }, { owner: -1, internal: true, expected: 401 });
  const revoked = await api(revokeRoute(consent), { expectedRevision: 1 });
  assert.equal(revoked.status, 'revoked'); assert.equal(revoked.revision, 2);
  assert.deepEqual(await api(revokeRoute(consent), { expectedRevision: 1 }), revoked);
  assert.equal((await api(route(setup), body)).status, 'revoked');
  await rejectStatus(authorize(consent, fresh)); checks++;

  const expiredBody = grantInput(), expired = await grantEnvironmentConsent(owners[0], workspaces[0], setup.id, expiredBody);
  await db.update(schema.environmentConsents).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(schema.environmentConsents.id, expired.id));
  assert.equal((await grantEnvironmentConsent(owners[0], workspaces[0], setup.id, expiredBody)).status, 'expired');
  await rejectStatus(authorize(expired, fresh)); checks++;

  const rotationBody = grantInput(), rotated = await grantEnvironmentConsent(owners[0], workspaces[0], setup.id, rotationBody);
  await saveVaultEntry(owners[0], workspaces[0], { repoUrl, expectedRevision: 1, values: { API_KEY: `rotated-${randomUUID()}` } });
  assert.equal((await environmentConsentStatus(owners[0], workspaces[0], setup.id)).consents.find(row => row.id === rotated.id).status, 'outdated');
  assert.equal((await grantEnvironmentConsent(owners[0], workspaces[0], setup.id, rotationBody)).status, 'outdated');
  await rejectStatus(authorize(rotated, fresh)); checks++;

  // Order 1: an authorization already serialized before revocation may finish;
  // the revocation waits, then every later authorization is denied.
  const beforeRevoke = await grant(setup, 2), gate1 = barrier();
  const first = track(db.transaction(async tx => { const result = await authorize(beforeRevoke, fresh, { connection: tx }); await gate1.wait(); return result; }));
  await bounded(gate1.entered, 'authorization holds Vault lock');
  const second = track(revokeEnvironmentConsent(owners[0], workspaces[0], beforeRevoke.id, { expectedRevision: 1 }));
  await bounded(lockWaiter(), 'revocation waits behind authorization'); gate1.release();
  noValues(await bounded(first, 'first authorization')); assert.equal((await bounded(second, 'serialized revocation')).status, 'revoked');
  await rejectStatus(authorize(beforeRevoke, fresh)); checks++;

  // Order 2: an authorization started before revoke commits waits and then
  // sees the revoked row instead of a transaction-start snapshot.
  const afterRevoke = await grant(setup, 2), gate2 = barrier();
  const revoking = track(db.transaction(async tx => { await revokeEnvironmentConsent(owners[0], workspaces[0], afterRevoke.id, { expectedRevision: 1 }, tx); await gate2.wait(); }));
  await bounded(gate2.entered, 'revocation holds Vault lock');
  const denied = track(rejectStatus(authorize(afterRevoke, fresh)));
  await bounded(lockWaiter(), 'authorization waits behind revocation'); gate2.release();
  await bounded(revoking, 'revocation commits'); await bounded(denied, 'waiting authorization rejected'); checks++;

  // Real time, not transaction-start now(): make the row expire while a caller
  // waits on the lock, with a non-UTC SQL session to catch timezone regressions.
  const expiring = await grant(setup, 2), gate3 = barrier();
  const expirer = track(db.transaction(async tx => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${lockScope}, 0))`);
    await tx.update(schema.environmentConsents).set({ expiresAt: new Date(Date.now() + 150) }).where(eq(schema.environmentConsents.id, expiring.id));
    await gate3.wait();
  }));
  await bounded(gate3.entered, 'expiry lock held');
  const expiryDenied = track(rejectStatus(db.transaction(async tx => {
    await tx.execute(sql`set local time zone 'Pacific/Honolulu'`);
    return authorize(expiring, fresh, { connection: tx });
  })));
  await bounded(lockWaiter(), 'expiry authorization waits'); await delay(200); gate3.release();
  await bounded(expirer, 'expiry update commits'); await bounded(expiryDenied, 'expired waiter rejected'); checks++;

  // Vault revision is also read after its mutex, never from pre-lock state.
  const rotationWait = await grant(setup, 2), gate4 = barrier();
  const rotating = track(db.transaction(async tx => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${lockScope}, 0))`);
    await tx.update(schema.projectEnvironments).set({ revision: 3 }).where(eq(schema.projectEnvironments.workspaceId, workspaces[0])); await gate4.wait();
  }));
  await bounded(gate4.entered, 'rotation lock held');
  const rotationDenied = track(rejectStatus(authorize(rotationWait, fresh)));
  await bounded(lockWaiter(), 'rotation authorization waits'); gate4.release();
  await bounded(rotating, 'rotation commits'); await bounded(rotationDenied, 'changed Vault revision rejected'); checks++;

  const rows = await db.select().from(schema.setupJobs).where(eq(schema.setupJobs.workspaceId, workspaces[0]));
  assert.ok(rows.every(row => row.status === 'needs_configuration' || row.id === busy.id));
  assert.ok(rows.every(row => row.applyRevision === null), 'Consent operations never dispatch or inject values'); checks++;
  console.log(JSON.stringify({ status: 'passed', checks, database: 'actual isolated PostgreSQL', api: 'authored H3 routes and session guard', session: 'synthetic resolved Supabase session', execution: 'none, external fetch denied', tested: ['session-only grants', 'Vault save grants nothing', 'immutable plan and request identity', 'owner/workspace/runtime fence', 'refs-only authorization', 'bounded expiry', 'idempotent revoke', 'both revoke race orders', 'expiry during lock wait in non-UTC session', 'Vault rotation during lock wait'] }));
} finally {
  for (const release of releases) release(); await Promise.allSettled(pending);
  globalThis.fetch = originalFetch; delete globalThis.requireSessionUserId;
  server.close(); server.closeAllConnections(); await once(server, 'close');
  try { for (const owner of owners) await db.delete(schema.user).where(eq(schema.user.id, owner)); }
  finally { await app.close(); }
}
