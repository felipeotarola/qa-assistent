import { test } from 'node:test';
import assert from 'node:assert/strict';
import { missionReportWriterContext } from '../shared/mission-report-context.ts';
import { reportEvidenceAvailability } from '../shared/mission-report-remediation.ts';

function reviewFixture() {
  const target = { environment: 'Public web', revision: '', url: 'https://fixture.example.test/', scope: { kind: 'observation', id: 'f67edbde-c7b4-4a98-a18e-71912b9360b6', capturedAt: '2026-10-05T10:00:00Z' } };
  const evidence = { id: 'capture', itemId: 'item', title: 'Click receipt', version: 3, hash: 'content-hash', kind: 'text', origin: 'tool', evidencePolicyVersion: 2,
    unavailable: false, excerpt: 'Raw observation must be read separately', observedAt: '2026-10-05T10:01:00Z', url: target.url,
    provenance: { version: 1, origin: 'tool', producer: 'browser-action', sourceType: 'test', sourceId: 'run', observedAt: '2026-10-05T10:01:00Z', sha256: 'a'.repeat(64) } };
  const source = { schemaVersion: 2, sourceType: 'test', sourceId: 'run', sourceRevision: 'source-hash', attemptId: 'attempt', status: 'completed', target,
    startedAt: '2026-10-05T10:00:00Z', finishedAt: '2026-10-05T10:02:00Z', reportedOutcome: 'achieved', summary: 'Executor narrative', limitations: ['Unknown release version'],
    claims: [{ id: 'step-1', requirement: 'Click the main navigation link', reportedStatus: 'mismatch', reportedActual: 'Actual failed result' }],
    assessment: { id: 'review', sourceHash: 'review-input-hash', reviewerVersion: '3', verdict: 'supported', summary: 'Full review explanation', stale: false,
      findings: [{ requirementId: 'step-1', verdict: 'supported', evidenceIds: ['capture'], explanation: 'Exact negative outcome is evidenced', suggestedNextStep: 'Preserve the negative finding' }] },
    evidence: [evidence, { ...evidence, id: 'unread', itemId: 'unread-item', title: 'Other receipt', hash: 'another-hash' }],
  };
  const snapshot = { schemaVersion: 2, revision: 9, capturedAt: '2026-10-05T10:03:00Z', inputFingerprint: 'snapshot-hash',
    config: { goal: 'Inspect navigation and report findings', criteria: [{ id: 'qa', text: 'Inspect selected cases', delivery: { kind: 'test_cases', caseKeys: ['case'] } }], target },
    delivery: { complete: true, criteria: [{ criterionId: 'qa', complete: true, gaps: [] }], cases: [], gaps: [] },
    tasks: [{ id: 'execution', title: 'Execute', criterionIds: ['qa'], sources: [source] }, { id: 'reviewing', title: 'Review', criterionIds: ['qa'], sources: [source] }] };
  return { snapshot, source, evidence };
}

test('active writer context preserves original criteria, exact frozen identities and explicitly labelled executor claims', () => {
  const { snapshot, source, evidence } = reviewFixture(), before = structuredClone(snapshot);
  const output = missionReportWriterContext(snapshot, new Set(['capture']));
  assert.equal(output.sources.length, 1);
  assert.deepEqual(output.sources[0].criterionIds, ['qa']);
  assert.deepEqual(output.sources[0].reportedClaims, { basis: 'executor_claims_not_observation_bytes', items: source.claims });
  const reference = { ...evidence }; delete reference.excerpt;
  assert.deepEqual(output.sources[0].evidence, [reference]);
  assert.equal(output.inputFingerprint, snapshot.inputFingerprint);
  assert.deepEqual(output.criteria, snapshot.config.criteria);
  assert.deepEqual(output.target, snapshot.config.target);
  assert.equal(output.sources[0].sourceRevision, source.sourceRevision);
  assert.equal(output.sources[0].attemptId, source.attemptId);
  assert.equal(output.sources[0].assessment, undefined);
  assert.equal(output.sources[0].summary, undefined);
  assert.equal(output.sources[0].limitations, undefined);
  assert.equal(output.sources[0].context, undefined);
  assert.ok(!JSON.stringify(output).includes('Raw observation must be read separately'));
  assert.deepEqual(snapshot, before);
});

test('pruned unread metadata cannot merge changed versions or conflicting evidence identities', () => {
  const { snapshot, source } = reviewFixture();
  snapshot.tasks[0].sources.push({ ...source, evidence: [source.evidence[0], { ...source.evidence[1], hash: 'changed-unread-hash' }] }, { ...source, sourceRevision: 'different-version' });
  const output = missionReportWriterContext(snapshot, new Set(['capture']));
  assert.equal(output.sources.length, 3);
  assert.equal(output.sources[2].sourceRevision, 'different-version');
  assert.ok(output.sources.every(value => value.evidence.length === 1 && value.evidence[0].id === 'capture'));
});

test('unread source diagnostics stay outside writer context and remain separate code-owned availability dimensions', () => {
  const { snapshot, source } = reviewFixture(); source.target = null;
  snapshot.config.criteria[0].delivery = { kind: 'source', sourceTypes: ['test'], sourceRefs: [{ type: 'test', id: 'run' }] };
  const before = structuredClone(snapshot), output = missionReportWriterContext(snapshot, new Set());
  assert.deepEqual(output.sources, []);
  assert.deepEqual(output.criteria, snapshot.config.criteria);
  assert.deepEqual(output.evidenceSelection.readEvidenceIds, []);
  assert.deepEqual(reportEvidenceAvailability(snapshot, new Map()), { registered: 2, fullyRead: 0, unread: 2, unavailable: 0, limited: 0, policyExcluded: 2 });
  assert.deepEqual(snapshot, before);
});

test('code-owned read counters distinguish unread, limited, unavailable and full reads without treating metadata as proof', () => {
  const { snapshot, source, evidence } = reviewFixture();
  snapshot.config.criteria[0].delivery = { kind: 'source', sourceTypes: ['test'], sourceRefs: [{ type: 'test', id: 'run' }] };
  source.evidence = ['full', 'unread', 'unavailable', 'limited'].map(id => ({ ...evidence, id }));
  const reads = new Map([['full', { id: 'full', text: 'read' }], ['unavailable', { id: 'unavailable', unavailable: true }], ['limited', { id: 'limited', limited: true, text: 'partial' }]]);
  assert.deepEqual(reportEvidenceAvailability(snapshot, reads), { registered: 4, fullyRead: 1, unread: 1, unavailable: 1, limited: 1, policyExcluded: 0 });
  const output = missionReportWriterContext(snapshot, new Set(['full']));
  assert.deepEqual(output.sources[0].evidence.map(item => item.id), ['full']);
  assert.equal(output.sources[0].evidenceAvailability, undefined);
  source.evidence = [];
  assert.deepEqual(reportEvidenceAvailability(snapshot, reads), { registered: 0, fullyRead: 0, unread: 0, unavailable: 0, limited: 0, policyExcluded: 0 });
});
