// Opt-in real Eve/Codex test: delegation releases chat while Codex is still busy.
import assert from 'node:assert/strict';
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
let workspaceId, session;
try {
  workspaceId = (await api('/api/workspaces', {name: 'Repokarta – verifiering'})).workspace.id;
  const thread = (await api('/api/threads', {workspaceId, title: 'Axels repokarta'})).thread;
  console.log(JSON.stringify({workspaceId,threadId:thread.id}));
  const client = new Client({host:origin,headers:{...headers(),'x-pat-browser-thread':thread.id,'x-pat-chat-model':'glm-5.3-flash','x-pat-reasoning':'high'}});
  const started = await client.sessions.create({message:'Be Axel skapa en repokarta i Material för https://github.com/felipeotarola/surdeg. Använd codex mode repository_map. Avgränsa till 6–10 komponenter: webbapp, autentisering, databas och livesändning. Läs bara kod, installera eller starta inget. Låt jobbet gå i bakgrunden.'});
  session = started.session;
  const first = await started.response.result();
  console.log(JSON.stringify({first:first.status,message:first.message}));
  assert.equal(first.status,'waiting');
  const reply = await (await session.send('Vad är en repokarta? Svara kort utan verktyg.',{turnPolicy:'queue'})).result();
  assert.equal(reply.status,'waiting');
  console.log('PASS chat remains responsive');
  const start = Date.now();
  let item;
  while(Date.now()-start < 600000) {
    const states = await api(`/api/workspaces/${workspaceId}/setup-jobs`);
    console.log(JSON.stringify({elapsed:Math.round((Date.now()-start)/1000),statuses:states.jobs?.map(j=>({status:j.status,message:j.result?.message}))}));
    const items = await api(`/api/workspaces/${workspaceId}/items`);
    item = items.items?.find(i=>i.content?.repository);
    if(item) break;
    await new Promise(resolve=>setTimeout(resolve,15000));
  }
  assert.ok(item,'No saved repository map');
  console.log(JSON.stringify({passed:true,workspaceId,threadId:thread.id,itemId:item.id,commit:item.content.repository.commit,nodes:item.content.nodes.length}));
} finally {
  if (workspaceId && process.env.KEEP_MAP_FIXTURE !== '1') {
    const states=await api(`/api/workspaces/${workspaceId}/sandboxes`);
    for(const s of states.sessions) await api(`/api/workspaces/${workspaceId}/sandboxes`,{id:s.id,action:'delete'});
    const sql=postgres(process.env.DATABASE_URL,{prepare:false,max:1});
    try {await sql`delete from pat_threads where workspace_id=${workspaceId}`;await sql`delete from pat_workspaces where id=${workspaceId}`;} finally {await sql.end();}
  }
  await auth.auth.signOut({scope:'local'});
}

