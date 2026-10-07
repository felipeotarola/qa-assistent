import { stampUserRequest, userTextHash } from '../shared/mission-request-context.ts';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { registerHooks } from 'node:module';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createApp, createRouter, defineEventHandler, toNodeListener } from 'h3';
import { eq } from 'drizzle-orm';
import { isolatedApp } from './helpers/isolated-app.mjs';

// Real isolated PostgreSQL + H3 route + authored tool execute. Only Eve
// registration/handoff and the background kick are inert; no model/executor.
process.env.PAT_RUNTIME_SCOPE += `-report-selection-${randomUUID()}`;
process.env.AUTONOMOUS_MISSIONS_ENABLED='true'; process.env.MISSIONS_ENABLED='true';
const app=await isolatedApp(),{db,schema}=app, runtime=process.env.PAT_RUNTIME_SCOPE;
const kicks=[],handoffs=[];
globalThis.reportSelectionTest={kicks,handoffs};
const hooks=registerHooks({resolve(specifier,context,next){
  if(specifier==='eve/tools') return {url:'data:text/javascript,export const defineTool = x => x;',shortCircuit:true};
  if(specifier==='eve/context') return {url:'data:text/javascript,export const defineState = () => ({update: x => globalThis.reportSelectionTest.handoffs.push(x())});',shortCircuit:true};
  if(specifier==='../../utils/mission-controller' && context.parentURL?.endsWith('/server/api/internal/autonomy.post.ts')) return {url:'data:text/javascript,export async function runMissionController(id) { globalThis.reportSelectionTest.kicks.push(id); }',shortCircuit:true};
  return next(specifier,context);
}});
const {acceptMission,controlMission}=await import('../server/utils/mission-control.ts');
const {saveItem}=await import('../server/utils/workspaces.ts');
const {testRunAction}=await import('../server/utils/test-runs.ts');
const {workspaceContext}=await import('../server/utils/workspace-context.ts');
const {readMissionSource}=await import('../server/utils/mission-sources.ts');
const {readMissionEvidence}=await import('../server/utils/mission-evidence.ts');
const {independentMissionEvidence}=await import('../shared/mission-report.ts');
const {missionAdmissionSchema}=await import('../shared/mission-control.ts');
const router=createRouter(); router.post('/api/internal/autonomy',(await import('../server/api/internal/autonomy.post.ts')).default);
const deferred=[];
const server=createServer(toNodeListener(createApp().use(defineEventHandler(event=>{ event.waitUntil=promise=>deferred.push(promise); })).use(router))); server.listen(0,'127.0.0.1'); await once(server,'listening');
const origin=`http://127.0.0.1:${server.address().port}`,originalFetch=globalThis.fetch;
process.env.APP_URL=origin;
globalThis.fetch=(url,options)=>{assert.ok(String(url).startsWith(origin+'/'),'No external HTTP is permitted');return originalFetch(url,options);};
const tool=(await import('../agent/tools/qa_mission.ts')).default;
const owner=randomUUID(),other=randomUUID(),workspace=randomUUID(),foreignWorkspace=randomUUID(),thread=randomUUID(),foreignThread=randomUUID();
const checks=[]; let plan,foreignPlan,runs;
const request=(sourceRefs,extra={})=>({requestId:randomUUID(),intent:'report_only',goal:'Summarize the three selected saved results; run nothing new.',sourceRefs,...extra});
const accept=(refs,extra)=>acceptMission(owner,workspace,thread,request(refs,extra));
const row=async(table,id)=>(await db.select().from(table).where(eq(table.id,id)))[0];
const task=async id=>(await db.select().from(schema.missionTasks).where(eq(schema.missionTasks.missionId,id)))[0];
const originalGoal='Summarize the three original selected results.',rootSession=randomUUID(),nonce=randomUUID();
const ctx={session:{id:rootSession,auth:{current:{authenticator:'app',principalId:owner,attributes:{browserThreadId:thread,browserUserInput:JSON.stringify({version:1,nonce,textSha256:userTextHash(originalGoal)})}}},turn:{id:'turn_0'}},callId:'same-original-call',abortSignal:new AbortController().signal};
async function check(name,fn){await fn();checks.push(name);}
async function state(){
  const missions=await db.select().from(schema.missions).where(eq(schema.missions.workspaceId,workspace));
  const ids=missions.map(m=>m.id);
  return {missions, tasks:(await db.select().from(schema.missionTasks)).filter(t=>ids.includes(t.missionId)),
    events:(await db.select().from(schema.missionEvents)).filter(t=>ids.includes(t.missionId)),
    runs:await db.select().from(schema.testRuns).where(eq(schema.testRuns.workspaceId,workspace)),
    reviews:await db.select().from(schema.resultAssessments).where(eq(schema.resultAssessments.workspaceId,workspace))};
}
const cases=Array.from({length:3},(_,i)=>({id:randomUUID(),title:`Saved case ${i}`,type:'browser',preconditions:'Synthetic fixture',steps:'Read original heading',expected:'Original heading shown'}));
const seed=(extra={})=>({id:randomUUID(),workspaceId:workspace,threadId:thread,itemId:plan.id,caseId:cases[0].id,planVersion:1,snapshot:cases[0],environment:'synthetic',runtime,requestId:randomUUID(),startedAt:new Date(Date.now()-1000),finishedAt:new Date(),target:{url:'https://example.com/',environment:'synthetic',revision:'A'},
  result:{schemaVersion:2,outcome:'inconclusive',actual:'Synthetic saved run, no provider.',checks:[],remaining:[],observations:[],evidenceItemIds:[]},...extra});
try {
  await db.insert(schema.user).values([owner,other].map(id=>({id,name:'Selection fixture',email:`${id}@example.test`})));
  await db.insert(schema.workspaces).values([{id:workspace,userId:owner,name:'Own selection'},{id:foreignWorkspace,userId:other,name:'Private other selection'}]);
  await db.insert(schema.threads).values([{id:thread,userId:owner,workspaceId:workspace,title:'Original turn'},{id:foreignThread,userId:other,workspaceId:foreignWorkspace,title:'Other'}]);
  plan=await saveItem(owner,workspace,{title:'Chosen plans are definitions',content:{kind:'test_plan',summary:'Original plan claim',cases,sources:[]}});
  foreignPlan=await saveItem(other,foreignWorkspace,{title:'Private plan',content:{kind:'test_plan',cases,sources:[]}});
  runs=cases.map(c=>seed({caseId:c.id,snapshot:c})); await db.insert(schema.testRuns).values(runs);

  const {saveChatEvents}=await import('../server/utils/chat-history.ts');
  const requestEvent={type:'message.received',meta:{id:randomUUID(),at:new Date().toISOString()},data:{message:originalGoal,parts:[{type:'text',text:originalGoal}],sequence:0,turnId:'turn_0'}};
  requestEvent.data.userRequest=stampUserRequest(requestEvent,{userId:owner,threadId:thread,sessionId:rootSession,runtime,turnId:'turn_0'},ctx.session.auth.current.attributes);
  await saveChatEvents(owner,thread,rootSession,[{type:'turn.started',meta:{id:randomUUID(),at:requestEvent.meta.at},data:{sequence:0,turnId:'turn_0'}},requestEvent],runtime);

  await check('actual tool -> authenticated H3 rejects plan as material before mission/task/event writes and exposes exact bounded corrective refs',async()=>{
    const before=await state(),input=tool.inputSchema.parse({intent:'report_only',sourceRefs:[{type:'material',id:plan.id}]});
    const result=await tool.execute(input,ctx);
    assert.equal(result.accepted,false); assert.equal(result.selectionError.code,'REPORT_SOURCE_KIND_MISMATCH');
    assert.deepEqual(result.selectionError.suggestions.map(r=>r.reportSource.id).sort(),runs.map(r=>r.id).sort());
    assert.ok(result.selectionError.suggestions.every(r=>r.itemId===plan.id&&r.planVersion===1));
    assert.equal(handoffs.length,0); assert.equal(kicks.length,0); assert.deepEqual(await state(),before);
  });
  await check('same original call can correct exact bindings; only selected runs become criteria and no execution begins',async()=>{
    const refs=runs.map(r=>({type:'test',id:r.id})),before=await state();
    const result=await tool.execute(tool.inputSchema.parse({intent:'report_only',sourceRefs:refs}),ctx);
    assert.ok(result.missionId); const saved=await row(schema.missions,result.missionId),t=await task(saved.id);
    assert.equal(saved.admission.goal,originalGoal); assert.deepEqual(saved.admission.sourceRefs,refs); assert.deepEqual(saved.config.criteria[0].delivery.sourceRefs,refs); assert.deepEqual(t.sources,refs);
    assert.equal(t.spec.kind,'report'); assert.deepEqual(saved.mandate.allowedTaskKinds,['review','report']);
    assert.equal((await state()).runs.length,before.runs.length); assert.equal((await state()).reviews.length,before.reviews.length);
    assert.equal(kicks.length,1); assert.equal(handoffs.length,1);
  });
  await check('research alias cannot bypass the plan guard and goal UUID prose cannot auto-select runs',async()=>{
    const before=await state();
    await assert.rejects(accept([{type:'research',id:plan.id}],{goal:`Summarize run ${runs[0].id}`}),e=>e.statusCode===400&&e.data.code==='REPORT_SOURCE_KIND_MISMATCH');
    assert.deepEqual(await state(),before);
  });
  await check('foreign workspace or missing definition is denied before exposing any suggestion',async()=>{
    for(const type of ['material','research','plan_definition']) for(const id of [foreignPlan.id,randomUUID()]) {
      const before=await state(); await assert.rejects(accept([{type,id},{type:'material',id:plan.id}]),e=>e.statusCode===404&&!e.data);
      assert.deepEqual(await state(),before);
    }
  });
  await check('suggestions exclude foreign runtime, old plan versions, unfinished and invalid-case rows',async()=>{
    const invalid=[seed({runtime:'other-runtime'}),seed({runtime:null}),seed({planVersion:2}),seed({finishedAt:null}),seed({caseId:randomUUID()}),seed({itemId:foreignPlan.id,workspaceId:foreignWorkspace,threadId:foreignThread})];
    await db.insert(schema.testRuns).values(invalid);
    await assert.rejects(accept([{type:'material',id:plan.id}]),e=>{
      assert.deepEqual(e.data.suggestions.map(r=>r.reportSource.id).sort(),runs.map(r=>r.id).sort());return true;
    });
    await db.delete(schema.testRuns).where(eq(schema.testRuns.id,invalid.at(-1).id));
  });
  await check('suggestions are capped at ten and remain suggestions, never automatic latest-run selection',async()=>{
    await db.insert(schema.testRuns).values(Array.from({length:12},()=>seed())); const before=await state();
    await assert.rejects(accept([{type:'material',id:plan.id}]),e=>e.data.suggestions.length===10&&e.data.suggestionsTruncated);
    assert.deepEqual(await state(),before);
  });
  await check('explicit plan definition normalizes to canonical material and stays stable through receipt replay and resume',async()=>{
    const input=request([{type:'plan_definition',id:plan.id}]),saved=await acceptMission(owner,workspace,thread,input),t=await task(saved.id);
    assert.deepEqual(saved.admission.sourceRefs,[{type:'material',id:plan.id}]); missionAdmissionSchema.parse(saved.admission);
    assert.deepEqual(t.sources,saved.admission.sourceRefs); assert.deepEqual(saved.config.criteria[0].delivery.sourceRefs,t.sources);
    assert.equal(t.results[0].sourceType,'material'); assert.equal(t.results[0].assessment,null);
    assert.equal((await acceptMission(owner,workspace,thread,input)).id,saved.id);
    await controlMission(owner,workspace,thread,{action:'pause',missionId:saved.id,requestId:randomUUID(),expectedMandateRevision:saved.mandateRevision});
    const paused=await row(schema.missions,saved.id);
    const resumed=await controlMission(owner,workspace,thread,{action:'resume',missionId:saved.id,requestId:randomUUID(),expectedMandateRevision:paused.mandateRevision});
    assert.deepEqual(resumed.admission.sourceRefs,saved.admission.sourceRefs); assert.deepEqual(resumed.config.criteria,saved.config.criteria);
  });
  await check('actual version/hash-fenced definition read yields the plan claim, never test proof even with legacy tool provenance',async()=>{
    await db.update(schema.workspaceItems).set({provenance:{version:1,origin:'tool',producer:'research-page',sourceType:'research',observedAt:new Date().toISOString()}}).where(eq(schema.workspaceItems.id,plan.id));
    const source=await readMissionSource(db,workspace,'material',plan.id),ref=source.evidence[0];
    assert.equal(source.assessment,null);assert.equal(source.claims,undefined);assert.equal(ref.origin,'unknown');assert.equal(independentMissionEvidence(source,ref),false);
    const read=await readMissionEvidence(workspace,ref,new AbortController().signal);assert.equal(read.unavailable,undefined);
    assert.equal(JSON.parse(read.text).kind,'test_plan');assert.equal(JSON.parse(read.text).cases.length,3);assert.equal(read.digest,ref.hash);
    await db.update(schema.workspaceItems).set({version:2}).where(eq(schema.workspaceItems.id,plan.id));
    assert.equal((await readMissionEvidence(workspace,ref,new AbortController().signal)).unavailable,true);
    await db.update(schema.workspaceItems).set({version:1,provenance:null}).where(eq(schema.workspaceItems.id,plan.id));
  });
  await check('ordinary selected documents/research remain canonical and plan_definition rejects a non-plan document',async()=>{
    const item=await saveItem(owner,workspace,{title:'Separate chosen note',content:{kind:'text',text:'Original user-selected claim.'}});
    for(const type of ['material','research']) {const saved=await accept([{type,id:item.id}]);assert.deepEqual(saved.admission.sourceRefs,[{type,id:item.id}]);}
    await assert.rejects(accept([{type:'plan_definition',id:item.id}]),e=>e.statusCode===400);
  });
  await check('exact repository source remains supported and foreign runtime is not adopted',async()=>{
    const repositoryId=randomUUID(),id=randomUUID(),now=new Date().toISOString();
    const config={url:'https://github.com/fixture/report-only',ref:'',script:'test',mode:'test',directory:''};
    await db.insert(schema.repositories).values({id:repositoryId,workspaceId:workspace,url:config.url});
    await db.insert(schema.repositoryRuns).values({id,repositoryId,workspaceId:workspace,runtime,requestId:randomUUID(),config,
      job:{id,status:'passed',message:'Synthetic saved command',logs:'Synthetic command logs, no runner.',commit:'a'.repeat(40),plan:{command:'npm test'},testExitCode:0,updatedAt:now,finishedAt:now}});
    const saved=await accept([{type:'repository',id}]);assert.deepEqual(saved.admission.sourceRefs,[{type:'repository',id}]);
    const before=await state();await db.update(schema.repositoryRuns).set({runtime:'other-runtime'}).where(eq(schema.repositoryRuns.id,id));
    await assert.rejects(accept([{type:'repository',id}]),e=>e.statusCode===404);assert.deepEqual(await state(),before);
  });
  await check('context and run list expose canonical exact reportSource without a cross-runtime suggestion',async()=>{
    const context=await workspaceContext(owner,thread);assert.ok(context.recentTestRuns.every(r=>r.reportSource.type==='test'&&r.reportSource.id===r.id));
    assert.equal(context.recentTestRuns.length,10);
    const listed=await testRunAction(owner,workspace,thread,{action:'list',itemId:plan.id});assert.ok(listed.every(r=>r.reportSource.type==='test'&&r.reportSource.id===r.id));
    assert.ok(listed.every(r=>r.runtime===runtime||r.runtime===null));
  });
  console.log(JSON.stringify({checks,count:checks.length,proof:'Actual isolated PostgreSQL and H3/authenticated API/tool; synthetic saved inputs, no models or execution',invariant:'exact-report-source-selection'}));
} finally {
  globalThis.fetch=originalFetch; await new Promise(resolve=>server.close(resolve)); await Promise.all(deferred);
  try { for(const id of [workspace,foreignWorkspace]) { await db.delete(schema.testRuns).where(eq(schema.testRuns.workspaceId,id)); await db.delete(schema.threads).where(eq(schema.threads.workspaceId,id));await db.delete(schema.workspaces).where(eq(schema.workspaces.id,id)); }
    for(const id of [owner,other]) await db.delete(schema.user).where(eq(schema.user.id,id));
  } finally {hooks.deregister();await app.close();}
}
