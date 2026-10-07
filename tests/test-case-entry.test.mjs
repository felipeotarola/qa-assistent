import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { plannedTestCase } from '../shared/mission-planning.ts';
import { testCaseSchema } from '../shared/test-plan.ts';
import { sameCase } from '../shared/quality.ts';

test('the planner preserves typed entry address alongside original steps', () => {
  const value = { title: 'Contact', entryUrl: 'https://example.test/', steps: [{ action: 'Click Contact', expected: 'Contact opens' }],  basis: { kind: 'exploratory', quote: '', source: null } };
  const result = plannedTestCase(value, randomUUID());
  assert.equal(result.entryUrl, value.entryUrl); assert.equal(result.preconditions, ''); assert.match(result.steps, /Click Contact/);
  assert.ok(sameCase(result, structuredClone(result)));
  assert.equal(sameCase(result, { ...result, entryUrl: 'https://example.test/products' }), false);
  const { entryUrl, ...withoutEntry } = result; void entryUrl;
  assert.equal(sameCase(result, withoutEntry), false);
});

test('legacy cases do not gain an inferred start or session-reset requirement', () => {
  const result = testCaseSchema.parse({ id: randomUUID(), title: 'Continue the existing flow', steps: 'Use the authenticated page', expected: 'Details visible' });
  assert.equal('entryUrl' in result, false); assert.ok(sameCase(result, { ...result }));
});

test('typed entry addresses reject malformed or credential-bearing values', () => {
  const value = { id: randomUUID(), title: 'Start' };
  for (const entryUrl of ['', '/relative', 'javascript:alert(1)', 'file:///tmp/page', 'https://user:password@example.test/', 'https://example.test/' + 'x'.repeat(2000)]) assert.equal(testCaseSchema.safeParse({ ...value, entryUrl }).success, false);
  for (const entryUrl of ['https://example.test/', 'http://example.test/path?q=filter#section']) assert.equal(testCaseSchema.safeParse({ ...value, entryUrl }).success, true);
});
