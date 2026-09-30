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
workspaceId=(await api('/api/workspaces',{name:'Temporary repository verification'})).body.workspace.id;
const path=`/api/workspaces/${workspaceId}/repositories`;
assert.equal((await api(path,undefined,true)).status,401);
assert.equal((await api(`/api/workspaces/${randomUUID()}/repositories`)).status,404);
const connected=await api(path,{action:'connect',url:process.env.REPO_TEST_URL || 'https://github.com/felipeotarola/surdeg',ref:process.env.REPO_TEST_REF || '',script:process.env.REPO_TEST_SCRIPT || 'typecheck'});
assert.equal(connected.status,200,JSON.stringify(connected.body));
assert.equal((await api(path)).body.available,true,'Runner must be configured');
const start={action:'start',repositoryId:connected.body.id,requestId:randomUUID(),mode:'test',...(process.env.REPO_TEST_ARGS ? {args:JSON.parse(process.env.REPO_TEST_ARGS)} : {})};
const begun=await api(path,start); assert.equal(begun.status,200,JSON.stringify(begun.body)); runIds.push(begun.body.id);
assert.equal((await api(path,start)).body.id,begun.body.id);
console.log('PASS authenticated workspace access, repository link and idempotent start');
const cancelled=await api(path,{...start,requestId:randomUUID(),mode:'inspect'}); runIds.push(cancelled.body.id);
assert.equal((await api(path,{action:'cancel',runId:cancelled.body.id})).status,200);
let latest=''; const deadline=Date.now()+660000; let job;
while(Date.now()<deadline) {
const state=await api(path); job=state.body.runs.find(r=>r.id===begun.body.id)?.job;
if(job?.status!==latest) {latest=job?.status;console.log('RUN',latest,job?.message);}
if(job?.finishedAt) break;
await new Promise(r=>setTimeout(r,3000));
}
assert.ok(job?.finishedAt,'Run must terminate');
console.log('Terminal status:', job.status, job.message, job.logs.slice(-1200));
assert.match(job.commit,/^[a-f0-9]{40}$/);
console.log(JSON.stringify({status:job.status,commit:job.commit,exitCode:job.testExitCode,logs:job.logs.slice(-4000)}));
assert.ok(['passed','failed'].includes(job.status),'Expected a completed command, not infrastructure blockage');
console.log('PASS persisted terminal result and exact commit; actual repo outcome above');
const reportPath=`/api/workspaces/${workspaceId}/repository-material`;
assert.equal((await api(reportPath,{runId:job.id},true)).status,401);
const report=await api(reportPath,{runId:job.id});
assert.equal(report.status,200,JSON.stringify(report.body));
assert.equal((await api(reportPath,{runId:job.id})).body.item.id,report.body.item.id);
assert.ok(report.body.item.content.text.includes(job.commit));
if (job.selectedScript) assert.ok(report.body.item.content.text.includes(`Script: ${job.selectedScript}`));
assert.equal((await api(`/api/workspaces/${randomUUID()}/repository-material`,{runId:job.id})).status,404);
console.log('PASS saved material report, retry deduplication and workspace authorization');
} finally {
if(workspaceId) for(const id of runIds) await api(`/api/workspaces/${workspaceId}/repositories`,{action:'cancel',runId:id}).catch(()=>{});
const {default:postgres}=await import('postgres');const sql=postgres(process.env.DATABASE_URL,{prepare:false,max:1});
await sql`delete from pat_user where id=${userId}`;await sql.end();await admin.auth.admin.deleteUser(userId);
console.log('Cleaned temporary integration account');
}
