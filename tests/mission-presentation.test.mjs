import assert from 'node:assert/strict';
import { test } from 'node:test';
import { presentMission } from '../shared/mission-presentation.ts';

const now = new Date('2026-10-05T12:00:00Z');
const before = '2026-10-05T11:00:00Z', future = '2026-10-05T12:30:00Z';
test('resource wait is explicit without disclosing the holder, and never overrides active or closed work', () => {
  const x = input(); x.mission.lifecycle = 'accepted'; x.resourceWait = 'busy';
  assert.equal(presentMission(x).nextStep.code, 'resource_wait');
  assert.match(presentMission(x).nextStep.text, /Väntar på körplats/);
  x.attempts.push(attempt()); assert.equal(presentMission(x).nextStep.code, 'continue');
  x.attempts = []; x.mission.lifecycle = 'closed'; assert.equal(presentMission(x).nextStep.code, 'closed');
});
function input() {
  return { mission: { id: 'public-mission', threadId: 'public-thread', title: 'Granska navigation', intent: 'explore', lifecycle: 'running', phase: 'execute', mandateRevision: 2, planRevision: 3,
    closureReason: null, deadlineAt: future, reportDeadlineAt: null, closedAt: null, heartbeatAt: '2026-10-05T11:59:50Z', nextWakeAt: now,
    leaseUntil: null, createdAt: before }, attempts: [], claims: [], waits: [], report: null, autonomyEnabled: true, now };
}
function attempt(overrides = {}) {
  return { id: 'private-attempt', status: 'running', mandateRevision: 2, planRevision: 3, deadlineAt: future, cancelRequestedAt: null, receipt: null, ...overrides };
}
function claim(overrides = {}) {
  return { attemptId: 'private-attempt', owner: 'agent', state: 'claimed', expiresAt: future, ...overrides };
}
function wait(reason = 'clarification', overrides = {}) {
  return { id: `public-wait-${reason}`, state: 'waiting', deadlineAt: future, definition: { reason, question: 'Vilket flöde?', taskIds: ['private-task'], mandateRevision: 2, planRevision: 3, requestedAt: before, deadlineAt: future }, ...overrides };
}
test('normal active resource does not mean cleanup or a verified test result', () => {
  const x = input(); x.attempts.push(attempt()); x.claims.push(claim());
  const result = presentMission(x);
  assert.equal(result.cleanupPending, false); assert.equal(result.resources.held, 1);
  assert.equal(result.threadId, 'public-thread');
  assert.deepEqual(result.allowedActions, ['pause', 'cancel']);
  assert.equal(result.workers.state, 'awaiting_receipt'); assert.equal(result.nextStep.code, 'continue');
  assert.equal('passed' in result, false);
});
test('cancelled mandate and terminal receipt keep real human resources pending until released', () => {
  const x = input(); x.mission.lifecycle = 'closed'; x.mission.closureReason = 'cancelled';
  x.attempts.push(attempt({ status: 'cancelled' })); x.claims.push(claim({ owner: 'human', expiresAt: before }));
  const result = presentMission(x);
  assert.equal(result.cleanupPending, true); assert.equal(result.resources.humanControlled, 1); assert.equal(result.resources.uncertain, 1);
  assert.deepEqual(result.allowedActions, []); assert.equal(result.nextStep.code, 'cleanup'); assert.equal(result.scheduler.state, 'not_required');
  x.claims = []; assert.deepEqual(presentMission(x).allowedActions, ['resume']);
});
for (const mode of ['expired', 'releasing', 'uncertain', 'old_epoch', 'unknown_attempt']) test(`${mode} claim remains held and requests cleanup`, () => {
  const x = input(); x.attempts.push(attempt()); x.claims.push(claim());
  if (mode === 'expired') x.claims[0].expiresAt = before;
  if (['releasing', 'uncertain'].includes(mode)) x.claims[0].state = mode;
  if (mode === 'old_epoch') x.attempts[0].mandateRevision--;
  if (mode === 'unknown_attempt') x.attempts = [];
  const result = presentMission(x);
  assert.equal(result.resources.held, 1); assert.equal(result.cleanupPending, true); assert.equal(result.nextStep.code, 'cleanup');
});
test('waits expose only current revision, enforce typed answers, and leave independent work visible', () => {
  const x = input(); x.attempts.push(attempt());
  x.waits = ['clarification', 'configuration', 'human_browser', 'authentication', 'authorization'].map(reason => wait(reason));
  x.waits.push(wait('clarification', { id: 'old', definition: { ...wait().definition, mandateRevision: 1 } }));
  const result = presentMission(x), byReason = Object.fromEntries(result.waits.map(w => [w.reason, w.allowedAnswers]));
  assert.equal(result.waits.length, 5); assert.deepEqual(byReason.clarification, ['text', 'decline']);
  assert.deepEqual(byReason.configuration, ['environment_consent', 'decline']); assert.deepEqual(byReason.human_browser, ['browser_returned', 'decline']);
  assert.deepEqual(byReason.authentication, ['decline']); assert.deepEqual(byReason.authorization, ['decline']);
  assert.equal(result.execution.active, 1); assert.equal(result.nextStep.code, 'answer');
});
test('deadline passage does not answer or mutate a wait, and late text cannot revive work', () => {
  const x = input(); x.waits.push(wait('clarification', { deadlineAt: before }));
  const saved = structuredClone(x), result = presentMission(x);
  assert.deepEqual(x, saved); assert.equal(result.waits[0].status, 'deadline_passed'); assert.deepEqual(result.waits[0].allowedAnswers, []);
  assert.equal(result.nextStep.code, 'wait_expired');
  x.mission.lifecycle = 'closed'; x.waits[0].deadlineAt = future;
  assert.deepEqual(presentMission(x).waits[0].allowedAnswers, []);
});
test('controller observation is not a heartbeat invented from reads or updatedAt', () => {
  const x = input(); x.mission.heartbeatAt = null; x.mission.nextWakeAt = before;
  x.mission.updatedAt = now; const a = presentMission(x), b = presentMission(x);
  assert.equal(a.scheduler.state, 'overdue'); assert.equal(a.scheduler.lastObservedAt, null); assert.deepEqual(a, b);
  x.mission.nextWakeAt = future; assert.equal(presentMission(x).scheduler.state, 'not_due');
  x.mission.nextWakeAt = now; assert.equal(presentMission(x).scheduler.state, 'not_observed');
  x.mission.heartbeatAt = before; assert.equal(presentMission(x).scheduler.state, 'not_observed');
  x.mission.heartbeatAt = now; assert.equal(presentMission(x).scheduler.state, 'recent_observation');
});
test('saved receipt and actual deadline distinguish worker observation from unknown dispatch', () => {
  const x = input(); x.attempts.push(attempt({ status: 'dispatch_unknown', updatedAt: now }));
  assert.equal(presentMission(x).workers.state, 'awaiting_receipt'); assert.equal(presentMission(x).execution.unconfirmedDispatch, 1);
  x.attempts[0].receipt = { receivedAt: '2026-10-05T13:59:00+02:00' };
  assert.equal(presentMission(x).workers.state, 'receipt_observed'); assert.equal(presentMission(x).workers.lastReceiptAt, '2026-10-05T11:59:00.000Z');
  x.attempts[0].deadlineAt = before; assert.equal(presentMission(x).workers.state, 'deadline_passed'); assert.equal(presentMission(x).execution.overdue, 1);
});
test('paused resume respects global admission, active attempts, and physical cleanup separately', () => {
  const x = input(); x.mission.lifecycle = 'paused'; x.autonomyEnabled = false;
  assert.deepEqual(presentMission(x).allowedActions, ['cancel']); assert.match(presentMission(x).nextStep.text, /starter.*pausade/);
  x.autonomyEnabled = true; assert.deepEqual(presentMission(x).allowedActions, ['cancel', 'resume']);
  x.attempts.push(attempt()); assert.deepEqual(presentMission(x).allowedActions, ['cancel']);
  assert.equal(presentMission(x).cleanupPending, false, 'Cancellation acknowledgement alone is not a physical claim');
});
test('only allowlisted output survives nested metadata and unknown report fields', () => {
  const x = input(); x.mission.leaseToken = 'SECRET'; x.mission.requestHash = 'PRIVATE'; x.attempts.push(attempt({ error: 'SECRET' }));
  x.waits.push(wait()); x.report = { id: 'public-report', itemId: 'public-item', status: 'completed', freshness: 'current', deleted: false, readIds: ['PRIVATE'], error: 'SECRET', leaseToken: 'SECRET' };
  const serialized = JSON.stringify(presentMission(x));
  for (const secret of ['SECRET', 'PRIVATE', 'private-attempt', 'private-task', 'leaseToken', 'readIds', 'requestHash']) assert.equal(serialized.includes(secret), false, secret);
});
