import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { createClient } from '@supabase/supabase-js';
import { createServerClient } from '@supabase/ssr';
import postgres from 'postgres';
import { openEnvironment } from '../server/utils/environment-crypto.ts';

if (process.env.RUN_VAULT_TESTS !== '1') throw new Error('Set RUN_VAULT_TESTS=1 for disposable vault fixtures');
const origin = process.env.TEST_APP_ORIGIN || 'http://localhost:3000';
const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const db = postgres(process.env.DATABASE_URL, { prepare: false, max: 1 });
const users = [], workspaces = [];
let keep = false;
async function identity() {
  const email = `vault-test-${randomUUID()}@example.com`, password = randomUUID();
  const result = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  assert.equal(result.error, null); users.push(result.data.user.id);
  const cookies = new Map();
  const auth = createServerClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, { cookieOptions: { name: 'pat_supabase_auth', path: '/', sameSite: 'lax' }, cookies: { getAll: () => [...cookies].map(([name, value]) => ({ name, value })), setAll: values => values.forEach(c => cookies.set(c.name, c.value)) } });
  assert.equal((await auth.auth.signInWithPassword({ email, password })).error, null);
  const api = async (path, method = 'GET', body) => {
    const response = await fetch(origin + path, { method, headers: { cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join('; '), 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json(), cache: response.headers.get('cache-control') };
  };
  return { email, password, api, userId: result.data.user.id };
}
try {
  const user = await identity(), other = await identity();
  const created = await user.api('/api/workspaces', 'POST', { name: 'Vault verification' });
  assert.equal(created.status, 200);
  const id = created.body.workspace.id; workspaces.push(id);
  const path = `/api/workspaces/${id}/vault`, repoUrl = 'https://github.com/example/vault-fixture';
  assert.equal((await fetch(origin + path)).status, 401);
  assert.equal((await other.api(path)).status, 404);
  assert.equal((await other.api(path, 'PUT', { repoUrl, expectedRevision: 0, values: { TEST_KEY: 'denied' } })).status, 404);
  const saved = await user.api(path, 'PUT', { repoUrl, expectedRevision: 0, values: { TEST_KEY: 'disposable-secret', TEST_URL: 'https://example.com' } });
  assert.equal(saved.status, 200); assert.equal(saved.body.revision, 1);
  assert.ok(!JSON.stringify(saved.body).includes('disposable-secret'));
  const listed = await user.api(path);
  assert.equal(listed.cache, 'no-store'); assert.equal(listed.body.entries.length, 1);
  assert.ok(!JSON.stringify(listed.body).includes('disposable-secret'));
  const [stored] = await db`select sealed_values from pat_project_environments where workspace_id=${id}`;
  assert.ok(!stored.sealed_values.includes('disposable-secret'));
  assert.equal(openEnvironment(stored.sealed_values, `${id}:${repoUrl}:test`).TEST_KEY, 'disposable-secret');
  assert.throws(() => openEnvironment(stored.sealed_values, `wrong:${repoUrl}:test`));
  assert.equal((await user.api(path, 'PUT', { repoUrl, expectedRevision: 0, values: { TEST_KEY: 'stale' } })).status, 409);
  assert.equal((await user.api(path, 'PUT', { repoUrl, expectedRevision: 1, values: { NODE_OPTIONS: '--inspect' } })).status, 400);
  const updated = await user.api(path, 'PUT', { repoUrl, expectedRevision: 1, values: { TEST_KEY: 'updated-fixture' }, forget: ['TEST_URL'] });
  assert.equal(updated.status, 200); assert.deepEqual(updated.body.configuredNames, ['TEST_KEY']);
  assert.equal((await user.api(`/api/workspaces/${id}/setup-jobs`)).body.jobs.length, 0, 'Saving keys does not start work');
  const thread = await user.api('/api/threads', 'POST', { workspaceId: id, title: 'Vault metadata verification' });
  assert.equal(thread.status, 201);
  const inventory = async userId => fetch(origin + '/api/internal/vault', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.INTERNAL_API_SECRET}` }, body: JSON.stringify({ userId, threadId: thread.body.thread.id }) });
  assert.equal((await fetch(origin + '/api/internal/vault', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 401);
  assert.equal((await inventory(other.userId)).status, 404);
  const metadata = await inventory(user.userId);
  assert.equal(metadata.status, 200);
  const inventoryBody = await metadata.json();
  assert.deepEqual(inventoryBody.entries[0].configuredNames, ['TEST_KEY']);
  assert.ok(!JSON.stringify(inventoryBody).includes('updated-fixture'));
  console.log('PASS: encrypted persistence, masked responses, no-store, ownership, revision conflicts, reserved variables, deletion and no execution');
  if (process.env.KEEP_VAULT_FIXTURE === '1') {
    await writeFile('.data/vault-fixture.json', JSON.stringify({ email: user.email, password: user.password, workspaceId: id, users }));
    keep = true;
    console.log(JSON.stringify({ email: user.email, password: user.password, workspaceId: id }));
  }
} finally {
  if (!keep) {
    for (const id of workspaces) {
      await db`delete from pat_threads where workspace_id=${id}`;
      await db`delete from pat_workspaces where id=${id}`;
    }
    for (const id of users) await admin.auth.admin.deleteUser(id);
  }
  await db.end();
}
