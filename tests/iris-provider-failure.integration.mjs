import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { controllerFixture } from './helpers/mission-controller-fixture.mjs';
import { irisModelUsage, IRIS_MODEL_LEDGER_PREFIX as prefix } from '../shared/browser-job.ts';

assert.equal(process.env.GRUNDEN_API_TOKEN, '', 'No model credential is permitted');
const h = await controllerFixture(), { db, schema } = h;
const { recordBrowserJobEvent } = await import('../server/utils/browser-jobs.ts');
const checks = [];
try {
  const f = await h.fixture(), state = await h.browserReady(f), attempt = state.attempts.find(value => value.kind === 'browser_tests');
  const sessionId = randomUUID();
  await db.update(schema.browserJobs).set({ sessionId }).where(eq(schema.browserJobs.id, attempt.dispatchId));
  const actor = { jobId: attempt.dispatchId, userId: h.owner, threadId: f.thread, sessionId }, modelCallId = randomUUID();
  await recordBrowserJobEvent({ ...actor, kind: 'model_started', modelCallId });
  const receipt = { ...actor, kind: 'model_finished', modelCallId, modelDurationMs: 10,
    modelUsage: { inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null },
    modelFailure: { kind: 'rate_limited', phase: 'request', outputObserved: false, status: 429, providerErrorCode: 'rate_limit_exceeded', retryAfterMs: 12000 } };
  await recordBrowserJobEvent(receipt);
  let row = await h.row(schema.missionAttempts, attempt.id);
  const stored = JSON.parse(row.toolCallIds.find(value => value.startsWith(`${prefix}usage:`)).slice(`${prefix}usage:`.length));
  assert.deepEqual(stored.failure, receipt.modelFailure); assert.equal(irisModelUsage(row.toolCallIds).tokens, null);
  checks.push('actual PostgreSQL persists safe failure metadata separately from unknown usage');
  await recordBrowserJobEvent(receipt);
  await assert.rejects(recordBrowserJobEvent({ ...receipt, modelFailure: { ...receipt.modelFailure, retryAfterMs: 0 } }));
  row = await h.row(schema.missionAttempts, attempt.id);
  assert.equal(row.toolCallIds.filter(value => value.startsWith(`${prefix}usage:`)).length, 1);
  checks.push('receipt retry is idempotent and diagnostics cannot be rewritten');
  await assert.rejects(recordBrowserJobEvent({ ...actor, kind: 'model_started', modelCallId: randomUUID() }));
  await assert.rejects(recordBrowserJobEvent({ ...receipt, sessionId: randomUUID() }));
  checks.push('unknown consumption still blocks provider admission and foreign sessions cannot write');
  await h.operate(f, 'pause');
  await recordBrowserJobEvent(receipt);
  assert.equal((await h.row(schema.missions, f.id)).lifecycle, 'paused');
  checks.push('late historical failure replay never resumes a paused mandate');
  console.log(JSON.stringify({ status: 'passed', checks: checks.length, results: checks, database: 'actual isolated PostgreSQL', providers: 'none', effects: 'synthetic controller fixture only' }));
} finally { await h.close(); }
