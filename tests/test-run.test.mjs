import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { registerHooks } from 'node:module';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { testCaseSchema, testPlanSchema, newTestCase } from '../shared/test-plan.ts';
import { plannedTestCase, missionPlanningDraftSchema } from '../shared/mission-planning.ts';
import { sameCase, qualitySummary, defaultQuality } from '../shared/quality.ts';
import { sameRegressionRequirement } from '../shared/mission-regression.ts';
import actual from './fixtures/run-checks-inline-parenthesis.mjs';
import { runResultSchema, testRunActionSchema, latestCaseRun, effectiveRunOutcome, runChecks, runVerificationError, runCoverage } from '../shared/test-run.ts';

test('coverage distinguishes legacy unknown, partial steps and unmet expectations', () => {
 const snapshot={steps:'1. Open page. 2. Log in.',expected:'Return to page',preconditions:'Logged out'};
 assert.equal(runCoverage(snapshot,{outcome:'passed'}).recorded,false);
 const coverage=runCoverage(snapshot,{checks:[{id:'step-1',status:'verified',actual:'Page opened'},{id:'expected',status:'blocked',actual:'No test account'}]});
 assert.equal(coverage.total,2); assert.equal(coverage.verified,1);
 assert.equal(coverage.checks.find(c=>c.id==='step-2').status,'unverified');
 assert.equal(coverage.checks.find(c=>c.id==='expected').actual,'No test account');
});

test('original login return requirement cannot disappear when delegated scope is narrower', () => {
 const snapshot={steps:'1. Open /konto logged out. 2. Open /starta logged out. 3. Log in and verify return.',expected:'Protected pages require login and preserve return path.',preconditions:'Logged out'};
 const checks=runChecks(snapshot);
 assert.deepEqual(checks.map(c=>c.id),['preconditions','step-1','step-2','step-3','expected']);
 const result={outcome:'passed',actual:'Redirect works',unverified:'',observations:[],evidenceItemIds:[]};
 assert.ok(runVerificationError(snapshot,result),'Legacy freeform pass is insufficient for new writes');
 const verified=checks.map(c=>({id:c.id,status:'verified',actual:`Observed: ${c.requirement}`}));
 assert.ok(runVerificationError(snapshot,{...result,checks:verified.filter(c=>c.id!=='step-3')}));
 assert.ok(runVerificationError(snapshot,{...result,checks:verified.map(c=>c.id==='step-3'?{...c,status:'unverified'}:c)}));
 assert.equal(runVerificationError(snapshot,{...result,checks:verified}),null);
 assert.equal(runVerificationError(snapshot,{...result,outcome:'inconclusive',checks:verified.filter(c=>c.id!=='step-3')}),null);
 assert.ok(runVerificationError(snapshot,{...result,checks:[...verified,verified[0]]}));
 assert.ok(runVerificationError(snapshot,{...result,checks:[...verified,{id:'invented',status:'verified',actual:'x'}]}));
 assert.ok(runVerificationError({...snapshot,expected:''},{...result,checks:verified}));
});

test('unstructured steps stay intact and declared coverage must agree with pass', () => {
 assert.deepEqual(runChecks({steps:'Open page and inspect 3.14 values',expected:'Visible',preconditions:''}).map(c=>c.id),['step-1','expected']);
 assert.equal(runResultSchema.safeParse({outcome:'passed',actual:'Partial',unverified:'',observations:[],evidenceItemIds:[],checks:[{id:'expected',status:'unverified',actual:'No account'}]}).success,false);
});
test('incomplete verification cannot pass', () => {
 const result={outcome:'passed',actual:'UI stayed put',unverified:'Session not checked',observations:[],evidenceItemIds:[]};
 assert.equal(runResultSchema.safeParse(result).success,false);
 assert.equal(runResultSchema.safeParse({...result,outcome:'inconclusive'}).success,true);
 assert.equal(runResultSchema.safeParse({...result,unverified:''}).success,true);
 assert.equal(runResultSchema.safeParse({...result,unverified:'',observations:[{title:'Mismatch',detail:'Requirement not met'}]}).success,false);
 assert.equal(runResultSchema.safeParse({...result,unverified:'',observations:[{title:'Expected behavior',detail:'Stayed logged out',kind:'note'}]}).success,true);
 for (const kind of ['requirement_gap','defect']) assert.equal(runResultSchema.safeParse({...result,unverified:'',observations:[{title:'Unresolved',detail:'Needs action',kind}]}).success,false);
});
test('human review changes displayed assessment without rewriting observations', () => {
 const run={result:{outcome:'inconclusive'},reviews:[{outcome:'passed'},{outcome:'failed'}]};
 assert.equal(effectiveRunOutcome(run),'passed');
 assert.equal(run.result.outcome,'inconclusive');
 assert.equal(effectiveRunOutcome({result:null}),'running');
});
test('numeric versions normalize; malformed versions rejected', () => {
 const input={action:'start',itemId:randomUUID(),caseId:randomUUID(),requestId:randomUUID(),environment:'Test',expectedVersion:'3'};
 assert.equal(testRunActionSchema.parse(input).expectedVersion,3);
 for (const expectedVersion of ['','1.5','abc',null,-1,0]) assert.equal(testRunActionSchema.safeParse({...input,expectedVersion}).success,false);
});
test('new unfinished run supersedes old pass without changing history', () => {
 const runs=[{id:'a',itemId:'i',caseId:'c',startedAt:'2026-01-01',result:{outcome:'passed'}},{id:'b',itemId:'i',caseId:'c',startedAt:'2026-01-02',result:null}];
 assert.equal(latestCaseRun(runs,'i','c').id,'b');
 assert.equal(runs[0].result.outcome,'passed');
 assert.equal(latestCaseRun(runs,'other','c'),undefined);
});

test('JSON transport is normalized but still fully validated', () => {
 const input={action:'finish',runId:randomUUID(),result:JSON.stringify({outcome:'blocked',actual:'No environment',unverified:'All steps',observations:[],evidenceItemIds:[]})};
 assert.equal(testRunActionSchema.parse(input).result.outcome,'blocked');
 assert.equal(testRunActionSchema.safeParse({...input,result:'broken'}).success,false);
 assert.equal(testRunActionSchema.safeParse({...input,result:JSON.stringify({outcome:'passed'})}).success,false);
});

test('versioned numbered lines preserve the real inline fall 1 text; historical six checks remain immutable', () => {
 const before=structuredClone(actual.snapshot), legacy=runChecks(actual.snapshot).filter(c=>c.id.startsWith('step-'));
 assert.deepEqual(legacy.map(c=>c.requirement),actual.legacySteps);
 assert.equal(legacy.length,6); assert.equal(legacy.at(-1).requirement,'1) ersätter inte denna kontroll.');
 const current={...actual.snapshot,checksVersion:2}, checks=runChecks(current).filter(c=>c.id.startsWith('step-'));
 assert.equal(checks.length,5); assert.deepEqual(checks.map(c=>c.requirement),actual.snapshot.steps.split('\n'));
 assert.match(checks[4].requirement,/\(fall 1\) ersätter inte denna kontroll\.$/);
 assert.equal(current.steps,before.steps); assert.deepEqual(actual.snapshot,before);
 assert.deepEqual(runChecks(testCaseSchema.parse(actual.snapshot)),runChecks(actual.snapshot));
 assert.equal(Object.hasOwn(testCaseSchema.parse(actual.snapshot),'checksVersion'),false,'No read-time upgrade');
});

test('versioned numbered lines preserve LF CRLF indentation multiline prose and empty steps', () => {
 for(const newline of ['\n','\r\n']) {
  const lines=['  1. First action (case 2) stays here.','Continuation with 3.14 and inline 7) prose.', '\t2) Second action.', '  More context.'];
  const snapshot={...actual.snapshot,checksVersion:2,steps:lines.join(newline)};
  assert.deepEqual(runChecks(snapshot).filter(c=>c.id.startsWith('step-')).map(c=>c.requirement),[lines.slice(0,2).join(newline).trim(),lines.slice(2).join(newline).trim()]);
  assert.equal(snapshot.steps,lines.join(newline));
 }
 for(const steps of ['Open page; 1. Inspect it then 2) return (fall 1) safely.', '1. Open then 2. inspect; 3) return.', 'Opening context\ncontinued without numbering.']) {
  assert.deepEqual(runChecks({...actual.snapshot,checksVersion:2,steps}).filter(c=>c.id.startsWith('step-')),[{id:'step-1',requirement:steps}]);
 }
 assert.deepEqual(runChecks({...actual.snapshot,checksVersion:2,steps:'  \r\n\t ',preconditions:'Original condition',expected:'Original result'}),[{id:'preconditions',requirement:'Original condition'},{id:'expected',requirement:'Original result'}]);
 assert.deepEqual(runChecks({...actual.snapshot,checksVersion:2,steps:'Opening context\n1. First\nbody\n2. Second'}).filter(c=>c.id.startsWith('step-')).map(c=>c.requirement),['Opening context','1. First\nbody','2. Second']);
});

test('versioned numbered lines drive exact FINISH coverage without borrowing a legacy check', () => {
 const current={...actual.snapshot,checksVersion:2}, checks=runChecks(current);
 const result={schemaVersion:2,outcome:'passed',actual:'Synthetic complete result',observations:[],evidenceItemIds:[],remaining:[],checks:checks.map(c=>({id:c.id,status:'verified',actual:c.requirement}))};
 assert.equal(runVerificationError(current,result),null);
 assert.ok(runVerificationError(current,{...result,checks:result.checks.filter(c=>c.id!=='step-5')}));
 assert.ok(runVerificationError(current,{...result,checks:[...result.checks,{id:'step-6',status:'verified',actual:'Invented split'}]}));
 assert.ok(runVerificationError(actual.snapshot,result),'Legacy original still requires its historical step-6');
 assert.deepEqual(runCoverage(current,result).checks.map(c=>({id:c.id,requirement:c.requirement})),checks);
});

test('versioned numbered lines are code-owned in new cases and planner projection, absent from native draft', () => {
 assert.equal(newTestCase().checksVersion,2);
 for(const checksVersion of [1,3,null,'2']) assert.equal(testCaseSchema.safeParse({...actual.snapshot,checksVersion}).success,false);
 const value={title:'An unchanged requirement',entryUrl:'https://example.test/',basis:{kind:'exploratory',quote:'',source:null},steps:[{action:'Use the original control (fall 1).',expected:'Observe the result.'}],expected:'Original expected.'};
 const original=structuredClone(value), projected=plannedTestCase(value,randomUUID());
 assert.equal(projected.checksVersion,2); assert.deepEqual(value,original); assert.equal(runChecks(projected).length,2);
 assert.match(projected.steps,/\(fall 1\)\. Förväntat/);
 const native={schemaVersion:1,title:'Plan',summary:'Plan only',cases:[value],limitations:[]};
 assert.equal(missionPlanningDraftSchema.safeParse(native).success,true);
 assert.equal(missionPlanningDraftSchema.safeParse({...native,cases:[{...value,checksVersion:2}]}).success,false,'No model-owned version field');
 assert.equal(missionPlanningDraftSchema.safeParse({...native,cases:[{...value,preconditions:''}]}).success,false,'P19 remains strict');
});

test('versioned numbered lines change applicability even when all visible text is identical', () => {
 const legacy=structuredClone(actual.snapshot), current={...legacy,checksVersion:2};
 assert.equal(sameCase(legacy,current),false); assert.equal(sameRegressionRequirement(legacy,current),false);
 assert.equal(sameCase(current,{...current}),true); assert.equal(sameRegressionRequirement(current,{...current}),true);
 const item={id:randomUUID(),title:'Plan',version:2,content:{kind:'test_plan',cases:[current],sources:[]}}, run={id:randomUUID(),itemId:item.id,caseId:legacy.id,planVersion:1,snapshot:legacy,startedAt:'2026-10-01T00:00:00Z',finishedAt:'2026-10-01T00:01:00Z',result:{outcome:'passed'},target:null};
 assert.equal(qualitySummary([item],[run],defaultQuality().config).counts.stale,1);
 assert.equal(run.result.outcome,'passed'); assert.deepEqual(run.snapshot,actual.snapshot);
});

test('versioned numbered lines stamp only ordinary saved plan versions with the same persisted content', async () => {
 // Actual saveItem body, synthetic transaction tables; no database or storage.
 const table=name=>({name,id:name+'.id',workspaceId:name+'.workspace',userId:name+'.user',itemId:name+'.item',version:name+'.version'});
 const schema=Object.fromEntries(['workspaces','workspaceItems','workspaceItemVersions','missionReports','threads','workspaceEvidence'].map(name=>[name,table(name)]));
 globalThis.runChecksTestDb={db:{},schema};
 const hooks=registerHooks({resolve(specifier,context,next){
  if(specifier==='@nuxthub/db')return{url:'data:text/javascript,export const {db,schema}=globalThis.runChecksTestDb;',shortCircuit:true};
  if(/(?:^|\/)evidence-storage(?:\.ts)?$/.test(specifier))return{url:'data:text/javascript,export const put=()=>{throw Error("Unexpected storage")};export const del=put;export const workspaceStorageToken=put;',shortCircuit:true};
  if(specifier.startsWith('.')&&context.parentURL?.startsWith('file:')){
   const url=new URL(specifier+'.ts',context.parentURL);
   if(existsSync(fileURLToPath(url)))return{url:url.href,shortCircuit:true};
  }
  return next(specifier,context);
 }});
 let saveItem;
 try {({saveItem}=await import('../server/utils/workspaces.ts'));} finally {hooks.deregister();delete globalThis.runChecksTestDb;}
 const userId=randomUUID(),workspaceId=randomUUID(),itemId=randomUUID();
 const plan=testPlanSchema.parse({kind:'test_plan',cases:[actual.snapshot],sources:[]}), original=structuredClone(plan);
 const existing={id:itemId,workspaceId,version:3,title:'Original',content:structuredClone(plan),deletedAt:null,blobPath:null};
 const oldVersion=structuredClone(existing), versions=[];let writes=0;
 const tx={
  execute:async()=>{},
  select:()=>({from:table=>({where:async()=>table===schema.workspaces?[{id:workspaceId,userId}]:table===schema.workspaceItems?[existing]:[]})}),
  update:table=>({set:values=>({where:()=>({returning:async()=>{assert.equal(table,schema.workspaceItems);writes++;Object.assign(existing,structuredClone(values));return[existing];}})})}),
  insert:table=>({values:async values=>{assert.equal(table,schema.workspaceItemVersions);versions.push(structuredClone(values));}}),
  transaction:async callback=>callback(tx),
 };
 const saved=await saveItem(userId,workspaceId,{id:itemId,expectedVersion:3,title:'Saved',content:plan},tx);
 assert.equal(saved.version,4);assert.equal(saved.content.cases[0].checksVersion,2);assert.equal(writes,1);
 assert.deepEqual(saved.content,versions[0].content);assert.equal(versions[0].version,4);
 assert.deepEqual(plan,original);assert.deepEqual(oldVersion.content,original);assert.equal(Object.hasOwn(oldVersion.content.cases[0],'checksVersion'),false);
 assert.deepEqual({...saved.content.cases[0],checksVersion:undefined},{...original.cases[0],checksVersion:undefined});
 // Generated cases have the marker before save, so planner's local content
 // hash equals the persisted content; no caller mutation is needed.
 const marked={...saved.content,cases:saved.content.cases.map(c=>({...c,checksVersion:2}))}, before=JSON.stringify(marked);
 const again=await saveItem(userId,workspaceId,{id:itemId,expectedVersion:4,title:'Saved again',content:marked},tx);
 assert.equal(JSON.stringify(again.content),before);assert.equal(JSON.stringify(marked),before);
 assert.equal(again.version,5);assert.equal(versions[1].version,5);
});
