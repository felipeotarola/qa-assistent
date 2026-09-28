import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { del } from "@vercel/blob";
import postgres from "postgres";
import { Client } from "eve/client";

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
  const a = (await api("/api/workspaces", "POST", { name: "Integration A" })).data.workspace.id;
  const b = (await api("/api/workspaces", "POST", { name: "Integration B" })).data.workspace.id;
  const t1 = (await api("/api/threads", "POST", { title: "First", workspaceId: a })).data.thread.id;
  const t2 = (await api("/api/threads", "POST", { title: "Second", workspaceId: a })).data.thread.id;
  const other = (await api("/api/threads", "POST", { title: "Isolated", workspaceId: b })).data.thread.id;
  const tool = (threadId, input, principal = userId) => api("/api/internal/workspace", "POST", { userId: principal, threadId, input }, true);
  const created = await tool(t1, { action: "create", title: "Test cases", content: { kind: "table", columns: ["Case", "Status"], rows: [["Login", "Todo"]] } });
  assert.equal(created.status, 200);
  const item = created.data.item;
  assert.equal((await tool(t2, { action: "read", itemId: item.id })).data.item.content.rows[0][0], "Login");
  assert.equal((await tool(other, { action: "read", itemId: item.id })).status, 404);
  assert.equal((await tool(t1, { action: "list" }, randomUUID())).status, 404);
  assert.equal((await fetch(`${origin}/api/workspaces/${a}/items`)).status, 401);
  console.log("PASS shared objects across chats; workspace and user isolation");
  const patch = { title: "Test cases", content: { kind: "table", columns: ["Case", "Status"], rows: [["Login", "Passed"]] }, expectedVersion: 1 };
  assert.equal((await api(`/api/workspaces/${a}/items/${item.id}`, "PATCH", patch)).status, 200);
  assert.equal((await api(`/api/workspaces/${a}/items/${item.id}`, "PATCH", patch)).status, 409);
  const versions = (await api(`/api/workspaces/${a}/items/${item.id}/versions`)).data.versions;
  assert.equal(versions.length, 2);
  assert.equal(versions[1].content.rows[0][1], "Todo");
  assert.equal((await api(`/api/workspaces/${a}/items/${item.id}`, "PATCH", { title: versions[1].title, content: versions[1].content, expectedVersion: 2 })).data.item.version, 3);
  console.log("PASS updates, immutable history, restore and conflict protection");
  if (process.env.WORKSPACE_BLOB_READ_WRITE_TOKEN) {
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5WQAAAAASUVORK5CYII=", "base64");
  const form = new FormData(); form.append("file", new Blob([png], { type: "image/png" }), "fixture.png");
  const response = await fetch(`${origin}/api/workspaces/${a}/upload`, { method: "POST", headers: { cookie: cookie() }, body: form });
  assert.equal(response.status, 200, "Private Blob upload must succeed");
  const uploaded = (await response.json()).item;
  assert.equal(uploaded.content.kind, "image");
  const file = await fetch(`${origin}/api/workspaces/${a}/items/${uploaded.id}/file`, { headers: { cookie: cookie() } });
  assert.equal(file.status, 200); assert.deepEqual(Buffer.from(await file.arrayBuffer()), png);
  assert.equal((await fetch(`${origin}/api/workspaces/${a}/items/${uploaded.id}/file`)).status, 401);
  const generated = await tool(t1, { action: "save_file", filename: "notes.txt", text: "Private workspace file" });
  assert.equal(generated.status, 200);
  console.log("PASS private image upload/download, anonymous denial and agent file creation");
  } else { console.log("SKIP Blob roundtrip: private WORKSPACE_BLOB_READ_WRITE_TOKEN missing"); }
  if (process.env.TEST_EVE_WORKSPACE === "1") {
    const eve = new Client({ host: origin, headers: { cookie: cookie(), "x-pat-browser-thread": t2, "x-pat-chat-model": "glm-5.3-flash", "x-pat-reasoning": "low" } });
    const { response } = await eve.sessions.create({ message: "Använd workspace-verktyget och spara ett textdokument med titeln Agent smoke test och texten Workspace works. Bekräfta när det är sparat. Gör inget annat." });
    const result = await response.result();
    assert.notEqual(result.status, "failed");
    assert.ok((await api(`/api/workspaces/${a}/items`)).data.items.some(i => i.title === "Agent smoke test" && i.content.kind === "text"));
    console.log("PASS real GLM/Eve turn saves a workspace document");
  }
}
finally {
  const paths = await sql`select i.blob_path from pat_workspace_items i join pat_workspaces w on w.id = i.workspace_id where w.user_id = ${userId} and i.blob_path is not null`;
  for (const row of paths) await del(row.blob_path, { token: process.env.WORKSPACE_BLOB_READ_WRITE_TOKEN });
  await sql`delete from pat_user where id = ${userId}`;
  await sql.end(); await admin.auth.admin.deleteUser(userId);
  console.log("Cleaned temporary workspace fixtures");
}
