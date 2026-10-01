import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
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
