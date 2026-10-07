import assert from 'node:assert/strict';
import test from 'node:test';
import { evidenceSearchPage, evidenceSearchHandler } from './fixtures/evidence-gap-site.mjs';
import { gapManifests, gapReportOnlyManifest } from './helpers/evidence-gap-prepare.mjs';
import { EVIDENCE_PROTOCOL, evidencePrompt, sha256, evidenceSeed, fingerprint } from './helpers/evidence-acceptance.mjs';

const base = () => ({ sourceHash: 'a'.repeat(64), runtime: 'autonomy-test:gap', variant: 'resolvable',
  fixture: { path: 'tests/fixtures/evidence-gap-site.mjs', sha256: 'b'.repeat(64), origin: 'https://gap.example.test', resultPath: '/search', queryKey: 'q' },
  trials: [{ workspaceId: 'workspace', userId: 'owner', accountFile: '.data/autonomy-isolation/account.json' }], driverSha256: 'c'.repeat(64), helperSha256: 'd'.repeat(64),
  receiptFile: '.data/autonomy-isolation/gap-receipt.json', acceptancePath: '.data/autonomy-isolation/gap-acceptance.json' });
test('dedicated GET search fixture exposes discoverable products, matching and empty outcomes', () => {
  assert.match(evidenceSearchPage('/').body, /Björklykta/); assert.doesNotMatch(evidenceSearchPage('/').body, /Inga produkter/);
  const match = evidenceSearchPage('/search?q=Bj%C3%B6rk'); assert.equal(match.status, 200); assert.match(match.body, /1 träff/); assert.match(match.body, /Björklykta/);
  const empty = evidenceSearchPage('/search?q=ingen-match-41929'); assert.match(empty.body, /Inga produkter matchar/); assert.match(empty.body, /Prova ett annat/);
  assert.doesNotMatch(evidenceSearchPage('/search?q=%3Cscript%3E').body, /<script>/); assert.equal(evidenceSearchPage('/search?q=' + 'x'.repeat(201)).status, 400);
  const response = { writeHead(code) { this.code = code; }, end(body) { this.body = body; } };
  evidenceSearchHandler({ method: 'POST', url: '/search' }, response); assert.equal(response.code, 405);
  evidenceSearchHandler({ method: 'HEAD', url: '/' }, response); assert.equal(response.code, 200); assert.equal(response.body, undefined);
});
test('fresh manifests lock exact acceptance bytes and fault routing without giving the model query or oracle', () => {
  for (const variant of ['resolvable', 'persistent']) {
    const value = gapManifests({ ...base(), variant });
    assert.equal(value.driver.acceptanceManifestSha256, sha256(value.acceptanceBytes)); assert.equal(value.acceptance.variant, variant);
    assert.deepEqual(value.acceptance.trials[0].selection, []);
    const prompt = evidencePrompt(value.acceptance, value.acceptance.trials[0]);
    assert.match(prompt, /både kan visa träffar/); assert.doesNotMatch(prompt, /Björk|\/search|q=|missing_observation|workspace|owner/);
  }
  const changed = base(); changed.trials[0].selection = []; assert.throws(() => gapManifests(changed), /existing results/);
  assert.throws(() => gapManifests({ ...base(), variant: 'report-only' }));
});
test('manifest compiler separates per-trial observation from the fixed whole-driver duration', () => {
  const input = base(); input.trials = [1, 2, 3].map(n => ({ ...input.trials[0], workspaceId: `workspace_${n}` }));
  for (const seconds of [60, 600, 1500]) {
    const value = gapManifests({ ...input, observationSeconds: seconds });
    assert.equal(value.acceptance.observationSeconds, seconds); assert.equal(value.driver.perTrialSeconds, seconds);
    assert.equal(value.driver.maxSeconds, seconds * 3); assert.equal(value.driver.acceptanceManifestSha256, sha256(value.acceptanceBytes));
  }
  assert.throws(() => gapManifests({ ...input, observationSeconds: 1501 }));
});
function origin() {
  const run = { id: 'run-original', item_id: 'plan', case_id: 'case', plan_version: 1, runtime: 'autonomy-test:gap',
    snapshot: { type: 'browser', title: 'Sökfunktion' }, target: { scope: { kind: 'observation', id: 'original-scope', capturedAt: '2026-10-05T10:00:00Z' } },
    result: { outcome: 'inconclusive' }, started_at: '2026-10-05T10:00:00Z', finished_at: '2026-10-05T10:01:00Z', mission_attempt_id: 'attempt-browser' };
  const state = { missions: [{ id: 'mission', thread_id: 'thread', lifecycle: 'closed', plan_revision: 1 }],
    tasks: [{ mission_id: 'mission', supplement_round: 1, spec: { complement: { runId: run.id, sourceAttemptId: 'attempt-browser', assessmentId: 'review', inputHash: 'ih', sourceHash: 'sh', reviewerVersion: '6', planRevision: 1 } } }],
    attempts: [{ kind: 'review', reviewCalls: [{ reviewId: 'review', providerCalls: 1 }] }], runs: [run],
    reviews: [{ id: 'review', run_id: run.id, status: 'completed', input_hash: 'ih', source_hash: 'sh', reviewer_version: '6', assessment: { verdict: 'needs_evidence' } }],
    captures: [{ id: 'capture', run_id: run.id, item_id: 'item', version: 1, content: {}, provenance: { origin: 'tool', producer: 'test-capture', sourceType: 'test', sourceId: run.id, sha256: 'd'.repeat(64) } }], items: [] };
  return { protocol: EVIDENCE_PROTOCOL, taskId: 'GAP-13', variant: 'resolvable', runtime: 'autonomy-test:gap', sourceHash: 'e'.repeat(64), attempts: [{ workspaceId: 'workspace', acceptedAt: '2026-10-05T10:00:00Z', threadId: 'thread', snapshots: [state] }] };
}
const reportOnly = value => gapReportOnlyManifest({ originBytes: Buffer.from(JSON.stringify(value)), originPath: '.data/autonomy-isolation/preserved-gap.json', sourceHash: 'a'.repeat(64), runtime: 'autonomy-test:gap', accountFiles: { workspace: '.data/autonomy-isolation/account.json' } });
test('report-only selects original gapped run and preserves observation target/seed, never the successful newer run', () => {
  const saved = origin(), state = saved.attempts[0].snapshots[0]; state.runs.push({ ...state.runs[0], id: 'new-success', result: { outcome: 'passed' } });
  const m = reportOnly(saved), trial = m.trials[0]; assert.deepEqual(trial.selection.map(s => s.id), ['run-original']);
  assert.equal(trial.seedHash, fingerprint(evidenceSeed(state, trial.selection))); assert.equal(m.variant, 'report-only'); assert.equal(m.fault, undefined);
  assert.match(trial.selection[0].label, /ursprunglig körning/); assert.equal(trial.originArtifacts[0].sha256, sha256(Buffer.from(JSON.stringify(saved))));
});
test('new report-only prompt may cite an unchanged v1 GAP artifact without relabelling its history', () => {
  const saved = { ...origin(), protocol: 'syna-evidence-acceptance-v1' }, before = structuredClone(saved);
  const manifest = reportOnly(saved);
  assert.equal(manifest.protocol, 'syna-evidence-acceptance-v3');
  assert.match(evidencePrompt(manifest, manifest.trials[0]), /spara en rapport/);
  assert.equal(manifest.trials[0].originArtifacts[0].sha256, sha256(Buffer.from(JSON.stringify(saved))));
  assert.deepEqual(saved, before);
  assert.throws(() => reportOnly({ ...saved, protocol: 'syna-evidence-acceptance-v999' }), /Unsupported/);
});
test('report-only manifest refuses unfinished, fabricated, foreign-runtime or misbound gap originals', () => {
  for (const mutate of [o => o.runtime = 'autonomy-test:other', o => o.attempts[0].acceptedAt = null,
    o => o.attempts[0].snapshots[0].missions[0].lifecycle = 'running', o => o.attempts[0].snapshots[0].attempts[0].reviewCalls = [],
    o => o.attempts[0].snapshots[0].tasks[0].spec.complement.inputHash = 'different', o => o.attempts[0].snapshots[0].runs[0].mission_attempt_id = null,
    o => o.attempts[0].snapshots[0].captures[0].provenance.origin = 'agent']) {
    const value = origin(); mutate(value); assert.throws(() => reportOnly(value));
  }
});
