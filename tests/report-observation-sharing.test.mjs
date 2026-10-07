import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { sharedReportDocument } from '../shared/report-sharing.ts';

function source() {
  return { schemaVersion: 1, title: 'Report', capturedAt: '2026-10-06T00:00:00Z', revision: 1, goal: 'Inspect original evidence', scope: 'Saved', target: 'A', partial: true, summary: 'System status', limitations: [],
    criteria: [{ id: 'c', text: 'Original criterion', delivery: { internal: true } }], tasks: [], tests: [], metrics: [],
    findings: [{ criterionId: 'c', verdict: 'needs_evidence', conclusion: 'System status', nextStep: 'Collect independent evidence', evidenceIds: ['e'], completionStatement: 'Original gap remains', privateMandate: 'must-not-share',
      observations: [{ text: 'A saved note claims success at http://127.0.0.1:3000', evidenceIds: ['e'], originLabel: 'Agentpåstående; inte oberoende verifiering', privateSource: 'must-not-share' }] }],
    evidence: [{ id: 'e', title: 'Note', itemId: 'private-id', version: 1, kind: 'text', url: null, observedAt: null, read: true }],
  };
}
const text = readFileSync(new URL('./autonomy-sharing.acceptance.mjs', import.meta.url), 'utf8');
const fn = text.slice(text.indexOf('function publicProjection('), text.indexOf("let cookie = ''"));
const audit = runInNewContext(`(${fn.trim()})`, { assert });

test('new observations are allowlisted, source-labelled and individually citation-bound in public reports', () => {
  const doc = sharedReportDocument(source(), ['e']);
  assert.doesNotThrow(() => audit(doc));
  assert.equal(doc.findings[0].observations[0].originLabel, 'Agentpåstående; inte oberoende verifiering');
  assert.ok(!JSON.stringify(doc).includes('must-not-share')); assert.ok(!JSON.stringify(doc).includes('127.0.0.1'));
  assert.equal(doc.findings[0].completionStatement, 'Original gap remains');
  const bad = structuredClone(doc); bad.findings[0].observations[0].privateAuthority = 'denied'; assert.throws(() => audit(bad));
  delete bad.findings[0].observations[0].privateAuthority; bad.findings[0].observations[0].evidenceIds = ['foreign']; assert.throws(() => audit(bad));
});

test('historical documents without observation fields preserve their original prose and public shape', () => {
  const old = source(); delete old.findings[0].observations; delete old.findings[0].completionStatement;
  old.summary = 'Historical saved summary'; old.findings[0].conclusion = 'Historical saved conclusion';
  const doc = sharedReportDocument(old, []);
  assert.doesNotThrow(() => audit(doc)); assert.equal(doc.summary, old.summary); assert.equal(doc.findings[0].conclusion, old.findings[0].conclusion);
  assert.equal(Object.hasOwn(doc.findings[0], 'observations'), false); assert.equal(Object.hasOwn(doc.findings[0], 'completionStatement'), false);
});

test('saved review public projection strips every private binding and future fields while preserving bounded negative prose', () => {
  const value = source(), observation = value.findings[0].observations[0];
  observation.subject = { requirement: 'Use the product return control.', relation: 'supports', checkRef: 'PRIVATE_CHECK_REF' };
  observation.savedReview = { version: 1, reportedStatus: 'mismatch', reportedActual: 'The return control opened an HTTP 404 page.', reviewerVersion: '17',
    finding: { verdict: 'supported', explanation: 'Saved pixels and trace both show HTTP 404.', suggestedNextStep: '', gap: { kind: 'missing_observation', capability: 'browser', wantedEvidence: 'Observation in http://127.0.0.1:3000', privateTrace: 'PRIVATE_TRACE' }, privatePrompt: 'PRIVATE_PROMPT' },
    binding: { reviewId: 'PRIVATE_REVIEW', runId: 'PRIVATE_RUN', checkId: 'PRIVATE_CHECK', sourceHash: 'PRIVATE_HASH', inputHash: 'PRIVATE_INPUT', sourceRevision: 'PRIVATE_REVISION', originalEvidenceIds: ['PRIVATE_ORIGINAL'] },
    privateAttempt: 'PRIVATE_ATTEMPT',
  };
  const doc = sharedReportDocument(value, ['e']); assert.doesNotThrow(() => audit(doc));
  assert.ok(!JSON.stringify(doc).includes('PRIVATE_')); assert.ok(!JSON.stringify(doc).includes('127.0.0.1'));
  const saved = doc.findings[0].observations[0].savedReview;
  assert.equal(saved.reportedActual, observation.savedReview.reportedActual); assert.equal(saved.finding.explanation, observation.savedReview.finding.explanation);
  const forged = structuredClone(doc); forged.findings[0].observations[0].savedReview.binding = {};
  assert.throws(() => audit(forged));
});
