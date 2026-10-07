import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
// Synthetic legacy test descriptions map to the current model wire only.
// These fixtures test contracts; they do not certify a real model's semantics.
const partsRow = ({ relation, text, evidenceIds, ...identity }) => ({ ...identity, text, coverage: 'complete', parts: [{ text, evidenceIds, relation, basis: 'other' }] });


const hooks = registerHooks({ resolve(specifier, context, next) {
  if (specifier.startsWith('.') && context.parentURL?.startsWith('file:')) {
    const url = new URL(`${specifier}.ts`, context.parentURL);
    if (existsSync(fileURLToPath(url))) return { url: url.href, shortCircuit: true };
  }
  return next(specifier, context);
} });
const { writeMissionReport } = await import('../agent/lib/mission-reporter.ts');
const { missionReportCheckSubjects } = await import('../shared/mission-report-context.ts');
const { validateReport, assembleReport, reportObservationText } = await import('../shared/mission-report.ts');
const { REVIEWER_VERSION } = await import('../shared/result-assessment.ts');
const { missionReportOutput } = await import('../shared/mission-report-output.ts');
const { DELIVERY_POLICY_VERSION } = await import('../shared/mission-delivery.ts');
hooks.deregister();

function fixture() {
  const text = 'The Update action was performed; the displayed status remained Pending instead of becoming Complete.';
  const digest = createHash('sha256').update(text).digest('hex');
  const target = { environment: 'isolated unit', url: 'https://unit.example.test/', revision: 'fixed' };
  const source = { schemaVersion: 2, sourceType: 'test', sourceId: 'saved-run', sourceRevision: 'source-version', attemptId: 'saved-run', status: 'completed', target,
    startedAt: '2026-10-06T00:00:00Z', finishedAt: '2026-10-06T00:01:00Z',
    claims: [{ id: 'step-1', requirement: 'Click Update; status becomes Complete.', reportedStatus: 'mismatch', reportedActual: text }],
    evidence: [{ id: 'proof', kind: 'text', title: 'Saved action', hash: digest, origin: 'tool', evidencePolicyVersion: 2,
      observedAt: '2026-10-06T00:00:30Z', provenance: { version: 1, origin: 'tool', producer: 'browser-action', sourceType: 'test', sourceId: 'saved-run', observedAt: '2026-10-06T00:00:30Z', sha256: digest } }],
  };
  const snapshot = { schemaVersion: 2, missionId: 'mission', workspaceId: 'workspace', revision: 4, inputFingerprint: 'immutable-input',
    config: { title: 'Saved QA', goal: 'Summarize the saved action results.', scope: 'No new execution', target, caseKeys: [], criteria: [{ id: 'c', text: 'Review the exact saved result and state what it establishes.', delivery: { kind: 'source', sourceTypes: ['test'], sourceRefs: [{ type: 'test', id: 'saved-run' }] } }] },
    tasks: [{ id: 'task', title: 'Review saved result', actor: 'main', parentId: null, dependsOn: [], criterionIds: ['c'], sources: [source] }],
    delivery: { schemaVersion: DELIVERY_POLICY_VERSION, complete: true, criteria: [{ criterionId: 'c', complete: true, gaps: [] }], cases: [], gaps: [] },
    tests: [{ key: 'source:saved-run', runId: 'saved-run', originalOutcome: 'failed', status: 'failed' }], metrics: [], gaps: [],
  };
  return { snapshot, source, reads: new Map([['proof', { id: 'proof', text, digest }]]) };
}

function wire(f, text='Saved action result.') {
  const checks = missionReportCheckSubjects(f.snapshot,new Set(f.reads.keys()));
  return {checkAssessments:[...checks].filter(([,c])=>c.evidenceIds.length).map(([checkRef,c])=>partsRow({checkRef,relation:'unresolved',text,evidenceIds:[c.evidenceIds[0]]})),
    findings:f.snapshot.config.criteria.map(c=>({criterionId:c.id,verdict:'needs_evidence',factualNotes:[]}))};
}
function multiply(f,count) {const check=f.source.claims[0];f.source.claims=Array.from({length:count},(_,i)=>({...check,id:'check-'+i,requirement:'Original immutable requirement '+i}));return f;}
function validate(f,value) {return validateReport(f.snapshot,missionReportOutput(f.snapshot,f.reads).toDraft(value),new Set(f.reads.keys()),f.reads);}
function duplicateSource(f,id,count) {
 const source=structuredClone(f.source);source.sourceId=id;source.sourceRevision=id;source.attemptId=id;
 source.claims=source.claims.slice(0,count);source.evidence=source.evidence.map(e=>({...e,id:id+'-proof',provenance:{...e.provenance,sourceId:id}}));
 f.snapshot.tasks[0].sources.push(source);f.snapshot.config.criteria[0].delivery.sourceRefs.push({type:'test',id});return source;
}
test('17 original checks are exact coverage in wire and final assembly; old observations and partial sets cannot replace it',()=>{
 const f=multiply(fixture(),17),good=wire(f),output=missionReportOutput(f.snapshot,f.reads),draft=validate(f,good);
 assert.equal(draft.findings[0].observations.length,17);assert.equal(assembleReport(f.snapshot,draft,new Set(f.reads.keys()),f.reads).findings[0].observations.length,17);
 for(const change of [x=>x.checkAssessments.pop(),x=>x.checkAssessments.push(x.checkAssessments[0]),x=>x.checkAssessments[1]=x.checkAssessments[0],x=>x.checkAssessments[0].checkRef=null,x=>x.checkAssessments[0].checkRef='foreign',x=>{delete x.checkAssessments;x.findings[0].observations=[{text:'Claim all checked',evidenceIds:['proof']}];}]) {
  const x=structuredClone(good);change(x);assert.equal(output.schema.safeParse(x).success,false);
 }
 for(const change of [x=>x.findings[0].observations.pop(),x=>x.findings[0].observations.push(x.findings[0].observations[0]),x=>delete x.findings[0].observations[0].subject,x=>x.findings[0].observations=[]]) {
  const x=structuredClone(draft);change(x);assert.throws(()=>validateReport(f.snapshot,x,new Set(f.reads.keys()),f.reads));assert.throws(()=>assembleReport(f.snapshot,x,new Set(f.reads.keys()),f.reads));
 }
});
test('shared checks require one assessment, render a visible reference for the other criterion and retain its citation fence',()=>{
 const f=multiply(fixture(),17);f.snapshot.config.criteria.push({...f.snapshot.config.criteria[0],id:'second',text:'Second original criterion'});f.snapshot.delivery.criteria.push({criterionId:'second',complete:true,gaps:[]});
 f.snapshot.tasks.push({...f.snapshot.tasks[0],id:'task2',criterionIds:['second'],sources:[structuredClone(f.source)]});
 const good=wire(f);assert.equal(good.checkAssessments.length,17);const draft=validate(f,good),doc=assembleReport(f.snapshot,draft,new Set(f.reads.keys()),f.reads);
 assert.equal(draft.findings[1].observations.length,0);assert.deepEqual(draft.findings[1].evidenceIds,['proof']);
 assert.equal(doc.findings[1].observations.length,17);assert.ok(doc.findings[1].observations.every(o=>o.originLabel==='Delad kontrollpunktsbedömning'&&o.text.includes(f.snapshot.config.criteria[0].text)&&o.evidenceIds.includes('proof')));
 const forged=structuredClone(draft);forged.findings[1].evidenceIds=[];assert.throws(()=>validateReport(f.snapshot,forged,new Set(f.reads.keys()),f.reads),/Shared check/);
});
test('unread, unavailable and limited sources remain separately unassessed and do not consume the 32 model-row capacity',()=>{
 const f=multiply(fixture(),32);const missing=duplicateSource(f,'unread',32),unavailable=duplicateSource(f,'unavailable',32),limited=duplicateSource(f,'limited',32);
 f.reads.set(unavailable.evidence[0].id,{id:unavailable.evidence[0].id,unavailable:true});f.reads.set(limited.evidence[0].id,{id:limited.evidence[0].id,text:'part',limited:true});
 const output=missionReportOutput(f.snapshot,f.reads);assert.equal(output.criteria[0].checkRefs.length,32);
 const value=wire(f);value.checkAssessments=value.checkAssessments.filter(row=>row.parts[0].evidenceIds[0]==='proof');const draft=validate(f,value),doc=assembleReport(f.snapshot,draft,new Set(['proof']),f.reads);
 assert.equal(doc.findings[0].observations.length,128);const texts=doc.findings[0].observations.filter(o=>o.originLabel.startsWith('Systemstatus')).map(o=>o.text);
 assert.ok(texts.some(t=>t.includes('ej lästa: 1; otillgängliga vid läsning: 0')));assert.ok(texts.some(t=>t.includes('ej lästa: 0; otillgängliga vid läsning: 1')));assert.ok(texts.some(t=>t.includes('begränsade utdrag: 1')));assert.ok(doc.findings[0].observations.some(o=>o.text.includes(missing.claims[0].requirement)));
});
test('fact notes cannot carry assessments or replace rows; row and total text budgets are hard and code requirements do not consume them',()=>{
 const f=multiply(fixture(),17),output=missionReportOutput(f.snapshot,f.reads),value=wire(f);
 for(const notes of [[{checkRef:value.checkAssessments[0].checkRef,relation:'supports',text:'x',evidenceIds:['proof']}],Array.from({length:3},()=>({text:'x',evidenceIds:['proof']})),[{text:'x'.repeat(301),evidenceIds:['proof']}]]){const x=structuredClone(value);x.findings[0].factualNotes=notes;assert.equal(output.schema.safeParse(x).success,false);}
 assert.equal(output.schema.safeParse(wire(f,'x'.repeat(240))).success,false,'17 x 240 exceeds 4000 total');
 assert.equal(output.schema.safeParse(wire(f,'x'.repeat(241))).success,false);
 const boundary=wire(f);boundary.checkAssessments.forEach((r,i)=>r.text='x'.repeat(i===16?160:240));assert.equal(boundary.checkAssessments.reduce((n,r)=>n+r.text.length,0),4000);assert.ok(output.schema.safeParse(boundary).success);
 boundary.checkAssessments[16].text+='x';assert.equal(output.schema.safeParse(boundary).success,false);
 const draft=validate(f,value);draft.findings[0].observations[0].text='x'.repeat(241);assert.throws(()=>validateReport(f.snapshot,draft,new Set(f.reads.keys()),f.reads),/text capacity/);
});
test('32/33 limit uses real reader results and zero calls on overflow; no partial subset, new requirements or implicit retry',async()=>{
 const f=multiply(fixture(),33), previousFetch=globalThis.fetch,previousKey=process.env.GRUNDEN_API_TOKEN;let calls=0,reads=0,usage;
 process.env.GRUNDEN_API_TOKEN='synthetic';globalThis.fetch=()=>{calls++;throw new Error('No model call permitted');};
 try {const result=await writeMissionReport(f.snapshot,async id=>{reads++;return f.reads.get(id);},AbortSignal.timeout(5000),{onUsage:value=>usage=value});assert.equal(calls,0);assert.equal(reads,1);assert.equal(usage.providerCalls,0);assert.equal(result.usage.totalTokens,0);assert.equal(result.draft.findings[0].observations.length,0);
 const doc=assembleReport(f.snapshot,validateReport(f.snapshot,result.draft,new Set(f.reads.keys()),f.reads),new Set(f.reads.keys()),f.reads);assert.equal(doc.partial,true);assert.equal(doc.findings[0].observations.length,33);assert.ok(doc.findings[0].completionStatement.includes('Gränsen är 32'));assert.equal(doc.findings[0].verdict,'needs_evidence');assert.ok(doc.findings[0].observations.every(o=>o.originLabel.startsWith('Systemstatus')));
 const forged=structuredClone(result.draft);forged.findings[0].verdict='supported';assert.throws(()=>validateReport(f.snapshot,forged,new Set(f.reads.keys()),f.reads));
 }finally{globalThis.fetch=previousFetch;if(previousKey===undefined)delete process.env.GRUNDEN_API_TOKEN;else process.env.GRUNDEN_API_TOKEN=previousKey;}
});
test('selected case and explicit source criteria exclude unrelated older checks even on the same target',()=>{
 const f=fixture(),other=duplicateSource(f,'older',1);f.snapshot.config.criteria[0].delivery={kind:'test_cases',caseKeys:['current']};f.snapshot.delivery.cases=[{caseKey:'current',runId:'saved-run',complete:true}];f.reads.set(other.evidence[0].id,{...f.reads.get('proof'),id:other.evidence[0].id});
 const output=missionReportOutput(f.snapshot,f.reads);assert.equal(output.criteria[0].checkRefs.length,1);assert.ok(!output.criteria[0].checkRefs[0].includes('older'));
});
test('redaction expansion happens after validating generated text; it cannot disclose raw text or consume generation budget',()=>{
 const f=fixture(),value=wire(f,'x'.repeat(240)),draft=validate(f,value);
 const doc=assembleReport(f.snapshot,draft,new Set(f.reads.keys()),f.reads,text=>text.replaceAll('x','[REDACTED]'));
 assert.equal(doc.findings[0].observations[0].text,'[REDACTED]'.repeat(240));
 assert.equal(draft.findings[0].observations[0].text,'x'.repeat(240),'Assembly does not mutate the validated draft');
 const invalid=structuredClone(draft);invalid.findings[0].observations[0].text+='x';
 assert.throws(()=>assembleReport(f.snapshot,invalid,new Set(f.reads.keys()),f.reads,text=>text.replaceAll('x','')),/text capacity/,'Redaction cannot rescue oversized generated text');
});

function reviewedFixture(count = 1) {
 const f = multiply(fixture(), count), runId = '10000000-0000-4000-8000-000000000001';
 f.source.sourceId = runId; f.source.attemptId = runId; f.source.sourceRevision = 'a'.repeat(64);
 f.source.evidence[0].provenance.sourceId = runId;
 f.snapshot.config.criteria[0].delivery.sourceRefs[0].id = runId;
 f.snapshot.tests[0].runId = runId;
 f.source.assessment = { id: '10000000-0000-4000-8000-000000000002', status: 'completed', finishedAt: '2026-10-06T00:02:00Z', stale: false,
  reviewerVersion: REVIEWER_VERSION, sourceHash: 'b'.repeat(64), inputHash: 'c'.repeat(64), summary: 'The saved negative result is supported.', verdict: 'supported',
  findings: f.source.claims.map(c => ({ requirementId: c.id, verdict: 'supported', explanation: 'The Update action occurred but the status remained Pending.', evidenceIds: ['proof'], suggestedNextStep: '', gap: null })) };
 return f;
}
function savedWire(f, verdict = 'supported') {
 const output = missionReportOutput(f.snapshot, f.reads), ordinary = wire(f);
 ordinary.checkAssessments = ordinary.checkAssessments.filter(row => output.requiredCheckRefs.includes(row.checkRef));
 ordinary.findings.forEach(row => row.verdict = verdict);
 return ordinary;
}

test('saved review regression: another same-run check text/citation cannot replace a current reviewed check', () => {
 const f = reviewedFixture(2), second = { ...f.source.evidence[0], id: 'return-proof', hash: createHash('sha256').update('The return click reached the original page.').digest('hex') };
 second.provenance = { ...second.provenance, sha256: second.hash };
 f.source.evidence.push(second); f.reads.set(second.id, { id: second.id, text: 'The return click reached the original page.', digest: second.hash });
 f.source.claims[1] = { ...f.source.claims[1], requirement: 'Use the return control to reach the original page.', reportedStatus: 'verified', reportedActual: 'The return click reached the original page.' };
 f.source.assessment.findings[1] = { ...f.source.assessment.findings[1], explanation: 'The return control reached the original page.', evidenceIds: ['return-proof'] };
 const wrong = wire(f);
 wrong.checkAssessments[1] = partsRow({ checkRef: wrong.checkAssessments[1].checkRef, relation: 'supports', text: f.source.claims[0].reportedActual, evidenceIds: ['proof'] });
 assert.equal(missionReportOutput(f.snapshot, f.reads).schema.safeParse(wrong).success, false, 'Baseline accepted the wrong same-run check mapping; current saved rows are code-owned');
 const draft = validate(f, savedWire(f)), before = structuredClone(f.snapshot), doc = assembleReport(f.snapshot, draft, new Set(f.reads.keys()), f.reads);
 assert.equal(draft.findings[0].observations.length, 0);
 assert.deepEqual(doc.findings[0].observations.map(o => o.evidenceIds), [['proof'], ['return-proof']]);
 assert.deepEqual(doc.findings[0].observations.map(o => o.subject.requirement), f.source.claims.map(c => c.requirement));
 assert.deepEqual(doc.findings[0].observations.map(o => o.savedReview.reportedActual), f.source.claims.map(c => c.reportedActual));
 assert.deepEqual(doc.findings[0].observations.map(o => o.savedReview.finding.explanation), f.source.assessment.findings.map(c => c.explanation));
 assert.equal(doc.tests[0].originalOutcome, 'failed'); assert.equal(doc.partial, false); assert.deepEqual(f.snapshot, before);
 const forged = structuredClone(draft); forged.findings[0].observations.push({ text: 'Wrong substitute', evidenceIds: ['proof'], subject: { checkRef: wrong.checkAssessments[0].checkRef, relation: 'supports' } });
 assert.throws(() => validateReport(f.snapshot, forged, new Set(f.reads.keys()), f.reads), /code-owned/);
 const injected = structuredClone(draft); injected.findings[0].observations.push({ text: 'Injected review', evidenceIds: ['proof'], savedReview: doc.findings[0].observations[0].savedReview });
 assert.throws(() => validateReport(f.snapshot, injected, new Set(f.reads.keys()), f.reads));
});

test('saved review adoption requires completed current identity and every source-local fully-read citation', () => {
 assert.equal(missionReportOutput(reviewedFixture().snapshot, reviewedFixture().reads).requiredCheckRefs.length, 0);
 for (const change of [
  f => { f.source.assessment.status = 'failed'; }, f => { delete f.source.assessment.status; }, f => { f.source.assessment.finishedAt = null; },
  f => { f.source.assessment.stale = true; }, f => { delete f.source.assessment.stale; }, f => { f.source.assessment.reviewerVersion = 'old'; },
  f => { delete f.source.assessment.inputHash; }, f => { f.source.assessment.sourceHash = 'invalid'; }, f => { f.source.assessment.id = 'invalid'; },
  f => { f.source.finishedAt = null; }, f => { f.source.status = 'running'; },
  f => { f.source.assessment.findings[0].requirementId = 'other'; }, f => { f.source.assessment.findings.push(f.source.assessment.findings[0]); },
  f => { f.source.assessment.findings[0].evidenceIds = ['foreign']; }, f => { f.source.assessment.findings[0].evidenceIds = ['proof', 'proof']; },
  f => { f.source.evidence.push({ ...f.source.evidence[0], id: 'alias', itemId: 'proof' }); },
  f => { f.source.evidence[0].provenance.sourceId = 'other-run'; }, f => { f.source.evidence[0].origin = 'agent'; },
  f => { f.source.claims[0].reportedStatus = 'unverified'; },
  f => { f.source.evidence.push({ ...f.source.evidence[0], id: 'unread' }); f.source.assessment.findings[0].evidenceIds.push('unread'); },
  f => { f.reads.get('proof').limited = true; }, f => { f.reads.get('proof').unavailable = true; },
 ]) {
  const f = reviewedFixture(); change(f); const output = missionReportOutput(f.snapshot, f.reads);
  assert.equal(output.savedChecks.length, 0, change.toString());
 }
 const conflict = reviewedFixture(); const copy = structuredClone(conflict.source); copy.assessment.status = 'failed'; conflict.snapshot.tasks[0].sources.push(copy);
 assert.throws(() => missionReportOutput(conflict.snapshot, conflict.reads), /Conflicting saved review/);
});

test('saved negative metadata keeps original schema bounds outside new model text budgets and never changes product outcome', () => {
 const f = reviewedFixture(); f.source.claims[0].reportedActual = 'Negative actual. '.repeat(290);
 f.source.assessment.findings[0].explanation = 'Negative evidence. '.repeat(100).trim();
 f.source.assessment.findings[0].suggestedNextStep = 'Optional next action. '.repeat(40);
 const doc = assembleReport(f.snapshot, validate(f, savedWire(f)), new Set(f.reads.keys()), f.reads);
 const o = doc.findings[0].observations[0], text = reportObservationText(o);
 assert.equal(o.savedReview.reportedActual, f.source.claims[0].reportedActual); assert.equal(o.savedReview.finding.explanation, f.source.assessment.findings[0].explanation);
 assert.ok(text.includes('Sparad granskning')); assert.ok(text.includes('inte automatiskt ett godkänt produktutfall')); assert.ok(!text.includes('Läst observation:'));
 assert.equal(doc.partial, false); assert.equal(doc.tests[0].originalOutcome, 'failed');
 const tooLong = reviewedFixture(); tooLong.source.claims[0].reportedActual = 'x'.repeat(5001); assert.equal(missionReportOutput(tooLong.snapshot, tooLong.reads).savedChecks.length, 0);
 for (const verdict of ['needs_evidence', 'contradicted']) {
  const g = reviewedFixture(); g.source.assessment.verdict = verdict; g.source.assessment.findings[0].verdict = verdict;
  g.source.assessment.findings[0].gap = verdict === 'needs_evidence' ? { kind: 'missing_observation', capability: 'browser', wantedEvidence: 'Read the changed status after Update.' } : null;
  if (verdict === 'needs_evidence') g.source.claims[0].reportedStatus = 'unverified';
  const output = missionReportOutput(g.snapshot, g.reads); assert.equal(output.savedChecks.length, 1); assert.equal(output.schema.safeParse(savedWire(g)).success, false);
  const draft = validate(g, savedWire(g, 'needs_evidence')), document = assembleReport(g.snapshot, draft, new Set(g.reads.keys()), g.reads);
  assert.equal(document.partial, true); assert.equal(document.findings[0].observations[0].savedReview.finding.verdict, verdict);
 }
});

test('31/32 saved and remaining model checks have exact unique coverage and shared criteria keep visible references', () => {
 for (const count of [31, 32]) {
  const f = reviewedFixture(count), extra = duplicateSource(f, 'other-run', 1); extra.assessment = null;
  extra.claims = count === 31 ? extra.claims : []; f.reads.set(extra.evidence[0].id, { ...f.reads.get('proof'), id: extra.evidence[0].id });
  f.snapshot.config.criteria.push({ ...structuredClone(f.snapshot.config.criteria[0]), id: 'second', text: 'Second original criterion' });
  f.snapshot.delivery.criteria.push({ criterionId: 'second', complete: true, gaps: [] });
  f.snapshot.tasks.push({ ...f.snapshot.tasks[0], id: 'task2', criterionIds: ['second'], sources: [structuredClone(f.source)] });
  const value = savedWire(f, 'needs_evidence'), output = missionReportOutput(f.snapshot, f.reads); assert.equal(output.savedChecks.length, count); assert.equal(output.requiredCheckRefs.length, 32 - count);
  const draft = validate(f, value), doc = assembleReport(f.snapshot, draft, new Set(f.reads.keys()), f.reads);
  assert.equal(doc.findings[0].observations.length, 32); assert.equal(doc.findings[1].observations.length, count);
  assert.ok(doc.findings[1].observations.every(o => o.originLabel === 'Delad sparad granskning' && o.text.includes('Originalkrav:') && o.text.includes(f.snapshot.config.criteria[0].text)));
  const forged = structuredClone(draft); forged.findings[1].evidenceIds = []; assert.throws(() => validateReport(f.snapshot, forged, new Set(f.reads.keys()), f.reads), /Saved review citation/);
 }
 const over = reviewedFixture(33); assert.throws(() => missionReportOutput(over.snapshot, over.reads), /capacity/);
});

test('saved per-check rows do not decide the separate historical/current regression conclusion', () => {
 const f = reviewedFixture(), old = structuredClone(f.source), oldId = '10000000-0000-4000-8000-000000000003', key = '10000000-0000-4000-8000-000000000004:10000000-0000-4000-8000-000000000005';
 old.sourceId = oldId; old.attemptId = oldId; old.sourceRevision = 'd'.repeat(64); old.target = { ...old.target, revision: 'old' };
 old.evidence[0] = { ...old.evidence[0], id: 'old-proof', provenance: { ...old.evidence[0].provenance, sourceId: oldId } };
 old.assessment = { ...old.assessment, id: '10000000-0000-4000-8000-000000000006', sourceHash: 'e'.repeat(64), findings: old.assessment.findings.map(row => ({ ...row, evidenceIds: ['old-proof'] })) };
 f.snapshot.tasks[0].sources.push(old); f.reads.set('old-proof', { ...f.reads.get('proof'), id: 'old-proof' });
 f.snapshot.config.criteria[0].delivery = { kind: 'regression_comparison', caseKey: key, capturedAt: '2026-10-06T01:00:00Z', baseline: { runId: oldId, sourceRevision: old.sourceRevision, startedAt: old.startedAt, finishedAt: old.finishedAt, target: old.target } };
 f.snapshot.delivery.cases = [{ caseKey: key, runId: f.source.sourceId, complete: true }];
 const output = missionReportOutput(f.snapshot, f.reads); assert.equal(output.savedChecks.length, 2); assert.equal(output.requiredCheckRefs.length, 0);
 for (const verdict of ['supported', 'needs_evidence', 'contradicted']) {
  const draft = validate(f, savedWire(f, verdict)); assert.equal(draft.findings[0].verdict, verdict);
  const doc = assembleReport(f.snapshot, draft, new Set(f.reads.keys()), f.reads); assert.equal(doc.findings[0].observations.length, 2);
  assert.deepEqual(new Set(doc.findings[0].observations.map(o => o.savedReview.binding.runId)), new Set([oldId, f.source.sourceId]));
 }
});
