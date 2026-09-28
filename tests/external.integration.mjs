import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import postgres from "postgres";

if (process.env.RUN_WORKSPACE_TESTS !== "1") throw new Error("Set RUN_WORKSPACE_TESTS=1 for disposable user/database fixtures.");
const origin = "http://localhost:3000";
const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const sql = postgres(process.env.DATABASE_URL, { prepare: false, max: 1 });
const users = [];
async function account() {
  const email = `external-test-${randomUUID()}@example.com`;
  const password = randomUUID();
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error("Cannot create disposable user");
  users.push(data.user.id);
  const cookies = new Map();
  const client = createServerClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, {
    cookieOptions: { name: "pat_supabase_auth", path: "/", sameSite: "lax" },
    cookies: { getAll: () => [...cookies].map(([name, value]) => ({ name, value })), setAll: values => values.forEach(c => cookies.set(c.name, c.value)) },
  });
  assert.equal((await client.auth.signInWithPassword({ email, password })).error, null);
  return { id: data.user.id, cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join("; ") };
}
async function api(user, path, method = "GET", body, internal = false) {
  const response = await fetch(origin + path, { method, headers: { cookie: user.cookie, "content-type": "application/json", ...(internal ? { authorization: `Bearer ${process.env.INTERNAL_API_SECRET}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: response.status, data: await response.json() };
}
try {
  const a = await account(); const b = await account();
  const workspace = (await api(a, "/api/workspaces", "POST", { name: "External fixture" })).data.workspace.id;
  await api(b, "/api/workspaces");
  const thread1 = (await api(a, "/api/threads", "POST", { workspaceId: workspace, title: "First" })).data.thread.id;
  const thread2 = (await api(a, "/api/threads", "POST", { workspaceId: workspace, title: "Second" })).data.thread.id;
  const destination = { provider: "github", targetId: "fixture/no-network", label: "Fixture" };
  await sql`insert into pat_workspace_destinations (workspace_id, provider, destination) values (${workspace}, 'github', ${sql.json(destination)})`;
  const saved = { id: "42", title: "Fixture issue", body: "", url: "https://github.com/fixture/no-network/issues/42" };
  await sql`insert into pat_external_operations (id, workspace_id, provider, action, fingerprint, destination, state, result) values (${randomUUID()}, ${workspace}, 'github', 'create', 'fixture', ${sql.json(destination)}, 'complete', ${sql.json(saved)})`;
  for (let i = 0; i < 27; i++) {
    await sql`insert into pat_workspace_items (id, workspace_id, title, content) values (${randomUUID()}, ${workspace}, ${`Fixture ${i}`}, ${sql.json({ kind: "text", text: "Private body excluded from automatic context" })})`;
  }
  await sql`insert into pat_workspace_items (id, workspace_id, title, content, deleted_at) values (${randomUUID()}, ${workspace}, 'Trashed fixture', ${sql.json({ kind: "text", text: "Hidden" })}, now())`;
  const owner = await api(a, `/api/workspaces/${workspace}/destinations`);
  assert.equal(owner.status, 200);
  assert.equal(owner.data.destinations[0].targetId, destination.targetId);
  assert.equal(owner.data.operations[0].result.url, saved.url);
  for (const threadId of [thread1, thread2]) {
    const context = await api(a, "/api/internal/workspace-context", "POST", { userId: a.id, threadId }, true);
    assert.equal(context.status, 200);
    assert.equal(context.data.workspace.id, workspace);
    assert.equal(context.data.items.length, 25);
    assert.equal(context.data.itemsTruncated, true);
    assert.ok(context.data.items.every(item => item.title !== "Trashed fixture" && item.content === undefined));
    assert.equal(context.data.destinations[0].targetId, destination.targetId);
    assert.equal(context.data.recentOperations[0].result.url, saved.url);
    assert.equal(context.data.recentOperations[0].result.body, undefined);
    const result = await api(a, "/api/internal/external", "POST", { userId: a.id, threadId, callId: randomUUID(), input: { action: "destinations" } }, true);
    assert.equal(result.status, 200);
    assert.equal(result.data.destinations[0].targetId, destination.targetId);
  }
  assert.equal((await api(b, `/api/workspaces/${workspace}/destinations`)).status, 404);
  assert.equal((await api(b, "/api/internal/workspace-context", "POST", { userId: b.id, threadId: thread1 }, true)).status, 404);
  assert.equal((await api(a, "/api/internal/workspace-context", "POST", { userId: a.id, threadId: thread1 })).status, 401);
  assert.equal((await api(b, `/api/workspaces/${workspace}/destinations?provider=github`, "DELETE")).status, 404);
  assert.equal((await api(b, `/api/workspaces/${workspace}/destinations`, "PUT", destination)).status, 404);
  assert.equal((await api(b, "/api/internal/external", "POST", { userId: b.id, threadId: thread1, callId: randomUUID(), input: { action: "history" } }, true)).status, 404);
  assert.equal((await api(a, "/api/internal/external", "POST", { userId: a.id, threadId: thread1, callId: randomUUID(), input: { action: "history" } })).status, 401);
  assert.equal((await fetch(`${origin}/api/workspaces/${workspace}/destinations`)).status, 401);
  assert.equal((await fetch(`${origin}/api/integrations/github/destinations`)).status, 401);
  assert.equal((await api(a, `/api/workspaces/${workspace}/destinations?provider=github`, "DELETE")).status, 200);
  assert.deepEqual((await api(a, `/api/workspaces/${workspace}/destinations`)).data.destinations, []);
  assert.deepEqual((await api(a, "/api/internal/workspace-context", "POST", { userId: a.id, threadId: thread2 }, true)).data.destinations, []);
  assert.equal((await api(a, `/api/workspaces/${workspace}/destinations`)).data.operations.length, 1);
  console.log("PASS personal access, shared chat destinations, private receipts, internal authentication, disconnect retains history");
} finally {
  for (const id of users) {
    await sql`delete from pat_user where id = ${id}`;
    await admin.auth.admin.deleteUser(id);
  }
  await sql.end();
}
