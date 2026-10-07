import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { missionComplementSchema, nextComplementRound } from '../shared/mission-complement.ts';

const caseKey = `${randomUUID()}:${randomUUID()}`;
const task = (round, extra = {}) => ({ planRevision: 1, supplementRound: round,
  spec: { kind: 'browser_tests', caseKeys: [caseKey] }, ...extra });
const next = tasks => nextComplementRound({ planRevision: 1, caseKey, maxRounds: 2, tasks });
test('two logical rounds per case, independent of renamed gaps or operation retries', () => {
  assert.equal(next([task(0)]), 1);
  assert.equal(next([task(0), task(1), task(1)]), 2);
  assert.equal(next([task(0), task(1), task(2)]), null);
  for (const state of ['failed', 'cancelled', 'blocked', 'completed']) assert.equal(next([task(2, { state })]), null);
});
test('other cases and old plan revisions cannot spend or reset this plan budget', () => {
  assert.equal(next([task(2, { planRevision: 2 }), task(2, { spec: { kind: 'browser_tests', caseKeys: [`${randomUUID()}:${randomUUID()}`] } })]), 1);
  assert.equal(next([task(1), task(0)]), 2);
});
test('malformed lineage and a zero complement allowance fail closed', () => {
  for (const round of [null, -1, 0.5, NaN]) assert.equal(next([task(round)]), null);
  assert.equal(nextComplementRound({ planRevision: 1, caseKey, maxRounds: 0, tasks: [] }), null);
});
test('complement linkage has exact server IDs and no executable instructions', () => {
  const value = { version: 1, sourceTaskId: randomUUID(), sourceAttemptId: randomUUID(), runId: randomUUID(), assessmentId: randomUUID(),
    sourceHash: 'a'.repeat(64), inputHash: 'b'.repeat(64), reviewerVersion: '5', planRevision: 1, caseKey, gapIds: ['c'.repeat(64)] };
  assert.deepEqual(missionComplementSchema.parse(value), value);
  for (const extra of [{ url: 'https://elsewhere.test' }, { command: 'curl' }, { mandate: {} }]) assert.equal(missionComplementSchema.safeParse({ ...value, ...extra }).success, false);
  assert.equal(missionComplementSchema.safeParse({ ...value, gapIds: [] }).success, false);
});
