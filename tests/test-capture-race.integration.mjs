import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { registerHooks } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import { eq, sql } from 'drizzle-orm';
import { isolatedApp } from './helpers/isolated-app.mjs';

// Actual PostgreSQL transactions, capture persistence and filesystem reads.
// The page and reviewer are synthetic fixtures; no browser/model network runs.
process.env.PAT_RUNTIME_SCOPE = `${process.env.PAT_RUNTIME_SCOPE}-captures-${randomUUID()}`;
const app = await isolatedApp(), { db, schema } = app;
const hooks = registerHooks({ resolve(specifier, context, next) {
  if (/(?:^|\/)result-reviewer(?:\.ts)?$/.test(specifier)) return { url: 'data:text/javascript,export const assessResult = input => globalThis.captureReview(input);', shortCircuit: true };
  return next(specifier, context);
} });
const { saveItem } = await import('../server/utils/workspaces.ts');
const { testRunAction } = await import('../server/utils/test-runs.ts');
const { captureTestStep } = await import('../server/utils/test-captures.ts');
const { listAssessments, buildReviewInput, hashReview } = await import('../server/utils/result-assessments.ts');
const { processReviewQueue } = await import('../server/utils/result-review-worker.ts');
const { readMissionSource } = await import('../server/utils/mission-sources.ts');
const { del, workspaceStorageToken } = await import('../server/utils/evidence-storage.ts');
const userId = randomUUID(), workspaceId = randomUUID(), threadId = randomUUID();
const target = { environment: 'isolated synthetic page', url: 'https://example.test', revision: 'fixture-v1' };
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jGZkAAAAASUVORK5CYII=', 'base64');
const pending = [], releases = new Set();
let checks = 0;
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
function barrier() {
  const entered = deferred(), released = deferred(); releases.add(released.resolve);
  return { entered: entered.promise, async wait() { entered.resolve(); await released.promise; }, release() { released.resolve(); releases.delete(released.resolve); } };
}
async function bounded(promise, label) {
  const controller = new AbortController();
  try { return await Promise.race([promise, delay(10000, undefined, { signal: controller.signal }).then(() => { throw new Error(`Timed out: ${label}`); })]); }
  finally { controller.abort(); }
}
function page({ gate, fail = false } = {}) {
  return { url: () => target.url, title: async () => 'Synthetic page', locator: () => ({}), screenshot: async () => { if (gate) await gate.wait(); if (fail) throw new Error('Synthetic screenshot failure'); return png; } };
}
function capture(run, options) {
  const request = db.transaction(async tx => {
    // Same outer transaction and lock ordering as browser.lockedWorkspace.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`browser:${workspaceId}:${threadId}:main`}, 0))`);
    return captureTestStep(userId, workspaceId, threadId, 'click', page(options), run.id, tx);
  });
  pending.push(request); return request;
}
async function startRun() {
  const test = { id: randomUUID(), title: 'Capture fixture', type: 'browser', preconditions: '', steps: 'Click the link', expected: 'Destination visible' };
  const plan = await saveItem(userId, workspaceId, { title: 'Capture fixture plan', content: { kind: 'test_plan', sources: [], cases: [test] } });
  return testRunAction(userId, workspaceId, threadId, { action: 'start', requestId: randomUUID(), itemId: plan.id, caseId: test.id, expectedVersion: plan.version, environment: target.environment, target });
}
async function finish(run, itemId) {
  const result = { outcome: 'passed', actual: 'Synthetic observation', unverified: '', observations: [], evidenceItemIds: itemId ? [itemId] : [], checks: run.checks.map(check => ({ id: check.id, status: 'verified', actual: 'Synthetic step verified' })) };
  return testRunAction(userId, workspaceId, threadId, { action: 'finish', runId: run.id, result });
}
const captures = run => db.select().from(schema.testCaptures).where(eq(schema.testCaptures.runId, run.id));
const items = () => db.select().from(schema.workspaceItems).where(eq(schema.workspaceItems.workspaceId, workspaceId));
globalThis.captureReview = input => {
  const evidence = input.evidence.find(e => e.readStatus === 'read' && e.provenance?.producer === 'test-capture');
  assert.ok(evidence);
  return { verdict: 'supported', summary: 'Synthetic fixture bytes inspected', findings: input.requirements.map(r => ({ requirementId: r.id, verdict: 'supported', explanation: 'Synthetic fixture matches', evidenceIds: [evidence.id], suggestedNextStep: '', gap: null })) };
};

try {
  assert.equal(process.env.GRUNDEN_API_TOKEN, '');
  await db.insert(schema.user).values({ id: userId, name: 'Capture race fixture', email: `${userId}@example.test` });
  await db.insert(schema.workspaces).values({ id: workspaceId, userId, name: 'Capture race fixture' });
  await db.insert(schema.threads).values({ id: threadId, userId, workspaceId, title: 'Capture race fixture' });

  for (const fail of [false, true]) {
    const run = await startRun();
    const first = await capture(run);
    assert.ok(first.capture?.itemId);
    const stored = (await items()).find(item => item.id === first.capture.itemId);
    assert.equal(stored.provenance.sourceId, run.id); assert.ok(stored.provenance.sha256); checks++;
    const gate = barrier(), late = capture(run, { gate, fail });
    await bounded(gate.entered, 'screenshot begins before finish');
    await bounded(finish(run, first.capture.itemId), 'finish proceeds while screenshot is in flight');
    await processReviewQueue();
    const [assessment] = await listAssessments(userId, workspaceId, run.id);
    assert.equal(assessment.status, 'completed'); assert.equal(assessment.assessment.verdict, 'supported'); assert.equal(assessment.stale, false); checks++;
    const beforeHash = hashReview(await buildReviewInput(workspaceId, run.id)), beforeItems = (await items()).length;
    gate.release();
    const response = await bounded(late, 'late capture returns warning');
    assert.equal(response.capture, undefined); assert.match(response.captureWarning, /avslutades/);
    assert.equal((await captures(run)).length, 1); assert.equal((await items()).length, beforeItems);
    assert.equal(hashReview(await buildReviewInput(workspaceId, run.id)), beforeHash); checks++;
    const [current] = await listAssessments(userId, workspaceId, run.id);
    const source = await readMissionSource(db, workspaceId, 'test', run.id);
    assert.equal(current.stale, false); assert.equal(source.assessment.stale, false); checks++;
  }

  const failed = await startRun(), failedCapture = await capture(failed, { fail: true });
  assert.ok(failedCapture.captureWarning); assert.equal(failedCapture.capture, undefined);
  const [failure] = await captures(failed);
  assert.ok(failure.error); assert.equal(failure.itemId, null); checks++;
  await finish(failed); await processReviewQueue();
  assert.equal((await listAssessments(userId, workspaceId, failed.id))[0].assessment.verdict, 'needs_evidence'); checks++;

  const limited = await startRun();
  await db.insert(schema.testCaptures).values(Array.from({ length: 30 }, () => ({ id: randomUUID(), runId: limited.id, title: 'Synthetic earlier receipt', url: target.url, action: 'click', error: 'Synthetic earlier failure' })));
  let screenshotCalled = false;
  const limit = await captureTestStep(userId, workspaceId, threadId, 'click', { ...page(), screenshot: async () => { screenshotCalled = true; return png; } }, limited.id);
  assert.match(limit.captureWarning, /limit/); assert.equal(screenshotCalled, false); assert.equal((await captures(limited)).length, 30); checks++;
  console.log(JSON.stringify({ status: 'passed', checks, database: 'actual isolated PostgreSQL', storage: 'actual isolated files', browser: 'synthetic page barriers, no browser network', reviewer: 'deterministic fixture', tested: ['nested browser transaction and savepoints', 'finish wins successful screenshot race', 'finish wins failed screenshot race', 'no orphan late files', 'assessment source hash unchanged', 'active failure preserved', 'capture limit'] }));
} finally {
  for (const release of releases) release();
  await Promise.allSettled(pending);
  try {
    for (const item of await items()) if (item.blobPath) await del(item.blobPath, { token: workspaceStorageToken() });
    await db.delete(schema.testCaptures).where(sql`${schema.testCaptures.runId} in (select id from pat_test_runs where workspace_id = ${workspaceId})`);
    await db.delete(schema.user).where(eq(schema.user.id, userId));
  } finally { hooks.deregister(); delete globalThis.captureReview; await app.close(); }
}
