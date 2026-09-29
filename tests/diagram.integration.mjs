import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import postgres from "postgres";

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
} finally {
  await sql`delete from pat_user where id = ${userId}`;
  await sql.end(); await admin.auth.admin.deleteUser(userId);
  console.log('Temporary diagram fixtures removed');
}
