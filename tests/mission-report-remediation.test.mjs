import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { reportRemediation, reportEvidenceAvailability, reportObservationOrigin, reportSummary } from '../shared/mission-report-remediation.ts';
import { missionReportOutput } from '../shared/mission-report-output.ts';
import { assembleReport, validateReport, reportText } from '../shared/mission-report.ts';
import { missionReportWriterContext } from '../shared/mission-report-context.ts';

function fixture() {
  const text = 'A saved observation', digest = createHash('sha256').update(text).digest('hex');
  const target = { environment: 'QA', url: 'https://unit.example.test', revision: 'A' };
  const source = { schemaVersion: 2, sourceType: 'test', sourceId: 'run', target, status: 'completed', startedAt: '2026-10-06T00:00:00Z', finishedAt: '2026-10-06T00:01:00Z',
    evidence: [{ id: 'evidence', kind: 'text', origin: 'tool', evidencePolicyVersion: 2, observedAt: '2026-10-06T00:00:30Z', provenance: { version: 1, origin: 'tool', producer: 'browser-action', sourceType: 'test', sourceId: 'run', observedAt: '2026-10-06T00:00:30Z', sha256: digest } }] };
  const snapshot = { schemaVersion: 2, config: { title: 'Report', goal: 'Inspect saved evidence', scope: 'Saved sources', target, criteria: [{ id: 'c', text: 'Inspect the exact saved source', delivery: { kind: 'source', sourceTypes: ['test'], sourceRefs: [{ type: 'test', id: 'run' }] } }] },
    tasks: [{ id: 't', title: 'Task', actor: 'browser', parentId: null, dependsOn: [], criterionIds: ['c'], sources: [source] }], delivery: { schemaVersion: 3, complete: true, criteria: [{ criterionId: 'c', complete: true, gaps: [] }], cases: [], gaps: [] }, tests: [{ key: 'item:case', runId: 'run', originalOutcome: 'failed', status: 'failed' }], metrics: [], gaps: [] };
  return { snapshot, source, reads: new Map([['evidence', { id: 'evidence', text, digest }]]) };
}
function gap(f, code) { f.snapshot.delivery.complete = false; f.snapshot.delivery.criteria[0] = { criterionId: 'c', complete: false, gaps: [{ code }] }; }
const remediation = (f, verdict = 'needs_evidence') => reportRemediation(f.snapshot, 'c', verdict, f.reads);

test('exact agent-note source remains unmet even with another valid run and full text', () => {
  const f = fixture(), note = { ...f.source, sourceType: 'material', sourceId: 'note', evidence: [{ id: 'note-e', kind: 'text', origin: 'agent', evidencePolicyVersion: 2, provenance: { version: 1, origin: 'agent', producer: 'agent-authored', observedAt: null } }] };
  f.snapshot.tasks[0].sources.push(note); f.snapshot.config.criteria[0].delivery.sourceRefs.push({ type: 'material', id: 'note' });
  f.snapshot.config.criteria[0].delivery.sourceTypes.push('material'); f.reads.set('note-e', { id: 'note-e', text: 'Agent claims success' });
  const result = remediation(f);
  assert.ok(result.reasons.includes('evidence_unattested'));
  assert.ok(result.actions.some(action => action.kind === 'obtain_independent_observation' && action.requiresNewMandate && action.scope === 'new_mandate'));
  assert.match(result.completionStatement, /inte fullt underbyggt/); assert.match(result.nextStep, /uppfyller inte detta originalurval/);
  assert.match(reportObservationOrigin(f.snapshot, 'c', ['note-e'], f.reads), /Agentpåstående/);
});
test('target exclusion and failed reading coexist without claiming a missing file or a sufficient retry', () => {
  const f = fixture(); f.source.target = { ...f.source.target, revision: 'B' }; f.reads.set('evidence', { id: 'evidence', unavailable: true }); gap(f, 'target_mismatch');
  const result = remediation(f);
  assert.ok(result.reasons.includes('target_mismatch')); assert.ok(result.actions.some(action => action.kind === 'establish_target_identity'));
  assert.match(result.nextStep, /oföränderlig insamlingsmetadata/); assert.ok(result.reasons.includes('read_unavailable'));
  assert.ok(result.actions.some(action => action.kind === 'restore_readable_evidence'));
  const counts = reportEvidenceAvailability(f.snapshot, f.reads); assert.equal(counts.unavailable, 1); assert.equal(counts.policyExcluded, 1);
});
test('read omissions and failures are different from acquisition and never mutate source identity', () => {
  for (const [read, kind, reason] of [[null, 'review_existing_evidence', 'read_omitted'], [{ limited: true }, 'review_existing_evidence', 'read_limited'], [{ unavailable: true }, 'restore_readable_evidence', 'read_unavailable']]) {
    const f = fixture(), before = JSON.stringify(f.snapshot); f.reads.clear(); if (read) f.reads.set('evidence', { id: 'evidence', ...read });
    const result = remediation(f); assert.ok(result.actions.some(action => action.kind === kind)); assert.ok(result.reasons.includes(reason));
    assert.equal(JSON.stringify(f.snapshot), before); assert.equal(result.actions.some(action => action.requiresNewEvidence), false);
  }
});
test('stale exact source differs from original case criterion and complete negative QA needs no rerun', () => {
  const f = fixture(); gap(f, 'run_stale'); assert.equal(remediation(f).actions.find(a => a.kind === 'rerun_current_case').requiresNewMandate, true);
  f.snapshot.config.criteria[0].delivery = { kind: 'test_cases', caseKeys: ['item:case'] }; f.snapshot.delivery.cases = [{ caseKey: 'item:case', runId: 'run' }];
  assert.equal(remediation(f).actions.find(a => a.kind === 'rerun_current_case').requiresNewMandate, false);
  const complete = fixture(); assert.deepEqual(remediation(complete, 'supported').actions, []); assert.equal(remediation(complete, 'supported').nextStep, '');
});
test('shared source counts deduplicate and unrelated read receipts cannot create known completeness', () => {
  const f = fixture(); f.snapshot.config.criteria.push({ ...f.snapshot.config.criteria[0], id: 'other' }); f.snapshot.tasks[0].criterionIds.push('other');
  f.reads.set('foreign', { id: 'foreign', text: 'Must not count' }); assert.equal(reportEvidenceAvailability(f.snapshot, f.reads).registered, 1); assert.equal(reportEvidenceAvailability(f.snapshot, f.reads).fullyRead, 1);
  f.source.target = { ...f.source.target, revision: 'B' }; const summary = reportSummary(f.snapshot, [{ verdict: 'needs_evidence' }], f.reads);
  assert.match(summary, /1 av 1 referenser lästes fullständigt/); assert.match(summary, /betyder inte att filerna är oläsbara/);
});
test('summary counts only required saved runs and never doubles one run across criteria or target rows', () => {
  const f = fixture(); f.snapshot.tests.push({ runId: 'foreign', key: 'foreign:case', originalOutcome: 'passed' }, { ...f.snapshot.tests[0], key: 'another-projection' });
  f.snapshot.config.criteria.push({ ...f.snapshot.config.criteria[0], id: 'other' }); f.snapshot.tasks[0].criterionIds.push('other');
  const summary = reportSummary(f.snapshot, [{ verdict: 'supported' }, { verdict: 'supported' }], f.reads);
  assert.match(summary, /0 godkända, 1 misslyckade och 0 övriga/);
  assert.match(summary, /1 av 1 referenser/);
});
test('new wire rejects legacy free prose and omitted or cross-criterion observation citations', () => {
  const f = fixture(), output = missionReportOutput(f.snapshot, f.reads);
  const current = { findings: [{ criterionId: 'c', verdict: 'supported', observations: [{ text: 'Observed saved failure', evidenceIds: ['evidence'] }] }] };
  assert.deepEqual(output.schema.parse(current), current);
  for (const extra of ['summary', 'limitations', 'nextStep', 'conclusion']) assert.equal(output.schema.safeParse({ ...current, [extra]: 'Injected old wire' }).success, false);
  assert.equal(output.schema.safeParse({ findings: [{ ...current.findings[0], observations: [{ text: 'Bad', evidenceIds: ['foreign'] }] }] }).success, false);
  f.reads.clear(); const empty = missionReportOutput(f.snapshot, f.reads).schema;
  assert.equal(empty.safeParse(current).success, false); assert.ok(empty.safeParse({ findings: [{ criterionId: 'c', verdict: 'needs_evidence', observations: [] }] }).success);
});
test('assembly owns status and advice while real observations remain prominent in reportText', () => {
  const f = fixture(), draft = { summary: 'Old uncontrolled summary', limitations: [], findings: [{ criterionId: 'c', verdict: 'supported', conclusion: 'Old unsupported completion prose', nextStep: 'Shrink scope', evidenceIds: ['evidence'], observations: [{ text: 'The observed endpoint returned a failure.', evidenceIds: ['evidence'] }] }] };
  const valid = validateReport(f.snapshot, draft, new Set(f.reads.keys()), f.reads), report = assembleReport(f.snapshot, valid, new Set(f.reads.keys()), f.reads);
  assert.equal(report.findings[0].nextStep, ''); assert.notEqual(report.summary, draft.summary); assert.notEqual(report.findings[0].conclusion, draft.findings[0].conclusion);
  assert.match(reportText(report), /The observed endpoint returned a failure/); assert.match(report.findings[0].observations[0].originLabel, /oberoende verktygsunderlag/);
  assert.throws(() => validateReport(f.snapshot, { ...draft, findings: [{ ...draft.findings[0], observations: [{ text: 'Unbound', evidenceIds: ['foreign'] }] }] }, new Set(f.reads.keys()), f.reads), /outside the finding/);
});

test('source-scoped setup and research limitations stay scoped while the concrete target stays unchanged', () => {
  const f = fixture();
  f.snapshot.gaps = ['Research research:discovery: Observerad version saknas.', 'Prepare setup:prepare: Identitetskontrollen verifierar commit; appstart är inte verifierad.'];
  const draft = { summary: 'All relevant sources have no version.', limitations: [], findings: [{ criterionId: 'c', verdict: 'supported', conclusion: 'Unsupported global conclusion', nextStep: '', evidenceIds: ['evidence'], observations: [{ text: 'The cited saved run reports HTTP failure.', evidenceIds: ['evidence'] }] }] };
  const report = assembleReport(f.snapshot, draft, new Set(f.reads.keys()), f.reads);
  assert.deepEqual(report.limitations, f.snapshot.gaps);
  assert.equal(report.target, 'QA · https://unit.example.test · A');
  assert.ok(!report.summary.includes('All relevant sources'));
  assert.ok(report.limitations.every(value => value.includes('research:discovery') || value.includes('setup:prepare')));
});

test('writer context deduplicates shared sources and unions criterion bindings without multiplying large claims', () => {
  const f = fixture(); f.source.claims = [{ id: 'expected', requirement: 'Inspect original requirement', reportedActual: 'A'.repeat(12000) }];
  f.snapshot.tasks = Array.from({ length: 20 }, (_, i) => ({ id: `task-${i}`, criterionIds: [`criterion-${i}`], sources: [{ ...f.source, context: { taskId: `task-${i}` } }] }));
  const before = JSON.stringify(f.snapshot), context = missionReportWriterContext(f.snapshot, new Set(f.reads.keys()));
  assert.equal(context.sources.length, 1); assert.equal(context.sources[0].criterionIds.length, 20);
  assert.equal(context.sources[0].reportedClaims.items[0].reportedActual.length, 12000);
  assert.ok(JSON.stringify(context).length < 16000, 'One physical source must not become 240k of duplicated context');
  assert.equal(JSON.stringify(f.snapshot), before);
});

test('writer source dedup never merges changed versions, targets, claims or omitted evidence identities', () => {
  const f = fixture(); f.source.sourceRevision = 'source-v1'; f.source.claims = [{ id: 'expected', reportedActual: 'Original claim' }];
  f.source.evidence.push({ ...f.source.evidence[0], id: 'unread', hash: 'original-unread' });
  f.snapshot.tasks[0].sources.push(
    { ...f.source, sourceRevision: 'source-v2' },
    { ...f.source, target: { ...f.source.target, revision: 'B' } },
    { ...f.source, claims: [{ id: 'expected', reportedActual: 'Different claim' }] },
    { ...f.source, evidence: [f.source.evidence[0], { ...f.source.evidence[1], hash: 'changed-unread' }] },
  );
  const context = missionReportWriterContext(f.snapshot, new Set(f.reads.keys()));
  assert.equal(context.sources.length, 5); assert.ok(context.sources.every(source => source.evidence.length === 1));
  assert.ok(context.sources.some(source => source.sourceRevision === 'source-v2'));
});
