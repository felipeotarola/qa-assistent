import { reportFixtureObservations } from './helpers/report-check-fixture.mjs';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import { controllerFixture } from './helpers/mission-controller-fixture.mjs';

// Real isolated PostgreSQL, controller, result/review/report persistence and
// saved file reads. Planning, browser transport and models are synthetic.
const h = await controllerFixture(), { db, schema } = h, checks = [], files = [], captures = [];
const { testRunAction } = await import('../server/utils/test-runs.ts');
const { runChecks } = await import('../shared/test-run.ts');
const { saveFile } = await import('../server/utils/workspaces.ts');
const { del, workspaceStorageToken } = await import('../server/utils/evidence-storage.ts');
const { proposeUnstartedBrowserRecovery, validateUnstartedBrowserRecovery } = await import('../server/utils/mission-complements.ts');
const originalPlanner = h.scripts.planMission;
h.scripts.planMission = async (...args) => {
  const result = await originalPlanner(...args), first = result.draft.cases[0];
  result.draft.cases = Array.from({ length: 4 }, (_, i) => ({ ...structuredClone(first), title: `Original case ${i + 1}` }));
  return result;
};
h.scripts.assessResult = async (input, attachments, _signal, onUsage) => {
  assert.ok(attachments.length); const proof = input.evidence.find(e => e.itemId && e.readStatus === 'read'); assert.ok(proof);
  onUsage?.(12, { providerCalls: 1, unknownCalls: 0, inputTokens: 10, outputTokens: 2, totalTokens: 12, cacheReadTokens: 0, cacheWriteTokens: null, durationMs: 1 });
  return { verdict: 'supported', summary: 'The synthetic saved bytes support the reported negative observation.', findings: input.requirements.map(r => ({ requirementId: r.id, verdict: 'supported', explanation: 'Synthetic model; actual saved bytes were read.', evidenceIds: [proof.id], suggestedNextStep: '', gap: null })) };
};
h.scripts.writeMissionReport = async (snapshot, read, _signal, options) => {
  await options.beforeModel(); const readIds = [], reads = new Map();
  const evidence = new Map(snapshot.tasks.flatMap(t => t.sources.flatMap(s => s.evidence)).map(e => [e.id, e]));
  for (const item of evidence.values()) if (item.origin === 'tool' && item.itemId) { const value = await read(item.id); reads.set(item.id, value); if (value.text && !value.unavailable && !value.limited) readIds.push(item.id); }
  const supported = snapshot.delivery.complete;
  return { draft: { summary: 'Synthetic QA report preserves product failures.', findings: snapshot.config.criteria.map(c => ({ criterionId: c.id, verdict: supported ? 'supported' : 'needs_evidence', conclusion: supported ? 'All original checks were executed; observed defects remain failed product outcomes.' : 'Original work remains incomplete.', evidenceIds: readIds, observations: reportFixtureObservations(snapshot, c.id, readIds, 'The saved fixture observations preserve the reported passed and failed product outcomes.', reads), nextStep: '' })), limitations: ['Synthetic executor/model; no real browser invoked.'] }, usage: { inputTokens: 20, outputTokens: 20, totalTokens: 40, toolCalls: readIds.length, steps: 1 } };
};
async function prepared() {
  const f = await h.fixture(), state = await h.browserReady(f), attempt = state.attempts.find(a => a.kind === 'browser_tests');
  return { f, attempt, task: state.tasks.find(t => t.id === attempt.taskId) };
}
async function runCase(f, attempt, task, key) {
  const [itemId, caseId] = key.split(':'), options = { execution: { attemptId: attempt.id, dispatchId: attempt.dispatchId } };
  const run = await testRunAction(h.owner, f.workspace, f.thread, { action: 'start', itemId, caseId, expectedVersion: task.spec.planVersions.find(p => p.itemId === itemId).version, requestId: randomUUID(), environment: task.spec.target.environment, target: task.spec.target, mission: { missionId: f.id, taskId: task.id } }, options);
  const proof = await saveFile(h.owner, f.workspace, 'synthetic-negative.txt', 'text/plain', Buffer.from('Synthetic independent observation: the requested navigation returned HTTP 404.'), f.thread, db, { provenance: { version: 1, origin: 'tool', producer: 'test-capture', sourceType: 'test', sourceId: run.id, observedAt: new Date().toISOString(), url: run.target.url } });
  files.push((await h.row(schema.workspaceItems, proof.id)).blobPath); const capture = randomUUID(); captures.push(capture);
  await db.insert(schema.testCaptures).values({ id: capture, runId: run.id, itemId: proof.id, title: 'Synthetic capture', action: 'inspect', url: run.target.url });
  await testRunAction(h.owner, f.workspace, f.thread, { action: 'finish', runId: run.id, result: { schemaVersion: 2, outcome: 'failed', actual: 'Synthetic reported product failure, HTTP 404.', checks: runChecks(run.snapshot).map(c => ({ id: c.id, status: c.id === 'expected' ? 'mismatch' : 'verified', actual: 'Synthetic actual observation.' })), remaining: [], observations: [], evidenceItemIds: [proof.id] } }, options);
  return run;
}
async function stop(attempt, status = 'failed') {
  await db.update(schema.missionAttempts).set({ usage: { tokens: 100, toolCalls: 2, durationMs: 1 } }).where(eq(schema.missionAttempts.id, attempt.id));
  await db.update(schema.browserJobs).set({ status, updatedAt: new Date() }).where(eq(schema.browserJobs.id, attempt.dispatchId));
}
const recovery = state => state.tasks.filter(t => t.operationId?.startsWith('browser-remainder:'));
async function check(name, fn) { await fn(); checks.push(name); console.log(`PASS ${name}`); }
async function claimed(f, fn) {
  await db.update(schema.missions).set({ nextWakeAt: new Date(0) }).where(eq(schema.missions.id, f.id));
  const lease = h.attempts.leaseIdentity(await h.attempts.claimMission(f.id));
  try { return await db.transaction(async tx => fn(tx, await h.attempts.claimedMission(tx, lease))); }
  finally { await h.attempts.releaseMissionLease(lease, 0); }
}
try {
  await check('terminal executor resumes only three never-started original cases and closes investigated despite preserved failure history', async () => {
    const { f, attempt, task } = await prepared(); const original = await runCase(f, attempt, task, task.spec.caseKeys[0]); await stop(attempt);
    await h.pass(f); let state = await h.state(f); assert.equal(recovery(state).length, 1, 'Missing original cases need their own bounded continuation');
    const rest = recovery(state)[0]; assert.deepEqual(rest.spec.caseKeys, task.spec.caseKeys.slice(1)); assert.deepEqual(rest.spec.target, task.spec.target);
    await h.pass(f); state = await h.state(f); const next = state.attempts.find(a => a.taskId === rest.id); assert.ok(next);
    for (const key of rest.spec.caseKeys) await runCase(f, next, rest, key); await stop(next, 'completed');
    const closed = await h.settle(f, 22); assert.equal(closed.mission.closureReason, 'investigated'); assert.equal(closed.reports[0].document.partial, false);
    assert.equal(closed.tasks.find(t => t.id === task.id).state, 'blocked'); assert.equal(closed.attempts.find(a => a.id === attempt.id).status, 'failed');
    const runs = await db.select().from(schema.testRuns).where(eq(schema.testRuns.workspaceId, f.workspace));
    assert.equal(runs.length, 4); assert.equal(runs.filter(r => r.caseId === original.caseId).length, 1); assert.ok(runs.every(r => r.result.outcome === 'failed'));
    assert.equal(closed.claims.length, 0); assert.equal(recovery(closed).length, 1); assert.equal(h.calls.filter(c => c.kind === 'browser:start' && c.missionId === f.id).length, 2);
  });
  await check('zero started runs recover once; a second terminal failure cannot manufacture another retry family', async () => {
    const { f, attempt, task } = await prepared(); await stop(attempt); await h.pass(f);
    const ready = await h.state(f), rest = recovery(ready)[0]; assert.deepEqual(rest.spec.caseKeys, task.spec.caseKeys);
    await h.pass(f); const next = (await h.state(f)).attempts.find(a => a.taskId === rest.id); assert.ok(next); await stop(next);
    const closed = await h.settle(f); assert.equal(closed.mission.closureReason, 'blocked'); assert.equal(closed.reports[0].document.partial, true);
    assert.equal(recovery(closed).length, 1); assert.equal(closed.attempts.filter(a => a.kind === 'browser_tests').length, 2);
    assert.equal((await db.select().from(schema.testRuns).where(eq(schema.testRuns.workspaceId, f.workspace))).length, 0);
  });
  await check('completed executor that omitted cases is not trusted as delivery, and repeated graph passes deduplicate the continuation', async () => {
    const { f, attempt, task } = await prepared(); await runCase(f, attempt, task, task.spec.caseKeys[0]); await stop(attempt, 'completed'); await h.pass(f);
    const first = (await h.state(f)).tasks.find(t => t.id === task.id); assert.equal(first.state, 'blocked');
    const rest = recovery(await h.state(f))[0]; assert.ok(rest);
    assert.equal(await claimed(f, (tx, mission) => proposeUnstartedBrowserRecovery(tx, mission, first)), null);
    await h.pass(f); await h.pass(f); assert.equal(recovery(await h.state(f)).length, 1);
    assert.equal(h.calls.filter(c => c.kind === 'browser:start' && c.missionId === f.id).length, 2);
  });
  await check('single operation allowance forbids recovery, while remaining global budget is still enforced by ordinary reservation', async () => {
    for (const limits of [{ maxOperationAttempts: 1 }, { maxLogicalAttempts: 3 }]) {
      const { f, attempt } = await prepared(), mission = await h.row(schema.missions, f.id);
      await db.update(schema.missions).set({ mandate: { ...mission.mandate, limits: { ...mission.mandate.limits, ...limits } } }).where(eq(schema.missions.id, f.id));
      await stop(attempt); const closed = await h.settle(f);
      assert.equal(closed.attempts.filter(a => a.kind === 'browser_tests').length, 1); assert.equal(h.calls.filter(c => c.kind === 'browser:start' && c.missionId === f.id).length, 1);
      assert.equal(closed.mission.closureReason, limits.maxLogicalAttempts ? 'budget_exhausted' : 'blocked');
    }
  });
  await check('cancelling and uncertain executor receipts cannot authorize never-started work', async () => {
    const { f, attempt, task } = await prepared();
    await db.update(schema.missionAttempts).set({ status: 'failed', finishedAt: new Date() }).where(eq(schema.missionAttempts.id, attempt.id));
    await db.update(schema.missionTasks).set({ state: 'blocked' }).where(eq(schema.missionTasks.id, task.id));
    await db.update(schema.browserJobs).set({ status: 'cancelling' }).where(eq(schema.browserJobs.id, attempt.dispatchId));
    const blocked = await h.row(schema.missionTasks, task.id);
    assert.equal(await claimed(f, (tx, mission) => proposeUnstartedBrowserRecovery(tx, mission, blocked)), null);
    await db.update(schema.browserJobs).set({ status: 'failed' }).where(eq(schema.browserJobs.id, attempt.dispatchId));
    for (const owner of ['agent', 'human']) {
      await db.update(schema.missionResourceClaims).set({ owner, state: 'uncertain', expiresAt: new Date(0) }).where(eq(schema.missionResourceClaims.attemptId, attempt.id));
      assert.equal(await claimed(f, (tx, mission) => proposeUnstartedBrowserRecovery(tx, mission, blocked)), null);
    }
    assert.equal(recovery(await h.state(f)).length, 0);
  });
  await check('pause, cancellation, changed epoch, deadline and flag-off never create a recovery executor', async () => {
    for (const mode of ['pause', 'cancel', 'epoch', 'deadline', 'flag']) {
      const { f, attempt } = await prepared(); await stop(attempt);
      if (['pause', 'cancel'].includes(mode)) await h.operate(f, mode);
      if (mode === 'epoch') { const m = await h.row(schema.missions, f.id); await db.update(schema.missions).set({ mandateRevision: m.mandateRevision + 1 }).where(eq(schema.missions.id, f.id)); }
      if (mode === 'deadline') await db.update(schema.missions).set({ deadlineAt: new Date(0) }).where(eq(schema.missions.id, f.id));
      if (mode === 'flag') process.env.AUTONOMOUS_MISSIONS_ENABLED = 'false';
      try { await h.pass(f); await h.pass(f); } finally { process.env.AUTONOMOUS_MISSIONS_ENABLED = 'true'; }
      assert.equal(recovery(await h.state(f)).length, 0, mode); assert.equal(h.calls.filter(c => c.kind === 'browser:start' && c.missionId === f.id).length, 1, mode);
    }
  });
  await check('changed frozen plan refuses recovery and existing started unfinished cases are not placed in the never-started subset', async () => {
    const changed = await prepared(), plan = await h.row(schema.workspaceItems, changed.task.spec.planVersions[0].itemId);
    await h.saveItem(h.owner, changed.f.workspace, { id: plan.id, expectedVersion: plan.version, title: plan.title, content: { ...plan.content, summary: 'User changed original scope' } });
    await stop(changed.attempt); await h.pass(changed.f); assert.equal(recovery(await h.state(changed.f)).length, 0);
    const { f, attempt, task } = await prepared(), [itemId, caseId] = task.spec.caseKeys[0].split(':');
    const run = await testRunAction(h.owner, f.workspace, f.thread, { action: 'start', itemId, caseId, expectedVersion: 1, requestId: randomUUID(), environment: task.spec.target.environment, target: task.spec.target, mission: { missionId: f.id, taskId: task.id } }, { execution: { attemptId: attempt.id, dispatchId: attempt.dispatchId } });
    await db.update(schema.browserJobs).set({ sessionId: `synthetic-executor-${randomUUID()}` }).where(eq(schema.browserJobs.id, attempt.dispatchId));
    await stop(attempt); await h.pass(f); assert.deepEqual(recovery(await h.state(f))[0].spec.caseKeys, task.spec.caseKeys.slice(1));
    assert.equal((await h.row(schema.testRuns, run.id)).result.outcome, 'interrupted');
  });
  await check('saved lineage is revalidated before physical dispatch; changed source specification cannot grant extra tests', async () => {
    const { f, attempt, task } = await prepared(); await stop(attempt); await h.pass(f);
    const rest = recovery(await h.state(f))[0]; assert.ok(rest); const state = await h.state(f), current = state.attempts.find(a => a.taskId === rest.id);
    // If this pass already reserved, validate against its own identity; otherwise
    // use a non-existing next ID to exercise the pre-dispatch family bound.
    const ownId = current?.id ?? randomUUID();
    await claimed(f, (tx, mission) => validateUnstartedBrowserRecovery(tx, mission, rest, ownId));
    const forged = { ...rest, spec: { ...rest.spec, planVersions: [{ ...rest.spec.planVersions[0], version: 99 }] } };
    await assert.rejects(claimed(f, (tx, mission) => validateUnstartedBrowserRecovery(tx, mission, forged, ownId)), error => error.statusCode === 409);
    await db.update(schema.missionTasks).set({ spec: { ...task.spec, caseKeys: task.spec.caseKeys.slice(1) } }).where(eq(schema.missionTasks.id, task.id));
    await assert.rejects(claimed(f, (tx, mission) => validateUnstartedBrowserRecovery(tx, mission, rest, ownId)), error => error.statusCode === 409);
  });
} finally {
  if (captures.length) await db.delete(schema.testCaptures).where(inArray(schema.testCaptures.id, captures));
  for (const path of files) await del(path, { token: workspaceStorageToken() });
  await h.close();
}
console.log(JSON.stringify({ passed: checks.length, checks, database: 'actual isolated PostgreSQL', models: 'synthetic' }));
