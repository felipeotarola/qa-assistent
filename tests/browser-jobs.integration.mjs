// Opt-in real Eve/VPS test: delegation releases chat while Iris is still busy.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Client } from 'eve/client';
import { createClient } from '@supabase/supabase-js';
import { createServerClient } from '@supabase/ssr';
import postgres from 'postgres';
if (process.env.RUN_IRIS_TESTS !== '1') throw new Error('Enable live Iris verification explicitly');
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
let workspaceId, session, threadId, planId;
async function internal(body) {
  const response = await fetch(origin + '/api/internal/browser-jobs', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.INTERNAL_API_SECRET}` }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() };
}
try {
  workspaceId = (await api('/api/workspaces', { name: `Iris verification ${randomUUID().slice(0, 8)}` })).workspace.id;
  const thread = (await api('/api/threads', { workspaceId, title: 'Disposable Iris handoff test' })).thread;
  threadId = thread.id;
  if (process.env.TEST_SURDEG_RELIABILITY === '1') {
    const cases = [
      {id:randomUUID(),title:'Surdeg navigation',type:'browser',preconditions:'Public site, logged out',steps:'1. Open https://www.surdeg.nu/. 2. Click Se live and inspect the destination.',expected:'The click opens the Birgitta profile.'},
      {id:randomUUID(),title:'Unknown profile',type:'browser',preconditions:'Public site',steps:'1. Open https://www.surdeg.nu/surdeg/qa-missing-profile-20261001. 2. Inspect the missing-profile message.',expected:'A clear not-found message is displayed.'},
      {id:randomUUID(),title:'Login return coverage',type:'browser',preconditions:'Logged out. No test account or credentials available.',steps:'1. Open https://www.surdeg.nu/konto logged out. 2. Log in and verify the return to /konto.',expected:'Login is required and the return path works after login.'},
    ];
    const response=await fetch(origin+'/api/internal/workspace',{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${process.env.INTERNAL_API_SECRET}`},body:JSON.stringify({userId,threadId,input:{action:'create',title:'Disposable reliability regression',content:{kind:'test_plan',summary:'Real public observations; login is intentionally unavailable.',sources:[],cases}}})});
    const saved=await response.json(); assert.ok(response.ok,JSON.stringify(saved)); planId=saved.item.id;
  }
  const client = new Client({ host: origin, headers: { ...headers(), 'x-pat-browser-thread': thread.id, 'x-pat-chat-model': 'glm-5.3-flash', 'x-pat-reasoning': 'low' } });
  const start = Date.now();
  const message=planId ? `Delegera till Iris: kör alla tre fall i testplan ${planId} på https://www.surdeg.nu/. Läs planen, spara separata test_run start/finish med checklistan och skärmbilder. Inga testkonton finns: försök inte logga in eller skapa konto; redovisa den återstående täckningen. Ändra inte planen. Avsluta din egen tur direkt efter delegeringen.` : 'Delegera till Iris via browser_job start: öppna https://example.com i live-webbläsaren, inspektera sidans rubrik och kontrollera länken Learn more genom ett klick. Inspektera därefter sidan och rapportera det du faktiskt såg. Inga sparade testfall behövs. Avsluta din egen tur direkt efter delegeringen.';
  const started = await client.sessions.create({ message });
  session = started.session;
  const first = await started.response.result();
  assert.equal(first.status, 'waiting', first.message);
  assert.equal(calls(first).filter(name => name === 'browser_job').length, 1, JSON.stringify(calls(first)));
  let jobs = (await api(`/api/workspaces/${workspaceId}/browser-jobs`)).jobs;
  assert.equal(jobs.length, 1);
  assert.ok(jobs[0].sessionId, JSON.stringify(jobs));
  const firstStatus = jobs[0].status;
  assert.equal(firstStatus, 'running', 'Iris should still work when the main turn ends');
  const second = await (await session.send('Vad betyder QA? Svara kort utan verktyg.', { turnPolicy: 'queue' })).result();
  assert.equal(second.status, 'waiting'); assert.equal(calls(second).length, 0);
  for(let i=0; i<(planId?200:40) && ['starting','running'].includes(jobs[0].status); i++) {
    await new Promise(resolve=>setTimeout(resolve,3000));
    jobs=(await api(`/api/workspaces/${workspaceId}/browser-jobs`)).jobs;
  }
  assert.equal(jobs[0].status, 'completed', JSON.stringify(jobs));
  assert.ok(jobs[0].report.length > 0);
  if (planId) {
    const runs=await api(`/api/workspaces/${workspaceId}/runs`);
    const results=runs.filter(r=>r.itemId===planId);
    assert.equal(new Set(results.map(r=>r.caseId)).size,3,'All cases must have runs');
    assert.ok(results.every(r=>r.result),'Every case must finish');
    const login=results.find(r=>r.snapshot.title==='Login return coverage');
    assert.ok(['blocked','inconclusive'].includes(login.result.outcome),'Untested login must never pass');
    assert.ok(results.filter(r=>r.result.outcome==='passed').every(r=>r.result.checks?.length>0),'Passes must include original-case verification');
    console.log(JSON.stringify({surdegResults:results.map(r=>({title:r.snapshot.title,outcome:r.result.outcome,checks:r.result.checks,captures:r.captures?.length}))}));
  }
  const workerEvents = [];
  for await (const event of client.sessions.attach(jobs[0].sessionId).stream({ follow: false })) workerEvents.push(event);
  assert.ok(workerEvents.some(event => event.type === 'action.result' && event.data.result?.toolName === 'browser'), 'The activity panel must be able to read Iris tool events');
  let notified = false;
  for (let attempt = 0; attempt < 10 && !notified; attempt++) {
    const events = [];
    for await (const event of client.sessions.attach(session.state.sessionId).stream({ follow: false })) events.push(event);
    notified = JSON.stringify(events).includes('Bakgrundsrapport från Iris');
    if (!notified) await new Promise(resolve => setTimeout(resolve, 1000));
  }
  assert.ok(notified, 'The final report must be queued back to the main chat');
  // A completed receipt is stable: retries and late stop requests cannot restart it.
  const replay = await internal({ userId, threadId, action: 'start', jobId: jobs[0].id, task: jobs[0].task });
  assert.equal(replay.body.sessionId, jobs[0].sessionId);
  assert.equal(replay.body.status, 'completed');
  assert.equal((await api(`/api/workspaces/${workspaceId}/browser-jobs`, { jobId: jobs[0].id })).status, 'completed');
  assert.equal((await internal({ userId: randomUUID(), threadId, action: 'status', jobId: jobs[0].id })).status, 404);
  // Start a second bounded job, check deduplication, then stop it explicitly.
  const input = { userId, threadId, parentSessionId: session.state.sessionId, action: 'start', jobId: randomUUID(), task: 'Open https://example.com and inspect the heading. Report only observations.' };
  const pending = await internal(input);
  assert.ok(pending.body.sessionId, JSON.stringify(pending));
  assert.equal((await internal(input)).body.sessionId, pending.body.sessionId);
  const stopped = await api(`/api/workspaces/${workspaceId}/browser-jobs`, { jobId: input.jobId });
  assert.equal(stopped.status, 'cancelled');
  console.log(JSON.stringify({ passed: true, firstStatus, elapsedMs: Date.now()-start, mainCalls:calls(first), secondCalls:calls(second), report:jobs[0].report }));
} finally {
  if (session) await session.cancel().catch(()=>{});
  if (workspaceId) {
    const jobs=(await api(`/api/workspaces/${workspaceId}/browser-jobs`)).jobs;
    for(const job of jobs.filter(j=>['starting','running','dispatch_unknown'].includes(j.status))) await api(`/api/workspaces/${workspaceId}/browser-jobs`, {jobId:job.id});
    if (threadId) {
      const { browsers } = await api(`/api/threads/${threadId}/browser`);
      for (const browser of browsers || []) if (browser.sessionId) await api(`/api/threads/${threadId}/browser`, { control: 'close', sessionId: browser.sessionId });
    }
    const database = postgres(process.env.POSTGRES_URL || process.env.POSTGRESQL_URL || process.env.DATABASE_URL, { max: 1, prepare: false });
    try {
      const blobs=await database`select blob_path from pat_workspace_items where workspace_id=${workspaceId} and blob_path is not null`;
      const {del}=await import('@vercel/blob');
      for(const row of blobs) await del(row.blob_path,{token:process.env.WORKSPACE_BLOB_READ_WRITE_TOKEN});
      await database.begin(async tx => {
        await tx`delete from pat_test_captures where run_id in (select id from pat_test_runs where workspace_id=${workspaceId} and thread_id=${threadId})`;
        await tx`delete from pat_threads where id = ${threadId} and workspace_id = ${workspaceId} and user_id = ${userId} and title = 'Disposable Iris handoff test'`;
        await tx`delete from pat_workspaces where id = ${workspaceId} and user_id = ${userId} and name like 'Iris verification %'`;
      });
    }
    finally { await database.end(); }
  }
  await auth.auth.signOut({scope:'local'});
}
