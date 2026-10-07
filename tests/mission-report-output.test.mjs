import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { missionReportOutput } from '../shared/mission-report-output.ts';
import { assembleReport, validateReport } from '../shared/mission-report.ts';
import { DELIVERY_POLICY_VERSION } from '../shared/mission-delivery.ts';

function fixture(count = 1) {
  const target = { environment: 'QA', url: 'https://fixture.example.test/', revision: 'saved-commit' };
  const sources = Array.from({ length: count }, (_, index) => {
    const id = `run-${index}`, text = `Independent observed product failure for ${id}`;
    const sha256 = createHash('sha256').update(text).digest('hex');
    return { schemaVersion: 2, sourceType: 'test', sourceId: id, status: 'completed', target,
      startedAt: '2026-10-06T10:00:00Z', finishedAt: '2026-10-06T10:01:00Z',
      evidence: [{ id: `proof-${index}`, kind: 'text', title: 'Saved observation', hash: sha256, origin: 'tool', evidencePolicyVersion: 2,
        observedAt: '2026-10-06T10:00:30Z', provenance: { version: 1, origin: 'tool', producer: 'browser-action', sourceType: 'test', sourceId: id, observedAt: '2026-10-06T10:00:30Z', sha256 } }], text };
  });
  const criteria = sources.map((source, index) => ({ id: `criterion-${index}`, text: `Inspect saved run ${index}`,
    delivery: { kind: 'source', sourceTypes: ['test'], sourceRefs: [{ type: 'test', id: source.sourceId }] } }));
  const snapshot = { schemaVersion: 2, config: { title: 'Report', goal: 'Report saved observations', scope: 'Saved runs', target, criteria, caseKeys: [] },
    tasks: sources.map((source, index) => ({ id: `task-${index}`, criterionIds: [criteria[index].id], sources: [source] })),
    delivery: { schemaVersion: DELIVERY_POLICY_VERSION, complete: true, criteria: criteria.map(c => ({ criterionId: c.id, complete: true, gaps: [] })), cases: [], gaps: [] },
    tests: sources.map(source => ({ runId: source.sourceId, status: 'failed', originalOutcome: 'failed' })), metrics: [], gaps: [] };
  const reads = new Map(sources.map(source => [source.evidence[0].id, { id: source.evidence[0].id, text: source.text, digest: source.evidence[0].provenance.sha256 }]));
  const draft = { summary: 'Saved observations substantiate a product failure.', findings: criteria.map((c, index) => ({ criterionId: c.id, verdict: 'supported', conclusion: 'The negative observation is substantiated.', evidenceIds: [sources[index].evidence[0].id], nextStep: '' })), limitations: [] };
  return { snapshot, reads, draft, source: sources[0] };
}

// The provider returns only the current wire; legacy ReportDraft remains an
// internal validator fixture, never accepted as new physical model output.
const writerWire = draft => ({ findings: draft.findings.map(({ criterionId, verdict, conclusion, evidenceIds }) => ({ criterionId, verdict,
  observations: evidenceIds.length ? [{ text: conclusion, evidenceIds: [...evidenceIds] }] : [] })) });
const verdicts = f => missionReportOutput(f.snapshot, f.reads).criteria[0].allowedVerdicts;

test('fully read applicable evidence permits a complete negative report without changing product outcome', () => {
  const f = fixture(), before = JSON.stringify(f.snapshot);
  const output = missionReportOutput(f.snapshot, f.reads);
  assert.deepEqual(output.criteria[0].allowedVerdicts, ['supported', 'needs_evidence', 'contradicted']);
  assert.deepEqual(output.schema.parse(writerWire(f.draft)), writerWire(f.draft));
  const validated = validateReport(f.snapshot, f.draft, new Set(f.reads.keys()), f.reads);
  const report = assembleReport(f.snapshot, validated, new Set(f.reads.keys()));
  assert.equal(report.partial, false); assert.equal(report.tests[0].status, 'failed');
  assert.equal(report.tests[0].originalOutcome, 'failed'); assert.equal(JSON.stringify(f.snapshot), before);
});

test('incomplete delivery forbids supported but retains evidence-based contradiction and honest partial prose', () => {
  const f = fixture(); f.snapshot.delivery.complete = false; f.snapshot.delivery.criteria[0].complete = false;
  const output = missionReportOutput(f.snapshot, f.reads);
  assert.deepEqual(output.criteria[0].allowedVerdicts, ['needs_evidence', 'contradicted']);
  assert.match(output.criteria[0].constraint, /complete criterion delivery/);
  assert.equal(output.schema.safeParse(writerWire(f.draft)).success, false);
  for (const verdict of ['needs_evidence', 'contradicted']) {
    const draft = { ...f.draft, findings: [{ ...f.draft.findings[0], verdict }] };
    assert.deepEqual(output.schema.parse(writerWire(draft)), writerWire(draft));
    assert.doesNotThrow(() => validateReport(f.snapshot, draft, new Set(f.reads.keys()), f.reads));
    assert.equal(assembleReport(f.snapshot, draft, new Set(f.reads.keys())).partial, true);
    assert.equal(draft.findings[0].conclusion, f.draft.findings[0].conclusion, 'No silent semantic rewrite');
  }
});

test('no read, failed read, stale source, false provenance, wrong run/target or wrong bytes permit only needs_evidence', () => {
  for (const change of [
    f => f.reads.clear(),
    f => { f.reads.get('proof-0').limited = true; },
    f => { f.reads.get('proof-0').unavailable = true; },
    f => { f.reads.get('proof-0').digest = 'b'.repeat(64); },
    f => { f.source.evidence[0].stale = true; },
    f => { f.source.evidence[0].origin = 'agent'; },
    f => { f.source.evidence[0].provenance = null; },
    f => { f.source.evidence[0].provenance.sourceId = 'other-run'; },
    f => { f.source.target = { ...f.source.target, revision: 'other-commit' }; },
    f => { f.source.evidence[0].observedAt = '2026-10-06T11:00:00Z'; },
    f => { f.snapshot.schemaVersion = 1; },
  ]) {
    const f = fixture(); change(f); const output = missionReportOutput(f.snapshot, f.reads);
    assert.deepEqual(output.criteria[0].allowedVerdicts, ['needs_evidence']);
    for (const verdict of ['supported', 'contradicted']) {
      const draft = { ...f.draft, findings: [{ ...f.draft.findings[0], verdict }] };
      assert.equal(output.schema.safeParse(writerWire(draft)).success, false);
      assert.throws(() => validateReport(f.snapshot, draft, new Set([...f.reads.values()].filter(r => !r.limited && !r.unavailable).map(r => r.id)), f.reads));
    }
  }
});

test('criterion identity and citations cannot borrow another criterion or omit one using a duplicate', () => {
  const f = fixture(2), output = missionReportOutput(f.snapshot, f.reads);
  assert.deepEqual(output.schema.parse(writerWire(f.draft)), writerWire(f.draft));
  for (const findings of [
    [f.draft.findings[0], f.draft.findings[0]],
    [f.draft.findings[0]],
    [{ ...f.draft.findings[0], criterionId: 'invented' }, f.draft.findings[1]],
    [{ ...f.draft.findings[0], evidenceIds: ['proof-1'] }, f.draft.findings[1]],
  ]) assert.equal(output.schema.safeParse(writerWire({ ...f.draft, findings })).success, false);
  const json = z.toJSONSchema(output.schema);
  assert.equal(json.properties.findings.minItems, 2);
  assert.equal(json.properties.findings.items.oneOf.length, 2);
});

test('support requires actually read evidence for every exact source, and final validator still checks chosen citations', () => {
  const f = fixture(2), second = f.snapshot.tasks[1].sources[0];
  f.snapshot.config.criteria = [f.snapshot.config.criteria[0]];
  f.snapshot.config.criteria[0].delivery.sourceRefs.push({ type: 'test', id: second.sourceId });
  f.snapshot.tasks[0].sources.push(second); f.snapshot.tasks.pop();
  f.snapshot.delivery.criteria = [f.snapshot.delivery.criteria[0]];
  f.draft.findings = [f.draft.findings[0]];
  const secondRead = f.reads.get('proof-1'); f.reads.delete('proof-1');
  assert.deepEqual(verdicts(f), ['needs_evidence', 'contradicted']);
  f.reads.set('proof-1', secondRead);
  assert.ok(verdicts(f).includes('supported'));
  assert.throws(() => validateReport(f.snapshot, f.draft, new Set(f.reads.keys()), f.reads), /every requested source/);
  f.draft.findings[0].evidenceIds.push('proof-1');
  assert.doesNotThrow(() => validateReport(f.snapshot, { ...f.draft, findings: missionReportOutput(f.snapshot, f.reads).schema.parse(writerWire(f.draft)).findings.map((finding, index) => ({ ...f.draft.findings[index], ...finding, evidenceIds: [...new Set(finding.observations.flatMap(observation => observation.evidenceIds))] })) }, new Set(f.reads.keys()), f.reads));
  f.snapshot.config.criteria[0].delivery.sourceTypes.push('research');
  assert.deepEqual(verdicts(f), ['needs_evidence', 'contradicted']);
});

test('selected-case conclusive verdict requires the exact current run, not another run of the same case', () => {
  const f = fixture();
  f.snapshot.config.criteria[0].delivery = { kind: 'test_cases', caseKeys: ['plan:case'] };
  f.snapshot.delivery.cases = [{ caseKey: 'plan:case', runId: 'another-run', complete: true, gaps: [] }];
  assert.deepEqual(verdicts(f), ['needs_evidence']);
  f.snapshot.delivery.cases[0].runId = f.source.sourceId;
  assert.ok(verdicts(f).includes('supported'));
  f.snapshot.delivery.cases[0].complete = false;
  assert.deepEqual(verdicts(f), ['needs_evidence', 'contradicted']);
});

test('mechanically eligible verdicts do not constitute proof or relax final evidence validation', () => {
  const f = fixture(), output = missionReportOutput(f.snapshot, f.reads);
  f.draft.findings[0].evidenceIds = [];
  assert.throws(() => validateReport(f.snapshot, f.draft, new Set(f.reads.keys()), f.reads), /requires read evidence/);
  assert.ok(output.criteria[0].allowedVerdicts.includes('supported'));
  f.snapshot.config.criteria = [];
  assert.throws(() => missionReportOutput(f.snapshot, f.reads), /every original criterion/);
});
