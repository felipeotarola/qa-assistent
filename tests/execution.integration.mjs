// Opt-in: temporary user, two real VPS environments, a local app and two browsers.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { createServerClient } from '@supabase/ssr';
if (process.env.RUN_EXECUTION_TESTS !== '1') throw new Error('Enable live VPS integration tests explicitly');
const origin = process.env.APP_URL || 'http://localhost:3000';
const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const email = `execution-${randomUUID()}@example.com`, password = randomUUID();
const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
if (error) throw error;
const userId = data.user.id, cookies = new Map();
const client = createServerClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, { cookieOptions: { name: 'pat_supabase_auth', path: '/', sameSite: 'lax' }, cookies: { getAll: () => [...cookies].map(([name, value]) => ({ name, value })), setAll: values => values.forEach(c => cookies.set(c.name, c.value)) } });
async function api(path, body, internal = false) {
  const response = await fetch(origin + path, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json', cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join('; '), ...(internal ? { authorization: `Bearer ${process.env.INTERNAL_API_SECRET}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const result = await response.json(); assert.ok([200, 201].includes(response.status), JSON.stringify(result)); return result;
}
let threadId;
const keys = [randomUUID(), randomUUID()];
const sandbox = (sessionKey, input) => api('/api/internal/sandbox', { userId, threadId, sessionKey, input }, true);
const browser = (input, agentId = 'main') => api('/api/internal/browser', { userId, threadId, agentId, input }, true);
async function processResult(key, processId) {
  const until = Date.now() + 15000;
  for (;;) {
    const process = await sandbox(key, { action: 'process', processId });
    if (process.status === 'completed') return process;
    assert.ok(Date.now() < until); await new Promise(resolve => setTimeout(resolve, 300));
  }
}
try {
  assert.equal((await client.auth.signInWithPassword({ email, password })).error, null);
  const { workspace } = await api('/api/workspaces', { name: 'Temporary execution verification' });
  const { thread } = await api('/api/threads', { title: 'App preview and browser isolation', workspaceId: workspace.id }); threadId = thread.id;
  await sandbox(keys[0], { action: 'ensure' }); await sandbox(keys[1], { action: 'ensure' });
  const grantStarted = Date.now();
  const grants = await api(`/api/workspaces/${workspace.id}/execution-subscriptions`, {});
  const grantFinished = Date.now();
  const grant = grants.streams.find(s => s.kind === 'repository'); assert.ok(grant, 'Worker event subscription is available');
  // Grant lifetime is exactly 120s. Correct for client/VPS clock skew, reporting
  // the full handshake uncertainty rather than assuming synchronized machines.
  const clockOffset = (grantStarted + grantFinished) / 2 - (grant.expiresAt - 120000);
  const denied = await fetch(grant.url, { headers: { Origin: 'https://wrong.example' } }); assert.equal(denied.status, 401);
  const stopStream = new AbortController(), samples = [], cursor = new Map();
  const connectedAt = Date.now();
  const stream = await fetch(grant.url, { headers: { Origin: origin }, signal: stopStream.signal }); assert.equal(stream.status, 200);
  const reader = stream.body.getReader(), decoder = new TextDecoder();
  const reading = (async () => {
    let buffer = '';
    for (;;) {
      const { value, done } = await reader.read(); if (done) return;
      buffer += decoder.decode(value, { stream: true });
      let boundary;
      while ((boundary = buffer.indexOf('\n\n')) >= 0) {
        const entry = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
        const data = entry.split('\n').find(line => line.startsWith('data: ')); if (!data) continue;
        const event = JSON.parse(data.slice(6)); cursor.set(event.executionId, event.seq);
        if (Date.parse(event.at) + clockOffset >= connectedAt) samples.push(Date.now() - Date.parse(event.at) - clockOffset);
      }
    }
  })().catch(error => { if (!stopStream.signal.aborted) throw error; });
  try {
    for (let n = 0; n < 10; n++) await sandbox(keys[0], { action: 'write', path: 'event.txt', data: Buffer.from(String(n)).toString('base64') });
    const deadline = Date.now() + 5000;
    while (samples.length < 10 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
    assert.ok(samples.length >= 10, 'Live updates arrived without status polling');
    const p95 = samples.sort((a, b) => a - b)[Math.ceil(samples.length * .95) - 1];
    console.log(`LIVE EVENT p95 ${Math.round(p95)} ms, ${samples.length} samples, clock uncertainty ±${Math.ceil((grantFinished - grantStarted) / 2)} ms`);
    assert.ok(p95 >= -1000 && p95 < 1000, 'Defined light-load live event target');
  } finally { stopStream.abort(); await reading; }
  const reconnectAbort = new AbortController();
  const reconnect = await fetch(grant.url, { headers: { Origin: origin, 'Last-Event-ID': 'expired-cursor' }, signal: reconnectAbort.signal });
  const snapshotText = new TextDecoder().decode((await reconnect.body.getReader().read()).value); reconnectAbort.abort();
  assert.ok(snapshotText.includes('"kind":"sandbox"') && snapshotText.includes('"seq":'), 'Reconnect returns an authoritative snapshot');
  console.log('PASS scoped event feed, reconnect snapshot and live delivery');
  await sandbox(keys[0], { action: 'write', path: 'app.js', data: Buffer.from(`require('http').createServer((req,res)=>{res.setHeader('Content-Type','text/html');res.end('<title>VPS app verification</title><h1>Local app</h1><input aria-label="Name"><button>Save</button>')}).listen(8123,'0.0.0.0')`).toString('base64') });
  await sandbox(keys[0], { action: 'spawn', processId: randomUUID(), command: 'node /workspace/app.js' });
  const preview = await sandbox(keys[0], { action: 'preview', port: 8123 });
  assert.equal(preview.status, 'ready', JSON.stringify(preview)); assert.equal(preview.title, 'VPS app verification');
  const retry = await sandbox(keys[0], { action: 'preview', port: 8123 }); assert.equal(retry.sessionId, preview.sessionId);
  console.log('PASS real sandbox app → dedicated browser, exact port and idempotent preview');
  const publicBrowser = await browser({ action: 'open', url: 'https://example.com' }, 'repo-verification');
  assert.equal(publicBrowser.status, 'ready', JSON.stringify(publicBrowser));
  const views = await api(`/api/threads/${threadId}/browser`); assert.equal(views.browsers.length, 2);
  assert.notEqual(publicBrowser.sessionId, preview.sessionId);
  await api(`/api/threads/${threadId}/browser`, { control: 'human', sessionId: publicBrowser.sessionId });
  assert.equal((await browser({ action: 'inspect' }, 'repo-verification')).status, 'human_control');
  assert.equal((await browser({ action: 'inspect' })).title, 'VPS app verification');
  const captureResponse = sessionId => fetch(origin + '/api/internal/workspace', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.INTERNAL_API_SECRET}` }, body: JSON.stringify({ userId, threadId, input: { action: 'screenshot', sessionId, title: 'Disposable browser assignment fixture' } }) });
  assert.equal((await captureResponse(publicBrowser.sessionId)).status, 409, 'Selected child under human control cannot be captured through parent tools');
  assert.equal((await captureResponse(randomUUID())).status, 404, 'Unknown browser assignment cannot fall back to the default');
  await api(`/api/threads/${threadId}/browser`, { control: 'agent', sessionId: publicBrowser.sessionId });
  assert.equal((await browser({ action: 'inspect', sessionId: publicBrowser.sessionId })).title, 'Example Domain');
  await api(`/api/threads/${threadId}/browser`, { control: 'human', sessionId: preview.sessionId });
  assert.equal((await captureResponse(publicBrowser.sessionId)).status, 200, 'Parent can save the selected child browser while its own preview is under human control');
  await api(`/api/threads/${threadId}/browser`, { control: 'agent', sessionId: preview.sessionId });
  console.log('PASS two agents in one workspace, selected takeover, parent resumes exact child browser');
  const privateAttempt = await browser({ action: 'open', url: 'http://100.122.229.15:8090/health' });
  assert.equal(privateAttempt.status, 'action_failed');
  const wrongPort = new URL(preview.url); wrongPort.port = '8124';
  assert.equal((await browser({ action: 'open', url: wrongPort.href })).status, 'action_failed');
  const probe = randomUUID();
  await sandbox(keys[1], { action: 'spawn', processId: probe, command: `node -e ${JSON.stringify(`fetch(${JSON.stringify(preview.url)},{signal:AbortSignal.timeout(1500)}).then(()=>process.exit(1)).catch(()=>console.log('other sandbox blocked'))`)}` });
  assert.equal((await processResult(keys[1], probe)).exitCode, 0);
  console.log('PASS tailnet, wrong preview port and other sandbox cannot access the app');
  await sandbox(keys[0], { action: 'stop' });
  const remaining = await api(`/api/threads/${threadId}/browser`);
  assert.equal(remaining.browser, null);
  assert.equal((await browser({ action: 'inspect' }, 'repo-verification')).status, 'ready');
  console.log('PASS parent stop revokes preview; independent public browser survives');
} finally {
  if (threadId) {
    await browser({ action: 'close' }, 'repo-verification').catch(() => {});
    for (const key of keys) await sandbox(key, { action: 'delete' }).catch(() => {});
  }
  const { default: postgres } = await import('postgres'); const sql = postgres(process.env.DATABASE_URL, { prepare: false, max: 1 });
  const blobs = await sql`select i.blob_path from pat_workspace_items i join pat_workspaces w on w.id=i.workspace_id where w.user_id=${userId} and i.blob_path is not null`;
  if (blobs.length) { const { del } = await import('@vercel/blob'); await del(blobs.map(b => b.blob_path), { token: process.env.WORKSPACE_BLOB_READ_WRITE_TOKEN }); }
  await sql`delete from pat_user where id=${userId}`; await sql.end(); await admin.auth.admin.deleteUser(userId);
  console.log('Cleaned temporary execution fixtures');
}
