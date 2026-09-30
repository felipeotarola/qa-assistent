import { Client } from 'eve/client';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { createServerClient } from '@supabase/ssr';
if (process.env.RUN_REPOSITORY_TESTS !== '1') throw Error('Enable repository integration tests explicitly');
const origin = process.env.APP_URL || 'http://localhost:3000';
const admin=createClient(process.env.NEXT_PUBLIC_SUPABASE_URL,process.env.SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false}});
const email=`repo-test-${randomUUID()}@example.com`,password=randomUUID();
const {data,error}=await admin.auth.admin.createUser({email,password,email_confirm:true});
if(error) throw Error('Could not create test account');
const userId=data.user.id,cookies=new Map();
const client=createServerClient(process.env.NEXT_PUBLIC_SUPABASE_URL,process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,{cookieOptions:{name:'pat_supabase_auth',path:'/',sameSite:'lax'},cookies:{getAll:()=>[...cookies].map(([name,value])=>({name,value})),setAll:values=>values.forEach(c=>cookies.set(c.name,c.value))}});
async function api(path,body,anonymous=false) {
const response=await fetch(origin+path,{method:body?'POST':'GET',headers:{'content-type':'application/json',...(!anonymous?{cookie:[...cookies].map(([k,v])=>`${k}=${v}`).join('; ')}:{})},body:body?JSON.stringify(body):undefined});
return {status:response.status,body:await response.json()};
}
let workspaceId; const runIds=[];
try {
assert.equal((await client.auth.signInWithPassword({email,password})).error,null);
workspaceId=(await api('/api/workspaces',{name:'Temporary delegation verification'})).body.workspace.id;
const thread=(await api('/api/threads',{title:'Repository delegation smoke test',workspaceId})).body.thread;
const eve=new Client({host:origin,headers:{cookie:[...cookies].map(([k,v])=>`${k}=${v}`).join('; '),'x-pat-browser-thread':thread.id,'x-pat-chat-model':'glm-5.3-flash','x-pat-reasoning':'low'}});
const started=await eve.sessions.create({message:'Använd repo-specialisten för att koppla https://github.com/felipeotarola/surdeg, branch main, och starta scriptet typecheck på VPS. Gör arbetet via specialisten repo, inte root-agentens repository-verktyg. Kommandot är känt, ingen separat analys behövs. Svara med sparat körnings-ID. Inga ändringar i repot och ingen publicering.'});
const result=await started.response.result();
console.log('TURN',result.status);
console.log(JSON.stringify(result.events.filter(e=>['subagent.called','subagent.completed','turn.failed','step.failed','tool.called','tool.completed'].includes(e.type)),null,2));
assert.notEqual(result.status,'failed');
assert.ok(result.events.some(e=>e.type==='subagent.called'),'Root must delegate');
assert.ok(result.events.some(e=>e.type==='subagent.completed'),'Child must return');
const path=`/api/workspaces/${workspaceId}/repositories`;
let job; const deadline=Date.now()+660000;
while(Date.now()<deadline){
const state=await api(path);
job=state.body.runs.find(r=>r.job?.mode==='test')?.job;
if(!job) throw Error('Agent did not save a repository test run');
if(!runIds.includes(job.id)){runIds.push(job.id);console.log('DELEGATED RUN',job.id);}
if(job.finishedAt) break;
await new Promise(r=>setTimeout(r,3000));
}
assert.equal(job.status,'passed',job.message);
assert.equal(job.script,'typecheck'); assert.match(job.commit,/^[a-f0-9]{40}$/);
console.log('VPS RESULT',JSON.stringify({status:job.status,commit:job.commit,exitCode:job.testExitCode}));
const followup=await started.session.send('Be samma repo-specialist kontrollera den sparade körningen nu och rapportera resultat, körnings-ID, commit och vad som faktiskt verifierades. Starta ingen ny körning.');
const final=await followup.result();
assert.notEqual(final.status,'failed');
assert.ok(final.events.some(e=>e.type==='subagent.called'),'Follow-up must delegate');
const history=(await api(`/api/threads/${thread.id}`)).body.thread.history;
console.log('ASSISTANT',JSON.stringify(history.filter(r=>r.message.role==='assistant').map(r=>r.message.parts.filter(p=>p.type==='text').map(p=>p.text).join(' '))));
assert.equal((await api(path)).body.runs.filter(r=>r.job?.mode==='test').length,1,'Follow-up must not start a duplicate run');
console.log('PASS live parent delegation, inherited identity, VPS execution, specialist follow-up and persisted result');
} finally {
if(workspaceId){ const state=await api(`/api/workspaces/${workspaceId}/repositories`).catch(()=>null); for(const run of state?.body?.runs||[]) await api(`/api/workspaces/${workspaceId}/repositories`,{action:'cancel',runId:run.id}).catch(()=>{}); }
const {default:postgres}=await import('postgres');const sql=postgres(process.env.DATABASE_URL,{prepare:false,max:1});
await sql`delete from pat_user where id=${userId}`;await sql.end();await admin.auth.admin.deleteUser(userId);
console.log('Cleaned temporary delegation account');
}
