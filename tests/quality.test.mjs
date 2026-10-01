import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { qualitySummary, defaultQuality, qualityConfigSchema, caseKey } from '../shared/quality.ts';
import { testRunActionSchema } from '../shared/test-run.ts';
const target = { environment: 'QA', url: 'https://example.com', revision: 'commit-a' };
function fixture() {
  const c = { id: randomUUID(), title: 'Login', type: 'browser', preconditions: '', steps: 'Logga in', expected: 'Kontot visas' };
  const item = { id: randomUUID(), title: 'Kritiska flöden', version: 1, content: { kind: 'test_plan', cases: [c], sources: [] } };
  const config = { ...defaultQuality().config, target, checks: [{ id: randomUUID(), label: 'Miljö', status: 'ready', detail: 'Kontrollerad mot deployment a', caseKeys: [] }] };
  const run = { id: randomUUID(), itemId: item.id, caseId: c.id, planVersion: 1, snapshot: c, environment: target.url, target, startedAt: '2026-10-01T10:00:00Z', finishedAt: '2026-10-01T10:01:00Z', result: { outcome: 'passed', actual: 'Kontot visas', unverified: '', observations: [], evidenceItemIds: [] } };
  return { c, item, config, run };
}
test('a new release never inherits an old passing run', () => {
  const { item, config, run } = fixture();
  assert.equal(qualitySummary([item], [run], config).counts.passed, 1);
  assert.equal(qualitySummary([item], [run], { ...config, target: { ...target, revision: 'commit-b' } }).counts.stale, 1);
  assert.equal(qualitySummary([item], [{ ...run, target: null }], config).counts.passed, 0);
  assert.equal(qualitySummary([item], [run], { ...config, target: { ...target, revision: 'commit-b' } }).cases[0].historyCount, 1, 'Stale is not missing history');
});
test('changed definitions invalidate results, unrelated plan edits do not', () => {
  const { c, item, config, run } = fixture();
  assert.equal(qualitySummary([{ ...item, version: 2 }], [run], config).counts.passed, 1);
  assert.equal(qualitySummary([{ ...item, content: { ...item.content, cases: [{ ...c, expected: 'A different assertion' }] } }], [run], config).counts.stale, 1);
});
test('the selected environment is not replaced by a newer result elsewhere', () => {
  const { item, config, run } = fixture();
  const other = { ...run, id: randomUUID(), startedAt: '2026-10-02T10:00:00Z', target: { ...target, environment: 'Production' }, result: { ...run.result, outcome: 'failed' } };
  assert.equal(qualitySummary([item], [run, other], config).counts.passed, 1);
});
test('an unfinished retry hides an older pass; blocked and inconclusive stay distinct', () => {
  const { item, config, run } = fixture();
  const retry = { ...run, id: randomUUID(), startedAt: '2026-10-02T10:00:00Z', result: null, finishedAt: null };
  assert.equal(qualitySummary([item], [run, retry], config).counts.running, 1);
  for (const outcome of ['blocked', 'inconclusive', 'interrupted', 'failed']) assert.equal(qualitySummary([item], [{ ...run, result: { ...run.result, outcome } }], config).counts[outcome], 1);
});
test('a scoped prerequisite blocker does not block independent cases', () => {
  const { c, item, config } = fixture();
  const independent = { ...c, id: randomUUID(), title: 'Public page' };
  const result = qualitySummary([{ ...item, content: { ...item.content, cases: [c, independent] } }], [], { ...config, checks: [...config.checks, { id: randomUUID(), label: 'Account', status: 'blocked', detail: 'Missing test user', caseKeys: [caseKey(item.id, c.id)] }] });
  assert.deepEqual(result.cases.map(c => c.readiness), ['blocked', 'ready']);
  assert.equal(result.counts.untested, 2, 'readiness is not an execution result');
});
test('missing release details or unverified prerequisites cannot be ready', () => {
  const { item, config } = fixture();
  for (const value of [defaultQuality().config, { ...config, checks: [] }, { ...config, checks: [{ ...config.checks[0], status: 'unknown' }] }]) assert.equal(qualitySummary([item], [], value).ready, 0);
});
test('regression and fixed compare matching definitions and environments only', () => {
  const { item, config, run } = fixture();
  const previous = { ...run, id: randomUUID(), startedAt: '2026-09-30T10:00:00Z', target: { ...target, revision: 'older' } };
  assert.equal(qualitySummary([item], [previous, { ...run, result: { ...run.result, outcome: 'failed' } }], config).cases[0].change, 'regression');
  assert.equal(qualitySummary([item], [{ ...previous, result: { ...run.result, outcome: 'failed' } }, run], config).cases[0].change, 'fixed');
  for (const other of [{ ...previous, target: null }, { ...previous, target: { ...target, url: 'https://other.example' } }, { ...previous, snapshot: { ...run.snapshot, expected: 'different' } }]) assert.equal(qualitySummary([item], [other, run], config).cases[0].change, null);
});
test('deleted cases do not inflate totals and regression selection is explicit', () => {
  const { c, item, config, run } = fixture();
  const result = qualitySummary([item], [run, { ...run, caseId: randomUUID() }], { ...config, regression: [caseKey(item.id, c.id)] });
  assert.equal(result.total, 1); assert.equal(result.cases[0].regression, true);
});
test('readiness requires observations; test targets reject credentials and malformed URLs', () => {
  const { config, run } = fixture();
  assert.equal(qualityConfigSchema.safeParse({ ...config, checks: [{ ...config.checks[0], detail: '' }] }).success, false);
  const input = { action: 'start', itemId: run.itemId, caseId: run.caseId, expectedVersion: 1, requestId: randomUUID(), environment: 'QA' };
  assert.equal(testRunActionSchema.safeParse(input).success, true, 'Legacy callers remain supported without invented target');
  for (const url of ['https://', 'ftp://example.com', 'https://user:secret@example.com']) assert.equal(testRunActionSchema.safeParse({ ...input, target: { ...target, url } }).success, false);
});
