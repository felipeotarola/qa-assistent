import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { controllerFixture } from './helpers/mission-controller-fixture.mjs';
import { sumProviderUsage } from '../shared/provider-usage.ts';

// Actual isolated PostgreSQL, queue admission/settlement and owner-scoped read
// projection. Provider receipts are synthetic; no model or network is invoked.
const h = await controllerFixture(), { db, schema } = h;
const { beginQueueModel, settleQueueModel } = await import('../server/utils/mission-review-admission.ts');
const { readMissionDetail } = await import('../server/utils/mission-presentation.ts');
const prefix = 'server:queue-model:', passed = [];
const provider = (inputTokens = 90, outputTokens = 10, cacheReadTokens = 50) => sumProviderUsage([
  { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens: null, durationMs: 20 },
]);
const read = async f => (await readMissionDetail(h.owner, f.workspace, f.id)).telemetry;
async function check(name, fn) { await fn(); passed.push(name); }
async function queuedReport() {
  const f = await h.fixture({ intent: 'report_only' });
  const s = await h.until(f, s => s.reports.length === 1), job = s.reports[0], attempt = s.attempts.find(a => a.kind === 'report');
  assert.ok(attempt);
  return { f, job, attempt };
}
async function begin(fixture, invocation, lease = randomUUID()) {
  await db.update(schema.missionReports).set({ status: 'running', attempts: invocation, leaseToken: lease, leaseUntil: new Date(Date.now() + 60000) })
    .where(eq(schema.missionReports.id, fixture.job.id));
  const result = await beginQueueModel('report', fixture.job.id, invocation, lease);
  assert.equal(result.execution.status, 'allowed'); assert.ok(result.call);
  return result.call;
}
let sequence;
try {
  assert.equal(process.env.GRUNDEN_API_TOKEN, '');
  await check('real queue settlement stores provider receipt and aggregate; projection counts them once', async () => {
    sequence = await queuedReport(); const call = await begin(sequence, 1), value = provider();
    await settleQueueModel(call, { tokens: value.totalTokens, durationMs: 25, toolCalls: 1, provider: value });
    sequence.first = call;
    const stored = await h.row(schema.missionAttempts, sequence.attempt.id);
    assert.deepEqual(stored.usage.provider, value);
    assert.equal(stored.toolCallIds.filter(id => id.startsWith(`${prefix}usage:`)).length, 1);
    const view = await read(sequence.f);
    assert.deepEqual(view.tokens, { measuredKnown: 100, total: 100, unknownAttempts: 0 });
    assert.deepEqual(view.model.providers, { tracked: 1, knownTokens: 1, unknownTokens: 0, total: 1 });
    assert.deepEqual(view.model.measured, { inputTokens: 90, outputTokens: 10, cacheReadTokens: 50, cacheWriteTokens: null, durationMs: 20 });
    assert.equal(view.model.workflows.tracked, 1);
    assert.equal(JSON.stringify(view).includes(sequence.job.id), false);
  });
  await check('settlement replay preserves one receipt even when caller retries with different totals', async () => {
    const before = await h.row(schema.missionAttempts, sequence.attempt.id);
    await settleQueueModel(sequence.first, { tokens: 200, durationMs: 40, provider: provider(180, 20, 50) });
    assert.deepEqual(await h.row(schema.missionAttempts, sequence.attempt.id), before);
    assert.equal((await read(sequence.f)).model.providers.total, 1);
  });
  await check('durable workflow start with lost physical receipt remains untracked, not zero', async () => {
    sequence.lost = await begin(sequence, 2);
    const view = await read(sequence.f);
    assert.equal(view.model.providers.total, null);
    assert.equal(view.model.providers.tracked, 1);
    assert.equal(view.model.workflows.unknownTokens, 1);
    assert.equal(view.tokens.total, null);
    assert.equal(view.tokens.measuredKnown, 100);
    assert.ok(view.gaps.includes('provider_calls_untracked'));
  });
  await check('report recovery keeps earlier measured usage while retaining unknown call reservation', async () => {
    const third = await begin(sequence, 3), value = provider(180, 20, 100);
    await settleQueueModel(third, { tokens: value.totalTokens, durationMs: 25, toolCalls: 1, provider: value });
    const stored = await h.row(schema.missionAttempts, sequence.attempt.id), view = await read(sequence.f);
    assert.equal(stored.usage.tokens, null);
    assert.equal(stored.reservedTokens, 200100);
    assert.equal(view.model.providers.tracked, 2);
    assert.equal(view.model.providers.total, null);
    assert.equal(view.model.measured.inputTokens, 270);
    assert.equal(view.model.measured.cacheReadTokens, 150);
    assert.equal(view.tokens.measuredKnown, 300);
    assert.equal(view.tokens.total, null);
    assert.equal(view.budget.report.chargedTokens, 200100);
  });
  await check('late original physical receipt improves measurement without erasing conservative uncertainty', async () => {
    const value = provider(45, 5, 0);
    await settleQueueModel(sequence.lost, { tokens: 50, durationMs: 25, toolCalls: 1, provider: value });
    const view = await read(sequence.f);
    assert.deepEqual(view.model.providers, { tracked: 3, knownTokens: 3, unknownTokens: 0, total: 3 });
    assert.equal(view.tokens.measuredKnown, 350);
    assert.equal(view.tokens.total, null);
    assert.equal(view.budget.report.chargedTokens, 200100);
    assert.ok(view.gaps.includes('conservative_reservation_retained'));
  });
  await check('real rows distinguish explicitly measured zero tokens from missing provider fields', async () => {
    for (const value of [provider(0, 0, 0), provider(null, null, null)]) {
      const f = await queuedReport(), call = await begin(f, 1);
      await settleQueueModel(call, { tokens: value.totalTokens, durationMs: 25, provider: value });
      const view = await read(f.f);
      assert.equal(view.tokens.total, value.totalTokens);
      assert.equal(view.model.measured.inputTokens, value.inputTokens);
      assert.equal(view.model.measured.cacheReadTokens, value.cacheReadTokens);
      assert.equal(view.model.providers.total, 1);
      assert.equal(view.model.providers.unknownTokens, value.unknownCalls);
    }
  });
  await check('conflicting durable physical receipts cannot be rescued by a plausible aggregate', async () => {
    const fixture = await queuedReport(), call = await begin(fixture, 1), value = provider();
    await settleQueueModel(call, { tokens: 100, durationMs: 25, provider: value });
    const stored = await h.row(schema.missionAttempts, fixture.attempt.id);
    await db.update(schema.missionAttempts).set({ toolCallIds: [...stored.toolCallIds,
      `${prefix}usage:${JSON.stringify({ key: call.key, tokens: 100, toolCalls: 0, provider: { ...value, cacheReadTokens: 60 } })}`] }).where(eq(schema.missionAttempts.id, stored.id));
    const view = await read(fixture.f);
    assert.equal(view.tokens.total, null);
    assert.equal(view.model.providers.total, null);
    assert.equal(view.model.measured.inputTokens, null);
    assert.ok(view.gaps.includes('invalid_model_ledger'));
  });
  await check('planner provider summary survives actual planning persistence without a queue workflow', async () => {
    const original = globalThis.missionControllerFixtureExecutors.planMission, value = provider(110, 10, 50);
    globalThis.missionControllerFixtureExecutors.planMission = async (...args) => {
      // A physical provider receipt requires the real controller's matching
      // pre-call admission, even though generation itself is synthetic here.
      assert.equal(typeof args[3], 'function'); await args[3]();
      const result = await original(...args); return { ...result, usage: { ...result.usage, tokens: value.totalTokens, provider: value } };
    };
    try {
      const f = await h.fixture(), s = await h.until(f, s => s.attempts.some(a => a.kind === 'planning' && a.status === 'completed'));
      const attempt = s.attempts.find(a => a.kind === 'planning');
      assert.deepEqual(attempt.usage.provider, value); assert.equal(attempt.usage.tokens, value.totalTokens);
      const events = await h.rows(schema.missionEvents, f.id);
      const starts = events.filter(event => event.eventKey === `planning-model:${attempt.id}`);
      const receipts = events.filter(event => event.eventKey === `planning-usage:${attempt.id}`);
      assert.equal(starts.length, 1); assert.equal(receipts.length, 1);
      assert.equal(starts[0].payload.invocationId, `${attempt.dispatchId}:planner:0`);
      assert.equal(receipts[0].payload.invocationId, starts[0].payload.invocationId);
      assert.deepEqual(receipts[0].payload.usage.provider, value);
      const view = await read(f);
      assert.equal(view.tokens.total, 120);
      assert.equal(view.model.providers.total, 1);
      assert.equal(view.model.workflows.tracked, 0);
      assert.equal(view.model.measured.inputTokens, 110);
    } finally { globalThis.missionControllerFixtureExecutors.planMission = original; }
  });
} finally { await h.close(); }
console.log(JSON.stringify({ suite: 'mission-provider-telemetry', passed: passed.length, checks: passed }, null, 2));
