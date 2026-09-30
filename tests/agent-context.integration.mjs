import { Client } from 'eve/client';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { createServerClient } from '@supabase/ssr';
if (process.env.RUN_AGENT_CONTEXT_TESTS !== '1') throw Error('Enable live agent context tests explicitly');
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
let workspaceId;
try {
assert.equal((await client.auth.signInWithPassword({email,password})).error,null);
workspaceId=(await api('/api/workspaces',{name:'Temporary context verification'})).body.workspace.id;
const thread=(await api('/api/threads',{title:'Direct repository status verification',workspaceId})).body.thread;
const eve=new Client({host:origin,headers:{cookie:[...cookies].map(([k,v])=>`${k}=${v}`).join('; '),'x-pat-browser-thread':thread.id,'x-pat-chat-model':'glm-5.3-flash','x-pat-reasoning':'low'}});
const started=await eve.sessions.create({message:'Visa sparad status för repositories i detta workspace. Starta inget jobb och koppla inget nytt repo. Svara kort.'});
const result=await started.response.result();
assert.notEqual(result.status,'failed');
assert.ok(!result.events.some(e=>e.type==='subagent.called'),'Routine status should not delegate');
const calls=result.events.filter(e=>e.type==='action.input.appended');
console.log('STATUS',JSON.stringify({types:[...new Set(result.events.map(e=>e.type))],tools:[...new Set(calls.map(e=>e.data.toolName))],steps:result.events.filter(e=>e.type==='step.completed').map(e=>e.data.usage)}));
assert.ok(calls.some(e=>JSON.stringify(e).includes('repository')),'Status should read repository data');
const statusResults=result.events.filter(e=>e.type==='action.result' && e.data.result?.toolName==='repository');
assert.ok(statusResults.some(e=>e.data.status==='completed' && Array.isArray(e.data.result.output?.runs)),'Repository status must actually succeed');
assert.equal(result.events.filter(e=>e.type==='step.completed').length,2,'Routine status should take one tool step and one answer');
assert.ok(!calls.some(e=>JSON.stringify(e).includes('load_skill')),'Routine repo status should not load unrelated guides');
console.log('SESSION',result.sessionId);
const authoringThread=(await api('/api/threads',{title:'On-demand authoring verification',workspaceId})).body.thread;
const authoringClient=new Client({host:origin,headers:{cookie:[...cookies].map(([k,v])=>`${k}=${v}`).join('; '),'x-pat-browser-thread':authoringThread.id,'x-pat-chat-model':'glm-5.3-flash','x-pat-reasoning':'low'}});
const edit=await authoringClient.sessions.create({message:'Skapa ett dokument i Material med titeln Kontextprov och texten Testdokument. Använd inga externa tjänster.'});
const edited=await edit.response.result();
assert.notEqual(edited.status,'failed');
const editCalls=edited.events.filter(e=>e.type==='action.input.appended');
console.log('AUTHORING',JSON.stringify({tools:[...new Set(editCalls.map(e=>e.data.toolName))],message:edited.message}));
assert.ok(editCalls.some(e=>JSON.stringify(e).includes('load_skill')),'Authoring must load its workflow');
const items=(await api('/api/workspaces/'+workspaceId+'/items')).body;
const document=items.items.find(item=>item.title==='Kontextprov');
assert.ok(document,'Requested document must be persisted');
assert.ok(JSON.stringify(document.content).includes('Testdokument'),'Requested document text must be preserved');
console.log('PASS direct repository status and on-demand material authoring');
} finally {
const {default:postgres}=await import('postgres');const sql=postgres(process.env.DATABASE_URL,{prepare:false,max:1});
await sql`delete from pat_user where id=${userId}`;await sql.end();await admin.auth.admin.deleteUser(userId);
console.log('Cleaned temporary context-test account');
}
