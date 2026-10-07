import assert from 'node:assert/strict';
import test from 'node:test';
import { goldenRecipe, goldenResult, goldenAssessment, validateGoldenArtifact, GOLDEN_LABEL, GOLDEN_PROTOCOL, GOLDEN_REVIEW_MODEL } from './helpers/evidence-golden.mjs';
import { validateEvidenceManifest, validateEvidenceSeed, fingerprint, EVIDENCE_PROTOCOL, EVIDENCE_CATALOG } from './helpers/evidence-acceptance.mjs';
import { currentAssessmentSchema } from '../shared/result-assessment.ts';
import { runResultSchema } from '../shared/test-run.ts';

test('golden recipes keep catalog outcomes/version boundaries, unknown release and agent claim separate', () => {
  assert.deepEqual(goldenRecipe('REP-05').cases.map(c => c.outcome), ['passed', 'failed', 'inconclusive']);
  assert.deepEqual(goldenRecipe('REP-06').cases.map(c => c.target?.revision ?? null), ['A', 'B', null]);
  const login = goldenRecipe('REP-07'); assert.equal(login.cases.length, 2); assert.match(login.note.text, /Inloggningen fungerar/);
  assert.match(login.cases[1].observation, /ingen inloggning verifierades/); assert.throws(() => goldenRecipe('GAP-13'));
});
test('golden results satisfy original v2 shape and preserve every missing check', () => {
  for (const task of ['REP-05', 'REP-06', 'REP-07']) for (const c of goldenRecipe(task).cases) {
    const value = goldenResult(c, [{ id: 'step-1' }, { id: 'expected' }], 'e0524b40-3474-45c3-9174-b0b556794a6d'); runResultSchema.parse(value);
    assert.equal(value.remaining.length, c.outcome === 'inconclusive' ? 2 : 0); assert.ok(value.actual.includes(GOLDEN_LABEL));
  }
});
test('deterministic review requires actual labelled read bytes and never turns a product defect into a gap', () => {
  const input = { target: { revision: 'A' }, reportedResult: { outcome: 'failed' }, evidence: [{ id: 'file', readStatus: 'read' }], requirements: [{ id: 'step-1' }] };
  const result = goldenAssessment(input, [{ type: 'text', text: GOLDEN_LABEL }]); currentAssessmentSchema.parse(result); assert.equal(result.verdict, 'supported');
  assert.throws(() => goldenAssessment(input, [])); input.reportedResult.outcome = 'inconclusive';
  const missing = goldenAssessment(input, [{ type: 'text', text: GOLDEN_LABEL }]); currentAssessmentSchema.parse(missing);
  assert.equal(missing.verdict, 'needs_evidence'); assert.equal(missing.findings[0].gap.capability, 'none');
});
function fixture() {
  const runtime = 'autonomy-test:golden', runs = goldenRecipe('REP-05').cases.map((c, i) => ({ id: `run-${i}`, runtime, target: c.target, mission_attempt_id: null, finished_at: '2026-10-05T10:00:00Z', snapshot: { type: 'browser' }, result: { outcome: c.outcome, actual: GOLDEN_LABEL } }));
  const seed = { runs, material: [], captures: runs.map(run => ({ run_id: run.id, item_id: `file-${run.id}`, provenance: { origin: 'tool', sourceId: run.id, sourceType: 'test', producer: 'test-capture', sha256: 'a'.repeat(64) } })) };
  const reviews = runs.map(run => ({ id: `review-${run.id}`, run_id: run.id, status: 'completed', reviewer_version: '6', model: GOLDEN_REVIEW_MODEL, assessment: { verdict: run.result.outcome === 'inconclusive' ? 'needs_evidence' : 'supported' } }));
  const artifact = { protocol: GOLDEN_PROTOCOL, preparation: 'synthetic-golden', taskId: 'REP-05', runtime, realProviderCalls: 0, realBrowserActions: 0, reviewerVersion: '6', reviewMethod: 'authored-worker-with-deterministic-model-fixture', completedAt: '2026-10-05T10:01:00Z', authoringHashes: { a: 'a'.repeat(64), b: 'b'.repeat(64), c: 'c'.repeat(64) }, trials: [{ workspaceId: 'workspace', seed, seedHash: fingerprint(seed), reviews }] };
  return { artifact, context: { taskId: 'REP-05', runtime, workspaceId: 'workspace', seed, reviews, reviewerVersion: '6' } };
}
test('synthetic seed is accepted only by the explicit preparation branch; actual physical requirement remains', () => {
  const { context: c } = fixture(); validateEvidenceSeed(c.taskId, 'normal', c.seed, c.runtime, 'synthetic-golden');
  assert.throws(() => validateEvidenceSeed(c.taskId, 'normal', c.seed, c.runtime), /real saved/);
  c.seed.runs[0].mission_attempt_id = 'invented'; assert.throws(() => validateEvidenceSeed(c.taskId, 'normal', c.seed, c.runtime, 'synthetic-golden'), /masquerade/);
});
test('golden receipt locks original seed, current review, attribution and zero real executions', () => {
  const f = fixture(); validateGoldenArtifact(f.artifact, f.context);
  for (const change of [f => f.artifact.realProviderCalls = 1, f => f.artifact.reviewerVersion = '5', f => f.artifact.trials[0].seedHash = 'b'.repeat(64), f => f.context.reviews[0].model = 'real-model']) {
    const f = fixture(); change(f); assert.throws(() => validateGoldenArtifact(f.artifact, f.context));
  }
});
test('golden JSON receipt equals live UTC Date values but never changed timestamp/content/order', () => {
  const f = fixture();
  for (const run of f.context.seed.runs) run.finished_at = new Date(run.finished_at);
  f.artifact.trials[0].seedHash = fingerprint(f.context.seed);
  f.artifact = JSON.parse(JSON.stringify(f.artifact));
  validateGoldenArtifact(f.artifact, f.context);
  for (const alter of [
    f => f.context.seed.runs[0].finished_at = new Date('2026-10-05T10:00:01Z'),
    f => f.artifact.trials[0].seed.runs[0].result.actual += 'changed',
    f => f.artifact.trials[0].seed.runs.reverse(),
  ]) {
    const c = structuredClone(f); alter(c); assert.throws(() => validateGoldenArtifact(c.artifact, c.context));
  }
});
test('synthetic preparation manifest cannot certify a natural GAP or undeclared historical variant', () => {
  const m = { protocol: EVIDENCE_PROTOCOL, catalogVersion: EVIDENCE_CATALOG, taskId: 'REP-05', variant: 'normal', preparation: 'synthetic-golden', reviewerVersion: '6', sourceHash: 'a'.repeat(64), runtime: 'autonomy-test:golden', model: 'glm-5.3-flash', reasoning: 'low', observationSeconds: 1500,
    trials: [{ workspaceId: 'workspace', accountFile: '.data/autonomy-isolation/ordinary-user.json', selection: [{ type: 'test', id: 'run', label: 'Startsidan' }], seedHash: 'b'.repeat(64), originArtifacts: [{ path: '.data/autonomy-isolation/evidence-preparation.json', sha256: 'c'.repeat(64) }] }] };
  validateEvidenceManifest(m, { execute: true }); assert.throws(() => validateEvidenceManifest({ ...m, variant: 'historical-review-gap' }));
  assert.throws(() => validateEvidenceManifest({ ...m, taskId: 'GAP-13', variant: 'resolvable' }));
  delete m.reviewerVersion; assert.throws(() => validateEvidenceManifest(m));
});
