// Opt-in real Eve/Codex test: delegation releases chat while Codex is still busy.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Client } from 'eve/client';
import { createClient } from '@supabase/supabase-js';
import { createServerClient } from '@supabase/ssr';
import postgres from 'postgres';
if (process.env.RUN_CODEX_CHAT_TESTS !== '1') throw new Error('Enable live Codex chat verification explicitly');
const origin = process.env.APP_URL || 'http://localhost:3000';
const userId = process.env.CODEX_PILOT_USER_ID;
const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const { data: identity } = await admin.auth.admin.getUserById(userId);
assert.ok(identity.user?.email);
// Generate, but do not send, a one-use sign-in link for the authorized pilot owner.
const { data: link, error } = await admin.auth.admin.generateLink({ type: 'magiclink', email: identity.user.email });
assert.equal(error, null);
const cookies = new Map();
const auth = createServerClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, { cookieOptions: { name: 'pat_supabase_auth', path: '/', sameSite: 'lax' }, cookies: { getAll: () => [...cookies].map(([name, value]) => ({ name, value })), setAll: values => values.forEach(c => cookies.set(c.name, c.value)) } });
assert.equal((await auth.auth.verifyOtp({ token_hash: link.properties.hashed_token, type: 'magiclink' })).error, null);
const headers = () => ({ cookie: [...cookies].map(([key, value]) => `${key}=${value}`).join('; '), 'content-type': 'application/json' });
async function api(path, body) {
  const response = await fetch(origin + path, { method: body ? 'POST' : 'GET', headers: headers(), body: body ? JSON.stringify(body) : undefined });
  const data = await response.json(); assert.ok(response.ok, JSON.stringify(data)); return data;
}
const calls = result => result.events.filter(e => e.type === 'action.result').map(e => e.data.result?.toolName);
let workspaceId, session;
try {
  workspaceId = (await api('/api/workspaces', { name: `Codex handoff verification ${randomUUID().slice(0, 8)}` })).workspace.id;
  const thread = (await api('/api/threads', { workspaceId, title: 'Disposable background chat test' })).thread;
  const client = new Client({ host: origin, headers: { ...headers(), 'x-pat-browser-thread': thread.id, 'x-pat-chat-model': 'glm-5.3-flash', 'x-pat-reasoning': 'low' } });
  const startedAt = Date.now();
  const started = await client.sessions.create({ message: 'Använd codex start för detta testuppdrag: inspektera miljön, kör sedan sleep 90 i sandboxen och kontrollera processen tills den avslutats. Inget repo, inga installationer. Delegera direkt till Codex, inte repo-agenten. Följ sedan själv upp status tills Codex är klar.' });
  session = started.session;
  const first = await started.response.result();
  assert.equal(first.status, 'waiting', first.message);
  assert.equal(calls(first).filter(name => name === 'codex').length, 1, JSON.stringify(calls(first)));
  const states = await api(`/api/workspaces/${workspaceId}/sandboxes`);
  assert.ok(states.sessions.some(s => ['starting', 'running'].includes(s.codex?.status)), 'Chat must become ready while Codex is still active');
  // Queue avoids the SDK steer/cancellation boundary race when sending immediately after waiting.
  const second = await (await session.send('Vad är ett enhetstest? Svara med en mening utan verktyg.', { turnPolicy: 'queue' })).result();
  assert.equal(second.status, 'waiting'); assert.ok(second.message); assert.equal(calls(second).length, 0);
  const third = await (await session.send('Kontrollera Codex-jobbets status en gång nu.', { turnPolicy: 'queue' })).result();
  assert.equal(third.status, 'waiting'); assert.equal(calls(third).filter(name => name === 'codex').length, 1, JSON.stringify({ message: third.message, calls: calls(third) }));
  console.log(JSON.stringify({ passed: true, elapsedMs: Date.now() - startedAt, turns: [calls(first), calls(second), calls(third)], message: first.message }));
} finally {
  if (session) await session.cancel().catch(() => {});
  if (workspaceId) {
    const states = await api(`/api/workspaces/${workspaceId}/sandboxes`);
    for (const s of states.sessions) await api(`/api/workspaces/${workspaceId}/sandboxes`, { id: s.id, action: 'delete' });
    const sql = postgres(process.env.DATABASE_URL, { prepare: false, max: 1 });
    try { await sql.unsafe('delete from pat_threads where workspace_id=$1', [workspaceId]); await sql.unsafe('delete from pat_workspaces where id=$1', [workspaceId]); } finally { await sql.end(); }
  }
  await auth.auth.signOut({ scope: 'local' });
}
