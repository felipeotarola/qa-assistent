import assert from 'node:assert/strict';
import { fingerprint } from './evidence-acceptance.mjs';

export const GOLDEN_PROTOCOL = 'syna-evidence-preparation-v1';
export const GOLDEN_LABEL = 'SYNTHETIC GOLDEN FIXTURE — no browser or provider executed';
export const GOLDEN_REVIEW_MODEL = 'synthetic-golden-reviewer';
const url = 'https://evidence-fixture.example.test/';
const target = revision => revision ? { environment: 'Synthetic golden QA', url, revision } : null;
const row = (title, revision, outcome, steps, expected, observation) => ({ title, target: target(revision), outcome, steps, expected, observation });

/** Fixture facts are data for the real future reporter, never instructions or
 * model answers. The only model double is the explicitly declared preparation
 * reviewer. No real Iris/website/provider execution is claimed. */
export function goldenRecipe(taskId) {
  const common = { taskId, title: `Syntetiskt rapportunderlag ${taskId}`, disclaimer: GOLDEN_LABEL };
  if (taskId === 'REP-05') return { ...common, cases: [
    row('Startsidan – sparad godkänd kontroll', 'A', 'passed', 'Öppna startsidan.', 'Huvudrubriken visas.', 'Startsidan visar huvudrubriken Välkommen.'),
    row('Kontaktlänken – sparad avvikelse', 'A', 'failed', 'Klicka på Kontakt från startsidan.', 'Kontaktsidan visas.', 'Klick på Kontakt gav en felsida med HTTP 404.'),
    row('Sökningen – sparad ofullständig kontroll', 'A', 'inconclusive', 'Sök efter en vara.', 'Sökresultatet visas.', 'Sökfältet finns, men sökningen utfördes inte och resultatet observerades aldrig.'),
  ], note: null };
  if (taskId === 'REP-06') return { ...common, cases: [
    row('Navigation – sparad kontroll av version A', 'A', 'passed', 'Öppna menyn.', 'Menyn visas.', 'Menyn visas i version A. Detta observerar inte version B.'),
    row('Startsida – sparad kontroll av version B', 'B', 'passed', 'Öppna startsidan.', 'Huvudrubriken visas.', 'Huvudrubriken visas i version B. Menyn kontrollerades inte.'),
    row('Sökfält – sparad kontroll utan känd version', null, 'inconclusive', 'Öppna sidan med sökfältet.', 'Sökfältet visas.', 'Ett sökfält visas, men versionen är okänd. Ingen observation knyter detta till version B.'),
  ], note: null };
  if (taskId === 'REP-07') return { ...common, cases: [
    row('Inloggningslänken – sparat navigeringsklick', 'A', 'failed', 'Klicka på Logga in från startsidan.', 'Inloggningssidan öppnas.', 'Klick på Logga in lämnade startsidan oförändrad. Ingen inloggning utfördes.'),
    row('Inloggningssidan – separat sparad direktöppning', 'A', 'passed', 'Öppna inloggningssidan via direkt adress.', 'Inloggningssidan är tillgänglig.', 'Direktadressen visar inloggningssidan. Inga användaruppgifter fylldes i och ingen inloggning verifierades.'),
  ], note: { title: 'Agentens sparade slutsats om inloggning', text: `${GOLDEN_LABEL}\nAgentförfattat påstående: Inloggningen fungerar.\nDetta är en syntetisk agentanteckning, inte en separat observation.` } };
  throw new Error('Golden preparation supports REP-05/06/07 only');
}

export function goldenResult(testCase, checks, evidenceItemId) {
  const incomplete = testCase.outcome === 'inconclusive';
  return { schemaVersion: 2, outcome: testCase.outcome, actual: `${GOLDEN_LABEL}\n${testCase.observation}`, observations: [], evidenceItemIds: [evidenceItemId],
    checks: checks.map(check => ({ id: check.id, status: incomplete ? 'unverified' : testCase.outcome === 'failed' ? 'mismatch' : 'verified', actual: `${GOLDEN_LABEL}\n${testCase.observation}` })),
    remaining: incomplete ? checks.map(check => ({ checkId: check.id, reason: testCase.observation })) : [] };
}

export function goldenAssessment(input, attachments) {
  assert.ok(attachments.some(a => a.type === 'text' && a.text.includes(GOLDEN_LABEL)), 'Real worker must read labelled actual bytes');
  const proof = input.evidence.find(e => e.readStatus === 'read'); assert.ok(proof, 'Metadata alone is insufficient');
  const gap = input.reportedResult.outcome === 'inconclusive' || !input.target;
  return { verdict: gap ? 'needs_evidence' : 'supported', summary: `${GOLDEN_LABEL}. Deterministic preparation review only.`, findings: input.requirements.map(r => ({ requirementId: r.id,
    verdict: gap ? 'needs_evidence' : 'supported', evidenceIds: [proof.id], explanation: `${GOLDEN_LABEL}. ${gap ? 'Observation or target is incomplete.' : 'Stored fixture bytes support the original observation, including any product defect.'}`,
    suggestedNextStep: '', gap: gap ? { kind: 'missing_observation', capability: 'none', wantedEvidence: 'Complete observation for the original check and its target.' } : null })) };
}

/** Execute/audit compares the entire saved seed and original review receipts,
 * not merely a self-asserted synthetic=true label. This remains fixture proof,
 * never a physical website/provider receipt. */
export function validateGoldenArtifact(artifact, { taskId, runtime, workspaceId, seed, reviews, reviewerVersion }) {
  assert.equal(artifact.protocol, GOLDEN_PROTOCOL); assert.equal(artifact.preparation, 'synthetic-golden');
  assert.equal(artifact.taskId, taskId); assert.equal(artifact.runtime, runtime); assert.equal(artifact.realProviderCalls, 0); assert.equal(artifact.realBrowserActions, 0);
  assert.equal(artifact.reviewerVersion, reviewerVersion); assert.equal(artifact.reviewMethod, 'authored-worker-with-deterministic-model-fixture');
  assert.ok(!artifact.isolationFailure && !artifact.preparationFailed && artifact.completedAt && artifact.authoringHashes && Object.keys(artifact.authoringHashes).length >= 3);
  assert.ok(Object.values(artifact.authoringHashes).every(hash => /^[a-f0-9]{64}$/.test(hash)), 'Preparation code identities must be SHA-256');
  const trial = artifact.trials.find(t => t.workspaceId === workspaceId); assert.ok(trial);
  // The immutable preparation receipt is JSON, whereas postgres.js returns
  // timestamp columns as Date. Compare the same JSON semantics used by the
  // prelocked seedHash; never rewrite the receipt or accept changed values.
  assert.equal(trial.seedHash, fingerprint(seed));
  assert.equal(fingerprint(trial.seed), fingerprint(seed), 'Original golden seed differs from its persisted JSON receipt');
  assert.ok(seed.runs.every(run => !run.mission_attempt_id && run.result.actual.includes(GOLDEN_LABEL)), 'Do not relabel a real execution as synthetic');
  for (const run of seed.runs) {
    const locked = trial.reviews.find(r => r.run_id === run.id), saved = reviews.find(r => r.id === locked?.id);
    assert.ok(locked && saved && saved.status === 'completed' && saved.reviewer_version === reviewerVersion);
    assert.ok(saved.model === GOLDEN_REVIEW_MODEL || saved.model === 'deterministic-rules' && saved.assessment?.verdict === 'needs_evidence', 'Only a labelled fixture model or an explicitly incomplete deterministic assessment is preparation');
    assert.equal(saved.assessment?.verdict, run.result.outcome === 'inconclusive' || !run.target ? 'needs_evidence' : 'supported', 'Golden review must preserve its intended evidence gap or observed defect');
    assert.equal(fingerprint(saved), fingerprint(locked), 'Golden review receipt changed');
  }
  return { preparation: artifact.preparation, realProviderCalls: 0, realBrowserActions: 0, reviewerVersion, preparedAt: artifact.completedAt };
}
