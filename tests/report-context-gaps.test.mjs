import { test } from 'node:test';
import assert from 'node:assert/strict';
import { missionDelivery, DELIVERY_POLICY_VERSION } from '../shared/mission-delivery.ts';
import { assessmentWithoutEvidence, REVIEWER_VERSION } from '../shared/result-assessment.ts';
import { hasCurrentReportPolicy, MISSION_REPORT_VERSION } from '../shared/mission-report.ts';
import { runChecks } from '../shared/test-run.ts';
import { EVIDENCE_RULES_VERSION, evidenceContextIssues } from '../shared/evidence-rules.ts';
import { hasTargetIdentity, sameTarget } from '../shared/test-target.ts';

// Structural replay of saved REP06 report 8fabb72d's third source: a completed
// run with actual registered, available files, but no known environment/version.
// These are declared fixtures, not a reproduction of physical model execution.
function fixture() {
  const fileId = '022e8170-9bcf-43fe-b7b2-0b85005227a1';
  const testCase = { id: 'case', title: 'Sökfält utan känd version', type: 'browser', preconditions: 'Syntetiskt sparat underlag', steps: 'Kontrollera sökfältet.', expected: 'Sökfältet visas.' };
  const checks = runChecks(testCase);
  const run = { id: 'run', workspaceId: 'workspace', itemId: 'plan', caseId: 'case', planVersion: 1, snapshot: testCase,
    target: null, environment: 'Synthetic golden QA, unknown version', startedAt: '2026-10-06T00:13:04.670Z', finishedAt: '2026-10-06T00:13:04.684Z',
    result: { schemaVersion: 2, outcome: 'inconclusive', actual: 'Ett sökfält visas, men versionen är okänd.', observations: [], evidenceItemIds: [fileId],
      checks: checks.map(check => ({ id: check.id, status: 'unverified', actual: 'Versionen är okänd.' })), remaining: checks.map(check => ({ checkId: check.id, reason: 'Versionen är okänd.' })) } };
  const evidence = { id: `item:${fileId}`, itemId: fileId, version: 1, kind: 'text', origin: 'tool', evidencePolicyVersion: 2, unavailable: false,
    observedAt: '2026-10-06T00:13:04.676Z', provenance: { version: 1, origin: 'tool', producer: 'test-capture', sourceType: 'test', sourceId: run.id, observedAt: '2026-10-06T00:13:04.676Z' } };
  const source = { schemaVersion: 2, sourceType: 'test', sourceId: run.id, attemptId: run.id, status: 'completed', target: null,
    startedAt: run.startedAt, finishedAt: run.finishedAt, evidence: [evidence, { ...evidence, id: 'capture:metadata', itemId: null, provenance: { ...evidence.provenance, producer: 'capture-metadata' } }],
    assessment: { reviewerVersion: REVIEWER_VERSION, stale: false, verdict: 'needs_evidence', findings: [] } };
  const config = { goal: 'Bedöm sparat underlag för B utan nya tester.', title: 'Sparat urval', scope: 'Report only', target: null, caseKeys: [],
    criteria: [{ id: 'qa', text: 'Granska exakt den sparade körningen.', delivery: { kind: 'source', sourceTypes: ['test'], sourceRefs: [{ type: 'test', id: run.id }] } }] };
  const item = { id: 'plan', version: 1, content: { kind: 'test_plan', cases: [testCase] } };
  const task = { id: 'report', criterionIds: ['qa'], sources: [source] };
  const reviewInput = () => ({ schemaVersion: 2, runId: run.id, workspaceId: run.workspaceId, planVersion: 1, target: run.target, environment: run.environment,
    startedAt: run.startedAt, finishedAt: run.finishedAt, reportedResult: run.result, requirements: checks.map(check => ({ id: check.id, requirement: check.text ?? check.id })),
    evidence: [{ ...evidence, id: fileId, runId: run.id, readStatus: 'read' }], ruleFindings: [] });
  return { run, source, config, task, item, reviewInput, project: () => missionDelivery([item], [run], config, [task]) };
}

test('REP06 completed available source with unknown target is not missing, unreadable or mismatched', () => {
  const f = fixture(), result = f.project(), codes = result.gaps.map(gap => gap.code);
  assert.equal(result.complete, false);
  assert.ok(codes.includes('revision_unknown')); assert.ok(codes.includes('environment_unknown')); assert.ok(codes.includes('target_unknown'));
  for (const falseClaim of ['source_missing', 'source_unavailable', 'source_incomplete', 'evidence_missing', 'evidence_unavailable', 'target_mismatch']) {
    assert.ok(!codes.includes(falseClaim), `Available unknown-target source must not become ${falseClaim}`);
  }
  assert.ok(result.gaps.every(gap => gap.sourceId === 'run'));
});

test('REP06 prerequisite requests actual unknown target fields, not already-known run identity', () => {
  const f = fixture(), original = f.reviewInput(), assessment = assessmentWithoutEvidence(original);
  assert.equal(assessment.verdict, 'needs_evidence');
  for (const finding of assessment.findings) {
    assert.equal(finding.gap.kind, 'environment_prerequisite'); assert.equal(finding.gap.capability, 'none');
    assert.match(finding.gap.wantedEvidence, /revision|observationsscope/i); assert.match(finding.gap.wantedEvidence, /miljö/i);
    assert.doesNotMatch(finding.gap.wantedEvidence, /körningsidentitet|läsbar|filen saknas/i);
  }
  assert.deepEqual(f.reviewInput(), original);
});

test('old policy projection is rejected for new report generation without altering saved history', () => {
  assert.equal(DELIVERY_POLICY_VERSION, 4); assert.equal(REVIEWER_VERSION, '19');
  assert.equal(EVIDENCE_RULES_VERSION, '5'); assert.equal(MISSION_REPORT_VERSION, '5:delivery-4:reader-2:remediation-1:judgement-8:regression-1:task-history-2:reviewed-checks-2:model-glm-5.3:output-16000');
  assert.equal(hasCurrentReportPolicy(MISSION_REPORT_VERSION.replace(':reviewed-checks-2:', ':'), { schemaVersion: 2, delivery: { schemaVersion: DELIVERY_POLICY_VERSION } }), false);
  assert.equal(hasCurrentReportPolicy('4:delivery-2', { schemaVersion: 2, delivery: { schemaVersion: 2 } }), false);
  assert.equal(hasCurrentReportPolicy('5:delivery-4:reader-2:remediation-1:judgement-1:regression-1', { schemaVersion: 2, delivery: { schemaVersion: DELIVERY_POLICY_VERSION } }), false);
  assert.equal(hasCurrentReportPolicy(MISSION_REPORT_VERSION, { schemaVersion: 2, delivery: { schemaVersion: DELIVERY_POLICY_VERSION } }), true);
});

test('actually missing source, absent evidence, unavailable evidence and unfinished source stay distinct', () => {
  for (const [mutate, expected] of [
    [f => { f.task.sources = []; }, 'source_missing'],
    [f => { f.source.evidence = []; }, 'evidence_missing'],
    [f => { f.source.evidence.forEach(e => { e.unavailable = true; }); }, 'evidence_unavailable'],
    [f => { f.source.status = 'running'; }, 'source_incomplete'],
  ]) {
    const f = fixture(); mutate(f); const result = f.project(), codes = result.gaps.map(gap => gap.code);
    assert.equal(result.complete, false); assert.ok(codes.includes(expected), expected);
    for (const unrelated of ['source_missing', 'evidence_missing', 'evidence_unavailable']) if (unrelated !== expected) assert.ok(!codes.includes(unrelated), unrelated);
  }
});

test('confirmed known mismatch remains a gap while a supported negative outcome can complete', () => {
  const f = fixture(), target = { environment: 'QA', url: 'https://example.test/', revision: 'A' };
  f.run.target = target; f.source.target = target; f.config.target = { ...target, revision: 'B' };
  assert.ok(f.project().gaps.some(gap => gap.code === 'target_mismatch'));
  assert.ok(!f.project().gaps.some(gap => gap.code === 'target_unknown'));
  f.config.target = target; f.run.result.outcome = 'failed'; f.run.result.remaining = [];
  f.run.result.checks.forEach(check => { check.status = 'mismatch'; });
  f.source.assessment = { reviewerVersion: REVIEWER_VERSION, stale: false, verdict: 'supported', findings: f.run.result.checks.map(check => ({ requirementId: check.id, verdict: 'supported', evidenceIds: [f.source.evidence[0].id] })) };
  assert.equal(f.project().complete, true); assert.equal(f.run.result.outcome, 'failed');
});

test('only actual missing context is requested by the deterministic factory', () => {
  const base = { environment: 'QA', url: 'https://example.test/', revision: 'A' };
  const f = fixture();
  f.run.target = { ...base, environment: '' };
  let wanted = assessmentWithoutEvidence(f.reviewInput()).findings[0].gap.wantedEvidence;
  assert.match(wanted, /testmiljö/); assert.doesNotMatch(wanted, /revision|körningsidentitet/);
  f.run.target = { ...base, revision: '' };
  wanted = assessmentWithoutEvidence(f.reviewInput()).findings[0].gap.wantedEvidence;
  assert.match(wanted, /revision/); assert.doesNotMatch(wanted, /miljö|körningsidentitet/);
  f.run.target = base; f.run.finishedAt = 'invalid';
  wanted = assessmentWithoutEvidence(f.reviewInput()).findings[0].gap.wantedEvidence;
  assert.match(wanted, /tidsintervall/); assert.doesNotMatch(wanted, /miljö|revision|körningsidentitet/);
});

test('context reason refinement preserves prior eligibility across target combinations', () => {
  const base = { environment: 'QA', url: 'https://example.test/', revision: 'A' };
  const scope = { kind: 'observation', id: '306e19bb-12c8-4141-8421-89417cd6e924', capturedAt: '2026-10-06T00:00:00Z' };
  const variants = [null, base, { ...base, revision: 'B' }, { ...base, environment: '' }, { ...base, revision: '' },
    { ...base, revision: '', scope }, { ...base, scope }, { ...base, revision: '', scope: { ...scope, id: 'invalid' } },
    { ...base, revision: '', environment: '', scope }, { ...base, url: 'file:///tmp/local' }];
  const context = { schemaVersion: 2, sourceType: 'test', sourceId: 'run', startedAt: '2026-10-06T00:01:00Z', finishedAt: '2026-10-06T00:02:00Z' };
  for (const target of variants) for (const expectedTarget of variants) {
    // Pinned old context admission, before reason codes were separated. No
    // timestamp/schema issue is present in this deliberately scoped matrix.
    const previouslyEligible = hasTargetIdentity(target) && !(target && expectedTarget && !sameTarget(target, expectedTarget));
    assert.equal(evidenceContextIssues({ ...context, target, expectedTarget }).length === 0, !!previouslyEligible, JSON.stringify({ target, expectedTarget }));
  }
  assert.deepEqual(evidenceContextIssues({ ...context, target: { ...base, environment: '' } }).map(i => i.code), ['environment_unknown']);
  assert.deepEqual(evidenceContextIssues({ ...context, target: { ...base, revision: '' } }).map(i => i.code), ['revision_unknown']);
  assert.deepEqual(evidenceContextIssues({ ...context, target: { ...base, scope } }).map(i => i.code), ['target_identity_invalid']);
});
