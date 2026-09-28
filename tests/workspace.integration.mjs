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
  assert.equal((await api(`/api/workspaces/${b}/items/${item.id}`, "DELETE")).status, 404);
  assert.equal((await fetch(`${origin}/api/workspaces/${a}/items/${item.id}`, { method: "DELETE" })).status, 401);
  assert.equal((await api(`/api/workspaces/${a}/items/${item.id}`, "DELETE")).status, 200);
  assert.ok(!(await tool(t2, { action: "list" })).data.items.some(i => i.id === item.id));
  assert.equal((await tool(t2, { action: "read", itemId: item.id })).status, 404);
  assert.equal((await api(`/api/workspaces/${a}/items/${item.id}`, "PATCH", { ...patch, expectedVersion: 3 })).status, 404);
  assert.ok((await api(`/api/workspaces/${a}/items?trash=true`)).data.items.some(i => i.id === item.id));
  assert.equal((await api(`/api/workspaces/${b}/items/${item.id}/restore`, "POST")).status, 404);
  assert.equal((await api(`/api/workspaces/${a}/items/${item.id}/restore`, "POST")).status, 200);
  assert.equal((await tool(t2, { action: "read", itemId: item.id })).data.item.version, 3);
  assert.equal((await api(`/api/workspaces/${a}/items/${item.id}/versions`)).data.versions.length, 3);
  console.log("PASS trash, hidden agent reads/writes, ownership and full restoration");
  if (process.env.WORKSPACE_BLOB_READ_WRITE_TOKEN) {
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5WQAAAAASUVORK5CYII=", "base64");
  const form = new FormData(); form.append("file", new Blob([png], { type: "image/png" }), "fixture.png");
  const response = await fetch(`${origin}/api/workspaces/${a}/upload`, { method: "POST", headers: { cookie: cookie() }, body: form });
  assert.equal(response.status, 200, "Private Blob upload must succeed");
  const uploaded = (await response.json()).item;
  assert.equal(uploaded.content.kind, "image");
  const imageRef = { kind: "image", itemId: uploaded.id, caption: "Exempelbild" };
  const documentContent = { kind: "text", text: "", blocks: [{ kind: "heading", text: "Beskrivning" }, { kind: "text", text: "Sidan visas nedan." }, imageRef] };
  const document = (await tool(t1, { action: "create", title: "Illustrerad beskrivning", content: documentContent })).data.item;
  assert.equal(document.content.blocks[2].itemId, uploaded.id);
  assert.match(document.content.text, /Sidan visas/);
  assert.equal((await tool(other, { action: "create", title: "Forbidden image", content: documentContent })).status, 400);
  assert.equal((await tool(t1, { action: "create", title: "Missing image", content: { ...documentContent, blocks: [{ ...imageRef, itemId: randomUUID() }] } })).status, 400);
  assert.equal((await api(`/api/workspaces/${a}/items/${uploaded.id}`, "DELETE")).status, 409);
  const imageTable = (await tool(t2, { action: "create", title: "Bildtabell", content: { kind: "table", columns: ["Sida", "Bild"], rows: [["Startsida", imageRef]] } })).data.item;
  assert.equal(imageTable.content.rows[0][1].itemId, uploaded.id);
  await tool(t1, { action: "update", itemId: document.id, expectedVersion: 1, title: document.title, content: { kind: "text", text: "Utan bild" } });
  assert.equal((await api(`/api/workspaces/${a}/items/${uploaded.id}`, "DELETE")).status, 409, "Other references still protect the shared image");
  await api(`/api/workspaces/${a}/items/${imageTable.id}`, "DELETE");
  const oldDocument = (await api(`/api/workspaces/${a}/items/${document.id}/versions`)).data.versions.find(v => v.version === 1);
  assert.equal(oldDocument.content.blocks[2].itemId, uploaded.id);
  console.log("PASS document blocks, image table cells, scoped references, reuse and history");
  if (process.env.TEST_IMAGE_DOCUMENT === "1") {
    const eve = new Client({ host: origin, headers: { cookie: cookie(), "x-pat-browser-thread": t1, "x-pat-chat-model": "glm-5.3-flash", "x-pat-reasoning": "low" } });
    const generated = await eve.sessions.create({ message: `Skapa ett dokument i workspace med titeln Bildtest agent. Skriv en kort exempelbeskrivning och infoga den befintliga bilden fixture.png med ID ${uploaded.id} som bildblock efter texten, med bildtexten Exempelbild. Använd workspace-verktyget och bekräfta när dokumentet är sparat. Skapa ingen ny bild.` });
    assert.notEqual((await generated.response.result()).status, 'failed');
    const saved = (await api(`/api/workspaces/${a}/items`)).data.items.find(i => i.title === 'Bildtest agent');
    assert.ok(saved?.content.blocks?.some(b => b.kind === 'image' && b.itemId === uploaded.id), 'Agent must embed the actual image ID');
    await api(`/api/workspaces/${a}/items/${saved.id}`, 'DELETE');
    console.log('PASS real GLM/Eve agent embeds existing image in document');
  }
  const file = await fetch(`${origin}/api/workspaces/${a}/items/${uploaded.id}/file`, { headers: { cookie: cookie() } });
  assert.equal(file.status, 200); assert.deepEqual(Buffer.from(await file.arrayBuffer()), png);
  assert.equal((await fetch(`${origin}/api/workspaces/${a}/items/${uploaded.id}/file`)).status, 401);
  await api(`/api/workspaces/${a}/items/${uploaded.id}`, "DELETE");
  assert.equal((await fetch(`${origin}/api/workspaces/${a}/items/${uploaded.id}/file`, { headers: { cookie: cookie() } })).status, 404);
  await api(`/api/workspaces/${a}/items/${uploaded.id}/restore`, "POST");
  assert.equal((await fetch(`${origin}/api/workspaces/${a}/items/${uploaded.id}/file`, { headers: { cookie: cookie() } })).status, 200);
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
    const suggested = await eve.sessions.create({ message: "Jag planerar att undersöka inloggningen på en webbplats men vet inte var jag ska börja. Ge mig tre konkreta alternativ att välja mellan som förslagsknappar. Utför inget av alternativen ännu." });
    const suggestionsResult = await suggested.response.result();
    assert.notEqual(suggestionsResult.status, "failed");
    const suggestionResult = suggestionsResult.events.findLast(e => e.type === "action.result" && e.data.result?.toolName === "suggest_next_steps" && e.data.status === "completed");
    const choices = suggestionResult?.data.result.output.suggestions;
    assert.ok(choices?.length >= 2 && choices.length <= 4, "Agent must return completed suggestion output");
    assert.ok(choices.every(s => typeof s.label === "string" && s.label.length <= 60 && typeof s.prompt === "string" && /inlogg|webb|test/i.test(s.prompt)));
    assert.ok(!suggestionsResult.events.some(e => e.type === "input.requested"), "Suggestions must not pause for approval");
    console.log("PASS contextual suggestion labels/prompts returned without executing a choice");
  }
  if (process.env.TEST_RESEARCH === "1") {
    assert.equal((await api('/api/internal/research', 'POST', { userId, threadId: t1, input: { url: 'http://127.0.0.1', screenshot: false } }, true)).status, 400);
    assert.equal((await api('/api/internal/research', 'POST', { userId: randomUUID(), threadId: t1, input: { url: 'https://example.com', screenshot: false } }, true)).status, 404);
    const eve = new Client({ host: origin, headers: { cookie: cookie(), "x-pat-browser-thread": t1, "x-pat-chat-model": "glm-5.3-flash", "x-pat-reasoning": "low" } });
    const researched = await eve.sessions.create({ message: "Använd research för att läsa https://example.com i bakgrunden och spara en screenshot. Beskriv sidan kort med källans URL. Använd inte live-webbläsaren." });
    const result = await researched.response.result();
    const done = result.events.findLast(e => e.type === 'action.result' && e.data.result?.toolName === 'research' && e.data.status === 'completed');
    const output = done?.data.result.output;
    assert.equal(output?.status, 'ready', 'Research tool must succeed');
    assert.match(output.title, /Example Domain/);
    assert.ok(output.links.some(link => /iana.org/.test(link.url)));
    assert.equal(output.screenshot.content.kind, 'image');
    const picture = await fetch(`${origin}/api/workspaces/${a}/items/${output.screenshot.id}/file`, { headers: { cookie: cookie() } });
    assert.equal(picture.status, 200);
    assert.ok((await picture.arrayBuffer()).byteLength > 1000);
    assert.equal((await api(`/api/threads/${t1}/browser`)).data.browser, null);
    console.log('PASS real agent research, page text/links, private screenshot and no live browser');
  }
}
finally {
  const paths = await sql`select i.blob_path from pat_workspace_items i join pat_workspaces w on w.id = i.workspace_id where w.user_id = ${userId} and i.blob_path is not null`;
  for (const row of paths) await del(row.blob_path, { token: process.env.WORKSPACE_BLOB_READ_WRITE_TOKEN });
  await sql`delete from pat_user where id = ${userId}`;
  await sql.end(); await admin.auth.admin.deleteUser(userId);
  console.log("Cleaned temporary workspace fixtures");
}
