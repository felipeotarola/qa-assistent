import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { createServerClient } from '@supabase/ssr';
import { del } from '@vercel/blob';
import postgres from 'postgres';
import { Client } from 'eve/client';

if (process.env.RUN_RESULT_REVIEW_TESTS !== '1') throw new Error('Set RUN_RESULT_REVIEW_TESTS=1; creates temporary fixtures and calls the review model.');
const origin = 'http://localhost:3000';
const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const email = `review-test-${randomUUID()}@example.com`, password = randomUUID();
const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
if (error) throw new Error('Fixture identity creation failed');
const userId = data.user.id, cookies = new Map();
const client = createServerClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, { cookieOptions: { name: 'pat_supabase_auth', path: '/', sameSite: 'lax' }, cookies: { getAll: () => [...cookies].map(([name, value]) => ({ name, value })), setAll: values => values.forEach(c => cookies.set(c.name, c.value)) } });
const cookie = () => [...cookies].map(([k, v]) => `${k}=${v}`).join('; ');
async function api(path, method = 'GET', body, internal = false) {
  const response = await fetch(origin + path, { method, headers: { cookie: cookie(), 'content-type': 'application/json', ...(internal ? { authorization: `Bearer ${process.env.INTERNAL_API_SECRET}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, data: await response.json() };
}
const sql = postgres(process.env.DATABASE_URL, { prepare: false, max: 1 });
let session;
try {
  assert.equal((await client.auth.signInWithPassword({ email, password })).error, null);
  const a = (await api('/api/workspaces', 'POST', { name: 'Review integration' })).data.workspace.id;
  const b = (await api('/api/workspaces', 'POST', { name: 'Isolated review workspace' })).data.workspace.id;
  const threadId = (await api('/api/threads', 'POST', { title: 'Reviewer integration', workspaceId: a })).data.thread.id;
  const created = await api('/api/internal/workspace', 'POST', { userId, threadId, input: { action: 'create', title: 'Reviewer fixture', content: { kind: 'test_plan', cases: [{ id: randomUUID(), title: 'Navigation click', type: 'browser', steps: '1. Click Inspiration in the main navigation.', expected: 'The navigation click opens the Inspiration page.' }] } } }, true);
  assert.equal(created.status, 200);
  const plan = created.data.item;
  const started = await api('/api/internal/test-run', 'POST', { userId, threadId, action: 'start', itemId: plan.id, caseId: plan.content.cases[0].id, expectedVersion: 1, requestId: randomUUID(), environment: 'Synthetic QA fixture', target: { environment: 'fixture', revision: 'fixture-commit', url: 'https://example.com' } }, true);
  assert.equal(started.status, 200);
  const run = started.data;
  const form = new FormData();
  form.append('file', new Blob(['Synthetic capture: Click Inspiration timed out twice. Direct goto /inspiration succeeded with HTTP 200. No successful navigation click was observed.'], { type: 'text/plain' }), 'navigation.txt');
  const uploaded = await fetch(`${origin}/api/workspaces/${a}/upload`, { method: 'POST', headers: { cookie: cookie() }, body: form });
  assert.equal(uploaded.status, 200);
  const evidence = (await uploaded.json()).item;
  await sql`insert into pat_test_captures (id, run_id, item_id, url, title, action) values (${randomUUID()}, ${run.id}, ${evidence.id}, 'https://example.com/inspiration', 'Synthetic navigation capture', 'click')`;
  const result = { outcome: 'passed', actual: 'All navigation links worked.', unverified: '', observations: [], evidenceItemIds: [evidence.id], checks: run.checks.map(c => ({ id: c.id, status: 'verified', actual: 'Navigation worked.' })) };
  const finished = await api('/api/internal/test-run', 'POST', { userId, threadId, action: 'finish', runId: run.id, result }, true);
  assert.equal(finished.status, 200);
  const path = `/api/workspaces/${a}/assessments`;
  assert.equal((await fetch(origin + path)).status, 401);
  assert.equal((await fetch(`${origin}/api/internal/result-reviews/drain`, { method: 'POST' })).status, 401);
  assert.equal((await fetch(`${origin}/workers/result-review/notify`, { method: 'POST' })).status, 401, 'Eve notification is routed and requires authentication');
  assert.equal((await api(`/api/workspaces/${b}/assessments`, 'POST', { runId: run.id })).status, 404);
  const requests = await Promise.all([api(path, 'POST', { runId: run.id }), api(path, 'POST', { runId: run.id })]);
  assert.ok(requests.every(r => r.status === 202));
  assert.equal((await sql`select count(*)::int n from pat_result_assessments where run_id = ${run.id}`)[0].n, 1);
  console.log('PASS owner/auth boundaries, routed Eve notification and concurrent request deduplication');
  let job;
  for (let attempt = 0; attempt < 50; attempt++) {
    [job] = await sql`select * from pat_result_assessments where run_id = ${run.id}`;
    if (job.status === 'completed' || job.status === 'failed') break;
    if (job.status === 'queued' && attempt % 7 === 0) await api('/api/internal/result-reviews/drain', 'POST', {}, true);
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  assert.equal(job.status, 'completed', `Review did not complete: ${job.status}, attempts ${job.attempts}`);
  assert.notEqual(job.assessment.verdict, 'supported', 'Contradictory navigation log must never endorse the reported pass');
  assert.equal(job.input.evidence[0].readStatus, 'read');
  assert.match(job.input.evidence[0].sha256, /^[a-f0-9]{64}$/);
  assert.deepEqual((await sql`select result from pat_test_runs where id = ${run.id}`)[0].result, result);
  assert.equal((await sql`select count(*)::int n from pat_test_run_reviews where run_id = ${run.id}`)[0].n, 0);
  const listed = (await api(path)).data;
  assert.equal(listed.assessments[0].stale, false);
  assert.equal(listed.assessments[0].input, undefined);
  assert.equal(JSON.stringify(listed).includes(evidence.blobPath ?? '/nonexistent-private-path/'), false);
  console.log(`PASS real private evidence read, model verdict ${job.assessment.verdict}, immutable result and separate storage`);
  const eve = new Client({ host: origin, headers: { cookie: cookie(), 'x-pat-browser-thread': threadId, 'x-pat-chat-model': 'glm-5.3-flash', 'x-pat-reasoning': 'low' } });
  const startedChat = await eve.sessions.create({ message: 'Detta är ett tillfälligt integrationstest. Svara bara Redo utan verktyg.' });
  session = startedChat.session;
  assert.equal((await startedChat.response.result()).status, 'waiting');
  await sql`update pat_result_assessments set finished_at=now()-interval '2 minutes' where id=${job.id}`;
  assert.equal((await api('/api/internal/result-reviews/drain', 'POST', {}, true)).status, 200);
  assert.equal((await sql`select notification from pat_result_assessments where id=${job.id}`)[0].notification, 'sent');
  let events = [];
  for (let attempt = 0; attempt < 25; attempt++) {
    events = [];
    for await (const event of eve.sessions.attach(session.state.sessionId).stream({ follow: false })) events.push(event);
    if (events.filter(e => e.type === 'turn.completed').length >= 2) break;
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  assert.ok(JSON.stringify(events).includes('Resultatgranskaren har återrapporterat'));
  assert.ok(events.filter(e => e.type === 'turn.completed').length >= 2, 'V must finish the review summary');
  assert.equal(events.filter(e => e.type === 'action.result').length, 0, 'Review feedback must not invoke tools');
  const priorTurns = events.filter(e => e.type === 'turn.started').length;
  await api('/api/internal/result-reviews/drain', 'POST', {}, true);
  const afterReplay = [];
  for await (const event of eve.sessions.attach(session.state.sessionId).stream({ follow: false })) afterReplay.push(event);
  assert.equal(afterReplay.filter(e => e.type === 'turn.started').length, priorTurns, 'Repeated drain must not send a duplicate message');
  console.log('PASS actual Eve summary in originating chat, no tool calls, no duplicate notification');
  await sql`update pat_workspace_items set version = version + 1 where id = ${evidence.id}`;
  assert.equal((await api(`${path}?runId=${run.id}`)).data.assessments[0].stale, true);
  // Expired third attempt models a crashed worker; no additional paid invocation.
  const oldToken = randomUUID();
  await sql`update pat_result_assessments set status='running', attempts=3, assessment=null, finished_at=null, lease_token=${oldToken}, lease_until=now()-interval '1 minute' where id=${job.id}`;
  assert.equal((await api('/api/internal/result-reviews/drain', 'POST', {}, true)).status, 200);
  const [recovered] = await sql`select * from pat_result_assessments where id=${job.id}`;
  assert.equal(recovered.status, 'failed');
  const staleWrite = await sql`update pat_result_assessments set status='completed' where id=${job.id} and lease_token=${oldToken} returning id`;
  assert.equal(staleWrite.length, 0);
  assert.deepEqual((await sql`select result from pat_test_runs where id = ${run.id}`)[0].result, result);
  console.log('PASS changed evidence invalidates assessment; exhausted lease fails safely; stale worker cannot commit');
} catch (error) { console.error('Integration failure:', error.message); throw error; } finally {
  if (session) await session.cancel().catch(() => {});
  const paths = await sql`select i.blob_path from pat_workspace_items i join pat_workspaces w on w.id=i.workspace_id where w.user_id=${userId} and i.blob_path is not null`;
  for (const row of paths) await del(row.blob_path, { token: process.env.WORKSPACE_BLOB_READ_WRITE_TOKEN });
  await sql`delete from pat_test_captures where run_id in (select r.id from pat_test_runs r join pat_workspaces w on w.id=r.workspace_id where w.user_id=${userId})`;
  await sql`delete from pat_user where id=${userId}`;
  await sql.end(); await admin.auth.admin.deleteUser(userId);
  console.log('Cleaned temporary review fixtures');
}
