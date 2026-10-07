import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { generateText } from 'ai';
import { controllerFixture } from './helpers/mission-controller-fixture.mjs';
import { meteredModel } from '../agent/lib/model-usage.ts';
import { openAIWireUsage, sumProviderUsage } from '../shared/provider-usage.ts';

// Actual isolated PG + authored queue authority/accounting. Synthetic provider
// transport only; no real model, auth secrets, or external network permitted.
const h = await controllerFixture(), { db, schema } = h;
const { saveFile } = await import('../server/utils/workspaces.ts');
const { processReviewQueue } = await import('../server/utils/result-review-worker.ts');
const { processMissionReport } = await import('../server/utils/mission-reports.ts');
const { writeMissionReport } = await import('../agent/lib/mission-reporter.ts');
const { beginQueueModel, settleQueueModel } = await import('../server/utils/mission-review-admission.ts');
const { del, workspaceStorageToken } = await import('../server/utils/evidence-storage.ts');
const scripts = globalThis.missionControllerFixtureExecutors, originalReview = scripts.assessResult, originalReport = scripts.writeMissionReport;
const paths = [], runs = [], checks = [], failures = [];
const full = { prompt_tokens: 12, completion_tokens: 3, prompt_tokens_details: { cached_tokens: 8 } };
function meter(beforeCall) {
  let physical = 0;
  const provider = createOpenAICompatible({ name: 'audit-fixture', baseURL: 'http://127.0.0.1:1/v1', apiKey: 'test-only', fetch: async url => {
    assert.equal(String(url), 'http://127.0.0.1:1/v1/chat/completions'); physical++;
    return new Response(JSON.stringify({ id: 'fixture', created: 0, model: 'fixture', object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: 'observed' }, finish_reason: 'stop' }], usage: full }), { headers: { 'content-type': 'application/json' } });
  } });
  const value = meteredModel(provider('fixture'), beforeCall);
  return { ...value, physical: () => physical, run: () => generateText({ model: value.model, prompt: 'Synthetic local audit', maxRetries: 0 }) };
}
async function reviewFixture() {
  const f = await h.fixture(); await h.browserReady(f); const [run] = await h.finishBrowser(f); runs.push(run.id);
  const item = await saveFile(h.owner, f.workspace, 'provider-audit.txt', 'text/plain', Buffer.from('Synthetic independent browser observation.'), f.thread, db,
    { provenance: { version: 1, origin: 'tool', producer: 'test-capture', sourceType: 'test', sourceId: run.id, observedAt: new Date().toISOString(), url: f.target.url } });
  paths.push((await h.row(schema.workspaceItems, item.id)).blobPath);
  await db.insert(schema.testCaptures).values({ id: randomUUID(), runId: run.id, itemId: item.id, title: 'Audit observation', url: f.target.url, action: 'click' });
  await db.update(schema.testRuns).set({ finishedAt: new Date(Date.now() + 1), result: { outcome: 'passed', actual: 'Synthetic execution', unverified: '', observations: [], evidenceItemIds: [item.id], checks: run.checks.map(c => ({ id: c.id, status: 'verified', actual: 'Synthetic observation' })) } }).where(eq(schema.testRuns.id, run.id));
  const state = await h.until(f, state => state.attempts.some(a => a.kind === 'review'));
  const [job] = await db.select().from(schema.resultAssessments).where(eq(schema.resultAssessments.runId, run.id));
  return { f, job, attempt: state.attempts.find(a => a.kind === 'review') };
}
async function reportFixture() {
  const { f } = await reviewFixture(); await processReviewQueue();
  const state = await h.until(f, state => state.reports.some(r => r.status === 'queued'));
  return { f, job: state.reports.find(r => r.status === 'queued'), attempt: state.attempts.find(a => a.kind === 'report') };
}
async function stopOthers() {
  await db.update(schema.resultAssessments).set({ status: 'failed' }).where(and(eq(schema.resultAssessments.runtime, process.env.PAT_RUNTIME_SCOPE), inArray(schema.resultAssessments.status, ['queued', 'running'])));
  for (const mission of await db.select().from(schema.missions).where(eq(schema.missions.runtime, process.env.PAT_RUNTIME_SCOPE))) await db.update(schema.missionReports).set({ status: 'failed' }).where(and(eq(schema.missionReports.missionId, mission.id), inArray(schema.missionReports.status, ['queued', 'running'])));
}
async function check(name, run) {
  try { await run(); checks.push(name); }
  catch (error) { failures.push({ name, message: error.message }); }
  finally { scripts.assessResult = originalReview; scripts.writeMissionReport = originalReport; await stopOthers(); }
}
try {
  assert.equal(process.env.GRUNDEN_API_TOKEN, '');
  await check('pre-provider admission denial measures zero real calls and zero known tokens', async () => {
    const observed = meter(async () => { throw new Error('No permission'); }); await assert.rejects(observed.run(), /No permission/);
    assert.equal(observed.physical(), 0); assert.equal(observed.usage().providerCalls, 0); assert.equal(observed.usage().unknownCalls, 0); assert.equal(observed.usage().totalTokens, 0);
  });
  await check('review paused before transport remains queued without unknown consumption', async () => {
    const { f, job, attempt } = await reviewFixture(); let observed;
    scripts.assessResult = async (_input, _attachments, _signal, onUsage, beforeCall) => {
      observed = meter(async () => { await h.operate(f, 'pause'); await beforeCall(); });
      try { await observed.run(); assert.fail('Paused review must not generate'); }
      finally { onUsage(observed.usage().totalTokens, observed.usage()); }
    };
    await processReviewQueue(); const saved = await h.row(schema.missionAttempts, attempt.id);
    assert.equal(observed.physical(), 0); assert.equal((await h.row(schema.resultAssessments, job.id)).status, 'queued');
    assert.equal(saved.usage.tokens, 0); assert.equal(saved.usage.provider.providerCalls, 0); assert.ok(!saved.toolCallIds.includes('server:queue-model:unknown'));
  });
  for (const precedingCalls of [0, 1]) await check(`report paused after ${precedingCalls} real calls preserves the exact measured history`, async () => {
    const { f, job, attempt } = await reportFixture(); let observed, step = 0;
    scripts.writeMissionReport = async (_snapshot, _read, _signal, options) => {
      observed = meter(async () => { if (step++ === precedingCalls) await h.operate(f, 'pause'); await options.beforeModel(); });
      try { for (let i = 0; i <= precedingCalls; i++) await observed.run(); assert.fail('Paused report must not finish'); }
      finally { options.onUsage(observed.usage(), 0); }
    };
    await processMissionReport(); const saved = await h.row(schema.missionAttempts, attempt.id);
    assert.equal(observed.physical(), precedingCalls); assert.equal((await h.row(schema.missionReports, job.id)).status, 'queued');
    assert.equal(saved.usage.tokens, precedingCalls * 15); assert.equal(saved.usage.provider.providerCalls, precedingCalls); assert.ok(!saved.toolCallIds.includes('server:queue-model:unknown'));
  });
  await check('report cannot start a second provider call after the first consumed its token allowance', async () => {
    const { f, job } = await reportFixture(); const mission = await h.row(schema.missions, f.id);
    await db.update(schema.missions).set({ mandate: { ...mission.mandate, limits: { ...mission.mandate.limits, tokensPerAttempt: 10 } } }).where(eq(schema.missions.id, f.id));
    let physical = 0, evidenceId;
    scripts.writeMissionReport = async (...args) => {
      evidenceId = args[0].tasks.flatMap(t => t.sources.flatMap(s => s.evidence))[0].id;
      return writeMissionReport(...args);
    };
    const previousFetch = globalThis.fetch;
    globalThis.fetch = async url => {
      assert.equal(String(url), 'https://api.grunden.ai/v1/chat/completions');
      physical++;
      if (physical > 1) throw new Error('Synthetic over-budget transport observed');
      return new Response(JSON.stringify({ id: 'fixture', created: 0, model: 'fixture', object: 'chat.completion', choices: [{ index: 0,
        message: { role: 'assistant', content: null, tool_calls: [{ id: 'read-one', type: 'function', function: { name: 'read_mission_evidence', arguments: JSON.stringify({ evidenceId }) } }] }, finish_reason: 'tool_calls' }], usage: full }), { headers: { 'content-type': 'application/json' } });
    };
    process.env.GRUNDEN_API_TOKEN = 'synthetic-provider-only';
    try { await processMissionReport(); }
    finally { globalThis.fetch = previousFetch; process.env.GRUNDEN_API_TOKEN = ''; }
    assert.equal(physical, 1, 'A final admitted call may overshoot; another physical call must not be admitted after it');
    assert.equal((await h.row(schema.missionReports, job.id)).itemId, null);
  });
  await check('known and unknown report invocations aggregate once; replay cannot erase unknown or double-count', async () => {
    const { job, attempt } = await reportFixture(), lease = randomUUID();
    await db.update(schema.missionReports).set({ status: 'running', leaseToken: lease, leaseUntil: new Date(Date.now() + 60000) }).where(eq(schema.missionReports.id, job.id));
    const known = sumProviderUsage([{ ...openAIWireUsage({ raw: full }), durationMs: 4 }]), unknown = sumProviderUsage([{ ...openAIWireUsage(undefined), durationMs: 6 }]);
    const first = await beginQueueModel('report', job.id, 1, lease); assert.equal(first.execution.status, 'allowed');
    await settleQueueModel(first.call, { tokens: known.totalTokens, durationMs: 4, provider: known });
    const second = await beginQueueModel('report', job.id, 2, lease); assert.equal(second.execution.status, 'allowed');
    await settleQueueModel(second.call, { tokens: null, durationMs: 6, provider: unknown });
    const saved = await h.row(schema.missionAttempts, attempt.id);
    assert.equal(saved.usage.tokens, null); assert.equal(saved.usage.provider.providerCalls, 2); assert.equal(saved.usage.provider.unknownCalls, 1);
    await settleQueueModel(first.call, { tokens: 12345, durationMs: 999, provider: known });
    await settleQueueModel(second.call, { tokens: 12345, durationMs: 999, provider: known });
    assert.deepEqual((await h.row(schema.missionAttempts, attempt.id)).usage, saved.usage);
  });
  console.log(JSON.stringify({ passed: checks.length, checks, failures, provider: 'installed actual SDK, synthetic local transport only', database: 'actual isolated PostgreSQL' }));
  if (failures.length) process.exitCode = 1;
} finally {
  for (const runId of runs) await db.delete(schema.testCaptures).where(eq(schema.testCaptures.runId, runId));
  await Promise.all(paths.map(path => del(path, { token: workspaceStorageToken() }))); await h.close();
}
