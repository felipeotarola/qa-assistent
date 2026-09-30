import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { createServerClient } from '@supabase/ssr';
if (process.env.RUN_RESEARCH_TESTS !== '1') throw Error('Enable live research tests explicitly');
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
assert.equal(process.env.BROWSER_PROVIDER,'vps','Run against a local app configured for VPS');
async function research(input,caller=userId){ const response=await fetch(origin+'/api/internal/research',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+process.env.INTERNAL_API_SECRET},body:JSON.stringify({userId:caller,threadId:thread.id,input})});return {status:response.status,body:await response.json()}; }
assert.equal((await research({url:'https://grunden.ai/docs/api',screenshot:false},randomUUID())).status,404);
assert.equal((await research({url:'http://127.0.0.1',screenshot:false})).status,400);
const started=Date.now();
const result=await research({url:'https://grunden.ai/docs/api',screenshot:true});
assert.equal(result.status,200,JSON.stringify(result.body));
assert.equal(result.body.status,'ready');
assert.ok(result.body.text.length>100,'Rendered API documentation must be returned');
assert.ok(result.body.screenshot?.id,'Screenshot must be saved');
assert.equal((await api('/api/threads/'+thread.id+'/browser')).body.browser,null,'Background research must not become a workspace live browser');
console.log('PASS',JSON.stringify({url:result.body.url,title:result.body.title,httpStatus:result.body.httpStatus,textChars:result.body.text.length,screenshotSaved:true,elapsedMs:Date.now()-started}));
} finally {
const {default:postgres}=await import('postgres');const sql=postgres(process.env.DATABASE_URL,{prepare:false,max:1});
await sql`delete from pat_user where id=${userId}`;await sql.end();await admin.auth.admin.deleteUser(userId);
console.log('Cleaned temporary context-test account');
}
