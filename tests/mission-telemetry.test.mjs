import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { missionTelemetry } from '../shared/mission-telemetry.ts';
import { IRIS_MODEL_LEDGER_PREFIX } from '../shared/browser-job.ts';
import { DEFAULT_MISSION_LIMITS, evaluateAttemptAdmission } from '../shared/mission-control.ts';
import { combineProviderUsage, sumProviderUsage } from '../shared/provider-usage.ts';

const started = '2026-10-05T10:00:00Z', now = '2026-10-05T10:10:00Z', deadline = '2026-10-05T11:00:00Z';
const prefix = 'server:queue-model:';
function attempt(id, overrides = {}) {
  return { id, operationId: id, kind: 'browser_tests', status: 'completed', reservedTokens: 100000, reservedToolCalls: 60,
    toolCalls: 2, toolCallIds: [], usage: { tokens: 1000, toolCalls: 2, durationMs: 1500 }, ...overrides };
}
function input(overrides = {}) {
  return { now, mission: { lifecycle: 'running', closureReason: null, createdAt: started, closedAt: null,
    heartbeatAt: '2026-10-05T10:09:30Z', deadlineAt: deadline, reportDeadlineAt: null }, attempts: [], waits: [], resources: [], ...overrides };
}
function receipt(key, tokens) { return `${prefix}usage:${JSON.stringify({ key, tokens, toolCalls: 1 })}`; }
function markers(key, tokens) { return [`${prefix}start:${key}`, `${prefix}done:${key}`, receipt(key, tokens)]; }

test('elapsed time is actual wall time and closed elapsed stays frozen', () => {
  const live = input(), result = missionTelemetry(live);
  assert.equal(result.timing.elapsedMs, 600000);
  assert.equal(result.timing.heartbeatAgeMs, 30000);
  assert.equal(result.timing.workDeadlineRemainingMs, 3000000);
  assert.equal(result.timing.workDeadlineExceeded, false);
  assert.equal(result.timing.reportDeadlineExceeded, null);
  const closed = { ...live, mission: { ...live.mission, lifecycle: 'closed', closedAt: '2026-10-05T10:05:00Z' } };
  assert.equal(missionTelemetry(closed).timing.elapsedMs, 300000);
  assert.equal(missionTelemetry({ ...closed, now: '2026-11-01T00:00:00Z' }).timing.elapsedMs, 300000);
  assert.equal(missionTelemetry({ ...live, now: deadline }).timing.workDeadlineExceeded, true);
});

test('missing and malformed timing stays unknown rather than a zero duration or an unmet deadline', () => {
  const value = input();
  value.mission = { ...value.mission, lifecycle: 'closed', heartbeatAt: null, deadlineAt: null };
  const result = missionTelemetry(value);
  assert.equal(result.timing.elapsedMs, null);
  assert.equal(result.timing.heartbeatAgeMs, null);
  assert.equal(result.timing.workDeadlineExceeded, null);
  assert.ok(result.gaps.includes('invalid_timing'));
  assert.ok(result.gaps.includes('missing_heartbeat'));
  assert.ok(result.gaps.includes('missing_deadline'));
  assert.equal(missionTelemetry(input({ now: 'invalid' })).timing.elapsedMs, null);
  assert.equal(missionTelemetry(input({ now: '2026-10-05T09:59:00Z' })).timing.elapsedMs, null);
});

test('known usage is distinct from active, unknown and separate report reservations', () => {
  const rows = [attempt('known'), attempt('active', { status: 'running', usage: { tokens: 2, toolCalls: 1, durationMs: null } }),
    attempt('unknown', { usage: null }), attempt('report', { kind: 'report', usage: { tokens: 50, toolCalls: 0, durationMs: 100 }, toolCalls: 0 })];
  const result = missionTelemetry(input({ attempts: rows }));
  assert.deepEqual(result.tokens, { measuredKnown: 1052, total: null, unknownAttempts: 1 });
  assert.deepEqual(result.toolCalls, { observed: 6, total: null, unknownAttempts: 1 });
  assert.deepEqual(result.budget.work, { reservedTokens: 300000, chargedTokens: 201000, reservedToolCalls: 180, chargedToolCalls: 122 });
  assert.deepEqual(result.budget.report, { reservedTokens: 100000, chargedTokens: 50, reservedToolCalls: 60, chargedToolCalls: 0 });
  assert.ok(result.gaps.includes('unknown_tokens'));
  assert.ok(result.gaps.includes('unknown_tool_usage'));
  assert.equal(missionTelemetry(input({ attempts: [attempt('only-unknown', { usage: null })] })).tokens.measuredKnown, null);
  assert.equal(missionTelemetry(input()).tokens.total, 0);
});

test('projection charged budget agrees with admission for active, unknown and underreported tools', () => {
  const mandate = { version: 1, intent: 'explore', target: { kind: 'public_url', url: 'https://example.com' },
    allowedOrigins: ['https://example.com'], repositoryUrls: [], consentIds: [], allowedTaskKinds: ['browser_tests', 'report'],
    issuedAt: started, deadlineAt: deadline, limits: { ...DEFAULT_MISSION_LIMITS } };
  for (const rows of [
    [attempt('boundary', { usage: { tokens: 1500000, toolCalls: 1, durationMs: 1 } })],
    [attempt('known', { usage: { tokens: 500000, toolCalls: 0, durationMs: null } })],
    Array.from({ length: 5 }, (_, n) => attempt(String(n), { usage: null })),
    Array.from({ length: 5 }, (_, n) => attempt(String(n), { toolCalls: 60, usage: { tokens: 1, toolCalls: 0, durationMs: 1 } })),
    [attempt('active', { status: 'dispatch_unknown', usage: { tokens: 1, toolCalls: 1, durationMs: null } })],
  ]) {
    const view = missionTelemetry(input({ attempts: rows })).budget.work;
    const admission = evaluateAttemptAdmission({ mandate, kind: 'browser_tests', operationId: 'next', attempts: rows, now });
    assert.equal(admission.reasons.includes('token_budget'), view.chargedTokens + admission.reservation.tokens > mandate.limits.maxTokens);
    assert.equal(admission.reasons.includes('tool_budget'), view.chargedToolCalls + admission.reservation.toolCalls > mandate.limits.maxToolCalls);
  }
});

test('physical report retries keep measured receipts and unknown charge distinct without duplicate usage', () => {
  const first = 'report:job:1', second = 'report:job:2';
  const row = attempt('report', { kind: 'report', reservedTokens: 200000, reservedToolCalls: 120, usage: null,
    toolCallIds: [`${prefix}start:${first}`, `${prefix}charged-unknown:${first}`, `${prefix}unknown`, ...markers(second, 123)] });
  const reports = [{ id: 'job', status: 'completed', createdAt: started, usage: { totalTokens: 123, durationMs: 20, queueMs: 4 } }];
  const result = missionTelemetry(input({ attempts: [row], reports }));
  assert.deepEqual(result.tokens, { measuredKnown: 123, total: null, unknownAttempts: 1 });
  assert.equal(result.budget.report.chargedTokens, 200000);
  assert.deepEqual(result.model.workflows, { tracked: 2, knownTokens: 1, unknownTokens: 1 });
  assert.deepEqual(result.model.providers, { tracked: 0, knownTokens: 0, unknownTokens: 0, total: null });
  assert.ok(result.gaps.includes('conservative_reservation_retained'));
  assert.ok(result.gaps.includes('queue_usage_latest_only'));
  row.toolCallIds.push(`${prefix}done:${first}`, receipt(first, 42));
  const late = missionTelemetry(input({ attempts: [row], reports }));
  assert.equal(late.tokens.measuredKnown, 165);
  assert.equal(late.tokens.total, null);
  assert.equal(late.budget.report.chargedTokens, 200000);
  assert.equal(late.model.workflows.knownTokens, 2);
});

test('a started model invocation is unknown until its durable receipt, even when the prior aggregate is zero', () => {
  const row = attempt('review', { kind: 'review', status: 'running', usage: { tokens: 0, toolCalls: 0, durationMs: 0 }, toolCallIds: [`${prefix}start:review:job:1`] });
  const result = missionTelemetry(input({ attempts: [row] }));
  assert.equal(result.tokens.measuredKnown, 0);
  assert.equal(result.tokens.total, null);
  assert.equal(result.model.workflows.unknownTokens, 1);
});

test('logical attempts deduplicate receipt rows and retries count within the same operation only', () => {
  const one = attempt('one', { operationId: 'same', status: 'failed' });
  const two = attempt('two', { operationId: 'same', status: 'dispatch_unknown', cancelRequestedAt: now });
  const three = attempt('three', { operationId: 'different' });
  const result = missionTelemetry(input({ attempts: [one, one, two, three] }));
  assert.deepEqual(result.attempts, { logical: 3, operations: 2, retries: 1, active: 1, dispatchUnknown: 1, cancelRequested: 1 });
  assert.equal(result.tokens.total, 3000);
});

test('invalid or contradictory ledger records cannot turn into a complete measured total', () => {
  const key = 'review:job:1';
  for (const ids of [[...markers(key, 10), receipt(key, 20), receipt(key, 10)], [`${prefix}usage:not-json`],
    [receipt('no-start', 10)], [...markers(key, 10), receipt(key, -1)]]) {
    const result = missionTelemetry(input({ attempts: [attempt('one', { toolCallIds: ids })] }));
    assert.equal(result.tokens.total, null);
    assert.ok(result.gaps.includes('invalid_model_ledger'));
  }
  const duplicate = missionTelemetry(input({ attempts: [attempt('one', { toolCallIds: [...markers(key, 10), ...markers(key, 10)] })] }));
  assert.equal(duplicate.model.workflows.tracked, 1);
  assert.equal(duplicate.tokens.measuredKnown, 1000);
  assert.equal(duplicate.tokens.total, 1000);
});

test('invalid numeric usage does not produce a negative or fabricated zero metric', () => {
  const result = missionTelemetry(input({ attempts: [attempt('invalid', { toolCalls: -2, reservedTokens: -1, usage: { tokens: NaN, toolCalls: -1, durationMs: 0 } })] }));
  assert.equal(result.tokens.total, null);
  assert.equal(result.tokens.measuredKnown, null);
  assert.equal(result.toolCalls.observed, null);
  assert.equal(result.toolCalls.total, null);
  assert.equal(result.budget.work.chargedTokens, null);
  assert.ok(result.gaps.includes('invalid_usage'));
});

test('wait deadlines and resource cleanup distinguish empty inventories from unavailable ones', () => {
  const value = input();
  const result = missionTelemetry({ ...value, mission: { ...value.mission, lifecycle: 'closed', closedAt: now },
    waits: [{ id: 'w1', state: 'waiting', deadlineAt: started }, { id: 'w2', state: 'waiting', deadlineAt: null }, { id: 'w3', state: 'expired', deadlineAt: started }],
    resources: [{ id: 'r1', owner: 'human', state: 'claimed', expiresAt: started }, { id: 'r2', owner: 'agent', state: 'uncertain', expiresAt: null }] });
  assert.deepEqual(result.waits, { pending: 2, overdue: 1, unknownDeadlines: 1, expired: 1 });
  assert.deepEqual(result.resources, { pending: 2, humanOwned: 1, uncertain: 1, expired: 1, unknownExpiries: 1, remainingAfterClosure: 2, clean: false });
  assert.equal(missionTelemetry(input()).resources.clean, true);
  const missing = missionTelemetry(input({ waits: undefined, resources: undefined }));
  assert.equal(missing.waits, null);
  assert.equal(missing.resources, null);
  assert.ok(missing.gaps.includes('resource_inventory_unavailable'));
  assert.ok(missing.gaps.includes('wait_inventory_unavailable'));
});

test('task and event counters do not infer test quality and queue durations stay latest-receipt measurements', () => {
  const event = { id: 'event', kind: 'late_executor_receipt' };
  const result = missionTelemetry(input({ tasks: [{ id: '1', state: 'completed' }, { id: '2', state: 'blocked' }, { id: '3', state: 'waiting' }],
    events: [event, event, { id: '2', kind: 'dispatch_unknown' }, { id: '3', kind: 'wait_expired' }],
    reports: [{ id: 'old', status: 'failed', createdAt: started, usage: { durationMs: 100, queueMs: 50 } },
      { id: 'new', status: 'completed', createdAt: now, usage: { durationMs: 20, queueMs: 3 } }], reviews: [] }));
  assert.deepEqual(result.tasks, { total: 3, completed: 1, blocked: 1, waiting: 1 });
  assert.deepEqual(result.events, { lateReceipts: 1, dispatchUnknown: 1, expiredWaits: 1 });
  assert.deepEqual(result.reports, { total: 2, queued: 0, running: 0, completed: 1, failed: 1, latestReportedDurationMs: 20, latestReportedQueueMs: 3 });
  assert.equal(result.timing.modelMs, null);
  assert.equal(result.timing.executionMs, null);
  assert.equal(result.timing.queueMs, null);
  assert.equal(result.monetaryCost, null);
  assert.ok(result.gaps.includes('provider_calls_untracked'));
  assert.equal('passed' in result, false);
  assert.equal('quality' in result, false);
});

test('projection is read-only and never returns IDs, secrets, prompts, URLs or marker contents', () => {
  const secret = 'private-marker-dont-show';
  const value = input({ attempts: [attempt(secret, { operationId: secret, toolCallIds: [`${prefix}start:${secret}`, receipt(secret, 100)], prompt: secret, receipt: { sourceId: secret } })],
    resources: [{ id: secret, owner: 'human', state: 'claimed', expiresAt: deadline, executorResourceId: secret }],
    events: [{ id: secret, kind: secret, payload: { url: secret } }] });
  value.mission.goal = secret;
  const before = structuredClone(value);
  const result = missionTelemetry(value);
  assert.deepEqual(value, before);
  assert.equal(JSON.stringify(result).includes(secret), false);
  assert.equal(JSON.stringify(result).includes('sourceId'), false);
});

function irisMarkers(usage) {
  const callId = randomUUID();
  return [`${IRIS_MODEL_LEDGER_PREFIX}start:${callId}`, ...(usage ? [`${IRIS_MODEL_LEDGER_PREFIX}usage:${JSON.stringify({ callId, durationMs: 2000, ...usage })}`] : [])];
}

test('Iris physical calls and cache usage never duplicate aggregate or workflow token usage', () => {
  const measured = { inputTokens: 372580, outputTokens: 4216, cacheReadTokens: 337792, cacheWriteTokens: 0 };
  const rows = [attempt('iris', { toolCallIds: irisMarkers(measured), usage: { tokens: 376796, toolCalls: 20, durationMs: 2000 }, toolCalls: 20 }),
    attempt('review', { kind: 'review', toolCallIds: markers('review:job:1', 1000) })];
  const result = missionTelemetry(input({ attempts: rows }));
  assert.equal(result.tokens.measuredKnown, 377796);
  assert.equal(result.tokens.total, 377796);
  assert.deepEqual(result.model.providers, { tracked: 1, knownTokens: 1, unknownTokens: 0, total: null });
  assert.deepEqual(result.model.workflows, { tracked: 1, knownTokens: 1, unknownTokens: 0 });
  assert.deepEqual(result.model.measured, { ...measured, durationMs: 2000 });
});

test('unsettled physical provider calls remain unknown despite an earlier aggregate', () => {
  const row = attempt('iris', { toolCallIds: [...irisMarkers({ inputTokens: 800, outputTokens: 200, cacheReadTokens: null, cacheWriteTokens: null }), ...irisMarkers(null)] });
  const result = missionTelemetry(input({ attempts: [row] }));
  assert.equal(result.tokens.measuredKnown, 1000);
  assert.equal(result.tokens.total, null);
  assert.deepEqual(result.model.providers, { tracked: 2, knownTokens: 1, unknownTokens: 1, total: 2 });
  assert.ok(result.gaps.includes('unknown_tokens'));
  assert.equal(result.model.measured.inputTokens, 800);
  assert.equal(result.model.measured.cacheReadTokens, null);
});

test('missing all provider usage is null, while an explicitly measured zero remains zero', () => {
  const missing = missionTelemetry(input({ attempts: [attempt('iris', { usage: null, toolCallIds: irisMarkers({ inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null }) })] }));
  assert.equal(missing.tokens.measuredKnown, null);
  assert.equal(missing.tokens.total, null);
  assert.deepEqual(missing.model.measured, { inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, durationMs: 2000 });
  const zero = missionTelemetry(input({ attempts: [attempt('iris', { usage: { tokens: 0, toolCalls: 0, durationMs: 0 }, toolCallIds: irisMarkers({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }) })] }));
  assert.equal(zero.tokens.measuredKnown, 0);
  assert.equal(zero.tokens.total, 0);
  assert.equal(zero.model.measured.cacheReadTokens, 0);
});

function provider(inputTokens = 90, outputTokens = 10, cacheReadTokens = 50) {
  return sumProviderUsage([{ inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens: null, durationMs: 20 }]);
}
function providerMarkers(key, value, tokens = value.totalTokens) {
  return [`${prefix}start:${key}`, `${prefix}done:${key}`, `${prefix}usage:${JSON.stringify({ key, tokens, toolCalls: 0, provider: value })}`];
}

test('planner, queue and Iris physical summaries add once, with cache only inside input tokens', () => {
  const planning = provider(), first = provider(), second = combineProviderUsage([provider(), provider()]);
  const queue = combineProviderUsage([first, second]);
  const iris = { inputTokens: 800, outputTokens: 200, cacheReadTokens: 500, cacheWriteTokens: null };
  const rows = [attempt('planning', { kind: 'planning', usage: { tokens: 100, toolCalls: 0, durationMs: 20, provider: planning } }),
    attempt('report', { kind: 'report', toolCallIds: [...providerMarkers('report:job:1', first), ...providerMarkers('report:job:2', second)],
      usage: { tokens: 300, toolCalls: 0, durationMs: 60, provider: queue } }),
    attempt('iris', { toolCallIds: irisMarkers(iris), usage: { tokens: 1000, toolCalls: 2, durationMs: 2000, provider: provider(800, 200, 500) } })];
  const result = missionTelemetry(input({ attempts: rows }));
  assert.deepEqual(result.tokens, { measuredKnown: 1400, total: 1400, unknownAttempts: 0 });
  assert.deepEqual(result.model.providers, { tracked: 5, knownTokens: 5, unknownTokens: 0, total: 5 });
  assert.deepEqual(result.model.workflows, { tracked: 2, knownTokens: 2, unknownTokens: 0 });
  assert.deepEqual(result.model.measured, { inputTokens: 1160, outputTokens: 240, cacheReadTokens: 700, cacheWriteTokens: null, durationMs: 2080 });
  assert.equal(result.gaps.includes('provider_calls_untracked'), false);
});

test('workflow replay deduplicates both physical summary and aggregate', () => {
  const value = provider(), ids = providerMarkers('review:job:1', value);
  const row = attempt('review', { kind: 'review', toolCallIds: [...ids, ...ids], usage: { tokens: 100, toolCalls: 0, durationMs: 20, provider: value } });
  const result = missionTelemetry(input({ attempts: [row, row] }));
  assert.equal(result.tokens.total, 100);
  assert.equal(result.model.providers.total, 1);
  assert.equal(result.model.measured.durationMs, 20);
});

test('missing physical receipt leaves total call count unknown even with an earlier provider aggregate', () => {
  const value = provider(), row = attempt('report', { kind: 'report', status: 'running',
    toolCallIds: [...providerMarkers('report:job:1', value), `${prefix}start:report:job:2`],
    usage: { tokens: 100, toolCalls: 0, durationMs: 20, provider: value } });
  const result = missionTelemetry(input({ attempts: [row] }));
  assert.deepEqual(result.tokens, { measuredKnown: 100, total: null, unknownAttempts: 1 });
  assert.deepEqual(result.model.providers, { tracked: 1, knownTokens: 1, unknownTokens: 0, total: null });
  assert.equal(result.model.workflows.unknownTokens, 1);
  assert.ok(result.gaps.includes('provider_calls_untracked'));
  assert.equal(result.model.measured.cacheReadTokens, 50);
});

test('a measured physical failure counts as a call but not zero tokens and preserves other measured fields', () => {
  const known = provider(), unknown = provider(null, 10, null), combined = combineProviderUsage([known, unknown]);
  const result = missionTelemetry(input({ attempts: [attempt('report', { kind: 'report',
    toolCallIds: [...providerMarkers('report:job:1', known), ...providerMarkers('report:job:2', unknown), `${prefix}unknown`],
    usage: { tokens: null, toolCalls: 0, durationMs: 40, provider: combined } })] }));
  assert.equal(result.tokens.total, null);
  assert.equal(result.tokens.measuredKnown, 110);
  assert.deepEqual(result.model.providers, { tracked: 2, knownTokens: 1, unknownTokens: 1, total: 2 });
  assert.deepEqual(result.model.measured, { inputTokens: 90, outputTokens: 20, cacheReadTokens: 50, cacheWriteTokens: null, durationMs: 40 });
});

test('conflicting physical receipts with identical token totals remain invalid and cannot endorse aggregates', () => {
  const value = provider(), key = 'review:job:1';
  const original = providerMarkers(key, value);
  const changed = providerMarkers(key, { ...value, cacheReadTokens: 60 });
  const result = missionTelemetry(input({ attempts: [attempt('review', { kind: 'review', toolCallIds: [...original, ...changed, ...original],
    usage: { tokens: 100, toolCalls: 0, durationMs: 20, provider: value } })] }));
  assert.equal(result.tokens.total, null);
  assert.equal(result.model.providers.total, null);
  assert.equal(result.model.measured.cacheReadTokens, null);
  assert.ok(result.gaps.includes('invalid_model_ledger'));
});

test('invalid, impossible or mismatched provider summaries are never returned as measurements', () => {
  const value = provider();
  for (const corrupt of [{ ...value, providerCalls: -1 }, { ...value, unknownCalls: 2 }, { ...value, totalTokens: 99 },
    { ...value, inputTokens: null }, { ...value, cacheReadTokens: 1000 }, { ...value, durationMs: NaN }, { ...value, privatePrompt: 'do-not-project' }]) {
    const result = missionTelemetry(input({ attempts: [attempt('planning', { kind: 'planning', usage: { tokens: 100, toolCalls: 0, durationMs: 20, provider: corrupt } })] }));
    assert.equal(result.tokens.total, null);
    assert.equal(result.model.providers.total, null);
    assert.equal(result.model.measured.inputTokens, null);
    assert.ok(result.gaps.includes('invalid_model_ledger'));
    assert.equal(JSON.stringify(result).includes('do-not-project'), false);
  }
  const mismatch = missionTelemetry(input({ attempts: [attempt('report', { kind: 'report', toolCallIds: providerMarkers('report:job:1', value),
    usage: { tokens: 100, toolCalls: 0, durationMs: 20, provider: provider(80, 20) } })] }));
  assert.equal(mismatch.model.providers.total, null);
  assert.equal(mismatch.model.measured.inputTokens, null);
  assert.ok(mismatch.gaps.includes('invalid_model_ledger'));
});

test('physical receipts distinguish explicit zero from missing usage and from untracked legacy calls', () => {
  const zero = provider(0, 0, 0), unknown = provider(null, null, null);
  for (const [value, measured, total] of [[zero, 0, 0], [unknown, null, null]]) {
    const result = missionTelemetry(input({ attempts: [attempt('review', { kind: 'review', toolCallIds: providerMarkers('review:job:1', value),
      usage: { tokens: total, toolCalls: 0, durationMs: 20, provider: value } })] }));
    assert.equal(result.tokens.total, total);
    assert.equal(result.model.measured.inputTokens, measured);
    assert.equal(result.model.measured.cacheReadTokens, measured);
    assert.equal(result.model.providers.total, 1);
  }
  const legacy = missionTelemetry(input({ attempts: [attempt('review', { kind: 'review', toolCallIds: markers('review:job:1', 100) })] }));
  assert.equal(legacy.model.providers.total, null);
  assert.equal(legacy.model.measured.inputTokens, null);
  assert.equal(legacy.model.providers.tracked, 0);
});

test('safe individual counts cannot overflow into fabricated aggregate measurements', () => {
  const value = provider(Number.MAX_SAFE_INTEGER, 0, 0);
  const rows = ['first', 'second'].map(id => attempt(id, { kind: 'planning', usage: { tokens: Number.MAX_SAFE_INTEGER, toolCalls: 0, durationMs: 20, provider: value } }));
  const result = missionTelemetry(input({ attempts: rows }));
  assert.equal(result.model.measured.inputTokens, null);
  assert.equal(result.tokens.measuredKnown, null);
  assert.equal(result.tokens.total, null);
  assert.ok(result.gaps.includes('invalid_usage'));
});
