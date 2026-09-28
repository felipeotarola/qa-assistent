import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { Client } from "eve/client";
import postgres from "postgres";

if (process.env.RUN_WORKSPACE_TESTS !== "1") throw new Error("Set RUN_WORKSPACE_TESTS=1 for disposable fixtures and two model turns.");
const local = "http://localhost:3000";
const secondOrigin = process.env.TEST_CHAT_SECOND_ORIGIN || local;
const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const email = `chat-test-${randomUUID()}@example.com`, password = randomUUID();
const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
if (error) throw new Error("Could not create temporary test user");
const userId = data.user.id;
const cookies = new Map();
const auth = createServerClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, {
  cookieOptions: { name: "pat_supabase_auth", path: "/", sameSite: "lax" },
  cookies: { getAll: () => [...cookies].map(([name, value]) => ({ name, value })), setAll: values => values.forEach(c => cookies.set(c.name, c.value)) },
});
const url = new URL(process.env.DATABASE_URL);
const sql = postgres(url.toString(), { prepare: false, max: 1, ...(url.hostname.endsWith(".pooler.supabase.com") ? { port: 6543 } : {}) });
const cookie = () => [...cookies].map(([k, v]) => `${k}=${v}`).join("; ");
async function api(origin, path, method = "GET", body) {
  const response = await fetch(origin + path, { method, headers: { cookie: cookie(), "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
  assert.ok(response.ok, `${method} ${path}: ${response.status}`);
  return response.json();
}
try {
  assert.equal((await auth.auth.signInWithPassword({ email, password })).error, null);
  const { thread } = await api(local, "/api/threads", "POST", { title: "Shared history fixture" });
  const client = origin => new Client({ host: origin, headers: { cookie: cookie(), "x-pat-browser-thread": thread.id, "x-pat-chat-model": "glm-5.3-flash", "x-pat-reasoning": "low" } });
  const marker = `Sommar-${randomUUID().slice(0, 8)}`;
  const first = await client(local).sessions.create({ message: `Projektets testkod är ${marker}. Svara bara: Noterat. Spara inget i minne eller workspace, använd inga verktyg.` });
  assert.notEqual((await first.response.result()).status, "failed");
  const initial = (await api(local, `/api/threads/${thread.id}`)).thread;
  assert.equal(initial.sessionId, first.session.state.sessionId, "Server hook saves runtime binding without browser callbacks");
  assert.ok(initial.history.some(row => row.message.parts.some(p => p.type === "text" && p.text.includes(marker))));
  const count = initial.history.length;
  if (secondOrigin === local) {
    // Simulate the first session belonging to another runtime without changing
    // application configuration or touching any real user's rows.
    await sql`update pat_chat_runtimes set runtime = 'test-other-runtime' where thread_id = ${thread.id}`;
  }
  const other = (await api(secondOrigin, `/api/threads/${thread.id}`)).thread;
  assert.equal(other.sessionId, null, "Other runtime must not resume the original workflow ID");
  assert.equal(other.history.length, count, "Both environments see the same history");
  const stale = await fetch(`${secondOrigin}/api/threads/${thread.id}`, { method: "PATCH", headers: { cookie: cookie(), "content-type": "application/json" }, body: JSON.stringify({ sessionId: first.session.state.sessionId }) });
  assert.equal(stale.status, 409, "Old browser tabs cannot restore a foreign runtime's session ID");
  const returnMarker = `Vinter-${randomUUID().slice(0, 8)}`;
  const second = await client(secondOrigin).sessions.create({ message: `Projektets andra testkod är ${returnMarker}. Vad är projektets första testkod som jag nämnde tidigare i den här chatten? Svara endast med den första koden. Spara inget i minne eller workspace. Använd inga verktyg.` });
  const outcome = await second.response.result();
  if (outcome.status === "failed") console.log(outcome.events.filter(e => ["step.failed", "turn.failed", "session.failed"].includes(e.type)).map(e => ({ type: e.type, code: e.data.code, message: e.data.message, details: e.data.details })));
  assert.notEqual(outcome.status, "failed");
  const final = (await api(secondOrigin, `/api/threads/${thread.id}`)).thread;
  assert.equal(final.sessionId, second.session.state.sessionId);
  assert.ok(final.history.some(row => row.sessionId === second.session.state.sessionId && row.message.role === "assistant" && row.message.parts.some(p => p.type === "text" && p.text.includes(marker))), "New runtime receives the archived conversation as model context");
  const repeated = (await api(secondOrigin, `/api/threads/${thread.id}`)).thread;
  assert.equal(repeated.history.length, final.history.length, "Reload must not duplicate archived messages");
  if (secondOrigin !== local) {
    const third = await first.session.send("Vad är projektets ANDRA testkod som jag nämnde senast? Svara endast med den andra koden. Använd inga verktyg.");
    assert.notEqual((await third.result()).status, "failed");
    const returned = (await api(local, `/api/threads/${thread.id}`)).thread;
    assert.ok(returned.history.some(row => row.sessionId === first.session.state.sessionId && row.message.role === "assistant" && row.message.parts.some(p => p.type === "text" && p.text.includes(returnMarker))), "Existing local session sees new production messages");
  }
  assert.equal((await fetch(`${secondOrigin}/api/threads/${thread.id}/history`)).status, 401);
  const denied = await fetch(`${local}/api/internal/chat-history`, { method: "POST", headers: { authorization: `Bearer ${process.env.INTERNAL_API_SECRET}`, "content-type": "application/json" }, body: JSON.stringify({ userId: randomUUID(), threadId: thread.id, sessionId: "other" }) });
  assert.equal(denied.status, 404);
  console.log("PASS shared persisted history, distinct runtime sessions, real agent context transfer, reload deduplication and user isolation");
} finally {
  await sql`delete from pat_user where id = ${userId}`;
  await admin.auth.admin.deleteUser(userId);
  await sql.end();
}
