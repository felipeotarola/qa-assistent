import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { registerHooks } from 'node:module';
import { missionAdmissionSchema, missionIntakeAdmissionSchema, missionControlActionSchema, missionSourceRefSchema } from '../shared/mission-control.ts';
import { reportSelectionDiagnosticSchema, testRunReportSource } from '../shared/report-selection.ts';
const request = extra => ({requestId:randomUUID(),intent:'report_only',goal:'Summarize explicitly selected saved sources',...extra});

test('definition alias is intake-only and cannot widen stored source or execution contracts',()=>{
  const ref={type:'plan_definition',id:randomUUID()}, input=request({sourceRefs:[ref]});
  assert.deepEqual(missionIntakeAdmissionSchema.parse(input).sourceRefs,[ref]);
  assert.equal(missionControlActionSchema.parse({action:'accept',...input}).sourceRefs[0].type,'plan_definition');
  assert.equal(missionAdmissionSchema.safeParse(input).success,false);
  assert.equal(missionSourceRefSchema.safeParse(ref).success,false);
  for(const intent of ['explore','verify','regression']) assert.equal(missionIntakeAdmissionSchema.safeParse({...input,intent,target:{kind:'public_url',url:'https://example.com'}}).success,false);
});
test('duplicate aliases and extra model fields cannot be hidden by normalization',()=>{
  const id=randomUUID();
  for(const refs of [[{type:'plan_definition',id},{type:'material',id}],[{type:'plan_definition',id},{type:'plan_definition',id}],[{type:'plan_definition',id,runId:randomUUID()}]])
    assert.equal(missionIntakeAdmissionSchema.safeParse(request({sourceRefs:refs})).success,false);
});
test('normal test/material/research/repository refs retain exact IDs with no prose inference',()=>{
  const sourceRefs=['test','material','research','repository'].map(type=>({type,id:randomUUID()}));
  const input=request({sourceRefs,goal:`Summarize ${randomUUID()}`});
  assert.deepEqual(missionIntakeAdmissionSchema.parse(input),missionAdmissionSchema.parse(input));
  const id=randomUUID(); assert.deepEqual(testRunReportSource(id),{type:'test',id});
  assert.throws(()=>testRunReportSource('invented run'));
});
test('corrective error is bounded typed metadata and excludes unknown payload fields',()=>{
  const id=randomUUID(), diagnostic={code:'REPORT_SOURCE_KIND_MISMATCH',message:'No mission created; choose the selected exact runs.',rejected:[{type:'material',id,planVersion:1}],suggestions:[{reportSource:testRunReportSource(randomUUID()),itemId:id,caseId:randomUUID(),planVersion:1}],suggestionsTruncated:false};
  assert.deepEqual(reportSelectionDiagnosticSchema.parse(diagnostic),diagnostic);
  for(const value of [{...diagnostic,secret:'private'},{...diagnostic,suggestions:Array(11).fill(diagnostic.suggestions[0])},{...diagnostic,suggestions:[{...diagnostic.suggestions[0],result:'private'}]},{...diagnostic,rejected:[{...diagnostic.rejected[0],planVersion:0}]}]) assert.equal(reportSelectionDiagnosticSchema.safeParse(value).success,false);
});

test('real qa_mission execute exposes allowlisted HTTP error details without accepted handoff; corrected selection passes unchanged',async()=>{
  const updates=[],requests=[]; globalThis.reportSelectionPureUpdates=updates;
  const hooks=registerHooks({resolve(specifier,context,next){
    if(specifier==='eve/tools')return {url:'data:text/javascript,export const defineTool = x => x;',shortCircuit:true};
    if(specifier==='eve/context')return {url:'data:text/javascript,export const defineState = () => ({update: value => globalThis.reportSelectionPureUpdates.push(value())});',shortCircuit:true};
    // Match the bundler's extensionless imports, while loading the real tool
    // dependencies. Shared modules must work without this test-only hook.
    if(context.parentURL?.endsWith('/agent/tools/qa_mission.ts') && ['../../shared/mission-control','../../shared/mission-request-context','../../shared/runtime-scope','../../shared/report-selection','../lib/internal-api','../lib/codex-turn'].includes(specifier)) return next(`${specifier}.ts`,context);
    return next(specifier,context);
  }});
  const originalFetch=globalThis.fetch,oldUrl=process.env.APP_URL,oldSecret=process.env.INTERNAL_API_SECRET;
  process.env.APP_URL='http://127.0.0.1:12345';process.env.INTERNAL_API_SECRET='synthetic-test-secret';
  const planId=randomUUID(),runId=randomUUID(),owner=randomUUID(),threadId=randomUUID();
  const diagnostic={code:'REPORT_SOURCE_KIND_MISMATCH',message:'No mission created. Select the exact saved run.',rejected:[{type:'material',id:planId,planVersion:1}],suggestions:[{reportSource:testRunReportSource(runId),itemId:planId,caseId:randomUUID(),planVersion:1}],suggestionsTruncated:false};
  globalThis.fetch=async(url,options)=>{
    assert.equal(url,'http://127.0.0.1:12345/api/internal/autonomy');assert.equal(options.headers.authorization,'Bearer synthetic-test-secret');
    const body=JSON.parse(options.body);requests.push(body);
    return body.input.sourceRefs[0].type==='material'?Response.json({statusCode:400,statusMessage:'Report source kind mismatch',data:diagnostic},{status:400}):Response.json({missionId:randomUUID(),background:true});
  };
  try {
    const tool=(await import('../agent/tools/qa_mission.ts')).default;
    const nonce=randomUUID();
    const ctx={session:{id:randomUUID(),auth:{current:{authenticator:'app',principalId:owner,attributes:{browserThreadId:threadId,browserUserInput:JSON.stringify({version:1,nonce,textSha256:'a'.repeat(64)})}}},turn:{id:'turn_0'}},callId:'same-call',abortSignal:new AbortController().signal};
    const input={intent:'report_only',sourceRefs:[{type:'material',id:planId}]};
    const rejected=await tool.execute(tool.inputSchema.parse(input),ctx);
    assert.equal(rejected.accepted,false);assert.deepEqual(rejected.selectionError,diagnostic);assert.equal(updates.length,0);
    const corrected=await tool.execute(tool.inputSchema.parse({...input,sourceRefs:[testRunReportSource(runId)]}),ctx);
    assert.ok(corrected.missionId);assert.equal(updates.length,1);assert.deepEqual(requests[1].input.sourceRefs,[testRunReportSource(runId)]);
    assert.equal(requests[0].input.requestId,requests[1].input.requestId);assert.equal(requests[1].input.goal,undefined);assert.equal(requests[1].requestContext.nonce,nonce);assert.equal(requests[1].requestContext.turnId,ctx.session.turn.id);
    globalThis.fetch=async()=>Response.json({statusMessage:'Denied',data:{...diagnostic,secret:'PRIVATE'}},{status:403});
    await assert.rejects(tool.execute(tool.inputSchema.parse(input),ctx),/Denied/);assert.equal(updates.length,1);
  } finally {
    globalThis.fetch=originalFetch;for(const [key,value] of [['APP_URL',oldUrl],['INTERNAL_API_SECRET',oldSecret]]) if(value===undefined)delete process.env[key];else process.env[key]=value;
    hooks.deregister();delete globalThis.reportSelectionPureUpdates;
  }
});
