import { Client } from 'eve/client';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { createServerClient } from '@supabase/ssr';
if (process.env.RUN_AGENT_SIMPLE_TESTS !== '1') throw Error('Enable live agent context tests explicitly');
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
const measurements=[];
for(const prompt of ['Hej!', 'Vad är skillnaden mellan ett testfall och en testkörning? Svara kort.', 'Skriv om den här meningen så den blir tydligare: Testet gick inte för att sidan inte startade.']) {
const thread=(await api('/api/threads',{title:'Simple question timing',workspaceId})).body.thread;
const eve=new Client({host:origin,headers:{cookie:[...cookies].map(([k,v])=>k+'='+v).join('; '),'x-pat-browser-thread':thread.id,'x-pat-chat-model':'glm-5.3-flash','x-pat-reasoning':'low'}});
const start=Date.now();
const response=await eve.sessions.create({message:prompt});
const result=await response.response.result();
const first=result.events.find(e=>e.type==='message.appended' && e.data.messageDelta?.trim());
const steps=result.events.filter(e=>e.type==='step.completed');
const tools=[...new Set(result.events.filter(e=>e.type==='action.input.appended').map(e=>e.data.toolName))];
const row={prompt,firstTextMs:first?Date.parse(first.meta.at)-start:null,totalMs:Date.now()-start,steps:steps.length,tools,inputTokens:steps[0]?.data.usage?.inputTokens,status:result.status,message:result.message};
measurements.push(row);console.log(JSON.stringify(row));
}
const {writeFile}=await import('node:fs/promises');
await writeFile('.eve/simple-question-timing.json',JSON.stringify(measurements,null,2));
assert.ok(measurements.every(row=>row.firstTextMs!==null && row.steps===1 && row.tools.length===0),'Simple questions should answer in one model step without tools');
} finally {
const {default:postgres}=await import('postgres');const sql=postgres(process.env.DATABASE_URL,{prepare:false,max:1});
await sql`delete from pat_user where id=${userId}`;await sql.end();await admin.auth.admin.deleteUser(userId);
console.log('Cleaned temporary context-test account');
}
