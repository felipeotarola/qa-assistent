import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { assessmentSchema, currentAssessmentSchema, reviewGapSchema, reviewGaps, validateAssessment, assessmentWithoutEvidence, REVIEWER_VERSION, REVIEW_EVIDENCE_RULES_VERSION } from '../shared/result-assessment.ts';
import { EVIDENCE_RULES_VERSION } from '../shared/evidence-rules.ts';

const gap = (kind = 'missing_observation', capability = 'browser') => ({ kind, capability, wantedEvidence: 'En oberoende observation av kontrollpunktens faktiska utfall.' });
const finding = (requirementId = 'step-1', verdict = 'needs_evidence', value = gap()) => ({ requirementId, verdict, explanation: 'Underlaget behöver kompletteras.', evidenceIds: [], suggestedNextStep: 'Förklarande text, aldrig exekvering.', gap: value });
const assessment = (value = gap()) => ({ verdict: 'needs_evidence', summary: 'Utfallet saknar stöd.', findings: [finding('step-1', 'needs_evidence', value)] });
const input = () => ({ schemaVersion: 2, runId: 'run-a', workspaceId: 'workspace-a', planVersion: 1,
  startedAt: '2026-10-01T10:00:00Z', finishedAt: '2026-10-01T10:01:00Z', environment: 'test', target: { revision: 'abc', url: 'https://example.com', environment: 'test' },
  requirements: [{ id: 'step-1', requirement: 'Click the original link' }],
  reportedResult: { outcome: 'passed', actual: 'Opened', unverified: '', observations: [], evidenceItemIds: [], checks: [{ id: 'step-1', status: 'verified', actual: 'clicked' }] },
  evidence: [], ruleFindings: [] });
const proof = () => ({ id: 'proof', evidencePolicyVersion: 2, origin: 'tool', provenance: { version: 1, origin: 'tool', producer: 'test-capture', sourceType: 'test', sourceId: 'run-a', observedAt: '2026-10-01T10:00:30Z' }, runId: 'run-a', observedAt: '2026-10-01T10:00:30Z', readStatus: 'read' });

test('new model contract describes bounded evidence needs without execution fields', () => {
  const value = assessment(), source = input(), before = structuredClone(source);
  assert.deepEqual(currentAssessmentSchema.parse(value), value);
  assert.deepEqual(validateAssessment(source, value), value);
  assert.deepEqual(reviewGaps({ reviewerVersion: REVIEWER_VERSION, assessment: value }), [{ requirementId: 'step-1', ...gap() }]);
  assert.deepEqual(source, before);
  for (const forbidden of ['url', 'command', 'mandate', 'runId', 'assessmentId', 'planVersion', 'inputHash', 'round']) {
    const invalid = assessment({ ...gap(), [forbidden]: 'model-selected' });
    assert.equal(currentAssessmentSchema.safeParse(invalid).success, false, forbidden);
  }
});

test('provider JSON schema requires an explicit bounded gap or null, never execution parameters', () => {
  const schema = z.toJSONSchema(currentAssessmentSchema), finding = schema.properties.findings.items;
  assert.ok(finding.required.includes('gap'));
  const gap = finding.properties.gap.anyOf.find(branch => branch.type === 'object');
  assert.deepEqual(Object.keys(gap.properties).sort(), ['capability', 'kind', 'wantedEvidence']);
  assert.equal(gap.additionalProperties, false); assert.equal(gap.properties.wantedEvidence.maxLength, 1000);
  assert.ok(finding.properties.gap.anyOf.some(branch => branch.type === 'null'));
});

test('unclear requirements, prerequisites and read limits cannot request browser work', () => {
  for (const kind of ['unclear_requirement', 'environment_prerequisite', 'evidence_read_limit']) assert.equal(reviewGapSchema.safeParse(gap(kind, 'browser')).success, false, kind);
  for (const kind of ['unclear_requirement', 'environment_prerequisite']) {
    assert.equal(reviewGapSchema.safeParse(gap(kind, 'review')).success, false);
    assert.equal(reviewGapSchema.safeParse(gap(kind, 'none')).success, true);
  }
  assert.equal(reviewGapSchema.safeParse(gap('evidence_read_limit', 'review')).success, true);
  assert.equal(reviewGapSchema.safeParse(gap('unverified_step', 'review')).success, false);
});

test('supported product failures and contradictions never emit continuation gaps', () => {
  for (const verdict of ['supported', 'contradicted']) {
    const source = input(); source.evidence = [proof()]; source.reportedResult.outcome = 'failed'; source.reportedResult.checks[0].status = 'mismatch';
    const value = { verdict, summary: 'Det rapporterade utfallet granskas.', findings: [{ ...finding('step-1', verdict, null), evidenceIds: ['proof'] }] };
    assert.equal(validateAssessment(source, currentAssessmentSchema.parse(value)).verdict, verdict);
    assert.deepEqual(reviewGaps({ reviewerVersion: REVIEWER_VERSION, assessment: value }), []);
    value.findings[0].gap = gap(); assert.equal(assessmentSchema.safeParse(value).success, false);
  }
  const mixed = { verdict: 'contradicted', summary: 'En del motsägs.', findings: [finding('step-1', 'contradicted', null), finding('expected')] };
  assert.equal(currentAssessmentSchema.safeParse(mixed).success, false);
  mixed.findings[1].gap = null; assert.equal(currentAssessmentSchema.safeParse(mixed).success, true);
  assert.deepEqual(reviewGaps({ reviewerVersion: REVIEWER_VERSION, assessment: mixed }), []);
});

test('legacy gapless assessments remain unchanged and cannot be upgraded by prose or version', () => {
  const legacy = assessment(); delete legacy.findings[0].gap;
  legacy.findings[0].suggestedNextStep = 'Run the browser again';
  const parsed = assessmentSchema.parse(legacy);
  assert.deepEqual(parsed, legacy); assert.equal(Object.hasOwn(parsed.findings[0], 'gap'), false);
  assert.equal(currentAssessmentSchema.safeParse(legacy).success, false);
  assert.deepEqual(reviewGaps({ reviewerVersion: REVIEWER_VERSION, assessment: legacy }), []);
  assert.deepEqual(reviewGaps({ reviewerVersion: EVIDENCE_RULES_VERSION, assessment: assessment() }), []);
  assert.notEqual(REVIEWER_VERSION, EVIDENCE_RULES_VERSION); assert.equal(REVIEW_EVIDENCE_RULES_VERSION, EVIDENCE_RULES_VERSION);
});

test('malformed gaps, missing current gaps, false summaries and repeated IDs are rejected', () => {
  for (const value of [gap('invented'), gap('missing_observation', 'shell'), { ...gap(), wantedEvidence: '' }, { ...gap(), wantedEvidence: 'x'.repeat(1001) }, { ...gap(), wantedEvidence: {} }, 'browser', 123]) assert.equal(reviewGapSchema.safeParse(value).success, false);
  assert.equal(currentAssessmentSchema.safeParse(assessment(null)).success, false);
  const duplicate = assessment(); duplicate.findings.push(structuredClone(duplicate.findings[0])); assert.equal(assessmentSchema.safeParse(duplicate).success, false);
  const falseSummary = assessment(); falseSummary.verdict = 'supported'; assert.equal(assessmentSchema.safeParse(falseSummary).success, false);
  assert.deepEqual(reviewGaps({ reviewerVersion: REVIEWER_VERSION, assessment: { verdict: 'needs_evidence' } }), []);
});

test('gap fields never relax original checkpoint or independent evidence requirements', () => {
  const source = input();
  const unknown = assessment(); unknown.findings[0].requirementId = 'invented'; assert.throws(() => validateAssessment(source, unknown), /original requirements/);
  const extra = assessment(); extra.findings.push(finding('invented')); assert.throws(() => validateAssessment(source, extra), /original requirements/);
  const unread = assessment(); unread.findings[0].evidenceIds = ['invented']; assert.throws(() => validateAssessment(source, unread), /unread or unknown/);
  const unsupported = { verdict: 'supported', summary: 'No proof.', findings: [finding('step-1', 'supported', null)] };
  assert.throws(() => validateAssessment(source, unsupported), /needs evidence/);
  source.evidence = [proof()]; unsupported.findings[0].evidenceIds = ['proof']; source.evidence[0].runId = 'other';
  assert.throws(() => validateAssessment(source, unsupported), /independent evidence/);
});

test('original requirement gaps and unknown execution context cannot be relabelled as browser supplements', () => {
  const source = input(); source.reportedResult.observations.push({ kind: 'requirement_gap', title: 'Unknown expectation', detail: 'Requirement not established.' });
  assert.throws(() => validateAssessment(source, assessment()), /unclear requirement/);
  assert.equal(validateAssessment(source, assessment(gap('unclear_requirement', 'none'))).verdict, 'needs_evidence');
  source.reportedResult.observations = []; source.target.revision = '';
  assert.throws(() => validateAssessment(source, assessment()), /evidence context/);
  assert.equal(validateAssessment(source, assessment(gap('environment_prerequisite', 'none'))).verdict, 'needs_evidence');
});

test('deterministic no-evidence assessment emits typed needs without calling a model', () => {
  const source = input(), before = structuredClone(source);
  let result = assessmentWithoutEvidence(source);
  assert.equal(currentAssessmentSchema.safeParse(result).success, true);
  assert.deepEqual(result.findings[0].gap, { kind: 'missing_observation', capability: 'browser', wantedEvidence: 'Oberoende observerat underlag som visar utfallet för den ursprungliga kontrollpunkten.' });
  assert.deepEqual(source, before);
  source.reportedResult.outcome = 'inconclusive'; source.reportedResult.checks[0].status = 'unverified';
  result = assessmentWithoutEvidence(source); assert.equal(result.findings[0].gap.kind, 'unverified_step'); assert.equal(result.findings[0].gap.capability, 'browser');
  source.reportedResult.checks[0].status = 'blocked'; assert.equal(assessmentWithoutEvidence(source).findings[0].gap.capability, 'none');
  source.reportedResult.outcome = 'blocked'; assert.equal(assessmentWithoutEvidence(source).findings[0].gap.kind, 'environment_prerequisite');
});

test('deterministic read limit, unclear requirement and invalid target remain non-browser needs', () => {
  const source = input(); source.evidence = [{ ...proof(), readStatus: 'limited' }];
  let result = assessmentWithoutEvidence(source);
  assert.equal(result.findings[0].gap.kind, 'evidence_read_limit'); assert.equal(result.findings[0].gap.capability, 'review');
  source.reportedResult.observations.push({ kind: 'requirement_gap', title: 'Unknown', detail: 'Clarify expected behavior.' });
  result = assessmentWithoutEvidence(source); assert.equal(result.findings[0].gap.kind, 'unclear_requirement'); assert.equal(result.findings[0].gap.capability, 'none');
  source.reportedResult.observations = []; source.target = null;
  result = assessmentWithoutEvidence(source); assert.equal(result.findings[0].gap.kind, 'environment_prerequisite'); assert.equal(result.findings[0].gap.capability, 'none');
  source.target = beforeTarget(); source.evidence = [proof()]; assert.equal(assessmentWithoutEvidence(source), null);
});
function beforeTarget() { return { revision: 'abc', url: 'https://example.com', environment: 'test' }; }
