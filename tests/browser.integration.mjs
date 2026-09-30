// Explicit integration test: creates a temporary Supabase user and Browserbase
// session, exercises the real HTTP API, then removes its own fixtures.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { Client } from "eve/client";
import Browserbase from "@browserbasehq/sdk";

if (process.env.RUN_BROWSERBASE_TESTS !== "1" && process.env.RUN_VPS_BROWSER_TESTS !== '1') throw new Error("Enable the live browser integration test explicitly.");
const origin = process.env.APP_URL || "http://localhost:3000";
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const admin = createClient(supabaseUrl, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const email = `browser-test-${randomUUID()}@example.com`;
const password = randomUUID();
const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
if (error) throw new Error("Could not create the integration test user");
const userId = data.user.id;
const cookies = new Map();
const client = createServerClient(supabaseUrl, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, {
  cookieOptions: { name: "pat_supabase_auth", path: "/", sameSite: "lax" },
  cookies: { getAll: () => [...cookies].map(([name, value]) => ({ name, value })), setAll: values => values.forEach(c => cookies.set(c.name, c.value)) },
});
let threadId;
let parallelThreadId;
async function api(path, body, internal = false, anonymous = false) {
  const headers = { "content-type": "application/json" };
  if (internal) headers.authorization = `Bearer ${process.env.INTERNAL_API_SECRET}`;
  if (!anonymous) headers.cookie = [...cookies].map(([k, v]) => `${k}=${v}`).join("; ");
  const response = await fetch(`${origin}${path}`, { method: body ? "POST" : "GET", headers, body: body ? JSON.stringify(body) : undefined });
  const payload = await response.json().catch(() => null);
  return { status: response.status, payload };
}
async function action(input, id = userId) {
  const result = await api("/api/internal/browser", { userId: id, threadId, input }, true);
  assert.equal(result.status, 200, `Browser API status ${result.status}`);
  return result.payload;
}
try {
  const signIn = await client.auth.signInWithPassword({ email, password });
  assert.equal(signIn.error, null);
  const workspace = await api('/api/workspaces', { name: 'Temporary browser verification' });
  const thread = await api("/api/threads", { title: "Browser integration test", workspaceId: workspace.payload.workspace.id });
  assert.ok([200, 201].includes(thread.status));
  threadId = thread.payload.thread.id;
  assert.equal((await api(`/api/threads/${threadId}/browser`, undefined, false, true)).status, 401);
  assert.equal((await api("/api/internal/browser", { userId: randomUUID(), threadId, input: { action: "inspect" } }, true)).status, 404);
  console.log("PASS authenticated access and ownership isolation");
  // Regression: workspace polling must not exhaust the DB pool while capture
  // reads run inside the browser transaction (especially on the first session).
  let polling = false;
  const poll = setInterval(async () => {
    if (polling) return;
    polling = true;
    try { await api(`/api/threads/${threadId}/browser`); } finally { polling = false; }
  }, 300);
  let opened;
  try {
    opened = await Promise.race([
      action({ action: "open", url: "https://en.wikipedia.org/wiki/Software_testing" }),
      new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('Browser/polling deadlock')), 45000); timer.unref(); }),
    ]);
  } finally { clearInterval(poll); }
  assert.equal(opened.status, "ready", `Open returned ${opened.status}: ${opened.message ?? ''}`);
  assert.match(opened.title, /Software testing/);
  assert.ok(opened.controls.length > 0);
  const view = await api(`/api/threads/${threadId}/browser`);
  assert.ok(view.payload.browser.liveUrl.startsWith(process.env.BROWSER_PROVIDER === 'vps' ? process.env.BROWSER_SERVICE_URL : 'https://'));
  assert.equal(view.payload.browser.connectUrl, undefined);
  const second = (await api("/api/threads", { title: "Shared workspace", workspaceId: thread.payload.thread.workspaceId })).payload.thread.id;
  const shared = (await api(`/api/threads/${second}/browser`)).payload.browser;
  assert.equal(shared.liveUrl, view.payload.browser.liveUrl);
  const separateWorkspace = (await api("/api/workspaces", { name: "Separate browser scope" })).payload.workspace.id;
  const separate = (await api("/api/threads", { title: "Isolated", workspaceId: separateWorkspace })).payload.thread.id;
  assert.equal((await api(`/api/threads/${separate}/browser`)).payload.browser, null);
  if (process.env.TEST_PARALLEL_BROWSERS === '1') {
    parallelThreadId = separate;
    const parallel = await api('/api/internal/browser', { userId, threadId: separate, input: { action: 'open', url: 'https://en.wikipedia.org/wiki/Software_testing' } }, true);
    assert.equal(parallel.payload?.status, 'ready', 'Second workspace must open its own browser');
    const parallelView = (await api(`/api/threads/${separate}/browser`)).payload.browser;
    assert.notEqual(parallelView.sessionId, view.payload.browser.sessionId);
    assert.equal((await action({ action: 'inspect' })).status, 'ready', 'First browser must remain usable');
    console.log('PASS two workspaces have simultaneously usable independent sessions');
  }
  console.log("PASS browser shared across workspace chats and isolated from other workspaces");
  console.log("PASS real Chromium navigation, page reading and live view");
  const taken = await api(`/api/threads/${threadId}/browser`, { control: "human" });
  assert.equal(taken.payload.browser.control, "human");
  for (const input of [{ action: "open", url: "https://example.com" }, { action: "inspect" }, { action: "close" }]) {
    assert.equal((await action(input)).status, "human_control");
  }
  console.log("PASS human takeover blocks agent navigation, reading and close");
  await api(`/api/threads/${threadId}/browser`, { control: "agent" });
  const inspected = await action({ action: "inspect" });
  assert.equal(inspected.status, "ready", JSON.stringify(inspected));
  assert.match(inspected.title, /Software testing/);
  const example = await action({ action: "open", url: "https://example.com" });
  assert.equal(example.status, "ready", `Navigation returned ${example.status}: ${example.message ?? ''}`);
  const linked = example.controls.find(c => c.tag === "a");
  assert.ok(linked, "Expected a visible link on Example Domain");
  const clicked = await action({ action: "click", ref: linked.ref });
  assert.equal(clicked.status, "ready", JSON.stringify(clicked));
  assert.match(clicked.url, /iana.org/);
  const back = await action({ action: "back" });
  assert.equal(back.status, "ready", JSON.stringify(back));
  console.log("PASS return control and reuse the same session");
  const closed = await api(`/api/threads/${threadId}/browser`, { control: "close" });
  assert.equal(closed.status, 200, `Close returned HTTP ${closed.status}: ${closed.payload?.statusMessage ?? ''}`);
  assert.ok(!(await api(`/api/threads/${threadId}/browser`)).payload.browser, 'Live view must clear after closing');
  if (parallelThreadId) {
    const parallel = await api('/api/internal/browser', { userId, threadId: parallelThreadId, input: { action: 'inspect' } }, true);
    assert.equal(parallel.payload?.status, 'ready', 'Closing first workspace must leave second usable');
  }
  console.log("PASS session release and cleared live view");
  if (process.env.TEST_EVE_BROWSER === "1") {
    const eve = new Client({ host: origin, headers: {
      cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join("; "),
      "x-pat-browser-thread": threadId, "x-pat-chat-model": "glm-5.3-flash", "x-pat-reasoning": "low",
    } });
    const { response } = await eve.sessions.create({ message: "Öppna https://en.wikipedia.org/wiki/Software_testing i webbläsaren i workspace. Använd browser-verktyget och bekräfta sidans titel. Inget annat." });
    const result = await response.result();
    assert.notEqual(result.status, "failed");
    assert.ok(!result.events.some(event => event.type === "input.requested"), "Browser navigation must not request approval");
    assert.match(result.message, /Software testing/i);
    const state = (await api(`/api/threads/${threadId}/browser`)).payload.browser;
    assert.ok(state, "The agent must actually create a browser session");
    assert.match(state.title, /Software testing/);
    console.log("PASS actual Eve + GLM turn invokes browser tool and opens Workspace session");
  }
}
finally {
  if (parallelThreadId) await api(`/api/threads/${parallelThreadId}/browser`, { control: 'close' }).catch(() => {});
  if (threadId) await api(`/api/threads/${threadId}/browser`, { control: "close" }).catch(() => {});
  // Only remove the randomly named user and its app data created by this test.
  const { default: postgres } = await import("postgres");
  const sql = postgres(process.env.DATABASE_URL, { prepare: false, max: 1 });
  const [browserRow] = await sql`select context_id from pat_workspace_browsers where user_id = ${userId}`;
  if (browserRow?.context_id) await new Browserbase({ apiKey: process.env.BROWSERBASE_API_KEY }).contexts.delete(browserRow.context_id);
  await sql`delete from pat_user where id = ${userId}`;
  await sql.end();
  await admin.auth.admin.deleteUser(userId);
  console.log("Cleaned integration test fixtures");
}
