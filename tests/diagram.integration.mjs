import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import postgres from "postgres";
import { repositoryMapTask } from '../shared/repository-map.ts';
import { sandboxScope } from '../server/utils/sandbox-scope.ts';

if (process.env.RUN_WORKSPACE_TESTS !== "1") throw new Error("Set RUN_WORKSPACE_TESTS=1 to create temporary integration fixtures.");
const origin = "http://localhost:3000";
const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const email = `workspace-test-${randomUUID()}@example.com`;
const password = randomUUID();
const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
if (error) throw new Error("Test user creation failed");
const userId = data.user.id;
const cookies = new Map();
const client = createServerClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, {
  cookieOptions: { name: "pat_supabase_auth", path: "/", sameSite: "lax" },
  cookies: { getAll: () => [...cookies].map(([name, value]) => ({ name, value })), setAll: values => values.forEach(c => cookies.set(c.name, c.value)) },
});
const cookie = () => [...cookies].map(([k, v]) => `${k}=${v}`).join("; ");
async function api(path, method = "GET", body, internal = false) {
  const r = await fetch(origin + path, { method, headers: { cookie: cookie(), "content-type": "application/json", ...(internal ? { authorization: `Bearer ${process.env.INTERNAL_API_SECRET}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, data: await r.json() };
}
const sql = postgres(process.env.DATABASE_URL, { prepare: false, max: 1 });
try {
  assert.equal((await client.auth.signInWithPassword({ email, password })).error, null);
  const a = (await api('/api/workspaces', 'POST', { name: 'Diagram integration' })).data.workspace.id;
  const b = (await api('/api/workspaces', 'POST', { name: 'Isolated diagram' })).data.workspace.id;
  const thread = (await api('/api/threads', 'POST', { title: 'Diagram', workspaceId: a })).data.thread.id;
  const tool = input => api('/api/internal/workspace', 'POST', { userId, threadId: thread, input }, true);
  const source = (await tool({ action: 'create', title: 'Pages', content: { kind: 'table', columns: ['URL'], rows: [['https://example.com']] } })).data.item;
  const content = { kind: 'diagram', summary: 'Inferred structure', nodes: [{ id: 'home', label: 'Home' }, { id: 'docs', label: 'Docs' }], edges: [{ id: 'edge', source: 'home', target: 'docs', status: 'inferred' }], sources: [{ itemId: source.id, version: 1 }] };
  const created = await tool({ action: 'create', title: 'Map', content });
  assert.equal(created.status, 200, JSON.stringify(created.data));
  const item = created.data.item;
  assert.equal((await tool({ action: 'read', itemId: item.id })).data.item.content.edges[0].status, 'inferred');
  assert.equal((await api(`/api/workspaces/${b}/items`, 'POST', { title: 'Wrong workspace', content })).status, 400);
  assert.equal((await tool({ action: 'create', title: 'Wrong version', content: { ...content, sources: [{ itemId: source.id, version: 999 }] } })).status, 400);
  assert.equal((await tool({ action: 'update', itemId: item.id, expectedVersion: 1, content: { ...content, summary: 'Revised' } })).status, 200);
  assert.equal((await tool({ action: 'update', itemId: item.id, expectedVersion: 1, content })).status, 409);
  const versions = (await api(`/api/workspaces/${a}/items/${item.id}/versions`)).data.versions;
  assert.equal(versions.length, 2);
  assert.equal(versions[1].content.summary, 'Inferred structure');
  assert.equal((await tool({ action: 'update', itemId: item.id, expectedVersion: 2, content: { ...content, edges: [{ id: 'invalid', source: 'home', target: 'absent' }] } })).status, 400);
  console.log('PASS diagram API create/read/update/history, source ownership/version, conflict protection and graph validation');
  const jobId = randomUUID(), sessionKey = randomUUID();
  const repo = { url: 'https://github.com/felipeotarola/surdeg', commit: 'a'.repeat(40) };
  const task = repositoryMapTask(repo.url, 'Test fixture');
  await sql`insert into pat_setup_jobs (id,workspace_id,thread_id,runtime,parent_session_id,session_key,task,model,reasoning) values (${jobId},${a},${thread},'map-integration','fixture',${sessionKey},${task},'glm-5.3-flash','low')`;
  const result = { jobId, id: sandboxScope(userId, thread, sessionKey).id, workspaceId: a, status: 'completed', message: 'Fixture analysis', result: JSON.stringify({ kind: 'diagram', repository: repo, nodes: [{ id: 'app', label: 'App', code: [{ path: 'app.ts', line: 1 }] }], edges: [] }), updatedAt: new Date().toISOString() };
  const callbacks = await Promise.all([1,2].map(() => api('/api/internal/setup-result', 'POST', result, true)));
  callbacks.forEach(r => assert.equal(r.status, 200, JSON.stringify(r.data)));
  const maps = (await tool({ action: 'list' })).data.items.filter(i => i.title.endsWith('repokarta'));
  assert.equal(maps.length, 1, 'callback replay must not create duplicate maps');
  const saved = (await tool({ action: 'read', itemId: maps[0].id })).data.item;
  assert.deepEqual(saved.content.repository, repo);
  assert.equal(saved.content.nodes[0].code[0].line, 1);
  assert.equal((await api('/api/internal/setup-result', 'POST', { ...result, workspaceId: b }, true)).status, 409);
  assert.equal((await api('/api/internal/setup-result', 'POST', { ...result, updatedAt: new Date(Date.now()+1000).toISOString(), result: '{}' }, true)).status, 200);
  const [invalid] = await sql`select status,result from pat_setup_jobs where id=${jobId}`;
  assert.equal(invalid.status, 'failed');
  console.log('PASS map callback validation, concurrent deduplication, saved commit/references and scope isolation');
} finally {
  await sql`delete from pat_user where id = ${userId}`;
  await sql.end(); await admin.auth.admin.deleteUser(userId);
  console.log('Temporary diagram fixtures removed');
}
