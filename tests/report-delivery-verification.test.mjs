import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

// Execute the exact production verification body with synthetic database/read
// ports. Sizes are metadata fixtures; this is not actual PG or blob I/O.
const source = readFileSync(new URL('../server/utils/mission-reports.ts', import.meta.url), 'utf8');
const begin = source.indexOf('async function verifyReviewedDeliveries(');
const end = source.indexOf('\nasync function requireCurrentReportPolicy(', begin);
assert.ok(begin >= 0 && end > begin);
const body = ts.transpileModule(source.slice(begin, end), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
const load = new Function('ports', `const { currentMissionDelivery, missionHash, reviewedReportChecks, criterionEvidenceScope, readMissionSource, readMissionEvidence, schema, and, eq, independentMissionEvidence, evidenceApplicability, REVIEWER_VERSION } = ports; ${body}; return verifyReviewedDeliveries;`);
const MiB = 1024 * 1024;

function fixture(sizes = [40 * MiB], criteria = ['first']) {
  const refs = sizes.map((size, i) => ({ id: `proof-${i}`, itemId: `item-${i}`, kind: 'text', hash: `hash-${i}`, version: 1, size }));
  const assessment = { id: 'review', status: 'completed', finishedAt: '2026-10-06T00:01:00Z', sourceHash: 'source-hash', reviewerVersion: 'current-fixture-version', stale: false, verdict: 'supported',
    findings: refs.map((ref, i) => ({ requirementId: `check-${i}`, verdict: 'supported', evidenceIds: [ref.id] })) };
  const frozen = { sourceId: 'run', sourceType: 'test', sourceRevision: 'revision', status: 'completed', assessment,
    claims: refs.map((_, i) => ({ id: `check-${i}`, reportedStatus: 'mismatch', reportedActual: 'Observed product failure.' })), evidence: refs };
  const current = structuredClone(frozen);
  const snapshot = { workspaceId: 'workspace', missionId: 'mission', config: { target: { id: 'target' }, caseKeys: [], criteria: criteria.map(id => ({ id, delivery: { kind: 'source', sourceTypes: ['test'], sourceRefs: [{ type: 'test', id: 'run' }] } })) },
    delivery: { criteria: criteria.map(criterionId => ({ criterionId, complete: true })), cases: [] }, tasks: [{ criterionIds: criteria, sources: [frozen] }] };
  const draft = { findings: criteria.map(criterionId => ({ criterionId, verdict: 'supported' })) };
  const reads = new Map(refs.map(ref => [ref.id, { text: 'Full synthetic byte read', digest: ref.hash }]));
  const count = { sources: 0, bytes: [], metadata: [], independentTargets: [], applicabilityTargets: [] };
  const options = { deniedIndependent: null, deniedApplicability: null, changedDigest: false, limited: false, sameTarget: false };
  const rows = new Map(refs.map((ref, i) => [i, { source: frozen, criterionIds: criteria, evidenceIds: [ref.id] }]));
  const connection = { select: () => ({ from: () => ({ where: async conditions => {
    const itemId = conditions.find(condition => condition.field === 'item-id').value;
    count.metadata.push(itemId);
    return [{ content: { kind: 'file', size: refs.find(ref => ref.itemId === itemId).size } }];
  } }) }) };
  const ports = {
    REVIEWER_VERSION: 'current-fixture-version', schema: { workspaceItems: { id: 'item-id', workspaceId: 'workspace-id' } }, and: (...values) => values, eq: (field, value) => ({ field, value }),
    missionHash: value => JSON.stringify(value), currentMissionDelivery: async () => structuredClone(snapshot),
    reviewedReportChecks: () => rows,
    criterionEvidenceScope: (_snapshot, criterionId) => ({ allowed: true, target: { id: options.sameTarget ? 'shared-target' : criterionId } }),
    readMissionSource: async () => { count.sources++; return current; },
    readMissionEvidence: async (_workspaceId, ref) => { count.bytes.push(ref.id); return { text: 'Full synthetic byte read', digest: options.changedDigest ? 'changed' : ref.hash, limited: options.limited }; },
    independentMissionEvidence: (_frozen, _ref, target) => { count.independentTargets.push(target.id); return options.deniedIndependent !== target.id; },
    evidenceApplicability: context => { count.applicabilityTargets.push(context.expectedTarget.id); return { eligible: options.deniedApplicability !== context.expectedTarget.id }; },
  };
  return { current, snapshot, draft, reads, count, options, rows, async run() { await load(ports)(connection, snapshot, draft, reads); } };
}

test('saved and supported consumers count/read the same 40 MiB proof and current source once', async () => {
  const f = fixture(), before = structuredClone(f.snapshot);
  await f.run();
  assert.equal(f.count.sources, 1);
  assert.deepEqual(f.count.bytes, ['proof-0']); assert.deepEqual(f.count.metadata, ['item-0']);
  assert.deepEqual(f.count.independentTargets, ['first']); assert.deepEqual(f.count.applicabilityTargets, ['first']);
  assert.deepEqual(f.snapshot, before);
});

test('distinct physical proofs still add to the fixed 64 MiB budget', async () => {
  const f = fixture([40 * MiB, 40 * MiB]);
  await assert.rejects(f.run(), /verification budget exceeded/);
  assert.deepEqual(f.count.bytes, ['proof-0']); assert.deepEqual(f.count.metadata, ['item-0', 'item-1']);
  assert.equal(f.count.sources, 1);
});

test('cached bytes do not cache target independence or applicability across criteria', async () => {
  for (const denied of ['deniedIndependent', 'deniedApplicability']) {
    const f = fixture([MiB], ['first', 'second']); f.options[denied] = 'second';
    await assert.rejects(f.run(), /proof unavailable/);
    assert.deepEqual(f.count.bytes, ['proof-0']); assert.equal(f.count.sources, 1);
    assert.deepEqual(f.count.independentTargets, ['first', 'second']);
    assert.deepEqual(f.count.applicabilityTargets, denied === 'deniedIndependent' ? ['first'] : ['first', 'second']);
  }
});

test('adopted proof still requires the original read digest and a full read', async () => {
  for (const invalid of ['changedDigest', 'limited']) {
    const f = fixture([MiB]); f.options[invalid] = true;
    await assert.rejects(f.run(), /proof unavailable/);
    assert.deepEqual(f.count.bytes, ['proof-0']); assert.deepEqual(f.count.independentTargets, []);
  }
});

test('source completion, fingerprints and fresh citation identity remain fail closed', async () => {
  for (const change of [value => { value.assessment.status = 'failed'; }, value => { value.assessment.finishedAt = null; },
    value => { value.sourceRevision = 'changed'; }, value => { value.assessment.inputHash = 'changed'; },
    value => { value.claims[0].reportedActual = 'changed'; }, value => { value.evidence[0].hash = 'changed'; }]) {
    const f = fixture([MiB]); change(f.current);
    await assert.rejects(f.run(), /changed during report|proof unavailable/);
    assert.equal(f.count.sources, 1); assert.deepEqual(f.count.bytes, []);
  }
});

test('source cache never adopts a second frozen revision or assessment without comparing it', async () => {
  for (const change of [value => { value.sourceRevision = 'older'; }, value => { value.assessment.inputHash = 'older'; }, value => { value.claims[0].reportedActual = 'older'; }]) {
    const f = fixture([MiB]), second = structuredClone(f.rows.get(0)); change(second.source); f.rows.set(1, second);
    await assert.rejects(f.run(), /changed during report/);
    assert.equal(f.count.sources, 1); assert.deepEqual(f.count.bytes, ['proof-0']);
  }
});

test('same-target supported branches compare each frozen source before reusing its verified scope', async () => {
  for (const change of [value => { value.sourceRevision = 'older'; }, value => { value.assessment.inputHash = 'older'; }, value => { value.claims[0].reportedActual = 'older'; }]) {
    const f = fixture([MiB], ['first', 'second']); f.rows.clear(); f.options.sameTarget = true;
    const second = structuredClone(f.snapshot.tasks[0]); second.criterionIds = ['second']; change(second.sources[0]);
    f.snapshot.tasks[0].criterionIds = ['first']; f.snapshot.tasks.push(second);
    await assert.rejects(f.run(), /changed during report/);
    assert.equal(f.count.sources, 1); assert.deepEqual(f.count.bytes, ['proof-0']);
  }
});
