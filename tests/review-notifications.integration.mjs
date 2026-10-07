import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { isolatedApp } from './helpers/isolated-app.mjs';

// Actual isolated PostgreSQL and authored queue/notifier services. HTTP delivery
// is recorded locally: this test must not start an Eve turn or any model call.
process.env.PAT_RUNTIME_SCOPE = `${process.env.PAT_RUNTIME_SCOPE}-notify-${randomUUID()}`;
const app = await isolatedApp(), { db, schema } = app;
const { enqueueReview, requestReview } = await import('../server/utils/result-assessments.ts');
const { notifyReviewedResults } = await import('../server/utils/result-review-notifications.ts');
const owner = randomUUID(), workspaceId = randomUUID(), threadId = randomUUID(), itemId = randomUUID(), missionId = randomUUID(), taskId = randomUUID(), attemptId = randomUUID();
const runtime = process.env.PAT_RUNTIME_SCOPE, past = new Date(Date.now() - 120000), sent = [], checks = [];
const originalFetch = globalThis.fetch;
globalThis.fetch = async (url, options) => {
  assert.ok(String(url).endsWith('/workers/result-review/notify'), 'Only synthetic local notification delivery is allowed');
  sent.push(JSON.parse(options.body)); return Response.json({ ok: true });
};
const row = async (table, id) => (await db.select().from(table).where(eq(table.id, id)))[0];
async function queue({ autonomous = false, completed = false } = {}) {
  const runId = randomUUID(), testCase = { id: randomUUID(), title: 'Saved observation', type: 'browser', preconditions: '', steps: 'Inspect page', expected: 'Page is readable' };
  await db.insert(schema.testRuns).values({ id: runId, workspaceId, itemId, caseId: testCase.id, planVersion: 1, snapshot: testCase, environment: 'fixture',
    target: { environment: 'fixture', url: 'https://example.test', revision: 'fixture' }, threadId, requestId: randomUUID(), runtime,
    missionAttemptId: autonomous ? attemptId : null, startedAt: past, finishedAt: past,
    result: { outcome: 'inconclusive', actual: 'Saved synthetic observation', unverified: 'No browser executed by this test', observations: [], evidenceItemIds: [] } });
  await db.transaction(tx => enqueueReview(tx, owner, workspaceId, runId, threadId));
  const [job] = await db.select().from(schema.resultAssessments).where(and(eq(schema.resultAssessments.runId, runId), eq(schema.resultAssessments.runtime, runtime)));
  if (completed) await db.update(schema.resultAssessments).set({ status: 'completed', finishedAt: past }).where(eq(schema.resultAssessments.id, job.id));
  return { ...job, runId };
}
try {
  await db.insert(schema.user).values({ id: owner, name: 'Notification fixture', email: `${owner}@example.test` });
  await db.insert(schema.workspaces).values({ id: workspaceId, userId: owner, name: 'Notification fixture' });
  await db.insert(schema.threads).values({ id: threadId, userId: owner, workspaceId, title: 'Mixed legacy and autonomous work' });
  await db.insert(schema.chatRuntimes).values({ threadId, runtime, sessionId: 'local-notification-fixture' });
  await db.insert(schema.workspaceItems).values({ id: itemId, workspaceId, title: 'Fixture plan', content: { kind: 'test_plan', sources: [], cases: [] } });
  await db.insert(schema.missions).values({ id: missionId, workspaceId, userId: owner, threadId, runtime, requestId: randomUUID(), controllerVersion: 1,
    config: { title: 'Fixture', goal: 'Fixture', scope: 'Saved results', criteria: [], target: null, caseKeys: [], automaticReports: false } });
  await db.insert(schema.missionTasks).values({ id: taskId, missionId, requestId: randomUUID(), title: 'Browser fixture', actor: 'iris', criterionIds: [], dependsOn: [] });
  await db.insert(schema.missionAttempts).values({ id: attemptId, missionId, taskId, runtime, kind: 'browser_tests', operationId: randomUUID(), requestHash: 'fixture', dispatchId: randomUUID(), attemptNo: 1,
    mandateRevision: 1, planRevision: 1, status: 'completed', reservedTokens: 0, reservedToolCalls: 0, deadlineAt: new Date(Date.now() + 60000) });

  const first = await queue({ autonomous: true });
  assert.equal(first.notification, 'recorded'); checks.push('new autonomous assessments use UI-only receipts');
  await db.update(schema.resultAssessments).set({ status: 'failed', finishedAt: past }).where(eq(schema.resultAssessments.id, first.id));
  await requestReview(owner, workspaceId, first.runId);
  assert.equal((await row(schema.resultAssessments, first.id)).notification, 'recorded'); checks.push('explicit review retry does not restore autonomous chat notification');

  const oldAuto = await queue({ autonomous: true, completed: true });
  await db.update(schema.resultAssessments).set({ notification: 'pending' }).where(eq(schema.resultAssessments.id, oldAuto.id));
  await db.update(schema.resultAssessments).set({ notification: 'pending' }).where(eq(schema.resultAssessments.id, first.id));
  const legacy = await queue({ completed: true });
  assert.equal(legacy.notification, 'pending');
  await notifyReviewedResults();
  assert.equal(sent.length, 1); assert.deepEqual(sent[0].report.map(entry => entry.runId), [legacy.runId]);
  assert.equal((await row(schema.resultAssessments, first.id)).notification, 'recorded');
  assert.equal((await row(schema.resultAssessments, oldAuto.id)).notification, 'recorded');
  assert.equal((await row(schema.resultAssessments, legacy.id)).notification, 'sent');
  checks.push('mixed thread sends legacy result only; old queued/completed autonomous rows are recorded');
  await notifyReviewedResults(); assert.equal(sent.length, 1); checks.push('repeated notifier pass cannot duplicate a turn');

  const foreign = await queue({ autonomous: true, completed: true });
  await db.update(schema.resultAssessments).set({ notification: 'pending', runtime: `${runtime}-other` }).where(eq(schema.resultAssessments.id, foreign.id));
  await notifyReviewedResults(); assert.equal(sent.length, 1); assert.equal((await row(schema.resultAssessments, foreign.id)).notification, 'pending');
  checks.push('another runtime is left untouched');
  console.log(JSON.stringify({ passed: checks.length, checks, database: 'actual isolated PostgreSQL', delivery: 'synthetic HTTP receipt; no Eve or model calls' }));
} finally {
  globalThis.fetch = originalFetch;
  await db.delete(schema.testRuns).where(eq(schema.testRuns.workspaceId, workspaceId));
  await db.delete(schema.user).where(eq(schema.user.id, owner));
  await app.close();
}
