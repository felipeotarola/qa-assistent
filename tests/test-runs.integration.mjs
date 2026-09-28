import { Client } from "eve/client";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";

import postgres from "postgres";




if (process.env.RUN_WORKSPACE_TESTS !== "1") throw new Error("Set RUN_WORKSPACE_TESTS=1 to create temporary integration fixtures.");
const origin = "http://localhost:3000";
const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const email = `workspace-test-${randomUUID()}@example.com`;
const password = randomUUID();
console.log('Creating temporary test user');
const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
if (error) throw new Error("Test user creation failed");
const userId = data.user.id;
console.log('Temporary user created', userId);
const cookies = new Map();
const client = createServerClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, {
  cookieOptions: { name: "pat_supabase_auth", path: "/", sameSite: "lax" },
  cookies: { getAll: () => [...cookies].map(([name, value]) => ({ name, value })), setAll: values => values.forEach(c => cookies.set(c.name, c.value)) },
});
const cookie = () => [...cookies].map(([k, v]) => `${k}=${v}`).join("; ");
async function api(path, method = "GET", body, internal = false) {
  const r = await fetch(origin + path, { method, headers: { cookie: cookie(), "content-type": "application/json", ...(internal ? { authorization: `Bearer ${process.env.INTERNAL_API_SECRET}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, data: await r.json() };
}
const sql = postgres(process.env.DATABASE_URL, { prepare: false, max: 1 });
try {
  assert.equal((await client.auth.signInWithPassword({ email, password })).error, null);
  const a = (await api('/api/workspaces', 'POST', {name:'Temporary run verification'})).data.workspace.id;
  const b = (await api('/api/workspaces', 'POST', {name:'Isolation verification'})).data.workspace.id;
  const t = (await api('/api/threads','POST',{title:'Runs',workspaceId:a})).data.thread.id;
  const other = (await api('/api/threads','POST',{title:'Other',workspaceId:b})).data.thread.id;
  const caseId = randomUUID();
  const plan = {kind:'test_plan',summary:'Definition stays intact',cases:[{id:caseId,title:'Fixture',type:'manual',steps:'Observe',expected:'Expected',preconditions:''}],sources:[]};
  const created = await api('/api/internal/workspace','POST',{userId,threadId:t,input:{action:'create',title:'Run fixture',content:plan}},true);
  assert.equal(created.status,200);
  const item = created.data.item;
  const call = (input,threadId=t) => api('/api/internal/test-run','POST',{userId,threadId,...input},true);
  const input = {action:'start',itemId:item.id,caseId,expectedVersion:1,requestId:randomUUID(),environment:'Fixture / no live website'};
  assert.equal((await call({...input,expectedVersion:99})).status,409);
  assert.equal((await call(input,other)).status,404);
  const started = await call(input);
  assert.equal(started.status,200,JSON.stringify(started.data));
  const id=started.data.id;
  assert.equal((await call(input)).data.id,id);
  assert.equal((await call({...input,environment:'Different'})).status,409);
  assert.equal((await api(`/api/workspaces/${a}/runs`)).data.length,1);
  assert.equal((await fetch(`${origin}/api/workspaces/${a}/runs`)).status,401);
  const result = {outcome:'inconclusive',actual:'UI showed generic error',unverified:'Session not inspected',observations:[{title:'Clarify message requirement',detail:'Observed generic message; requirement unclear'}],evidenceItemIds:[]};
  assert.equal((await call({action:'finish',runId:id,result},other)).status,404);
  assert.notEqual((await call({action:'finish',runId:id,result:{...result,outcome:'passed'}})).status,200);
  assert.equal((await call({action:'finish',runId:id,result})).status,200);
  assert.equal((await call({action:'finish',runId:id,result})).status,200);
  assert.equal((await call({action:'finish',runId:id,result:{...result,actual:'Overwritten'}})).status,409);
  const read = await api('/api/internal/workspace','POST',{userId,threadId:t,input:{action:'read',itemId:item.id}},true);
  assert.equal(read.data.item.version,1);
  assert.deepEqual(read.data.item.content,plan);
  const second=await call({...input,requestId:randomUUID()});
  assert.equal(second.status,200);
  assert.notEqual(second.data.id,id);
  const listed=(await call({action:'list',itemId:item.id})).data;
  assert.equal(listed.length,2);
  assert.equal(listed.find(r=>r.id===id).snapshot.expected,'Expected');
  if (process.env.TEST_RUN_AGENT === '1') {
    const eve = new Client({ host: origin, headers: {cookie:cookie(),'x-pat-browser-thread':t,'x-pat-chat-model':'glm-5.3-flash','x-pat-reasoning':'low'} });
    console.log('Starting agent verification');
    const turn = await eve.sessions.create({message:`Verify the test_run tool using test plan ${item.id}, case ${caseId}. This is a synthetic fixture, not a real product result. Read the plan. Use test_run start with expectedVersion from the plan you just read, environment Fixture and a fresh UUID requestId. Then use test_run finish with outcome blocked because no real test environment exists, actual explaining this, unverified explaining that nothing was executed, empty observations and evidenceItemIds arrays. Do not edit the plan or call browser/external tools. Do not delegate. Confirm the saved run ID. Stop after one validation error and report the exact error.`});
    console.log('Agent session created');
    const agentResult = await turn.response.result();
    assert.notEqual(agentResult.status,'failed');
    const results=(await call({action:'list',itemId:item.id})).data;
    if (!results.some(r=>r.result?.outcome==='blocked')) console.log(JSON.stringify(agentResult.events.filter(e=>e.type==='action.result'||e.type==='action.failed'||e.type==='message.completed'),null,2).slice(-12000));
    assert.ok(results.some(r=>r.result?.outcome==='blocked'),'Agent must save a structured blocked result');
    console.log('PASS real agent starts and finalizes structured run');
  }
  console.log('PASS: authenticated access, workspace isolation, version check, retry idempotency, immutable results, retained plan, independent reruns');
} finally {
  await sql`delete from pat_user where id = ${userId}`;
  await sql.end(); await admin.auth.admin.deleteUser(userId);
  console.log('Temporary run fixtures removed');
}
