import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { runResultSchema, testRunActionSchema, latestCaseRun, effectiveRunOutcome } from '../shared/test-run.ts';
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
