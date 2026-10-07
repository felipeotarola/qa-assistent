import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { hasTargetIdentity, sameTarget, testTargetSchema, targetVersionLabel } from '../shared/test-target.ts';
import { evidenceContextIssues } from '../shared/evidence-rules.ts';
import { defaultQuality, qualitySummary } from '../shared/quality.ts';

const capturedAt = '2026-10-05T10:00:00.000Z';
const observation = () => ({ environment: 'Publik webb', url: 'https://example.com/', revision: '', scope: { kind: 'observation', id: randomUUID(), capturedAt } });
test('observation identity is distinct from release and from another mission', () => {
  const target = observation();
  assert.equal(hasTargetIdentity(target), true);
  assert.equal(hasTargetIdentity({ ...target, scope: undefined }), false);
  assert.equal(testTargetSchema.safeParse({ ...target, revision: 'made-up-release' }).success, false);
  assert.equal(testTargetSchema.safeParse({ ...target, scope: { ...target.scope, capturedAt: 'yesterday' } }).success, false);
  assert.equal(sameTarget(target, structuredClone(target)), true);
  assert.equal(sameTarget(target, observation()), false);
  assert.equal(sameTarget(target, { ...target, scope: { ...target.scope, capturedAt: '2026-10-05T10:01:00.000Z' } }), false);
  assert.match(targetVersionLabel(target), /releaseversion okänd/);
});
test('evidence from another observation or before the observation is not applicable', () => {
  const target = observation();
  const context = { schemaVersion: 2, sourceType: 'test', sourceId: randomUUID(), target, expectedTarget: target, startedAt: '2026-10-05T10:01:00.000Z', finishedAt: '2026-10-05T10:02:00.000Z' };
  assert.deepEqual(evidenceContextIssues(context), []);
  assert.ok(evidenceContextIssues({ ...context, expectedTarget: observation() }).some(x => x.code === 'target_mismatch'));
  assert.ok(evidenceContextIssues({ ...context, startedAt: '2026-10-05T09:59:00.000Z' }).some(x => x.code === 'observation_window_mismatch'));
});
test('observation runs are separated and never create a release regression comparison', () => {
  const target = observation(), itemId = randomUUID(), caseId = randomUUID();
  const snapshot = { id: caseId, title: 'Read page', type: 'browser', preconditions: '', steps: 'Read page', expected: 'Page is readable' };
  const items = [{ id: itemId, title: 'Plan', content: { kind: 'test_plan', cases: [snapshot] } }];
  const run = { id: randomUUID(), itemId, caseId, snapshot, target, startedAt: '2026-10-05T10:01:00.000Z', result: { outcome: 'failed' } };
  const settings = { ...defaultQuality().config, target, checks: [{ id: randomUUID(), label: 'Observed', status: 'ready', detail: 'Verified', caseKeys: [] }] };
  const same = qualitySummary(items, [run], settings);
  assert.equal(same.targetComplete, true); assert.equal(same.cases[0].status, 'failed'); assert.equal(same.cases[0].change, null);
  const newer = qualitySummary(items, [run], { ...settings, target: observation() });
  assert.equal(newer.cases[0].status, 'stale'); assert.equal(newer.cases[0].run, null);
});
