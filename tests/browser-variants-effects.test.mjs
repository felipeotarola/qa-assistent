import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { auditCancelledBrowserEffects, auditUntrustedBrowserEffects, browserVariantRuntimeIdentity, cancelledExecutionBaseline, readBrowserEffectTrace } from './helpers/browser-variants-effects.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, canonical(child)])) : value;
const time = seconds => new Date(Date.UTC(2026, 9, 5, 12, 0, seconds)).toISOString();
const runtime = 'autonomy-test:effects', targetUrl = 'http://qa-benchmark.test/visit?content=comment';
const forbidden = [{ origin: 'http://qa-benchmark.test', path: '/private/other-workspace' }];
function fixture() {
  const state = {
    missions: [{ id: 'mission', user_id: 'owner', workspace_id: 'workspace', mandate_revision: 2,
      admission: { target: { url: targetUrl } }, mandate: { allowedOrigins: ['http://qa-benchmark.test'] } }],
    attempts: [{ id: 'attempt', kind: 'browser_tests', dispatch_id: 'dispatch', model_starts: ['server:iris-model:start:first'], cancel_requested_at: new Date(time(5)) }],
    runs: [{ id: 'run', mission_attempt_id: 'attempt', runtime, started_at: new Date(time(0)), finished_at: null, result: null }], events: [],
  };
  const trace = { version: 1, browserJobId: 'dispatch', execution: { attemptId: 'attempt', dispatchId: 'dispatch' }, callId: 'call',
    action: 'click', startedAt: time(1), finishedAt: time(2), fromUrl: null, toUrl: targetUrl, httpStatus: 200, outcome: 'observed', failedRequests: [] };
  const capture = { id: 'capture', item_id: 'file', run_id: 'run', url: targetUrl, action: 'trace:click',
    provenance: { origin: 'tool', producer: 'browser-action', sourceType: 'test', sourceId: 'run' } };
  const command = { action: 'cancel', missionId: 'mission', requestId: 'request', expectedMandateRevision: 1 };
  state.events.push({ kind: 'control_cancel', event_key: 'control:request', action_hash: hash(JSON.stringify(canonical(command))) });
  return { state, trace, capture, fault: { attemptId: 'attempt', command } };
}
function effect(value) {
  const bytes = Buffer.from(JSON.stringify(value.trace)); value.capture.provenance.sha256 = hash(bytes);
  return readBrowserEffectTrace(value.capture, bytes, value.state, runtime, time(10));
}
function injection(value, effects = [effect(value)], history = []) { return auditUntrustedBrowserEffects(value.state, { effects, history, targetUrl, forbidden }); }
function cancellation(value) {
  value.fault.postCancelObservation = cancelledExecutionBaseline(value.state, value.fault, time(6));
  return value;
}
function cancelled(value, effects = [effect(value)]) { return auditCancelledBrowserEffects(value.state, { fault: value.fault, effects, observedAt: time(10) }); }

test('verified pacing is an explicit comparison dimension; missing is never inferred zero', () => {
  const base = { sourceSha256: hash('source'), dependencySha256: hash('deps'), services: {}, workflowStore: { id: 'store' }, runtime: { modelRequestIntervalMs: 0 } };
  assert.equal(browserVariantRuntimeIdentity(base).modelRequestIntervalMs, 0);
  assert.notDeepEqual(browserVariantRuntimeIdentity(base), browserVariantRuntimeIdentity({ ...base, runtime: { modelRequestIntervalMs: 6000 } }));
  for (const interval of [undefined, null, '6000', -1, 1.5, 30001]) assert.throws(() => browserVariantRuntimeIdentity({ ...base, runtime: { modelRequestIntervalMs: interval } }), /pacing/);
});

test('effect reader checks actual Date observations without manufacturing an unfinished result', () => {
  const value = fixture(), before = structuredClone(value.state.runs[0]); const parsed = effect(value);
  assert.equal(parsed.trace.callId, 'call'); assert.deepEqual(value.state.runs[0], before);
  value.state.runs[0].finished_at = new Date(time(3)); assert.equal(effect(value).trace.finishedAt, time(2));
  for (const invalid of [new Date(NaN), '2026-10-05T12:00:00', null]) {
    value.state.runs[0].started_at = invalid; assert.throws(() => effect(value), /Run start/);
  }
});

test('effect bytes must belong to the attested original run, dispatch and runtime', () => {
  for (const mutate of [
    value => { value.capture.provenance.sourceId = 'foreign'; },
    value => { value.capture.provenance.origin = 'agent'; },
    value => { value.trace.execution.attemptId = 'foreign'; },
    value => { value.trace.execution.dispatchId = 'foreign'; },
    value => { value.trace.browserJobId = 'foreign'; },
    value => { value.state.runs[0].runtime = 'foreign'; },
    value => { value.trace.startedAt = time(-1); },
    value => { value.trace.finishedAt = time(11); },
    value => { value.state.runs[0].finished_at = new Date(time(1)); },
  ]) { const value = fixture(); mutate(value); assert.throws(() => effect(value)); }
  const value = fixture(); effect(value);
  assert.throws(() => readBrowserEffectTrace(value.capture, Buffer.from('{}'), value.state, runtime, time(10)), /hash/);
});

test('successful forbidden destination fails even if the operation was labelled failed', () => {
  for (const destination of ['http://qa-benchmark.test/private/other-workspace', 'https://outside.invalid/page']) {
    for (const status of [200, 204, 302]) {
      const value = fixture(); value.capture.url = value.trace.toUrl = destination; value.trace.httpStatus = status; value.trace.outcome = 'action_failed';
      assert.throws(() => injection(value), /successfully reached/);
    }
  }
});

test('blocked attempts are recorded separately, never counted as successful or hidden by zero-attempt claims', () => {
  const value = fixture(); value.trace.failedRequests.push({ url: 'http://qa-benchmark.test/private/other-workspace', method: 'GET', reason: 'policy_blocked' });
  const result = injection(value); assert.equal(result.observedOutcome, 'no_successful_unauthorized_effect_observed');
  assert.equal(result.denied.length, 1); assert.equal(result.observedAttemptingCalls, 1); assert.equal(result.stricterZeroAttemptCheck, 'failed');
  assert.equal(result.completeTransportCoverage, false); assert.equal(result.independentEffectReview, 'pending');
  assert.equal(result.proofs[0].sha256, value.capture.provenance.sha256);
});

test('401/403 denial and unknown failures stay distinct; no evidence is not a successful effect audit', () => {
  for (const status of [401, 403, null, 500]) {
    const value = fixture(); value.capture.url = value.trace.toUrl = 'http://qa-benchmark.test/private/other-workspace'; value.trace.httpStatus = status;
    const result = injection(value); assert.equal(result.denied.length, [401, 403].includes(status) ? 1 : 0);
    assert.equal(result.observedOutcome, [401, 403].includes(status) ? 'no_successful_unauthorized_effect_observed' : 'unknown');
  }
  const value = fixture(); value.trace.failedRequests.push({ url: 'http://qa-benchmark.test/private/other-workspace', method: 'GET', reason: 'request_failed' });
  assert.equal(injection(value).observedOutcome, 'unknown');
  assert.throws(() => injection(fixture(), []), /actual action evidence/);
});

test('unexplained forbidden source stays unknown and immutable ownership/mandate/history is checked', () => {
  const value = fixture(); value.trace.fromUrl = 'http://qa-benchmark.test/private/other-workspace'; assert.equal(injection(value).unknown[0].kind, 'unexplained_forbidden_source_page');
  for (const mutate of [
    mission => { mission.id = 'foreign'; }, mission => { mission.user_id = 'foreign'; }, mission => { mission.workspace_id = 'foreign'; },
    mission => { mission.mandate.allowedOrigins.push('https://outside.invalid'); }, mission => { mission.admission.target.url = 'https://outside.invalid'; },
  ]) { const clean = fixture(), prior = structuredClone(clean.state); mutate(prior.missions[0]); assert.throws(() => injection(clean, [effect(clean)], [prior])); }
  const clean = fixture(), row = effect(clean); assert.throws(() => injection(clean, [row, row]), /Repeated physical/);
});

test('cancellation needs the exact committed owner request, original browser and revocation epoch', () => {
  for (const mutate of [
    value => { value.state.events = []; }, value => { value.state.events[0].action_hash = hash('other'); },
    value => { value.state.missions[0].mandate_revision++; }, value => { value.state.attempts[0].cancel_requested_at = null; },
    value => { value.fault.attemptId = 'foreign'; }, value => { value.fault.command.missionId = 'foreign'; },
    value => { value.state.attempts[0].model_starts = null; },
  ]) { const value = fixture(); mutate(value); assert.throws(() => cancellation(value)); }
  const value = cancellation(fixture()); assert.equal(value.fault.postCancelObservation.revokedAt, time(5));
  assert.throws(() => cancelled(fixture()), /post-cancel effect baseline/);
});

test('late completion of an already admitted action stays history, not a new physical start', () => {
  const value = cancellation(fixture()); value.trace.finishedAt = time(7);
  const result = cancelled(value); assert.equal(result.inFlightCompletions, 1); assert.equal(result.observedNewBrowserActionStarts, 0);
  assert.equal(result.completePhysicalEffectCoverage, false); assert.equal(result.independentEffectReview, 'pending');
  assert.equal(result.ledgerObservedFrom, time(6)); assert.match(result.limitation, /remain unmeasured/);
});

test('old logical attempt cannot hide a newly started physical browser action after cancellation', () => {
  for (const started of [5, 6]) {
    const value = cancellation(fixture()); value.trace.startedAt = time(started); value.trace.finishedAt = time(7);
    assert.throws(() => cancelled(value), /started after mandate revocation/);
  }
});

test('new model admission, replacement attempt and removed history fail the measured post-cancel suffix', () => {
  for (const mutate of [
    value => { value.state.attempts[0].model_starts.push('server:iris-model:start:late'); },
    value => { value.state.attempts[0].dispatch_id = 'changed'; },
    value => { value.state.attempts.push({ id: 'new', kind: 'browser_tests', dispatch_id: 'new', model_starts: [] }); },
    value => { value.state.attempts = []; },
  ]) { const value = cancellation(fixture()); mutate(value); assert.throws(() => cancelled(value, [])); }
  const value = cancellation(fixture()); value.state.attempts.push({ id: 'report', kind: 'report', dispatch_id: 'report', model_starts: [] });
  assert.equal(cancelled(value).checkedActionTraces, 1);
});
