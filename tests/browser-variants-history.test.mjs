import test from 'node:test';
import assert from 'node:assert/strict';
import { runChecks } from '../shared/test-run.ts';
import { auditReviewInputHash, sha256 } from './helpers/autonomy-web-audit.mjs';
import { regressionFingerprint } from './helpers/browser-variants-regression.mjs';
import { auditBrowserVariant } from './helpers/browser-variants-protocol.mjs';
import { actualHistoryOracle, actualRegressionPlan, actualHistoryExecutionProtocol, sealActualRegressionHistory, importActualRegressionHistory, projectRegressionMission, auditActualRegressionB, boundRegressionSource } from './helpers/browser-variants-history.mjs';
import { example, clone, time, hash } from './browser-variants-current-fixture.mjs';

const uuid = n => `${String(n).padStart(8,'0')}-0000-4000-8000-000000000000`;
function value() {
  const { state, context } = example(), plan = actualRegressionPlan([uuid(4),uuid(5)],'a');
  const identity = { workspaceId:uuid(1),userId:uuid(2),threadId:uuid(3),planId:uuid(6),sessionId:'actual-fixture-channel',runtime:context.runtime,
    sourceHash:hash,fixtureSourceHash:hash,harnessSha256:hash,helperSha256:hash };
  const mission=state.missions[0]; Object.assign(mission,{id:uuid(7),workspace_id:identity.workspaceId,user_id:identity.userId,thread_id:identity.threadId});
  mission.config.target.url='http://qa-regression.test/regression/a';mission.config.caseKeys=plan.cases.map(row=>`${identity.planId}:${row.id}`);
  mission.config.criteria[0].delivery.caseKeys=clone(mission.config.caseKeys);
  mission.admission={intent:'verify',target:{url:mission.config.target.url},caseKeys:clone(mission.config.caseKeys)};
  state.versions=[{item_id:identity.planId,version:1,created_at:time(0),content:plan}];
  for(const [index,run]of state.runs.entries()){
    const testCase=plan.cases[index],requirements=runChecks(testCase),negative=index===0;
    Object.assign(run,{thread_id:identity.threadId,item_id:identity.planId,case_id:testCase.id,snapshot:clone(testCase),target:clone(mission.config.target)});
    run.result.outcome=negative?'failed':'passed';run.result.checks=requirements.map(req=>({id:req.id,status:negative?'mismatch':'verified',actual:negative?'Actual fixture 404':'Actual fixture contact'}));
    const task=state.tasks[index];task.spec.caseKeys=[`${identity.planId}:${testCase.id}`];task.spec.planVersions=[{itemId:identity.planId,version:1}];task.spec.target=clone(run.target);
    const review=state.reviews[index];review.input={...review.input,target:clone(run.target),requirements,reportedResult:clone(run.result)};review.input_hash=auditReviewInputHash(review.input);
    review.assessment.findings=requirements.map(req=>({requirementId:req.id,verdict:'supported',evidenceIds:[review.input.evidence[0].id],gap:null}));
    const expected=actualHistoryOracle.tasks[0].checks[index],trace=context.traces[index].trace;
    Object.assign(trace,{action:'click',fromUrl:actualHistoryOracle.origin+expected.fromPath,toUrl:actualHistoryOracle.origin+expected.toPath,httpStatus:expected.status,
      observation:{text:expected.visibleText.join(' '),headings:[expected.heading],truncated:false}});
    state.reports[0].document.tests[index]={runId:run.id,originalOutcome:run.result.outcome,status:run.result.outcome,review:'supported'};
  }
  for(const [index,capture]of state.captures.entries())capture.id=uuid(20+index);
  for(const task of state.tasks)task.mission_id=mission.id;
  for(const attempt of state.attempts){attempt.operation_id??=attempt.id;attempt.mission_id=mission.id;}
  state.jobs.forEach(row=>row.thread_id=identity.threadId);state.waits=[];
  state.tasks.push({id:'final-task',mission_id:mission.id,state:'completed',plan_revision:1,spec:{kind:'report',purpose:'final'}});
  state.attempts.push({id:'final-attempt',mission_id:mission.id,task_id:'final-task',kind:'report',status:'completed',operation_id:'report:final:1',executor_resource_id:'report',mandate_revision:1,plan_revision:1,finished_at:time(20),lease_until:null});
  state.reports[0].mission_id=mission.id;state.reportItems=[{id:'report-item',version:1,deleted_at:null}];
  state.reportBindings=[{id:'report',mission_id:mission.id,snapshot_id:uuid(8),snapshot_hash:hash,snapshot_mission_id:mission.id,snapshot_workspace_id:identity.workspaceId,purpose:'final',captured_at:time(19),snapshot_tasks:[snapshotTask(state,state.runs.map(run=>source(run,state.captures)))]}];
  state.events=[{mission_id:mission.id,kind:'report_requested',created_at:time(18)}];
  context.protocol={schemaVersion:5,taskId:'WEB-04',variant:'normal'};context.runChecksPolicy={version:1,sourceSha256:hash};
  context.history=[{at:time(0),missions:clone(state.missions),runs:[]}];
  const receipts=state.captures.map(c=>({itemId:c.item_id,sha256:c.provenance.sha256,bytes:10,denials:[401,404]}));
  const scheduler=['/api/internal/autonomy/drain','/api/internal/result-reviews/drain','/api/internal/mission-reports/drain'].map(path=>({path,method:'POST',status:200,timestamp:time(5)}));
  const ownerReport={reportId:'report',itemId:'report-item',stale:false,documentSha256:regressionFingerprint(state.reports[0].document),denials:[401,404]};
  return{state,context,identity,plan,receipts,scheduler,ownerReport,acceptedAt:time(0),closedAt:time(21)};
}
const sealed = () => {const v=value(),preparation=sealActualRegressionHistory(v),bytes=Buffer.from(JSON.stringify(preparation));return{...v,preparation,bytes,expected:{artifactSha256:sha256(bytes),identity:v.identity},reads:{...v.context,receipts:v.receipts}};};
function source(run,captures){return{sourceType:'test',sourceId:run.id,sourceRevision:sha256(run.id),target:clone(run.target),startedAt:run.started_at,finishedAt:run.finished_at,
  evidence:captures.filter(c=>c.run_id===run.id).map(c=>({id:'item:'+c.item_id,itemId:c.item_id,origin:'tool',provenance:{...c.provenance,sourceType:'test',sourceId:run.id}}))};}
function snapshotTask(state,sources,id=state.tasks[0].id,actor='browser') {
  const mission=state.missions[0],task={id,actor,parentId:null,criterionIds:['qa'],sources:clone(sources)};
  for(const source of task.sources)source.context={resultId:source.sourceType+':'+source.sourceId,missionId:mission.id,taskId:id,
    workspaceId:mission.workspace_id,runtime:mission.runtime,actor,parentId:task.parentId,criterionIds:clone(task.criterionIds)};
  return task;
}
function duplicateSources(state) {
  const task=snapshotTask(state,state.reportBindings[0].snapshot_tasks[0].sources,'review-source-task','main');
  state.tasks.push({id:task.id,mission_id:state.missions[0].id,state:'completed',spec:{kind:'review'}});
  state.reportBindings[0].snapshot_tasks.push(task);
  return task;
}
function comparison(){
  const v=sealed(),state=clone(v.state),mission=state.missions[0];mission.id=uuid(80);mission.thread_id=uuid(81);mission.admission.intent='regression';mission.admission.target.url='http://qa-regression.test/regression/b';mission.config.target.url=mission.admission.target.url;
  state.versions.push({item_id:v.identity.planId,version:2,content:v.preparation.afterContent});
  state.runs=state.runs.map((run,i)=>({...run,id:'new-'+run.id,thread_id:mission.thread_id,plan_version:2,target:clone(mission.config.target),started_at:time(23),finished_at:time(24),snapshot:v.preparation.afterContent.cases[i]}));
  state.captures=state.captures.map(c=>({...c,item_id:'new-'+c.item_id,run_id:'new-'+c.run_id}));
  const report=clone(v.state.reports[0]);
  report.document.tests.push(...state.runs.map(run=>({runId:run.id,originalOutcome:run.result.outcome,status:run.result.outcome,review:'supported'})));
  const sources=[...v.preparation.final.reportBindings[0].snapshot_tasks[0].sources,...state.runs.map(run=>source(run,state.captures))];
  mission.config.criteria.push(...v.preparation.currentRunIds.map((id,i)=>{
    const old=v.preparation.final.runs.find(run=>run.id===id),delivery={kind:'regression_comparison',caseKey:`${old.item_id}:${old.case_id}`,capturedAt:time(22),baseline:{runId:id,planVersion:old.plan_version,snapshot:old.snapshot,target:old.target,startedAt:old.started_at,finishedAt:old.finished_at,sourceRevision:sha256(id)}};
    const criterion={id:'comparison-'+i,delivery};const evidence=sources.filter(s=>[id,'new-'+id].includes(s.sourceId)).flatMap(s=>s.evidence.filter(e=>e.provenance.producer==='browser-action'));
    report.document.findings.push({criterionId:criterion.id,verdict:'supported',evidenceIds:evidence.map(e=>e.id)});
    for(const e of evidence)if(!report.document.evidence.some(x=>x.id===e.id)){report.document.evidence.push({id:e.id,itemId:e.itemId,read:true});report.read_receipts.push({id:e.id,digest:e.provenance.sha256,limited:false});}
    return criterion;
  }));
  for(const task of state.tasks)task.mission_id=mission.id;
  Object.assign(state.reportBindings[0],{mission_id:mission.id,snapshot_mission_id:mission.id,snapshot_config:clone(mission.config),snapshot_delivery:{cases:state.runs.map(run=>({caseKey:`${run.item_id}:${run.case_id}`,runId:run.id,complete:true}))},snapshot_tasks:[snapshotTask(state,sources)]});
  return{...v,state,report};
}

test('actual A/B keep all original semantic requirements; preparation prompt contains no oracle or run IDs',()=>{
  const a=actualRegressionPlan([uuid(4),uuid(5)],'a'),b=actualRegressionPlan(a.cases.map(c=>c.id),'b');
  const requirement = value => Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'entryUrl'));
  assert.deepEqual(a.cases.map(requirement),b.cases.map(requirement));
  const p=actualHistoryExecutionProtocol({taskId:'WEB-04',stop:{},edit:{}});assert.equal(p.stop,null);assert.equal(p.edit,null);
  assert.ok(!/404|missing|[a-f0-9]{8}-[a-f0-9]{4}/i.test(p.prompt));
});
test('actual preparation is revalidated against immutable live rows and independently reread bytes',()=>{
  const v=sealed(),before=clone(v.state),imported=importActualRegressionHistory(v.bytes,v.expected,v.state,v.reads,v.context.protocol);
  assert.equal(imported.preparation,'actual-natural-QA-A');assert.equal(imported.currentRunIds.length,2);assert.deepEqual(v.state,before);
});
test('actual A import accepts independent B rows without hiding changes inside original A scope',()=>{
  const v=sealed(),observed=clone(v.state),mid=uuid(80),thread=uuid(81);
  observed.missions.push({...clone(observed.missions[0]),id:mid,thread_id:thread});
  for(const table of ['tasks','attempts','reports','reportBindings'])observed[table].push({...clone(observed[table][0]),id:'B-'+table,mission_id:mid});
  observed.jobs.push({...clone(observed.jobs[0]),id:'B-job',thread_id:thread});observed.waits.push({id:'B-wait',mission_id:mid});
  observed.events.push({mission_id:mid,kind:'report_requested'});observed.reportItems.push({id:'B-material',version:1,deleted_at:null});
  observed.runs.push({...clone(observed.runs[0]),id:'B-run',thread_id:thread,mission_attempt_id:'B-attempts'});
  observed.reviews.push({...clone(observed.reviews[0]),id:'B-review',run_id:'B-run'});observed.captures.push({...clone(observed.captures[0]),id:'B-capture',run_id:'B-run'});
  assert.equal(importActualRegressionHistory(v.bytes,v.expected,observed,v.reads,v.context.protocol).preparation,'actual-natural-QA-A');
});
for(const[label,corrupt]of[
  ['synthetic run without executor',v=>{v.state.runs[0].mission_attempt_id=null;}],
  ['unknown reviewer',v=>{v.state.reviews[0].reviewer_version='obsolete';}],
  ['unread old capture',v=>{v.context.byteEvidence.delete(v.state.captures[0].item_id);}],
  ['direct navigation instead of actual broken return click',v=>{v.context.traces[0].trace.action='open';}],
  ['wrong 404 destination',v=>{v.context.traces[0].trace.toUrl='http://qa-regression.test/regression/a/contact';}],
  ['fabricated green old defect',v=>{v.state.runs[0].result.outcome='passed';}],
  ['missing real scheduler',v=>{v.scheduler.pop();}],
  ['stale owner report',v=>{v.ownerReport.stale=true;}],
  ['missing report privacy control',v=>{v.ownerReport.denials.pop();}],
  ['wrong original workspace',v=>{v.identity.workspaceId=uuid(99);}],
])test(`A preparation rejects ${label}`,()=>{const v=value();corrupt(v);assert.throws(()=>sealActualRegressionHistory(v));});
for(const[label,corrupt]of[
  ['changed A result',v=>{v.state.runs[0].result.actual='changed';}],
  ['additional A run on old attempt',v=>{v.state.runs.push({...clone(v.state.runs[0]),id:'late-run'});}],
  ['unbound late run in original A chat',v=>{v.state.runs.push({...clone(v.state.runs[0]),id:'late-legacy-run',mission_attempt_id:null});}],
  ['removed A review',v=>{v.state.reviews.pop();}],
  ['additional A review',v=>{v.state.reviews.push({...clone(v.state.reviews[0]),id:'late-review'});}],
  ['changed A report prose',v=>{v.state.reports[0].document.summary='changed';}],
  ['changed A report reads',v=>{v.state.reports[0].read_receipts.pop();}],
  ['changed A immutable snapshot',v=>{v.state.reportBindings[0].snapshot_hash='b'.repeat(64);}],
  ['deleted A report material',v=>{v.state.reportItems[0].deleted_at=time(29);}],
  ['new A report version',v=>{v.state.reportItems[0].version++;}],
  ['new A task',v=>{v.state.tasks.push({...clone(v.state.tasks[0]),id:'late-task'});}],
  ['new A attempt',v=>{v.state.attempts.push({...clone(v.state.attempts[0]),id:'late-attempt'});}],
  ['changed report attempt',v=>{v.state.attempts.at(-1).finished_at=time(29);}],
  ['new A browser job',v=>{v.state.jobs.push({...clone(v.state.jobs[0]),id:'late-job'});}],
  ['new A wait',v=>{v.state.waits.push({id:'late-wait',mission_id:v.state.missions[0].id,state:'open'});}],
  ['new A event',v=>{v.state.events.push({...clone(v.state.events[0]),event_key:'late'});}],
  ['new A report',v=>{v.state.reports.push({...clone(v.state.reports[0]),id:'late-report'});}],
  ['changed A terminal outcome',v=>{v.state.missions[0].closure_reason='cancelled';}],
  ['changed A bytes',v=>{v.reads.receipts[0].sha256='b'.repeat(64);}],
  ['missing repeated privacy controls',v=>{v.reads.receipts[0].denials=[];}],
  ['rewritten original plan version',v=>{v.state.versions[0].content.summary='rewritten';}],
  ['foreign original thread',v=>{v.state.missions[0].thread_id=uuid(99);}],
  ['missing A capture',v=>{v.state.captures.pop();}],
  ['changed runtime',v=>{v.expected.identity={...v.identity,runtime:'autonomy-test:other'};}],
  ['relabeled synthetic artifact',v=>{const p=JSON.parse(v.bytes);p.preparation='synthetic-unreviewed-history';v.bytes=Buffer.from(JSON.stringify(p));v.expected.artifactSha256=sha256(v.bytes);}],
  ['changed artifact bytes',v=>{v.bytes=Buffer.from(v.bytes+' ');}],
])test(`Actual A import rejects ${label}`,()=>{const v=sealed();corrupt(v);assert.throws(()=>importActualRegressionHistory(v.bytes,v.expected,v.state,v.reads,v.context.protocol));});

test('B projection excludes every A attempt/token meter but retains declared plan versions and rejects unrelated work',()=>{
  const v=sealed(),state=clone(v.state),old=state.missions[0],mission={...clone(old),id:uuid(80),thread_id:uuid(81)};state.missions.push(mission);
  const aid='new-attempt';state.tasks.push({id:'new-task',mission_id:mission.id});state.attempts.push({id:aid,mission_id:mission.id,usage:{tokens:7}});
  state.runs.push({...clone(state.runs[0]),id:'new-run',mission_attempt_id:aid,plan_version:2});
  const result=projectRegressionMission(state,v.preparation,mission.thread_id);assert.deepEqual(result.attempts.map(r=>r.id),[aid]);assert.deepEqual(result.runs.map(r=>r.id),['new-run']);
  assert.equal(result.missions.length,1);assert.equal(result.missions[0].id,mission.id);
  state.missions.push({...mission,id:uuid(82),thread_id:uuid(83)});assert.throws(()=>projectRegressionMission(state,v.preparation,mission.thread_id));
});
test('B comparison needs read-backed A evidence, not invented sourceType/sourceId fields or merely prose',()=>{
  const v=comparison();assert.equal(auditActualRegressionB(v.state,v.preparation,v.report).semanticComparison,'independent_review_pending');
  v.report.document.evidence[0].read=false;assert.throws(()=>auditActualRegressionB(v.state,v.preparation,v.report),/actual A\/B action evidence/);
});
for(const[label,corrupt]of[
  ['missing typed comparison',v=>{v.state.missions[0].config.criteria.pop();}],
  ['substituted historical run',v=>{v.state.missions[0].config.criteria[1].delivery.baseline.runId='other';}],
  ['late baseline capture',v=>{v.state.missions[0].config.criteria[1].delivery.capturedAt=time(24);v.state.reportBindings[0].snapshot_config=clone(v.state.missions[0].config);}],
  ['report changed comparison',v=>{v.state.reportBindings[0].snapshot_config.criteria.pop();}],
  ['old source version drift',v=>{v.state.reportBindings[0].snapshot_tasks[0].sources[0].sourceRevision='b'.repeat(64);}],
  ['old result shown green',v=>{v.report.document.tests[0].status='passed';}],
  ['missing B read',v=>{v.report.read_receipts=v.report.read_receipts.filter(r=>!r.id.startsWith('item:new-'));}],
  ['borrowed other-case source',v=>{v.state.reportBindings[0].snapshot_tasks[0].sources[0].evidence=v.state.reportBindings[0].snapshot_tasks[0].sources[1].evidence;}],
  ['A reused as B',v=>{v.state.reportBindings[0].snapshot_delivery.cases[0].runId=v.preparation.currentRunIds[0];}],
  ['extra report test',v=>{v.report.document.tests.push(clone(v.report.document.tests[0]));}],
  ['original A mission reused',v=>{v.state.missions[0].id=v.preparation.final.missions[0].id;}],
  ['other owner',v=>{v.state.missions[0].user_id=uuid(99);}],
])test(`B exact typed comparison rejects ${label}`,()=>{const v=comparison();corrupt(v);assert.throws(()=>auditActualRegressionB(v.state,v.preparation,v.report));});

test('full current-run oracle accepts only separately bound history and still checks all current results',()=>{
  const v=value();const protocol={...actualHistoryExecutionProtocol(v.context.protocol),historicalBaseline:'actual-natural-QA-A-before-measured-B-v1'};
  const currentRunIds=v.state.runs.map(r=>r.id),historicalComparison={binding:'immutable-regression-comparison-v1',reportSnapshotHash:hash,currentRunIds,currentHistoricalRunIds:['older-original']};
  v.state.reports[0].document.tests.push({...v.state.reports[0].document.tests[0],runId:'older-original'});
  const context={...v.context,protocol,oracle:actualHistoryOracle,historicalComparison};
  assert.equal(auditBrowserVariant(v.state,context).matches.length,2);
  assert.throws(()=>auditBrowserVariant(v.state,{...context,historicalComparison:undefined}),/binding is required/);
  assert.throws(()=>auditBrowserVariant(v.state,{...context,historicalComparison:{...historicalComparison,reportSnapshotHash:'b'.repeat(64)}}));
  assert.throws(()=>auditBrowserVariant(v.state,{...context,historicalComparison:{...historicalComparison,currentHistoricalRunIds:[currentRunIds[0]]}}));
  v.state.reports[0].document.tests.pop();assert.throws(()=>auditBrowserVariant(v.state,context),/separately bound history/);
});

test('A seal accepts identical saved sources in distinct verified browser and review task contexts',()=>{
  const v=value(),duplicate=duplicateSources(v.state),first=v.state.reportBindings[0].snapshot_tasks[0].sources[0];
  assert.notEqual(regressionFingerprint(first),regressionFingerprint(duplicate.sources[0]),'Old whole-object equality rejects this legitimate duplicate');
  const before=clone(v.state),p=sealActualRegressionHistory(v);
  assert.equal(p.currentRunIds.length,2);assert.deepEqual(v.state,before);
});
test('B comparison accepts historical and current sources rebound to real B task parents',()=>{
  const v=comparison();duplicateSources(v.state);
  assert.equal(auditActualRegressionB(v.state,v.preparation,v.report).actualHistoryVerified,true);
  assert.notEqual(v.state.reportBindings[0].snapshot_tasks[0].sources[0].context.missionId,
    v.preparation.final.reportBindings[0].snapshot_tasks[0].sources[0].context.missionId);
});
for(const [label,corrupt]of[
  ['actor',s=>{s.context.actor='unbound-actor';}],
  ['task',s=>{s.context.taskId='other-task';}],
  ['runtime',s=>{s.context.runtime='autonomy-test:foreign';}],
  ['mission',s=>{s.context.missionId=uuid(99);}],
  ['workspace',s=>{s.context.workspaceId=uuid(99);}],
  ['result identity',s=>{s.context.resultId='test:other';}],
  ['parent',s=>{s.context.parentId='foreign-parent';}],
  ['criterion selection',s=>{s.context.criterionIds=['other'];}],
  ['unexpected owner',s=>{s.context.userId=uuid(99);}],
  ['missing context',s=>{delete s.context;}],
  ['run substitution',s=>{s.sourceId='different-run';}],
])for(const stage of ['A','B'])test(stage+' rejects conflicting '+label+' context despite identical source revision',()=>{
  const v=stage==='A'?value():comparison(),duplicate=duplicateSources(v.state);corrupt(duplicate.sources[0]);
  assert.throws(()=>stage==='A'?sealActualRegressionHistory(v):auditActualRegressionB(v.state,v.preparation,v.report),/Source context/);
});
for(const [label,corrupt]of[
  ['revision',s=>{s.sourceRevision='b'.repeat(64);}],
  ['target',s=>{s.target.url='http://other.test/';}],
  ['requirements',s=>{s.claims=[{requirement:'Substituted original requirement'}];}],
  ['reported observation',s=>{s.claims=[{reportedActual:'Changed actual'}];}],
  ['capture bytes',s=>{s.evidence[0].provenance.sha256='b'.repeat(64);}],
  ['capture identity',s=>{s.evidence[0].itemId='other-capture';}],
  ['provenance origin',s=>{s.evidence[0].origin='agent';}],
  ['reported outcome',s=>{s.reportedOutcome='passed';}],
  ['completion time',s=>{s.finishedAt=time(29);}],
  ['additional unknown evidence field',s=>{s.observation={text:'different'};}],
])for(const stage of ['A','B'])test(stage+' rejects duplicate source '+label+' conflict after checking context',()=>{
  const v=stage==='A'?value():comparison(),duplicate=duplicateSources(v.state);corrupt(duplicate.sources[0]);
  assert.throws(()=>stage==='A'?sealActualRegressionHistory(v):auditActualRegressionB(v.state,v.preparation,v.report),/Conflicting regression source payload/);
});
for(const [label,corrupt]of[
  ['missing persisted task',v=>{v.state.tasks=v.state.tasks.filter(t=>t.id!=='review-source-task');}],
  ['foreign persisted task mission',v=>{v.state.tasks.find(t=>t.id==='review-source-task').mission_id=uuid(99);}],
  ['duplicate persisted task ID',v=>{v.state.tasks.push(clone(v.state.tasks.find(t=>t.id==='review-source-task')));}],
  ['duplicate immutable task ID',v=>{v.state.reportBindings[0].snapshot_tasks.push(clone(v.state.reportBindings[0].snapshot_tasks[1]));}],
  ['foreign immutable mission',v=>{v.state.reportBindings[0].snapshot_mission_id=uuid(99);}],
  ['foreign immutable workspace',v=>{v.state.reportBindings[0].snapshot_workspace_id=uuid(99);}],
])test('source occurrence rejects '+label,()=>{
  const v=value();duplicateSources(v.state);corrupt(v);
  assert.throws(()=>boundRegressionSource(v.state,v.state.reportBindings[0],v.state.runs[0].id));
});
test('B revalidates every original A source occurrence instead of taking the first',()=>{
  const v=comparison();duplicateSources(v.preparation.final);
  v.preparation.final.reportBindings[0].snapshot_tasks[1].sources[0].summary='Conflicting old source';
  assert.throws(()=>auditActualRegressionB(v.state,v.preparation,v.report),/Conflicting regression source payload/);
});
test('B rejects historical A context copied without binding to its real B parent',()=>{
  const v=comparison();v.state.reportBindings[0].snapshot_tasks[0].sources[0].context=clone(v.preparation.final.reportBindings[0].snapshot_tasks[0].sources[0].context);
  assert.throws(()=>auditActualRegressionB(v.state,v.preparation,v.report),/Source context/);
});
