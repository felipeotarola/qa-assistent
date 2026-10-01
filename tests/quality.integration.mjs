// Opt-in API/DB verification. KEEP_QUALITY_FIXTURE=1 retains a disposable user for browser review.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClient } from '@supabase/supabase-js';
import { createServerClient } from '@supabase/ssr';
import postgres from 'postgres';
if (process.env.RUN_QUALITY_TESTS !== '1') throw new Error('Enable RUN_QUALITY_TESTS=1 for disposable fixtures');
const origin = process.env.APP_URL || 'http://localhost:3000';
const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const email = `quality-${randomUUID()}@example.com`, password = randomUUID();
const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
assert.equal(error, null);
const userId = data.user.id;
const cookies = new Map();
const auth = createServerClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, { cookieOptions: { name: 'pat_supabase_auth', path: '/', sameSite: 'lax' }, cookies: { getAll: () => [...cookies].map(([name, value]) => ({ name, value })), setAll: values => values.forEach(c => cookies.set(c.name, c.value)) } });
const database = postgres(process.env.POSTGRES_URL || process.env.POSTGRESQL_URL || process.env.DATABASE_URL, { prepare: false, max: 1 });
async function api(path, method = 'GET', body, internal = false) {
  const response = await fetch(origin + path, { method, headers: { cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join('; '), 'content-type': 'application/json', ...(internal ? { authorization: `Bearer ${process.env.INTERNAL_API_SECRET}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, data: await response.json() };
}
let keep = false;
try {
  assert.equal((await auth.auth.signInWithPassword({ email, password })).error, null);
  const workspaceId = (await api('/api/workspaces', 'POST', { name: 'Tillfällig kvalitetsverifiering' })).data.workspace.id;
  const threadId = (await api('/api/threads', 'POST', { workspaceId, title: 'Syntetiska testresultat för verifiering' })).data.thread.id;
  const cases = ['Startsida', 'Inloggning', 'Återställ lösenord'].map(title => ({ id: randomUUID(), title, type: 'browser', preconditions: '', steps: 'Syntetiskt test: kontrollera flödet', expected: 'Det förväntade innehållet visas' }));
  const item = (await api(`/api/workspaces/${workspaceId}/items`, 'POST', { title: 'Verifieringsplan · syntetiska data', content: { kind: 'test_plan', cases, sources: [] } })).data.item;
  const path = `/api/workspaces/${workspaceId}/quality`;
  assert.equal((await fetch(origin + path)).status, 401);
  assert.equal((await api(`/api/workspaces/${randomUUID()}/quality`)).status, 404);
  assert.equal((await api(path)).data.revision, 0);
  const target = { environment: 'QA', url: 'https://example.com', revision: 'release-a' };
  let config = { target, checks: [{ id: randomUUID(), label: 'Miljö och version', status: 'ready', detail: 'Syntetiskt observationsunderlag', caseKeys: [] }], regression: [`${item.id}:${cases[0].id}`] };
  const first = await api(path, 'PUT', { expectedRevision: 0, config });
  assert.equal(first.status, 200, JSON.stringify(first.data));
  assert.equal(first.data.config.checks[0].status, 'unknown', 'New target resets prior observations');
  assert.equal((await api(path, 'PUT', { expectedRevision: 0, config })).status, 409);
  const saved = await api(path, 'PUT', { expectedRevision: 1, config });
  assert.equal(saved.status, 200);
  assert.equal((await api(path, 'PUT', { expectedRevision: 2, config: { ...config, regression: [`${randomUUID()}:${randomUUID()}`] } })).status, 400);
  const call = input => api('/api/internal/test-run', 'POST', { userId, threadId, ...input }, true);
  for (let index = 0; index < 2; index++) {
    const input = { action: 'start', itemId: item.id, caseId: cases[index].id, expectedVersion: 1, requestId: randomUUID(), environment: 'QA fixture', target };
    const started = await call(input);
    assert.equal(started.status, 200, JSON.stringify(started.data));
    assert.deepEqual(started.data.target, target);
    assert.equal((await call({ ...input, target: { ...target, revision: 'different' } })).status, 409);
    assert.equal((await call({ action: 'finish', runId: started.data.id, result: { outcome: index ? 'failed' : 'passed', actual: 'Syntetiskt resultat för integrationstest, ingen webbplats har testats.', unverified: '', observations: [], evidenceItemIds: [] } })).status, 200);
  }
  const report = () => api('/api/internal/quality', 'POST', { userId, threadId, action: 'read' }, true);
  assert.equal((await report()).data.counts.passed, 1);
  const switched = await api(path, 'PUT', { expectedRevision: 2, config: { ...config, target: { ...target, revision: 'release-b' } } });
  assert.equal(switched.status, 200);
  assert.equal((await report()).data.counts.stale, 2);
  assert.equal((await api(`/api/workspaces/${workspaceId}/runs`)).data.length, 2, 'Release changes preserve history');
  assert.equal((await api('/api/internal/quality', 'POST', { userId: randomUUID(), threadId, action: 'read' }, true)).status, 404);
  await api(path, 'PUT', { expectedRevision: 3, config });
  config = { ...config, checks: [...config.checks, { id: randomUUID(), label: 'Testkonto för återställning', status: 'blocked', detail: 'Syntetiskt exempel: testkonto saknas', caseKeys: [`${item.id}:${cases[2].id}`] }] };
  assert.equal((await api(path, 'PUT', { expectedRevision: 4, config })).status, 200);
  const final = (await report()).data;
  assert.equal(final.ready, 2); assert.equal(final.cases[2].readiness, 'blocked');
  console.log('Passed: ownership, readiness reset, revision conflicts, scoped blockers, run targets and preserved history.');
  if (process.env.KEEP_QUALITY_FIXTURE === '1') {
    const stateFile = join(tmpdir(), `quality-state-${userId}.json`);
    const fixtureFile = join(tmpdir(), `quality-fixture-${userId}.json`);
    writeFileSync(stateFile, JSON.stringify({ cookies: [...cookies].map(([name, value]) => ({ name, value, domain: 'localhost', path: '/', expires: -1, httpOnly: false, secure: false, sameSite: 'Lax' })).concat([{ name: 'pat_workspace', value: workspaceId, domain: 'localhost', path: '/', expires: -1, httpOnly: false, secure: false, sameSite: 'Lax' }]), origins: [] }));
    writeFileSync(fixtureFile, JSON.stringify({ userId, workspaceId, threadId, stateFile }));
    keep = true; console.log(JSON.stringify({ stateFile, fixtureFile, url: `${origin}/?workspaceView=testing` }));
  }
} finally {
  if (!keep) { await auth.auth.signOut({ scope: 'local' }); await database`delete from pat_user where id = ${userId}`; await admin.auth.admin.deleteUser(userId); }
  await database.end();
}
