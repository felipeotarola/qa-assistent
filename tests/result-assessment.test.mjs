import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reviewRules, validateAssessment, assessmentWithoutEvidence } from '../shared/result-assessment.ts';

const input = () => ({ schemaVersion: 2, runId: 'run-a', workspaceId: 'workspace-a', planVersion: 1,
  startedAt: '2026-10-01T10:00:00Z', finishedAt: '2026-10-01T10:01:00Z', environment: 'test', target: { revision: 'abc', url: 'https://example.com', environment: 'test' },
  requirements: [{ id: 'step-1', requirement: 'Click Inspiration' }, { id: 'expected', requirement: 'Navigation opens Inspiration' }],
  reportedResult: { outcome: 'passed', actual: 'Opened', unverified: '', observations: [], evidenceItemIds: ['proof'], checks: [{ id: 'step-1', status: 'verified', actual: 'clicked' }, { id: 'expected', status: 'verified', actual: 'opened' }] },
  evidence: [{ id: 'proof', evidencePolicyVersion: 2, origin: 'tool', provenance: { version: 1, origin: 'tool', producer: 'test-capture', sourceType: 'test', sourceId: 'run-a', observedAt: '2026-10-01T10:00:30Z' }, runId: 'run-a', observedAt: '2026-10-01T10:00:30Z', readStatus: 'read' }], ruleFindings: [] });
const assessment = () => ({ verdict: 'supported', summary: 'Underbyggt', findings: ['step-1', 'expected'].map(requirementId => ({ requirementId, verdict: 'supported', explanation: 'Underlaget visar utfallet', evidenceIds: ['proof'], suggestedNextStep: '' })) });

test('complete coverage and run-specific evidence validate without changing original result', () => {
  const source = input(); const before = JSON.stringify(source);
  assert.deepEqual(reviewRules(source), []);
  assert.equal(validateAssessment(source, assessment()).verdict, 'supported');
  assert.equal(JSON.stringify(source), before);
});
test('missing check, version, provenance and unread evidence remain explicit uncertainties', () => {
  const source = input(); source.target.revision = ''; source.reportedResult.checks.pop(); source.evidence[0].runId = null; source.evidence[0].readStatus = 'unavailable';
  source.ruleFindings = reviewRules(source);
  assert.deepEqual(source.ruleFindings.map(f => f.code), ['revision_unknown', 'coverage_missing', 'evidence_unread', 'provenance_unknown']);
  assert.throws(() => validateAssessment(source, assessment()));
});
test('cross-run and out-of-time proof cannot endorse a run', () => {
  const source = input(); source.evidence[0].runId = 'other'; source.evidence[0].observedAt = '2026-09-01T10:00:00Z';
  source.ruleFindings = reviewRules(source);
  assert.deepEqual(source.ruleFindings.map(f => f.code), ['source_mismatch', 'time_inconsistent', 'time_mismatch']);
  assert.throws(() => validateAssessment(source, assessment()));
});
test('fabricated evidence, duplicate requirements and narrowed scope are rejected', () => {
  for (const mutate of [a => a.findings.pop(), a => a.findings.push(a.findings[0]), a => a.findings[0].requirementId = 'invented', a => a.findings[0].evidenceIds = ['invented'], a => a.findings[0].evidenceIds = []]) {
    const value = assessment(); mutate(value); assert.throws(() => validateAssessment(input(), value));
  }
});
test('overall verdict must reflect individual contradictions', () => {
  const value = assessment(); value.findings[0].verdict = 'contradicted';
  assert.throws(() => validateAssessment(input(), value));
  value.verdict = 'contradicted'; assert.equal(validateAssessment(input(), value).verdict, 'contradicted');
});
test('correctly reported failures can be supported: supported does not mean passed', () => {
  const source = input(); source.reportedResult.outcome = 'failed'; source.reportedResult.checks[0].status = 'mismatch';
  assert.deepEqual(reviewRules(source), []);
  assert.equal(validateAssessment(source, assessment()).verdict, 'supported');
  assert.equal(source.reportedResult.outcome, 'failed');
});

test('a reported failure does not turn unperformed checkpoints into supported findings', () => {
  for (const status of ['unverified', 'blocked']) {
    const source = input(); source.reportedResult.outcome = 'failed'; source.reportedResult.checks[0].status = status;
    assert.ok(reviewRules(source).some(rule => rule.code === 'coverage_incomplete' && rule.requirementId === 'step-1'));
    assert.throws(() => validateAssessment(source, assessment()), /Unresolved requirement/);
  }
});
test('empty or partial evidence cannot produce a clean endorsement', () => {
  const source = input(); source.evidence = []; source.ruleFindings = reviewRules(source);
  assert.ok(source.ruleFindings.some(f => f.code === 'evidence_missing'));
  const value = assessment(); value.verdict = 'needs_evidence'; value.findings = value.findings.map(f => ({ ...f, verdict: 'needs_evidence', evidenceIds: [], suggestedNextStep: 'Samla underlag' }));
  assert.equal(validateAssessment(source, value).verdict, 'needs_evidence');
});

test('unread evidence gets a deterministic needs-evidence assessment without a model', () => {
  const source = input();
  assert.equal(assessmentWithoutEvidence(source), null);
  source.evidence[0].readStatus = 'unavailable';
  assert.equal(assessmentWithoutEvidence(source).verdict, 'needs_evidence');
  assert.ok(assessmentWithoutEvidence(source).findings.every(f => f.evidenceIds.length === 0));
});
