import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { controllerFixture } from './helpers/mission-controller-fixture.mjs';
import { runChecks } from '../shared/test-run.ts';

// Actual isolated PostgreSQL/controller/START/FINISH; browser HTTP and executor
// are synthetic. No physical browser, authentication, model or acceptance claim.
assert.equal(process.env.GRUNDEN_API_TOKEN, '');
const h = await controllerFixture(), { db, schema } = h;
const { testRunAction } = await import('../server/utils/test-runs.ts');
const { controlBrowser } = await import('../server/utils/browser.ts');
const { policyDigest } = await import('../server/utils/browser-mission-guard.ts');
const { browserAttemptCases } = await import('../server/utils/mission-browser-return.ts');
const planner = h.scripts.planMission;
h.scripts.planMission = async (...args) => {
  const result = await planner(...args);
  result.draft.cases = [0, 1, 2].map(index => ({ ...result.draft.cases[0], title: `Independent original case ${index}` }));
  return result;
};
let humanEffect = async () => {};
let physicalPosts = 0;
h.scripts.vpsBrowserRequest = async (path, method) => {
  assert.match(path, /^\/sessions\/[a-f0-9-]+(?:\/(?:human|agent)\?scoped=1)?$/);
  assert.ok(['POST', 'DELETE'].includes(method));
  if (method === 'POST') physicalPosts++;
  if (path.endsWith('/human?scoped=1')) await humanEffect();
  return { ok: true };
};
const passed = [], owned = [];
async function bounded(promise) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Synthetic takeover barrier timed out')), 5000); })]); }
  finally { clearTimeout(timer); }
}
const execution = attempt => ({ execution: { attemptId: attempt.id, dispatchId: attempt.dispatchId } });
const start = (f, attempt, index) => {
  const [itemId, caseId] = f.task.spec.caseKeys[index].split(':');
  return testRunAction(h.owner, f.workspace, f.thread, { action: 'start', itemId, caseId,
    expectedVersion: f.task.spec.planVersions.find(plan => plan.itemId === itemId).version, requestId: randomUUID(),
    environment: f.task.spec.target.environment, target: f.task.spec.target, mission: { missionId: f.id, taskId: f.task.id } }, execution(attempt));
};
const finish = (f, run, outcome) => testRunAction(h.owner, f.workspace, f.thread, { action: 'finish', runId: run.id,
  result: { schemaVersion: 2, outcome, actual: 'Synthetic saved outcome; no live product assertion.', observations: [], evidenceItemIds: [],
    remaining: outcome === 'inconclusive' ? [{ checkId: 'expected', reason: 'Original requirement remains unverified at human takeover.' }] : [],
    checks: runChecks(run.snapshot).map(check => ({ id: check.id, status: outcome === 'inconclusive' && check.id === 'expected' ? 'unverified' : outcome === 'failed' ? 'mismatch' : 'verified', actual: 'Synthetic independent checkpoint.' })) } }, execution(f.attempt));
async function fixture() {
  const f = await h.fixture(), ready = await h.browserReady(f); owned.push(f);
  f.attempt = ready.attempts.find(row => row.kind === 'browser_tests'); f.task = ready.tasks.find(row => row.id === f.attempt.taskId);
  const agentId = `wrun_takeover_${randomUUID()}`, sessionId = randomUUID();
  await db.update(schema.browserJobs).set({ sessionId: agentId }).where(eq(schema.browserJobs.id, f.attempt.dispatchId));
  const mission = await h.row(schema.missions, f.id);
  const policy = { version: 1, allowedOrigins: mission.mandate.allowedOrigins, readOnly: true, deadlineAt: f.attempt.deadlineAt.toISOString() };
  [f.assignment] = await db.insert(schema.browserAssignments).values({ id: randomUUID(), workspaceId: f.workspace, userId: h.owner, threadId: f.thread,
    agentId, sessionId, projectId: `self-hosted-policy-v1:${policyDigest(policy)}`, liveUrl: 'https://viewer.example.test/', control: 'agent', expiresAt: f.attempt.deadlineAt }).returning();
  await db.update(schema.missionResourceClaims).set({ executorResourceId: sessionId }).where(eq(schema.missionResourceClaims.attemptId, f.attempt.id));
  return f;
}
async function settleOriginal(f) {
  await db.update(schema.browserJobs).set({ status: 'completed', updatedAt: new Date() }).where(eq(schema.browserJobs.id, f.attempt.dispatchId));
  await db.update(schema.missionAttempts).set({ usage: { tokens: 100, toolCalls: 1, durationMs: 1 } }).where(eq(schema.missionAttempts.id, f.attempt.id));
  await h.pass(f);
  const waits = await h.rows(schema.missionWaits, f.id);
  f.wait = waits.find(wait => wait.state === 'waiting' && wait.definition.reason === 'human_browser');
  assert.ok(f.wait, 'Controller must retain the exact human-affected original case even if latest run completed');
  f.originalRuns = await db.select().from(schema.testRuns).where(eq(schema.testRuns.missionAttemptId, f.attempt.id));
  f.originalAttempt = await h.row(schema.missionAttempts, f.attempt.id);
}
async function answer(f) {
  await controlBrowser(h.owner, f.thread, 'agent', f.assignment.sessionId);
  return h.control.controlMission(h.owner, f.workspace, f.thread, { action: 'answer', missionId: f.id, waitId: f.wait.id,
    expectedMandateRevision: (await h.row(schema.missions, f.id)).mandateRevision, requestId: randomUUID(),
    answer: { kind: 'browser_returned', sessionId: f.assignment.sessionId } });
}
async function releaseFixture(f) {
  humanEffect = async () => {};
  if (!f.assignment) return;
  const row = await h.row(schema.browserAssignments, f.assignment.id);
  if (row?.sessionId) await controlBrowser(h.owner, f.thread, 'close', row.sessionId);
  // Explicit synthetic-fixture teardown only; no physical-stop conclusion.
  await db.delete(schema.missionResourceClaims).where(eq(schema.missionResourceClaims.missionId, f.id));
}
try {
  {
    const f = await fixture();
    let oldTransactionWait, failure, releaseWait = () => {};
    try {
      const completed = await start(f, f.attempt, 0); await finish(f, completed, 'failed');
      const account = await start(f, f.attempt, 1); let later;
      humanEffect = async () => {
        const free = await db.transaction(async tx => {
          const [row] = await tx.execute(sql`select pg_try_advisory_xact_lock(hashtextextended(${`mission:${f.id}`}, 0)) as acquired`);
          return row.acquired;
        });
        assert.equal(free, true, 'Physical HTTP must not retain the mission lock');
        await finish(f, account, 'inconclusive'); later = await start(f, f.attempt, 2);
        // A controller transaction can begin before the human ACK commits,
        // then acquire the mission lock and publish its wait afterward.
        let entered;
        const started = new Promise(resolve => { entered = resolve; });
        const gate = new Promise(resolve => { releaseWait = resolve; });
        oldTransactionWait = db.transaction(async tx => {
          await tx.execute(sql`select now()`); entered(); await gate;
          await h.control.lockMission(tx, f.id);
          return h.control.createMissionWait(tx, await h.missions.ownedMission(h.owner, f.workspace, f.id, tx),
            { reason: 'human_browser', taskIds: [f.task.id], question: 'Return this exact browser after the prerequisite.' });
        });
        void oldTransactionWait.catch(() => {});
        await bounded(started);
        await new Promise(resolve => setTimeout(resolve, 15));
      };
      await controlBrowser(h.owner, f.thread, 'human', f.assignment.sessionId);
      releaseWait(); const racedWait = await bounded(oldTransactionWait);
      const events = await h.rows(schema.missionEvents, f.id), event = events.find(row => row.kind === 'browser_human_takeover');
      assert.ok(event, 'Acknowledged takeover must bind the original active run');
      assert.equal(event.payload.takeover.run.id, account.id); assert.notEqual(event.payload.takeover.run.id, later.id);
      assert.equal(event.payload.takeover.run.startedAt, account.startedAt.toISOString());
      assert.ok(racedWait.createdAt < new Date(event.payload.takeover.confirmedAt), 'Wait default now() really precedes ACK publication');
      humanEffect = async () => {};
      await settleOriginal(f); await answer(f); await h.pass(f);
      const after = await h.state(f), next = after.attempts.find(row => row.kind === 'browser_tests' && row.id !== f.attempt.id);
      assert.ok(next); assert.equal(next.attemptNo, f.attempt.attemptNo + 1);
      assert.equal(next.deadlineAt.toISOString(), f.attempt.deadlineAt.toISOString());
      assert.deepEqual(await browserAttemptCases(db, next, f.task), f.task.spec.caseKeys.slice(1));
      assert.equal(after.claims.length, 1); assert.equal(after.claims[0].attemptId, next.id);
      assert.equal(after.claims[0].executorResourceId, f.assignment.sessionId);
      assert.deepEqual(await h.row(schema.missionAttempts, f.attempt.id), f.originalAttempt);
      assert.deepEqual(await db.select().from(schema.testRuns).where(eq(schema.testRuns.missionAttemptId, f.attempt.id)), f.originalRuns);
      assert.equal((await h.row(schema.testRuns, account.id)).result.outcome, 'inconclusive');
      await assert.rejects(start(f, next, 0), error => error.statusCode === 409);
      const fresh = await start(f, next, 1);
      assert.deepEqual(fresh.snapshot, account.snapshot); assert.notEqual(fresh.id, account.id);
      assert.equal((await h.row(schema.testRuns, fresh.id)).browserEntryReceipt, null);
      passed.push('Actual capture before HTTP + concurrent inconclusive FINISH/next START + terminal wait/return + exact same-session reservation; original history preserved');
    } catch (error) { failure = error; throw error; }
    finally {
      releaseWait();
      try { if (oldTransactionWait) await bounded(oldTransactionWait).catch(error => { if (!failure) throw error; }); }
      finally { await releaseFixture(f); }
    }
  }
  {
    const f = await fixture();
    try {
      const account = await start(f, f.attempt, 0);
      humanEffect = async () => {
        await finish(f, account, 'blocked');
        for (const index of [1, 2]) await finish(f, await start(f, f.attempt, index), 'failed');
      };
      await controlBrowser(h.owner, f.thread, 'human', f.assignment.sessionId); humanEffect = async () => {};
      await settleOriginal(f); await answer(f); await h.pass(f);
      const next = (await h.state(f)).attempts.find(row => row.kind === 'browser_tests' && row.id !== f.attempt.id);
      assert.ok(next); assert.deepEqual(await browserAttemptCases(db, next, f.task), [f.task.spec.caseKeys[0]]);
      passed.push('Only earlier human-blocked case remains: later completed negative cases cannot erase wait or be retried');
    } finally { await releaseFixture(f); }
  }
  {
    const f = await fixture();
    try {
      await start(f, f.attempt, 0);
      humanEffect = async () => { throw new Error('Synthetic unknown physical ACK'); };
      await assert.rejects(controlBrowser(h.owner, f.thread, 'human', f.assignment.sessionId), /unknown physical ACK/);
      assert.equal((await h.rows(schema.missionEvents, f.id)).some(row => row.kind === 'browser_human_takeover'), false);
      assert.equal((await h.row(schema.browserAssignments, f.assignment.id)).control, 'agent');
      passed.push('Unknown HTTP ACK has no confirmed takeover event');
    } finally { await releaseFixture(f); }
  }
  for (const fault of ['foreign-runtime', 'expired-claim', 'foreign-owner']) {
    const f = await fixture();
    try {
      await start(f, f.attempt, 0);
      if (fault === 'foreign-runtime') await db.update(schema.missionAttempts).set({ runtime: `${process.env.PAT_RUNTIME_SCOPE}:foreign` }).where(eq(schema.missionAttempts.id, f.attempt.id));
      if (fault === 'expired-claim') await db.update(schema.missionResourceClaims).set({ expiresAt: new Date(0) }).where(eq(schema.missionResourceClaims.attemptId, f.attempt.id));
      if (fault === 'foreign-owner') {
        const before = physicalPosts;
        await assert.rejects(controlBrowser(randomUUID(), f.thread, 'human', f.assignment.sessionId), error => error.statusCode === 404);
        assert.equal(physicalPosts, before);
      } else await controlBrowser(h.owner, f.thread, 'human', f.assignment.sessionId);
      assert.equal((await h.rows(schema.missionEvents, f.id)).some(row => row.kind === 'browser_human_takeover'), false);
      passed.push(`No continuation authority from ${fault}`);
    } finally { await releaseFixture(f); }
  }
  console.log(JSON.stringify({ kind: 'browser-human-takeover-integration', passed, actualPostgres: true, syntheticBrowserHttp: true,
    actualChromium: false, providerCalls: 0, acceptanceGate: false }));
} finally {
  try { for (const f of owned) await releaseFixture(f); }
  finally { await h.close(); }
}
