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
  const started = Date.now();
  const r = await fetch(origin + path, { signal: AbortSignal.timeout(30000), method, headers: { cookie: cookie(), "content-type": "application/json", ...(internal ? { authorization: `Bearer ${process.env.INTERNAL_API_SECRET}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) }).catch(error => { throw new Error(`${method} ${path} ${body?.action ?? body?.input?.action ?? ''} failed after ${Date.now()-started}ms`, {cause:error}); });
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
  assert.deepEqual(item.content, { ...plan, cases: plan.cases.map(testCase => ({ ...testCase, checksVersion: 2 })) });
  const call = (input,threadId=t) => api('/api/internal/test-run','POST',{userId,threadId,...input},true);
  const input = {action:'start',itemId:item.id,caseId,expectedVersion:1,requestId:randomUUID(),environment:'Fixture / no live website'};
  assert.equal((await call({...input,expectedVersion:99})).status,409);
  assert.equal((await call(input,other)).status,404);
  const started = await call(input);
  assert.equal(started.status,200,JSON.stringify(started.data));
  assert.deepEqual(started.data.snapshot, item.content.cases[0]);
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
  assert.deepEqual(read.data.item.content,item.content);
  const second=await call({...input,requestId:randomUUID()});
  assert.equal(second.status,200);
  assert.deepEqual(second.data.checks.map(c=>c.id),['step-1','expected']);
  const pass={outcome:'passed',actual:'Observed fixture',unverified:'',observations:[],evidenceItemIds:[]};
  assert.equal((await call({action:'finish',runId:second.data.id,result:pass})).status,400,'No full-case checklist means no pass');
  assert.equal((await call({action:'finish',runId:second.data.id,result:{...pass,checks:[{id:'step-1',status:'verified',actual:'Observed'}]}})).status,400,'Missing expected outcome cannot pass');
  assert.notEqual(second.data.id,id);
  const listed=(await call({action:'list',itemId:item.id})).data;
  assert.equal(listed.length,2);
  assert.equal(listed.find(r=>r.id===id).snapshot.expected,'Expected');
  const complete=await call({...input,requestId:randomUUID()});
  const completeResult={...pass,checks:complete.data.checks.map(c=>({id:c.id,status:'verified',actual:'Observed fixture requirement'}))};
  assert.equal((await call({action:'finish',runId:complete.data.id,result:completeResult})).status,200);
  assert.equal((await call({action:'finish',runId:complete.data.id,result:completeResult})).status,200,'Idempotent complete result');
  console.log('PASS full-case verification gate, complete result, immutable history and retry');
  if (process.env.RUN_RELIABILITY_ONLY !== '1') {
  const requirement = {action:'propose',itemId:item.id,caseId,expectedVersion:1,requestId:randomUUID(),question:'Is a generic authentication message acceptable?',clarification:'',expected:'Expected'};
  const reqPath = `/api/workspaces/${a}/requirements`;
  assert.equal((await api(`/api/workspaces/${b}/requirements`,'POST',requirement)).status,404);
  assert.equal((await api(reqPath,'POST',{...requirement,expectedVersion:99})).status,409);
  const proposal = await api(reqPath,'POST',requirement);
  assert.equal(proposal.status,200,JSON.stringify(proposal.data));
  assert.equal((await api(reqPath,'POST',requirement)).data.id,proposal.data.id);
  assert.equal((await api(reqPath,'POST',{...requirement,issueId:'COM-999'})).status,409);
  assert.equal((await api(reqPath,'POST',{action:'publish',id:proposal.data.id,expectedVersion:1})).status,400,'Incomplete proposal cannot publish');
  const concurrent = await Promise.all(Array.from({length:3}, () => api(reqPath,'POST',{action:'publish',id:proposal.data.id,expectedVersion:1})));
  assert.ok(concurrent.every(r=>[400,409].includes(r.status)),'Concurrent validation must return invalid/busy instead of deadlocking');
  assert.equal((await api('/api/internal/test-requirement','POST',{userId,threadId:t,action:'publish',id:proposal.data.id,expectedVersion:1},true)).status,400,'Agent tool cannot publish');
  const reqs = await api(reqPath,'POST',{action:'list',itemId:item.id,caseId});
  assert.equal(reqs.data.length,1);
  assert.equal(reqs.data[0].appliedVersion,null);
  const review = {runId:id,requestId:randomUUID(),outcome:'passed',reason:'UI behavior accepted for this run; backend sessions remain outside reviewed scope.'};
  const reviewPath = `/api/workspaces/${a}/run-review`;
  assert.equal((await api(`/api/workspaces/${b}/run-review`,'POST',review)).status,404);
  assert.equal((await api(reviewPath,'POST',{...review,runId:second.data.id})).status,409,'Cannot approve unfinished run');
  const reviewed = await api(reviewPath,'POST',review);
  assert.equal(reviewed.status,200,JSON.stringify(reviewed.data));
  assert.equal((await api(reviewPath,'POST',review)).data.id,reviewed.data.id);
  assert.equal((await api(reviewPath,'POST',{...review,reason:'Changed reason on same request'})).status,409);
  const audited=(await call({action:'list',itemId:item.id})).data.find(r=>r.id===id);
  assert.equal(audited.result.outcome,'inconclusive','Original result is immutable');
  assert.equal(audited.reviews[0].outcome,'passed');
  assert.equal(audited.reviews[0].userId,userId);
  assert.equal(audited.reviews.length,1);
  assert.equal((await api('/api/internal/workspace','POST',{userId,threadId:t,input:{action:'read',itemId:item.id}},true)).data.item.version,1,'Proposals and reviews do not edit requirements');
  console.log('PASS: requirement drafts, ownership, stale versions, agent publish denied, explicit review with immutable original and idempotent audit');
  if (process.env.TEST_CAPTURES === '1') {
    const browserCase=randomUUID();
    const browserPlan=(await api('/api/internal/workspace','POST',{userId,threadId:t,input:{action:'create',title:'Screenshot fixture',content:{kind:'test_plan',summary:'Temporary screenshot test',sources:[],cases:[{id:browserCase,title:'Example Domain page',type:'browser',preconditions:'',steps:'Open example.com',expected:'Example Domain visible'}]}}},true)).data.item;
    const browserRun=await call({action:'start',itemId:browserPlan.id,caseId:browserCase,requestId:randomUUID(),expectedVersion:1,environment:'https://example.com'});
    const browserAction=input=>api('/api/internal/browser','POST',{userId,threadId:t,input},true);
    const opened=await browserAction({action:'open',url:'https://example.com',runId:browserRun.data.id});
    assert.equal(opened.data.status,'ready',JSON.stringify(opened.data));
    assert.ok(opened.data.capture?.itemId,JSON.stringify(opened.data));
    const inspected=await browserAction({action:'inspect',runId:browserRun.data.id});
    assert.ok(inspected.data.capture?.itemId,JSON.stringify(inspected.data));
    const recorded=(await call({action:'list',itemId:browserPlan.id})).data[0];
    assert.equal(recorded.captures.length,2);
    assert.ok(recorded.captures.every(c=>c.itemId && c.url.startsWith('https://example.com')));
    const imagePath=`/api/workspaces/${a}/items/${recorded.captures[0].itemId}`;
    assert.equal((await api(imagePath,'DELETE')).status,409,'Run evidence is retained');
    const file=await fetch(origin+imagePath+'/file',{headers:{cookie:cookie()}});
    assert.equal(file.status,200); assert.match(file.headers.get('content-type'),/image\/png/);
    assert.equal((await fetch(origin+imagePath+'/file')).status,401);
    const finished=await call({action:'finish',runId:browserRun.data.id,result:{outcome:'passed',actual:'Example Domain visible in isolated screenshot fixture.',unverified:'',observations:[],evidenceItemIds:[],checks:browserRun.data.checks.map(c=>({id:c.id,status:'verified',actual:'Example Domain is visible at https://example.com/ in browser screenshot.'}))}});
    assert.equal(finished.status,200,JSON.stringify(finished.data));
    const after=await browserAction({action:'inspect'});
    assert.equal(after.data.capture,undefined,'No capture after run completes');
    await api(`/api/threads/${t}/browser`,'POST',{control:'close'});
    console.log('PASS real browser full-page capture, private Blob image, run association, gallery data, retention and completed-run isolation');
  }
  if (process.env.TEST_REQUIREMENT_AGENT === '1') {
    const eve = new Client({ host: origin, headers: {cookie:cookie(),'x-pat-browser-thread':t,'x-pat-chat-model':'glm-5.3-flash','x-pat-reasoning':'low'} });
    const turn = await eve.sessions.create({message:`Synthetic fixture verification only. Read test plan ${item.id}, case ${caseId}. Use test_requirement list, then test_requirement propose to persist the unanswered question 'Must the error message identify the exact credential?' Leave clarification empty, preserve current expected text, use the current version and a fresh requestId UUID. No Linear issue is linked: omit issueId and sourceItemId. Do not call external, browser or test_run, and do not edit the plan. Do not delegate. Confirm the saved proposal ID. Stop and report any validation error.`});
    const agentResult=await turn.response.result();
    const drafts=(await api(reqPath,'POST',{action:'list',itemId:item.id,caseId})).data;
    if (drafts.length!==2) console.log(JSON.stringify(agentResult.events.filter(e=>e.type==='action.result'||e.type==='action.failed'||e.type==='message.completed')).slice(-8000));
    assert.equal(drafts.length,2,'Agent must persist missing context as an explicit proposal');
    assert.equal(drafts[0].appliedVersion,null);
    console.log('PASS real agent saves unanswered requirement proposal');
  }
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
  }
} finally {
  if (process.env.TEST_CAPTURES === '1') {
    const browsers=await sql`select workspace_id, context_id from pat_workspace_browsers where user_id = ${userId}`;
    const {default:Browserbase}=await import('@browserbasehq/sdk');
    const bb=new Browserbase({apiKey:process.env.BROWSERBASE_API_KEY});
    for (const browser of browsers) {
      const [thread]=await sql`select id from pat_threads where workspace_id = ${browser.workspace_id} limit 1`;
      if (thread) await api(`/api/threads/${thread.id}/browser`,'POST',{control:'close'}).catch(()=>{});
      if (browser.context_id) await bb.contexts.delete(browser.context_id);
    }
    const blobs=await sql`select i.blob_path from pat_workspace_items i join pat_workspaces w on w.id=i.workspace_id where w.user_id=${userId} and i.blob_path is not null`;
    const {del}=await import('@vercel/blob');
    for (const blob of blobs) await del(blob.blob_path,{token:process.env.WORKSPACE_BLOB_READ_WRITE_TOKEN});
    await sql`delete from pat_test_captures where run_id in (select r.id from pat_test_runs r join pat_workspaces w on w.id=r.workspace_id where w.user_id=${userId})`;
  }
  await sql`delete from pat_user where id = ${userId}`;
  await sql.end(); await admin.auth.admin.deleteUser(userId);
  console.log('Temporary run fixtures removed');
}
