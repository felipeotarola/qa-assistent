// Opt-in: disposable account and inspect-only jobs; no dependency install or build.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { createServerClient } from '@supabase/ssr';
import postgres from 'postgres';

if (process.env.RUN_REPOSITORY_TESTS !== '1') throw Error('Enable repository integration tests explicitly');
const origin = process.env.APP_URL || 'http://localhost:3000';
const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const email = `script-override-${randomUUID()}@example.com`, password = randomUUID();
const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
if (error) throw Error('Could not create test account');
const userId = data.user.id, cookies = new Map(), runs = [];
const auth = createServerClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, {
  cookieOptions: { name: 'pat_supabase_auth', path: '/', sameSite: 'lax' },
  cookies: { getAll: () => [...cookies].map(([name, value]) => ({ name, value })), setAll: values => values.forEach(c => cookies.set(c.name, c.value)) },
});
async function api(path, body) {
  const response = await fetch(origin + path, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json', cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join('; ') }, body: body ? JSON.stringify(body) : undefined });
  return { status: response.status, body: await response.json() };
}
let path;
try {
  assert.equal((await auth.auth.signInWithPassword({ email, password })).error, null);
  const workspace = await api('/api/workspaces', { name: 'Temporary script override verification' });
  path = `/api/workspaces/${workspace.body.workspace.id}/repositories`;
  const connected = await api(path, { action: 'connect', url: 'https://github.com/adminmart/Modernize-Nextjs-Free', script: 'auto' });
  assert.equal(connected.status, 200);
  const start = { action: 'start', repositoryId: connected.body.id, requestId: randomUUID(), mode: 'inspect', script: 'build' };
  const first = await api(path, start);
  assert.equal(first.status, 200, JSON.stringify(first.body)); runs.push(first.body.id);
  assert.equal(first.body.script, 'build', 'The VPS receives the explicit script rather than the saved auto default');
  assert.equal((await api(path, start)).body.id, first.body.id, 'Replay reuses the same run');
  assert.equal((await api(path, { ...start, script: 'lint' })).status, 409, 'Changed script cannot reuse an old request ID');
  let job;
  const deadline = Date.now() + 90000;
  do {
    const state = await api(path);
    assert.equal(state.body.repositories[0].script, 'auto', 'One-off script does not mutate the saved connection');
    job = state.body.runs.find(run => run.id === first.body.id)?.job;
    if (job?.finishedAt) break;
    await new Promise(resolve => setTimeout(resolve, 1000));
  } while (Date.now() < deadline);
  assert.equal(job?.status, 'review', job?.message);
  assert.equal(job.plan.selectedScript, 'build');
  assert.equal(job.plan.directory, 'package');
  assert.ok(job.plan.command.includes('build'));
  assert.equal(job.testExitCode, null, 'Inspect must not run the build');
  console.log('PASS API → VPS plan preserves build, nested project path, idempotency, conflict and saved auto default');
  const omitted = { ...start }; delete omitted.script;
  const second = await api(path, { ...omitted, requestId: randomUUID() }); runs.push(second.body.id);
  assert.equal(second.status, 200);
  assert.equal(second.body.script, 'auto', 'Omitted override inherits the saved default');
  console.log('PASS omitted override retains the saved connection script');
} finally {
  if (path) for (const runId of runs) await api(path, { action: 'cancel', runId }).catch(() => {});
  const sql = postgres(process.env.DATABASE_URL, { prepare: false, max: 1 });
  await sql`delete from pat_user where id=${userId}`; await sql.end(); await admin.auth.admin.deleteUser(userId);
  console.log('Cleaned disposable script-override fixtures');
}
