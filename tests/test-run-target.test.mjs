import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { testRunActionSchema, testTargetSchema } from '../shared/test-run.ts';

const action = { action: 'start', itemId: randomUUID(), caseId: randomUUID(), expectedVersion: 1, requestId: randomUUID(), environment: 'Publik webb' };
const scope = { kind: 'observation', id: randomUUID(), capturedAt: '2026-10-05T12:00:00.000Z' };
const target = { environment: 'Publik webb', url: 'https://example.test/', revision: '', scope };
const parse = target => testRunActionSchema.parse({ ...action, target });
const valid = target => testRunActionSchema.safeParse({ ...action, target }).success;
function forms(target) {
  return [target, JSON.stringify(target), { ...target, scope: JSON.stringify(target.scope) }, JSON.stringify({ ...target, scope: JSON.stringify(target.scope) })];
}

test('test_run START accepts object, serialized target and serialized nested scope identically', () => {
  const canonical = parse(target);
  for (const form of forms(target)) {
    assert.deepEqual(parse(form), canonical);
    assert.deepEqual(testTargetSchema.parse(parse(form).target), target);
  }
});

test('boundary normalization preserves canonical trimming and legacy target omission', () => {
  const release = { environment: ' QA ', url: ' https://example.test/ ', revision: ' commit-123 ' };
  assert.deepEqual(parse(release), parse(JSON.stringify(release)));
  assert.deepEqual(parse(release).target, { environment: 'QA', url: 'https://example.test/', revision: 'commit-123' });
  assert.equal(Object.hasOwn(testRunActionSchema.parse(action), 'target'), false);
  assert.equal(testTargetSchema.safeParse(JSON.stringify(target)).success, false, 'Persisted schema stays object-only');
  assert.equal(testTargetSchema.safeParse({ ...target, scope: JSON.stringify(scope) }).success, false, 'Persisted scope stays object-only');
});

test('malformed, double-encoded and oversized gateway JSON remains rejected', () => {
  for (const value of ['{bad', 'null', '[]', '42', JSON.stringify(JSON.stringify(target)), `${' '.repeat(20001)}${JSON.stringify(target)}`]) assert.equal(valid(value), false);
  for (const value of ['{bad', 'null', '[]', '42', JSON.stringify(JSON.stringify(scope)), `${' '.repeat(2001)}${JSON.stringify(scope)}`]) {
    assert.equal(valid({ ...target, scope: value }), false);
    assert.equal(valid(JSON.stringify({ ...target, scope: value })), false);
  }
});

test('all gateway forms retain strict scope identity and observation-vs-release refinement', () => {
  const invalidTargets = [
    { ...target, revision: 'commit-123' }, { ...target, environment: '' }, { ...target, url: '' },
    { ...target, scope: { ...scope, id: 'invented-id' } },
    { ...target, scope: { ...scope, capturedAt: 'not-an-instant' } },
    { ...target, scope: { ...scope, kind: 'release' } },
    { ...target, scope: { ...scope, missionId: randomUUID() } },
    { ...target, scope: { kind: 'observation', capturedAt: scope.capturedAt } },
    { ...target, url: 'file:///etc/passwd' }, { ...target, url: 'https://user:secret@example.test/' },
    { ...target, environment: 'x'.repeat(201) }, { ...target, url: `https://example.test/${'x'.repeat(2000)}` },
  ];
  for (const invalid of invalidTargets) for (const form of forms(invalid)) assert.equal(valid(form), false);
});
