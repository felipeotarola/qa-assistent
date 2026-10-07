import assert from 'node:assert/strict';
import test from 'node:test';
import { EVIDENCE_PROTOCOL, EVIDENCE_CATALOG, validateEvidenceManifest, evidencePrompt, evidenceSeed, validateEvidenceSeed, fingerprint, auditEvidenceCompletion, auditEvidenceHistory, auditGapLineage, evidenceMetrics, observedReviewCalls } from './helpers/evidence-acceptance.mjs';

const provider = (extra = {}) => ({ providerCalls: 1, unknownCalls: 0, inputTokens: 10, outputTokens: 2, totalTokens: 12, cacheReadTokens: null, cacheWriteTokens: null, durationMs: 10, ...extra });
const manifest = (extra = {}) => ({ protocol: EVIDENCE_PROTOCOL, catalogVersion: EVIDENCE_CATALOG, taskId: 'REP-05', variant: 'normal', sourceHash: 'a'.repeat(64), runtime: 'autonomy-test:evidence', model: 'glm-5.3-flash', reasoning: 'low', observationSeconds: 1500,
  trials: [{ workspaceId: 'workspace-one', accountFile: '.data/autonomy-isolation/ordinary-user.json', selection: [{ type: 'test', id: 'run-one', label: 'Startsidan, måndag klockan tio' }], seedHash: 'b'.repeat(64), originArtifacts: [] }], ...extra });
const empty = () => Object.fromEntries(['missions', 'tasks', 'attempts', 'jobs', 'runs', 'reviews', 'reports', 'claims', 'events', 'captures', 'items', 'repositories', 'setups'].map(key => [key, []]));
const run = (id, outcome = 'passed') => ({ id, item_id: `plan-${id}`, case_id: 'case', plan_version: 1, snapshot: { title: id, type: 'browser', checks: [{ id: 'check', expected: 'Original check' }] }, target: { environment: 'QA', revision: 'A', url: 'https://example.test/' }, runtime: 'autonomy-test:evidence', result: { schemaVersion: 2, outcome, checks: [] }, started_at: '2026-10-01T10:00:00Z', finished_at: '2026-10-01T10:00:10Z', mission_attempt_id: `attempt-${id}` });
const capture = run => ({ id: `capture-${run.id}`, run_id: run.id, item_id: `image-${run.id}`, version: 1, content: { kind: 'image', size: 10 }, deleted_at: null,
  provenance: { version: 1, origin: 'tool', producer: 'test-capture', sourceType: 'test', sourceId: run.id, sha256: 'a'.repeat(64) } });

test('manifest distinguishes normal report input from unimplemented fault variants and requires frozen seed at execution', () => {
  validateEvidenceManifest(manifest(), { execute: true });
  assert.throws(() => validateEvidenceManifest(manifest({ variant: 'report-restart' })), /Variant/);
  const value = manifest(); value.trials[0].seedHash = null;
  validateEvidenceManifest(value); assert.throws(() => validateEvidenceManifest(value, { execute: true }), /prelocked/);
  value.trials[0].seedHash = 'b'.repeat(64); value.trials.push(structuredClone(value.trials[0]));
  assert.throws(() => validateEvidenceManifest(value), /separate/);
});
test('manifest never accepts tool-answer injection fields or internal identifier as normal label', () => {
  assert.throws(() => validateEvidenceManifest({ ...manifest(), assessment: {} }), /unknown field/);
  const value = manifest(); value.trials[0].selection[0].label = 'run-one'; assert.throws(() => validateEvidenceManifest(value), /identifier/);
});
test('natural report prompts contain normal selection descriptions, no hidden evidence oracle', () => {
  const value = manifest(), prompt = evidencePrompt(value, value.trials[0]);
  assert.match(prompt, /Kör inga nya tester/); assert.match(prompt, /Startsidan/); assert.doesNotMatch(prompt, /run-one|mission|supported|needs_evidence/);
});
test('v2 explicitly requests a saved report while v1 prompt bytes remain unchanged', () => {
  const oldPrompts = {
    'REP-05': 'Sammanfatta de valda sparade resultaten ”Startsidan” i en rapport. Kör inga nya tester.',
    'REP-06': 'Bedöm om de valda sparade resultaten ”Startsidan” räcker för version B. Kör inget nytt; skriv tydligt vad som saknas.',
    'REP-07': 'Gå igenom de valda sparade resultaten och anteckningen ”Startsidan” och skriv vad vi faktiskt vet om inloggningsflödet. Testa inget nytt.',
    'GAP-13': 'Sammanfatta de valda sparade resultaten ”Startsidan”. Skriv tydligt vad som saknas och kör inga nya tester.',
  };
  for (const [taskId, expected] of Object.entries(oldPrompts)) {
    const value = manifest({ taskId, variant: taskId === 'GAP-13' ? 'report-only' : 'normal' });
    value.trials[0].selection[0].label = 'Startsidan';
    const legacy = { ...value, protocol: 'syna-evidence-acceptance-v1' };
    assert.equal(evidencePrompt(legacy, legacy.trials[0]), expected);
    const prompt = evidencePrompt(value, value.trials[0]);
    assert.match(prompt, /spara en rapport/); assert.notEqual(prompt, expected);
    assert.doesNotMatch(prompt, /run-one|mission|supported|needs_evidence|report_only/);
    if (taskId !== 'GAP-13') {
      assert.equal(evidencePrompt({ ...legacy, protocol: 'syna-report-fault-acceptance-v1' }, legacy.trials[0]), expected);
      assert.equal(evidencePrompt({ ...value, protocol: 'syna-report-fault-acceptance-v2' }, value.trials[0]), prompt);
    }
  }
  assert.equal(EVIDENCE_PROTOCOL, 'syna-evidence-acceptance-v3');
  assert.throws(() => evidencePrompt({ ...manifest(), protocol: 'syna-evidence-acceptance-v999' }, manifest().trials[0]), /Unsupported/);
});
test('v1 and v2 validation preserve identity and enforce the same original seed/selection guards', () => {
  for (const protocol of ['syna-evidence-acceptance-v1', 'syna-evidence-acceptance-v2', EVIDENCE_PROTOCOL]) {
    const value = manifest({ protocol }); value.trials[0].seedHash = null;
    const before = structuredClone(value);
    validateEvidenceManifest(value); assert.deepEqual(value, before);
    assert.throws(() => validateEvidenceManifest(value, { execute: true }), /prelocked/);
    assert.throws(() => validateEvidenceManifest({ ...value, oracleAnswer: 'passed' }), /unknown field/);
    assert.equal(evidencePrompt({ ...value, taskId: 'SEC-08' }, value.trials[0]), null);
  }
  assert.throws(() => validateEvidenceManifest({ ...manifest(), protocol: 'syna-evidence-acceptance-v999' }), /Unsupported/);
});
test('GAP manifest cannot reuse an old target or saved run as the first natural execution', () => {
  const value = manifest({ taskId: 'GAP-13', variant: 'resolvable' }); value.trials[0].url = 'https://search.example.test/';
  assert.throws(() => validateEvidenceManifest(value), /must not reuse/);
  value.trials[0].selection = []; validateEvidenceManifest(value);
  assert.match(evidencePrompt(value, value.trials[0]), /både kan visa träffar och ett begripligt tomt resultat/);
});
test('REP-05 requires actual passed, failed, incomplete originals with exact capture lineage', () => {
  const runs = [run('a'), run('b', 'failed'), run('c', 'inconclusive')], seed = { runs, captures: runs.map(capture), material: [] };
  validateEvidenceSeed('REP-05', 'normal', seed, 'autonomy-test:evidence');
  seed.captures[2].provenance.sourceId = 'someone-else'; assert.throws(() => validateEvidenceSeed('REP-05', 'normal', seed, 'autonomy-test:evidence'), /independently/);
});
test('REP-06 rejects relabelling unknown observation scopes as version-A/B proof', () => {
  const runs = [run('a'), run('b'), run('c')]; runs[1].target.revision = 'B'; runs[2].target = null;
  const seed = { runs, captures: runs.map(capture), material: [] }; validateEvidenceSeed('REP-06', 'normal', seed, 'autonomy-test:evidence');
  runs[1].target.revision = ''; runs[1].target.scope = { kind: 'observation', id: 'obs', capturedAt: '2026-10-01T10:00:00Z' };
  assert.throws(() => validateEvidenceSeed('REP-06', 'normal', seed, 'autonomy-test:evidence'), /Version A\/B/);
});
test('seed hash ignores renewed assessment but detects run history/provenance edits', () => {
  const state = empty(); state.runs.push(run('a')); state.captures.push(capture(state.runs[0])); const selection = [{ type: 'test', id: 'a' }];
  const hash = fingerprint(evidenceSeed(state, selection)); state.reviews.push({ id: 'new-review' }); assert.equal(fingerprint(evidenceSeed(state, selection)), hash);
  state.captures[0].provenance.origin = 'agent'; assert.notEqual(fingerprint(evidenceSeed(state, selection)), hash);
});
function reportFixture() {
  const before = empty(); before.runs = [run('a'), run('b', 'failed'), run('c', 'inconclusive')]; before.captures = before.runs.map(capture);
  const selection = before.runs.map(run => ({ type: 'test', id: run.id, label: `Resultat ${run.id}` })), after = structuredClone(before);
  after.missions = [{ id: 'mission', thread_id: 'thread', intent: 'report_only', lifecycle: 'closed' }];
  after.tasks = [{ id: 'report-task', mission_id: 'mission', spec: { kind: 'report' } }];
  after.items = [{ id: 'saved-report', deleted_at: null }];
  after.reports = [{ id: 'report', mission_id: 'mission', status: 'completed', item_id: 'saved-report', input: { config: { target: null }, tasks: [{ sources: before.runs.map(run => ({ sourceType: 'test', sourceId: run.id, reportedOutcome: run.result.outcome === 'passed' ? 'achieved' : 'partial' })) }] }, document: { partial: true, findings: [{ verdict: 'needs_evidence' }] } }];
  return { before, after, selection };
}
test('report oracle accepts exact original negative + incomplete sources as honest partial report', () => {
  const { before, after, selection } = reportFixture(); const result = auditEvidenceCompletion(manifest(), { selection }, before, after, 'thread');
  assert.equal(result.semanticProse, 'pending'); assert.equal(result.reportId, 'report');
});
test('report oracle rejects silent newer-run substitution, execution, and fake full approval', () => {
  for (const alter of [state => state.reports[0].input.tasks[0].sources[0].sourceId = 'newer', state => state.runs.push(run('new')), state => state.reports[0].document.partial = false]) {
    const { before, after, selection } = reportFixture(); alter(after);
    assert.throws(() => auditEvidenceCompletion(manifest(), { selection }, before, after, 'thread'));
  }
});
function gapFixture() {
  const original = run('a', 'inconclusive'), next = { ...run('b'), item_id: original.item_id, snapshot: original.snapshot, mission_attempt_id: 'attempt-new' };
  const binding = { runId: original.id, sourceAttemptId: original.mission_attempt_id, assessmentId: 'review-a', inputHash: 'ih', sourceHash: 'sh', reviewerVersion: '5', caseKey: `${original.item_id}:${original.case_id}`, planRevision: 1 };
  binding.gapIds = [fingerprint({ planRevision: 1, caseKey: binding.caseKey, checkId: 'check', kind: 'missing_observation' })];
  return { mission: { id: 'mission', plan_revision: 1 }, tasks: [{ id: 'next-task', supplement_round: 1, spec: { kind: 'browser_tests', caseKeys: [binding.caseKey], complement: binding } }],
    attempts: [{ id: 'review-attempt', kind: 'review', reviewCalls: [{ reviewId: 'review-a', providerCalls: 1 }] }, { id: 'attempt-new', task_id: 'next-task', kind: 'browser_tests' }], runs: [original, next],
    reviews: [{ id: 'review-a', run_id: 'a', status: 'completed', input_hash: 'ih', source_hash: 'sh', reviewer_version: '5', input: { requirements: [{ id: 'check' }] }, assessment: { verdict: 'needs_evidence', findings: [{ requirementId: 'check', verdict: 'needs_evidence', gap: { kind: 'missing_observation', capability: 'browser' } }] } }, { id: 'review-b', run_id: 'b', status: 'completed', assessment: { verdict: 'supported' } }] };
}
const auditGap = f => auditGapLineage(f.mission, f.tasks, f.attempts, f.runs, f.reviews, 'resolvable');
test('GAP oracle requires physical model gap, exact lineage and new reviewed run', () => { assert.equal(auditGap(gapFixture()).lineage.length, 1); });
test('GAP oracle rejects synthetic no-evidence factory, modified case, repeated attempt and third round', () => {
  for (const alter of [f => f.attempts[0].reviewCalls = [], f => f.runs[1].snapshot = { ...f.runs[1].snapshot, title: 'Different requirement' }, f => f.attempts[1].id = f.tasks[0].spec.complement.sourceAttemptId, f => f.tasks[0].supplement_round = 3,
    f => f.tasks[0].spec.complement.inputHash = 'stale', f => f.reviews[1].status = 'failed']) {
    const f = gapFixture(); alter(f); assert.throws(() => auditGap(f));
  }
});
test('finished originals cannot be rewritten while a later supplement runs', () => {
  const before = empty(); before.runs.push(run('a')); const after = structuredClone(before); after.runs.push(run('b'));
  auditEvidenceHistory([before, after]); after.runs[0].result.outcome = 'passed-overwritten'; assert.throws(() => auditEvidenceHistory([before, after]), /finished original/);
});
test('queue marker parser records only exact review and valid physical provider receipt', () => {
  const rows = observedReviewCalls([`server:queue-model:usage:${JSON.stringify({ key: 'review:review-a:1', provider: provider() })}`, 'server:queue-model:usage:broken', `server:queue-model:usage:${JSON.stringify({ key: 'report:report-a:1', provider: provider() })}`]);
  assert.deepEqual(rows, [{ reviewId: 'review-a', providerCalls: 1 }]);
});
test('metrics do not double count queue or aggregate and retain unknown physical consumption', () => {
  const { before, after } = reportFixture(); after.attempts = [{ id: 'a', mission_id: 'mission', kind: 'report', tool_calls: 2, reserved_tokens: 100000, attempt_no: 1, usage: { tokens: 12, provider: provider() } }];
  after.reports[0].usage = { totalTokens: 12 }; assert.equal(evidenceMetrics(before, after, 'thread').tokens.total, 12);
  after.attempts[0].usage.provider = provider({ unknownCalls: 1, outputTokens: null, totalTokens: null });
  assert.equal(evidenceMetrics(before, after, 'thread').tokens.total, null); assert.equal(evidenceMetrics(before, after, 'thread').cost, null);
  after.attempts[0].usage.provider = provider({ totalTokens: 999 }); assert.equal(evidenceMetrics(before, after, 'thread').tokens.total, null);
  after.attempts[0].usage.provider = provider(); after.attempts[0].usage.tokens = 13; assert.equal(evidenceMetrics(before, after, 'thread').tokens.total, null);
});
