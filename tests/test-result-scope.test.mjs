import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { runChecks, runResultSchema, runResultV2Schema, runResultScope, runVerificationError, testRunActionSchema, testRunToolActionSchema } from '../shared/test-run.ts';

const snapshot = { preconditions: 'Start at home', steps: '1. Open search. 2. Search for an article. 3. Open its detail.', expected: 'The chosen detail is shown.' };
function complete() { return { schemaVersion: 2, outcome: 'passed', actual: 'All original checks observed.', checks: runChecks(snapshot).map(check => ({ id: check.id, status: 'verified', actual: `Observed ${check.id}` })), remaining: [], observations: [], evidenceItemIds: [] }; }

test('typed completion is independent of optional new testing ideas', () => {
  const result = { ...complete(), suggestedFollowUps: ['Try a different browser in a separately authorized test.'] };
  assert.deepEqual(runResultSchema.parse(result), result);
  assert.equal(runVerificationError(snapshot, result), null);
  assert.deepEqual(runResultScope(result), { remaining: [], suggestedFollowUps: result.suggestedFollowUps });
});
test('every incomplete original check requires typed remaining scope, without prose heuristics', () => {
  const result = complete(); result.outcome = 'inconclusive'; result.checks[2].status = 'unverified';
  assert.equal(runResultV2Schema.safeParse(result).success, false);
  result.remaining = [{ checkId: result.checks[2].id, reason: 'Detail navigation could not be observed.' }];
  assert.equal(runVerificationError(snapshot, runResultV2Schema.parse(result)), null);
  for (const remaining of ['Inget. Alla fem steg verifierades.', [{ checkId: 'none', reason: 'Nothing remains.' }], [result.remaining[0], result.remaining[0]], [{ checkId: 'step-1', reason: 'Another browser might be useful.' }]]) {
    assert.equal(runResultV2Schema.safeParse({ ...result, remaining }).success, false);
  }
});
test('missing original checks cannot be recast as an optional suggestion', () => {
  const result = complete(); result.outcome = 'failed'; result.checks.splice(2, 1); result.suggestedFollowUps = ['Maybe open the detail later.'];
  assert.ok(runVerificationError(snapshot, result));
  result.checks.push({ id: 'new-check', status: 'verified', actual: 'Different check' });
  assert.match(runVerificationError(snapshot, result), /Unknown/);
});
test('a correctly reported defect can finish QA while interruption cannot pretend to pass', () => {
  const defect = complete(); defect.outcome = 'failed'; defect.checks.at(-1).status = 'mismatch';
  defect.observations = [{ title: 'Wrong detail', detail: 'A different article was shown.', kind: 'defect' }];
  assert.equal(runVerificationError(snapshot, runResultV2Schema.parse(defect)), null);
  assert.equal(runResultV2Schema.safeParse({ ...defect, outcome: 'passed' }).success, false);
  const interrupted = complete(); interrupted.outcome = 'interrupted';
  interrupted.checks = interrupted.checks.map(check => ({ ...check, status: 'blocked', actual: 'Connection lost before execution.' }));
  interrupted.remaining = interrupted.checks.map(check => ({ checkId: check.id, reason: check.actual }));
  assert.equal(runVerificationError(snapshot, runResultV2Schema.parse(interrupted)), null);
});
test('requirement gaps and unknown observation kinds remain incompatible with pass', () => {
  for (const kind of ['requirement_gap', undefined]) assert.equal(runResultV2Schema.safeParse({ ...complete(), observations: [{ title: 'Unclear criterion', detail: 'Requirement unresolved.', ...(kind ? { kind } : {}) }] }).success, false);
});
test('legacy receipt shapes are preserved and all nonempty legacy prose stays unresolved', () => {
  for (const unverified of ['Inget. Alla fem steg verifierades.', 'None', 'Test another browser.', 'Login was never tested.']) {
    const legacy = { outcome: 'failed', actual: 'Legacy report', unverified, observations: [], evidenceItemIds: [] };
    assert.deepEqual(runResultSchema.parse(legacy), legacy);
    assert.deepEqual(runResultScope(legacy).remaining, [{ checkId: null, reason: unverified }]);
    const action = { action: 'finish', runId: randomUUID(), result: legacy };
    assert.equal(testRunActionSchema.safeParse(action).success, true);
    assert.equal(testRunToolActionSchema.safeParse(action).success, false, 'Models must not author the legacy shape');
  }
});
test('mixed contracts, future versions and oversized fields fail instead of falling back to legacy', () => {
  const result = complete();
  for (const invalid of [{ ...result, unverified: '' }, { ...result, unverified: 'Not tested.' }, { ...result, schemaVersion: 3, unverified: '' }, { ...result, suggestedFollowUps: ['x'.repeat(2001)] }]) {
    assert.equal(runResultSchema.safeParse(invalid).success, false);
  }
});
test('tool and API normalize serialized v2 results identically without changing persisted shape', () => {
  const action = { action: 'finish', runId: randomUUID(), result: complete() };
  for (const schema of [testRunActionSchema, testRunToolActionSchema]) {
    assert.deepEqual(schema.parse({ ...action, result: JSON.stringify(action.result) }), action);
    assert.equal(schema.safeParse({ ...action, result: 'broken' }).success, false);
    assert.equal(schema.safeParse({ ...action, result: ' '.repeat(200001) }).success, false);
  }
});

test('malformed historical scope remains unknown without crashing or guessing completion', () => {
  const legacy = { outcome: 'failed', actual: 'Saved result', unverified: '', observations: [], evidenceItemIds: [] };
  const missingLegacy = { ...legacy }; delete missingLegacy.unverified;
  const missingTyped = { ...complete() }; delete missingTyped.remaining;
  const badCheck = complete(); badCheck.checks[0].status = 'blocked';
  for (const value of [missingLegacy, { ...legacy, unverified: null }, { ...legacy, unverified: [] }, missingTyped,
    { ...complete(), remaining: null }, { ...complete(), suggestedFollowUps: 'Next test' }, badCheck, { ...complete(), schemaVersion: 3 }, {}, 'invalid', 0]) {
    const before = structuredClone(value), scope = runResultScope(value);
    assert.equal(scope.remaining.length, 1); assert.equal(scope.remaining[0].checkId, null);
    assert.match(scope.remaining[0].reason, /saknas eller är ogiltig/);
    assert.deepEqual(scope.suggestedFollowUps, []); assert.deepEqual(value, before);
  }
  assert.deepEqual(runResultScope(legacy).remaining, []);
  assert.deepEqual(runResultScope(null).remaining, []);
});
