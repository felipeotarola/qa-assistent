import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { browserReturnCases, browserReturnReceiptSchema } from '../shared/mission-browser-return.ts';

const itemId = randomUUID(), cases = Array.from({ length: 4 }, () => randomUUID());
const keys = cases.map(id => `${itemId}:${id}`);
const run = (index, outcome, extra = {}) => ({ id: randomUUID(), itemId, caseId: cases[index], finishedAt: '2026-10-06T00:00:00Z', result: { outcome }, ...extra });

test('return continues only unstarted and the exact human-blocked case', () => {
  const runs = [run(0, 'passed'), run(1, 'failed'), run(2, 'blocked')], before = structuredClone(runs);
  assert.deepEqual(browserReturnCases(keys, runs, runs[2].id), [keys[2], keys[3]]);
  assert.deepEqual(runs, before, 'No completed result or original requirement is rewritten');
});
test('system interrupted case may get a fresh full run; other blocked cases may not', () => {
  const runs = [run(0, 'interrupted'), run(1, 'blocked')];
  assert.deepEqual(browserReturnCases(keys, runs, runs[0].id), [keys[0], keys[2], keys[3]]);
});
test('passed/failed never retried even if nominated or a later run is blocked', () => {
  for (const outcome of ['passed', 'failed']) {
    const first = run(0, outcome), later = run(0, 'blocked');
    assert.deepEqual(browserReturnCases([keys[0]], [first, later], later.id), []);
    assert.deepEqual(browserReturnCases([keys[0]], [first], first.id), []);
  }
});
test('inconclusive is left to review/complement, not promoted into auth retry', () => {
  const first = run(0, 'inconclusive');
  assert.deepEqual(browserReturnCases([keys[0]], [first], first.id), []);
});
test('a pending/unknown original result cannot authorize another physical attempt', () => {
  const first = run(0, 'blocked', { finishedAt: null });
  assert.throws(() => browserReturnCases(keys, [first], first.id), /unknown/);
  assert.throws(() => browserReturnCases(keys, [{ ...first, result: null }], first.id), /unknown/);
});
test('duplicate/empty selection and another run ID fail conservatively', () => {
  assert.throws(() => browserReturnCases([], [], null));
  assert.throws(() => browserReturnCases([keys[0], keys[0]], [], null));
  assert.deepEqual(browserReturnCases([keys[0]], [run(0, 'blocked')], randomUUID()), []);
});
test('server receipt is strict and rejects credentials, policy expansion and unknown fields', () => {
  const receipt = { version: 1, waitId: randomUUID(), sourceAttemptId: randomUUID(), taskId: randomUUID(), assignmentId: randomUUID(), physicalSessionId: randomUUID(), claimId: randomUUID(), sourceDispatchId: randomUUID(), runtime: 'test-scope', planRevision: 1, mandateRevision: 1, requestHash: 'a'.repeat(64), policyDigest: 'b'.repeat(64), deadlineAt: '2026-10-06T00:00:00Z', blockedRunId: null };
  assert.deepEqual(browserReturnReceiptSchema.parse(receipt), receipt);
  for (const extra of [{ cookies: [] }, { connectUrl: 'secret' }, { allowedOrigins: ['https://other.test'] }, { newDeadline: 'tomorrow' }]) assert.equal(browserReturnReceiptSchema.safeParse({ ...receipt, ...extra }).success, false);
  for (const change of [{ physicalSessionId: 'foreign' }, { policyDigest: 'bad' }, { mandateRevision: 0 }]) assert.equal(browserReturnReceiptSchema.safeParse({ ...receipt, ...change }).success, false);
});
