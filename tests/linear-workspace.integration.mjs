// Opt-in read-only provider verification. Never creates tests or posts to Linear.
import assert from 'node:assert/strict';
import { createClient } from '@supabase/supabase-js';
import { createServerClient } from '@supabase/ssr';
import postgres from 'postgres';
if (process.env.RUN_LINEAR_TESTS !== '1') throw new Error('Enable live Linear verification explicitly');
const sql = postgres(process.env.DATABASE_URL, { prepare: false, max: 1 });
const userId = process.env.CODEX_PILOT_USER_ID;
const origin = process.env.APP_URL || 'http://localhost:3000';
let auth;
try {
  const targets = await sql.unsafe("select d.workspace_id from pat_workspace_destinations d join pat_workspaces w on w.id=d.workspace_id where w.user_id=$1 and d.provider='linear' and d.destination->>'projectId' is not null limit 1", [userId]);
  assert.ok(targets.length, 'Connect a Linear project to the pilot workspace first');
  const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  const { data: identity } = await admin.auth.admin.getUserById(userId);
  const { data: link, error } = await admin.auth.admin.generateLink({ type: 'magiclink', email: identity.user.email });
  assert.equal(error, null);
  const cookies = new Map();
  auth = createServerClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, { cookieOptions: { name: 'pat_supabase_auth', path: '/', sameSite: 'lax' }, cookies: { getAll: () => [...cookies].map(([name, value]) => ({ name, value })), setAll: values => values.forEach(c => cookies.set(c.name, c.value)) } });
  assert.equal((await auth.auth.verifyOtp({ token_hash: link.properties.hashed_token, type: 'magiclink' })).error, null);
  const headers = { cookie: [...cookies].map(([key, value]) => `${key}=${value}`).join('; ') };
  const path = `/api/workspaces/${targets[0].workspace_id}/linear`;
  const response = await fetch(origin + path, { headers, signal: AbortSignal.timeout(60000) });
  const result = await response.json();
  assert.equal(response.status, 200, result.statusMessage || result.message);
  assert.ok(result.project.id);
  assert.ok(Array.isArray(result.project.issues.nodes));
  const denied = await fetch(origin + path);
  assert.equal(denied.status, 401);
  console.log(JSON.stringify({ passed: true, project: result.project.name, issues: result.project.issues.nodes.length, documents: result.project.documents.nodes.length, anonymousDenied: true }));
} finally {
  await auth?.auth.signOut({ scope: 'local' });
  await sql.end();
}
