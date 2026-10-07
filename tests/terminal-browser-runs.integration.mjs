import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { controllerFixture } from './helpers/mission-controller-fixture.mjs';
import { fingerprint } from './helpers/evidence-acceptance.mjs';
const h = await controllerFixture(), { db, schema } = h;
const { testRunAction, reconcileTerminalBrowserRuns } = await import('../server/utils/test-runs.ts');
const { readMissionSource } = await import('../server/utils/mission-sources.ts');
const { runChecks, runVerificationError } = await import('../shared/test-run.ts');
const { saveFile } = await import('../server/utils/workspaces.ts');
const { get, del, workspaceStorageToken } = await import('../server/utils/evidence-storage.ts');
const files = [], captureIds = [];
const passed = [], failed = [];
async function check(name, fn) { try { await fn(); passed.push(name); } catch (e) { failed.push({ name, message: e.message, stack: e.stack }); console.error(`FAILED ${name}: ${e.message}`); } }
async function started() {
  const f = await h.fixture(), ready = await h.browserReady(f), attempt = ready.attempts.find(a => a.kind === 'browser_tests'), task = ready.tasks.find(t => t.id === attempt.taskId);
  // The only external boundary is synthetic: explicit original Eve session and
  // terminal status below. START, result persistence and controller are authored.
  await db.update(schema.browserJobs).set({ sessionId: `terminal-fixture-${randomUUID()}` }).where(eq(schema.browserJobs.id, attempt.dispatchId));
  const [itemId, caseId] = task.spec.caseKeys[0].split(':'), execution = { attemptId: attempt.id, dispatchId: attempt.dispatchId };
  const run = await testRunAction(h.owner, f.workspace, f.thread, { action: 'start', mission: { missionId: f.id, taskId: task.id }, itemId, caseId,
    expectedVersion: task.spec.planVersions[0].version, requestId: randomUUID(), environment: task.spec.target.environment, target: task.spec.target }, { execution });
  return { f, task, attempt, run, execution };
}
async function terminal(c, status = 'failed') {
  const at = new Date(); await db.update(schema.browserJobs).set({ status, updatedAt: at, report: 'Synthetic executor terminal receipt; no product outcome claimed.' }).where(eq(schema.browserJobs.id, c.attempt.dispatchId)); return at;
}
const reconcile = c => reconcileTerminalBrowserRuns(h.owner, c.f.workspace, c.f.thread, c.execution);
try {
  await check('actual controller closes a START-only run after terminal Iris and report snapshot is no longer running', async () => {
    const c = await started(), original = await h.row(schema.testRuns, c.run.id);
    const bytes = Buffer.from('Synthetic acquisition bytes saved before executor failure; not an actual browser observation.');
    const file = await saveFile(h.owner, c.f.workspace, 'before-failure.txt', 'text/plain', bytes, c.f.thread, db,
      { provenance: { version: 1, origin: 'tool', producer: 'test-capture', sourceType: 'test', sourceId: c.run.id, observedAt: new Date().toISOString(), url: c.run.target.url } });
    const stored = await h.row(schema.workspaceItems, file.id); files.push(stored.blobPath);
    const captureId = randomUUID(); captureIds.push(captureId); await db.insert(schema.testCaptures).values({ id: captureId, runId: c.run.id, itemId: file.id, url: c.run.target.url, title: 'Synthetic before failure', action: 'inspect' });
    const at = await terminal(c);
    await h.pass(c.f);
    const run = await h.row(schema.testRuns, c.run.id); assert.equal(run.result.outcome, 'interrupted'); assert.equal(run.finishedAt.getTime(), at.getTime());
    assert.deepEqual(run.snapshot, original.snapshot); assert.deepEqual(run.target, original.target); assert.equal(run.planVersion, original.planVersion);
    assert.equal(runVerificationError(run.snapshot, run.result), null);
    assert.deepEqual(run.result.checks.map(r => r.id), runChecks(run.snapshot).map(r => r.id)); assert.ok(run.result.checks.every(c => c.status === 'unverified'));
    assert.deepEqual(run.result.remaining.map(r => r.checkId), run.result.checks.map(r => r.id));
    const source = await readMissionSource(db, c.f.workspace, 'test', run.id); assert.equal(source.status, 'completed'); assert.equal(source.reportedOutcome, 'partial');
    assert.ok(source.finishedAt); assert.ok(!source.summary.includes('Testet pågår'));
    assert.ok(source.evidence.some(e => e.itemId === file.id)); assert.equal((await h.row(schema.testCaptures, captureId)).itemId, file.id);
    const retained = await get(stored.blobPath, { token: workspaceStorageToken(), access: 'private' });
    assert.deepEqual(Buffer.from(await new Response(retained.stream).arrayBuffer()), bytes);
    const done = await h.settle(c.f); assert.equal(done.mission.lifecycle, 'closed');
    const report = done.reports.find(r => r.status === 'completed'); assert.ok(report?.itemId); assert.equal(report.document.partial, true);
    const snapshot = await h.row(schema.missionSnapshots, report.snapshotId);
    const projected = snapshot.input.tasks.flatMap(t => t.sources).filter(s => s.sourceType === 'test' && s.sourceId === run.id);
    assert.ok(projected.length); assert.ok(projected.every(s => s.status !== 'running'));
    assert.ok(snapshot.input.tests.some(t => t.runId === run.id && t.originalOutcome === 'interrupted'));
  });
  await check('already saved genuine result and capture links survive terminal failure unchanged', async () => {
    const c = await started();
    const result = { schemaVersion: 2, outcome: 'failed', actual: 'Synthetic executor observed an explicit product mismatch.', observations: [], evidenceItemIds: [],
      checks: c.run.checks.map(check => ({ id: check.id, status: 'mismatch', actual: 'Synthetic mismatch.' })), remaining: [] };
    await testRunAction(h.owner, c.f.workspace, c.f.thread, { action: 'finish', runId: c.run.id, result }, { execution: c.execution });
    const before = await h.row(schema.testRuns, c.run.id); await terminal(c); assert.deepEqual(await reconcile(c), []);
    assert.equal(fingerprint(await h.row(schema.testRuns, c.run.id)), fingerprint(before));
    await h.settle(c.f);
  });
  await check('unknown, cancelling and unbound-session receipts never close an unfinished run', async () => {
    const c = await started();
    for (const status of ['running', 'dispatch_unknown', 'cancelling']) { await terminal(c, status); assert.deepEqual(await reconcile(c), []); }
    await terminal(c); await db.update(schema.browserJobs).set({ sessionId: null }).where(eq(schema.browserJobs.id, c.attempt.dispatchId));
    assert.deepEqual(await reconcile(c), []); assert.equal((await h.row(schema.testRuns, c.run.id)).result, null);
    await db.update(schema.browserJobs).set({ sessionId: 'restored-original-fixture-session' }).where(eq(schema.browserJobs.id, c.attempt.dispatchId));
    await h.settle(c.f);
  });
  await check('same immutable receipt concurrently reconciles once and rejects a late different FINISH', async () => {
    const c = await started(); await terminal(c, 'completed');
    const values = await Promise.all([reconcile(c), reconcile(c)]); assert.equal(values.flat().length, 1);
    const first = await h.row(schema.testRuns, c.run.id); assert.deepEqual(await reconcile(c), []);
    const events = await db.select().from(schema.missionEvents).where(and(eq(schema.missionEvents.missionId, c.f.id), eq(schema.missionEvents.kind, 'test_run_interrupted')));
    assert.equal(events.length, 1); assert.equal(events[0].payload.source, 'controller-terminal-receipt');
    await assert.rejects(testRunAction(h.owner, c.f.workspace, c.f.thread, { action: 'finish', runId: c.run.id,
      result: { ...first.result, actual: 'Different late executor response.' } }, { execution: c.execution }), e => e.statusCode === 409);
    assert.equal(fingerprint(await h.row(schema.testRuns, c.run.id)), fingerprint(first)); await h.settle(c.f);
  });
  await check('wrong dispatch, thread, owner and runtime cannot issue interruption receipts', async () => {
    const c = await started(); await terminal(c);
    await assert.rejects(reconcileTerminalBrowserRuns(h.owner, c.f.workspace, c.f.thread, { ...c.execution, dispatchId: randomUUID() }));
    await assert.rejects(reconcileTerminalBrowserRuns(h.owner, c.f.workspace, randomUUID(), c.execution));
    await assert.rejects(reconcileTerminalBrowserRuns(randomUUID(), c.f.workspace, c.f.thread, c.execution));
    const runtime = process.env.PAT_RUNTIME_SCOPE;
    try { process.env.PAT_RUNTIME_SCOPE = `${runtime}-other`; await assert.rejects(reconcile(c)); } finally { process.env.PAT_RUNTIME_SCOPE = runtime; }
    assert.equal((await h.row(schema.testRuns, c.run.id)).result, null); await h.settle(c.f);
  });
  await check('terminal timestamp before START is rejected, never rewritten to manufacture ordering', async () => {
    const c = await started(); await terminal(c);
    await db.update(schema.browserJobs).set({ updatedAt: new Date(c.run.startedAt.getTime() - 1000) }).where(eq(schema.browserJobs.id, c.attempt.dispatchId));
    await assert.rejects(reconcile(c), e => e.statusCode === 409); assert.equal((await h.row(schema.testRuns, c.run.id)).finishedAt, null);
    await terminal(c); await h.settle(c.f);
  });
  await check('pause or newer mandate permits original historical interruption but no new review/task admission', async () => {
    const c = await started(); await h.operate(c.f, 'pause'); const state = await h.state(c.f), counts = { tasks: state.tasks.length, attempts: state.attempts.length };
    await terminal(c, 'cancelled'); assert.deepEqual(await reconcile(c), [c.run.id]);
    const after = await h.state(c.f); assert.equal(after.mission.lifecycle, 'paused'); assert.equal(after.tasks.length, counts.tasks); assert.equal(after.attempts.length, counts.attempts);
    assert.equal((await db.select().from(schema.resultAssessments).where(eq(schema.resultAssessments.runId, c.run.id))).length, 0);
    await h.operate(c.f, 'cancel'); await h.settle(c.f);
  });
  await check('late terminal recovery after logical closure interrupts the run without rewriting the saved final report', async () => {
    const c = await started(); c.f.mode = 'unknown';
    await h.operate(c.f, 'cancel');
    // Fault injection: the stop acknowledgement is absent for longer than the
    // bounded grace period, while the original executor remains uncertain.
    await db.update(schema.missionAttempts).set({ cancelRequestedAt: new Date(Date.now() - 180_000) }).where(eq(schema.missionAttempts.id, c.attempt.id));
    const closed = await h.settle(c.f);
    assert.equal(closed.mission.lifecycle, 'closed'); assert.equal(closed.claims.length, 1);
    assert.equal((await h.row(schema.browserJobs, c.attempt.dispatchId)).status, 'cancelling');
    assert.equal((await h.row(schema.testRuns, c.run.id)).finishedAt, null);
    const originalReports = fingerprint(closed.reports), originalTasks = fingerprint(closed.tasks), originalAttempts = fingerprint(closed.attempts);
    const originalSnapshots = fingerprint(await db.select().from(schema.missionSnapshots).where(eq(schema.missionSnapshots.missionId, c.f.id)));
    const beforeCalls = h.calls.length;
    await h.reconcileClosedMissionResources();
    assert.equal((await h.row(schema.testRuns, c.run.id)).finishedAt, null);
    assert.equal((await h.state(c.f)).claims.length, 1);
    const at = await terminal(c);
    await h.reconcileClosedMissionResources();
    const run = await h.row(schema.testRuns, c.run.id), after = await h.state(c.f);
    assert.equal(run.result.outcome, 'interrupted'); assert.equal(run.finishedAt.getTime(), at.getTime());
    assert.equal(after.claims.length, 0); assert.equal(after.mission.lifecycle, 'closed');
    assert.equal(fingerprint(after.reports), originalReports); assert.equal(fingerprint(after.tasks), originalTasks); assert.equal(fingerprint(after.attempts), originalAttempts);
    assert.equal(fingerprint(await db.select().from(schema.missionSnapshots).where(eq(schema.missionSnapshots.missionId, c.f.id))), originalSnapshots);
    assert.ok(!h.calls.slice(beforeCalls).some(call => /model|queue|browser:start/.test(call.kind)));
    assert.equal((await db.select().from(schema.missionEvents).where(and(eq(schema.missionEvents.missionId, c.f.id), eq(schema.missionEvents.kind, 'test_run_interrupted')))).length, 1);
  });
  await check('a non-active attempt in a paused mission reconciles terminal history before releasing its resource', async () => {
    const c = await started(); await h.operate(c.f, 'pause');
    // Fault injection: logical failure committed before the stop receipt.
    await db.update(schema.missionAttempts).set({ status: 'failed', finishedAt: new Date() }).where(eq(schema.missionAttempts.id, c.attempt.id));
    const before = await h.state(c.f), beforeCalls = h.calls.length; await terminal(c, 'cancelled');
    await h.pass(c.f);
    const run = await h.row(schema.testRuns, c.run.id), after = await h.state(c.f);
    assert.equal(run.result.outcome, 'interrupted'); assert.equal(after.mission.lifecycle, 'paused'); assert.equal(after.claims.length, 0);
    assert.equal(after.tasks.length, before.tasks.length); assert.equal(after.attempts.length, before.attempts.length); assert.equal(after.reports.length, before.reports.length);
    assert.equal((await db.select().from(schema.resultAssessments).where(eq(schema.resultAssessments.runId, c.run.id))).length, 0);
    assert.ok(!h.calls.slice(beforeCalls).some(call => /model|queue|browser:start/.test(call.kind)));
    await h.operate(c.f, 'cancel'); await h.settle(c.f);
  });
} finally {
  for (const id of captureIds) await db.delete(schema.testCaptures).where(eq(schema.testCaptures.id, id));
  for (const path of files) await del(path, { token: workspaceStorageToken() });
  await h.close();
}
console.log(JSON.stringify({ proof: 'actual isolated PostgreSQL; authored START/controller/review/report; synthetic terminal executor receipt; no real browser/model', passed, failed }, null, 2));
if (failed.length) process.exitCode = 1;
