import test from 'node:test';
import assert from 'node:assert/strict';
import { EVIDENCE_POLICY_VERSION, evidenceProvenanceSchema, isIndependentEvidence, normalizeEvidenceProvenance, sanitizeEvidenceUrl } from '../shared/evidence-provenance.ts';

const observation = { version: 1, origin: 'tool', producer: 'research-page', observedAt: '2026-10-05T11:00:00.000Z' };
const evidence = { evidencePolicyVersion: EVIDENCE_POLICY_VERSION, origin: 'tool', provenance: observation, unavailable: false };

test('independent evidence requires current policy, consistent tool origin and a known producer', () => {
  for (const producer of ['research-page', 'browser-screenshot', 'test-capture', 'repository-runner', 'environment-probe']) {
    assert.equal(isIndependentEvidence({ ...evidence, provenance: { ...observation, producer } }), true);
  }
  for (const change of [{ evidencePolicyVersion: undefined }, { evidencePolicyVersion: 1 }, { evidencePolicyVersion: 3 }, { origin: 'source' }, { origin: 'agent' }, { origin: undefined }, { unavailable: true }, { provenance: undefined }, { provenance: null }]) {
    assert.equal(isIndependentEvidence({ ...evidence, ...change }), false);
  }
});

test('unknown history, user uploads and agent narratives never gain independence from hashes or source IDs', () => {
  for (const [origin, producer] of [['unknown', 'unknown'], ['user', 'user-authored'], ['agent', 'agent-authored']]) {
    const provenance = { version: 1, origin, producer, observedAt: null, sourceType: 'test', sourceId: 'known-run', sha256: 'a'.repeat(64) };
    assert.deepEqual(normalizeEvidenceProvenance(provenance), provenance);
    assert.equal(isIndependentEvidence({ ...evidence, origin, provenance }), false);
    assert.equal(isIndependentEvidence({ ...evidence, provenance }), false, 'Relabeling the outer origin cannot upgrade a narrative');
  }
  assert.equal(normalizeEvidenceProvenance(null), null);
  assert.equal(normalizeEvidenceProvenance({ origin: 'source' }), null);
});

test('capture metadata can describe capture status but cannot replace observed image evidence', () => {
  const provenance = { ...observation, producer: 'capture-metadata', sourceType: 'test', sourceId: 'actual-run' };
  assert.deepEqual(evidenceProvenanceSchema.parse(provenance), provenance);
  assert.equal(isIndependentEvidence({ ...evidence, provenance }), false);
  assert.equal(isIndependentEvidence({ ...evidence, provenance: { ...provenance, producer: 'test-capture' } }), true);
});

test('invalid versions, producer pairs, timestamps and byte digests fail closed', () => {
  for (const change of [
    { version: 0 }, { version: 2 }, { producer: 'agent-authored' }, { producer: 'claimed-tool' },
    { origin: 'user' }, { origin: 'source' }, { observedAt: 'yesterday' },
    { sha256: 'not-a-digest' }, { sourceType: 'untrusted-tool' }, { sourceId: '' },
    { trusted: true },
  ]) {
    const invalid = { ...observation, ...change };
    assert.equal(evidenceProvenanceSchema.safeParse(invalid).success, false);
    assert.equal(normalizeEvidenceProvenance(invalid), null);
    assert.equal(isIndependentEvidence({ ...evidence, provenance: invalid }), false);
  }
  assert.equal(evidenceProvenanceSchema.safeParse({ ...observation, observedAt: null }).success, true, 'Unknown observation time is preserved, not fabricated');
});

test('trusted observation URLs are HTTP(S), credential-free and separate from editable links', () => {
  for (const url of ['https://example.test/path?view=summary', 'http://127.0.0.1:3000/', null, undefined]) {
    assert.equal(evidenceProvenanceSchema.safeParse({ ...observation, url }).success, true);
  }
  for (const url of ['javascript:alert(1)', 'file:///workspace/app', 'ftp://example.test/file', 'https://user:secret@example.test/', '/relative', 'not a URL']) {
    assert.equal(evidenceProvenanceSchema.safeParse({ ...observation, url }).success, false);
    assert.equal(sanitizeEvidenceUrl(url), null);
  }
  const url = new URL(sanitizeEvidenceUrl('https://example.test/path?view=summary&access_token=secret&code=oauth-secret#access_token=fragment-secret'));
  assert.equal(url.pathname, '/path');
  assert.equal(url.searchParams.get('view'), 'summary');
  assert.equal(url.searchParams.get('access_token'), '[REDACTED]');
  assert.equal(url.searchParams.get('code'), '[REDACTED]');
  assert.equal(url.hash, '');
  assert.equal(sanitizeEvidenceUrl('https://example.test/path#section-2'), 'https://example.test/path#section-2');
});
