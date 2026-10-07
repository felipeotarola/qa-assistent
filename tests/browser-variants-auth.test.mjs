import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { auditAuthenticatedContinuation, validateHumanLogin, viewerLoginAddress } from './helpers/browser-variants-auth.mjs';
import { hash, authenticationCandidate } from './helpers/browser-variants-protocol.mjs';

function evidence() {
  const revision = hash('fixture'), input = { startedAt: '2026-10-05T12:00:00Z' }, sessionHash = hash('cookie');
  const receipt = { revision, events: [
    { sequence: 1, kind: 'account_read', method: 'GET', at: '2026-10-05T11:59:59Z', authenticated: false, status: 303, cookiePresent: false, sessionHash: null },
    { sequence: 2, kind: 'login', method: 'POST', at: '2026-10-05T12:00:01Z', accepted: true, status: 303, location: '/account', sessionHash },
    { sequence: 3, kind: 'account_read', method: 'GET', at: '2026-10-05T12:00:02Z', authenticated: true, status: 200, cookiePresent: true, sessionHash },
  ] };
  return { revision, input, receipt };
}
test('viewer input accepts only the exact owner-returned isolated session URL', () => {
  const origin = 'http://127.0.0.1:58092', id = randomUUID(), liveUrl = `${origin}/viewer#${id}:${'a'.repeat(64)}`;
  assert.match(viewerLoginAddress(liveUrl, id, origin), /^ws:\/\/127.0.0.1:58092\/view\//);
  for (const bad of [liveUrl.replace('127.0.0.1', 'remote.invalid'), liveUrl.replace('/viewer', '/cdp'), liveUrl.replace(id, randomUUID()), liveUrl.replace('#', '?unexpected#'), `${origin}/viewer#${id}:short`]) assert.throws(() => viewerLoginAddress(bad, id, origin));
});
test('login proof requires real POST redirect followed by matching issued-cookie authenticated GET', () => {
  const good = evidence(); assert.equal(validateHumanLogin(good.receipt, good.input, good.revision).authenticatedRead.sequence, 3);
  for (const mutate of [value => value.receipt.revision = hash('changed'), value => value.receipt.events[1].method = 'GET', value => value.receipt.events[1].accepted = false,
    value => value.receipt.events[1].status = 200, value => value.receipt.events[1].location = '/elsewhere', value => value.receipt.events[2].sessionHash = hash('unrelated-cookie'),
    value => value.receipt.events[2].cookiePresent = false, value => value.receipt.events[2].authenticated = false, value => value.receipt.events[2].sequence = 1,
    value => value.receipt.events.push({ ...value.receipt.events[1], sequence: 4 })]) {
    const value = evidence(); mutate(value); assert.throws(() => validateHumanLogin(value.receipt, value.input, value.revision));
  }
});
test('AUTH09 completion additionally requires the returned agent to finish in the original physical browser', () => {
  const { revision, input, receipt } = evidence();
  const fault = { loginInput: input, waitId: 'wait', answeredAt: '2026-10-05T12:00:03Z', sessionId: randomUUID() };
  const state = { runs: [{ id: 'run', finished_at: '2026-10-05T12:00:04Z', browser_entry_receipt: { sessionId: fault.sessionId } }], waits: [{ id: 'wait', state: 'answered', answered_at: fault.answeredAt }] };
  const matches = [{ oracleId: 'authenticated_profile', runId: 'run', traceItemId: 'trace' }], traces = [{ capture: { item_id: 'trace', run_id: 'run' }, trace: { startedAt: '2026-10-05T12:00:03.001Z' } }];
  assert.equal(auditAuthenticatedContinuation(state, fault, matches, receipt, revision, traces).physicalSessionPreserved, true);
  state.runs[0].browser_entry_receipt.sessionId = randomUUID(); assert.throws(() => auditAuthenticatedContinuation(state, fault, matches, receipt, revision, traces), /another physical browser/);
  state.runs[0].browser_entry_receipt.sessionId = fault.sessionId;
  traces[0].trace.startedAt = '2026-10-05T12:00:02Z'; assert.throws(() => auditAuthenticatedContinuation(state, fault, matches, receipt, revision, traces), /observation preceded/);
  state.runs[0].finished_at = '2026-10-05T12:00:02Z'; assert.throws(() => auditAuthenticatedContinuation(state, fault, matches, receipt, revision, traces), /preceded owner return/);
});
test('takeover requires an actual protected-entry redirect in the exact bound physical session', () => {
  const state = { missions: [{ lifecycle: 'running' }], attempts: [{ id: 'attempt', task_id: 'task', kind: 'browser_tests', status: 'running', dispatch_id: 'job' }],
    jobs: [{ id: 'job', session_id: 'eve' }], browsers: [{ session_id: 'physical', agent_id: 'eve', control: 'agent' }],
    claims: [{ attempt_id: 'attempt', executor_resource_id: 'physical', state: 'claimed' }],
    captures: [{ url: 'http://qa-auth.test/login', run_id: 'run', item_id: 'proof', provenance: { producer: 'browser-action' } }],
    runs: [{ id: 'run', mission_attempt_id: 'attempt', browser_entry_receipt: { sessionId: 'physical', requestedUrl: 'http://qa-auth.test/account', observedUrl: 'http://qa-auth.test/login' } }] };
  assert.equal(authenticationCandidate(state).sessionId, 'physical');
  for (const patch of [{ sessionId: 'another-browser' }, { requestedUrl: 'http://qa-auth.test/login' }, { observedUrl: 'http://elsewhere.test/login' }]) {
    const copy = structuredClone(state); Object.assign(copy.runs[0].browser_entry_receipt, patch); assert.equal(authenticationCandidate(copy), null);
  }
});
