import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { controllerFixture } from './helpers/mission-controller-fixture.mjs';

// Real isolated PostgreSQL and authored projection/control/source readers.
// Executor/model fixtures remain synthetic; this does not establish live QA.
assert.equal(process.env.GRUNDEN_API_TOKEN, '');
const h = await controllerFixture(), { db, schema } = h;
const { readMissionPresentation, listMissionPresentations } = await import('../server/utils/mission-presentation.ts');
const passed = [], failed = [];
const view = f => readMissionPresentation(h.owner, f.workspace, f.id);
async function check(name, fn) {
  try { await fn(); passed.push(name); }
  catch (e) { failed.push({ name, message: e.message, stack: e.stack }); console.error(`FAILED ${name}: ${e.message}`); }
}
async function persisted(f) {
  const result = await h.state(f);
  for (const key of ['missionEvents', 'missionSnapshots', 'missionWaits']) result[key] = await h.rows(schema[key], f.id);
  result.items = await db.select().from(schema.workspaceItems).where(eq(schema.workspaceItems.workspaceId, f.workspace));
  return JSON.stringify(result, (_key, value) => Array.isArray(value) && value.every(v => v && typeof v === 'object' && 'id' in v) ? [...value].sort((a, b) => a.id.localeCompare(b.id)) : value);
}
async function finished() {
  const f = await h.fixture({ intent: 'report_only' }); await h.settle(f);
  const saved = await h.state(f); f.report = saved.reports.find(r => r.status === 'completed');
  f.source = saved.tasks.flatMap(t => t.sources).find(s => s.type === 'material');
  assert.ok(f.report?.itemId); return f;
}
try {
  await check('ordinary owner sees actionable accepted mission without chat or worker invocation', async () => {
    const f = await h.fixture(), calls = h.calls.length, result = await view(f);
    assert.equal(result.lifecycle, 'accepted'); assert.equal(result.phase, 'discover'); assert.deepEqual(result.allowedActions, ['pause', 'cancel']);
    assert.equal(result.scheduler.lastObservedAt, null); assert.equal(result.cleanupPending, false); assert.equal(result.report, null);
    assert.equal(h.calls.length, calls); assert.equal((await listMissionPresentations(h.owner, f.workspace)).missions[0].id, f.id);
  });
  await check('real pause/cancel transitions expose only meaningful controls and retain physical claims', async () => {
    const f = await h.fixture(); await h.browserReady(f); assert.equal((await view(f)).cleanupPending, false);
    await h.operate(f, 'pause'); let result = await view(f);
    assert.equal(result.lifecycle, 'paused'); assert.equal(result.cleanupPending, true); assert.deepEqual(result.allowedActions, ['cancel']);
    await h.operate(f, 'cancel'); result = await view(f);
    assert.equal(result.lifecycle, 'cancelling'); assert.deepEqual(result.allowedActions, []); assert.equal(result.resources.held, 1);
  });
  await check('terminal executor with human takeover stays visible; reading never releases expired claims', async () => {
    const f = await h.closedClaim(); await h.assignment(f, { human: true, expired: true });
    await db.update(schema.missionResourceClaims).set({ expiresAt: new Date(0), runtime: 'older-executor-runtime' }).where(eq(schema.missionResourceClaims.id, f.claim.id));
    const before = await persisted(f), result = await view(f);
    assert.equal(result.lifecycle, 'closed'); assert.equal(result.cleanupPending, true); assert.equal(result.resources.held, 1); assert.equal(result.resources.humanControlled, 1);
    assert.equal(result.allowedActions.includes('resume'), false); assert.equal(await persisted(f), before);
  });
  await check('wait expiry is display-only and answers are revoked by saved mandate revision', async () => {
    const f = await h.fixture(), task = (await h.rows(schema.missionTasks, f.id))[0];
    const w = await db.transaction(async tx => h.control.createMissionWait(tx, await h.row(schema.missions, f.id), { reason: 'clarification', taskIds: [task.id], question: 'Vilket flöde ska granskas?' }));
    assert.deepEqual((await view(f)).waits[0].allowedAnswers, ['text', 'decline']);
    await db.update(schema.missionWaits).set({ deadlineAt: new Date(0) }).where(eq(schema.missionWaits.id, w.id));
    let result = await view(f); assert.equal(result.waits[0].status, 'deadline_passed'); assert.deepEqual(result.waits[0].allowedAnswers, []);
    assert.equal((await h.row(schema.missionWaits, w.id)).state, 'waiting');
    await db.update(schema.missions).set({ mandateRevision: f.mandateRevision + 1 }).where(eq(schema.missions.id, f.id));
    result = await view(f); assert.equal(result.waits.length, 0);
  });
  await check('completed report is current after closure events, then stale after actual source edit', async () => {
    const f = await finished(), snapshot = await h.row(schema.missionSnapshots, f.report.snapshotId);
    assert.ok((await h.row(schema.missions, f.id)).revision > snapshot.revision);
    let result = await view(f); assert.equal(result.report.freshness, 'current'); assert.equal(result.report.itemId, f.report.itemId);
    const source = await h.row(schema.workspaceItems, f.source.id);
    await h.saveItem(h.owner, f.workspace, { id: source.id, expectedVersion: source.version, title: source.title, content: { kind: 'text', text: 'Updated selected evidence.' } });
    result = await view(f); assert.equal(result.report.freshness, 'stale'); assert.equal(result.nextStep.code, 'read_report');
  });
  await check('missing fingerprint is unknown rather than revision-based false freshness', async () => {
    const f = await finished(), snapshot = await h.row(schema.missionSnapshots, f.report.snapshotId), input = { ...snapshot.input };
    delete input.inputFingerprint;
    await db.update(schema.missionSnapshots).set({ input }).where(eq(schema.missionSnapshots.id, snapshot.id));
    assert.equal((await view(f)).report.freshness, 'unknown');
  });
  await check('composed fingerprint read uses the caller snapshot across a concurrent committed edit', async () => {
    const f = await finished(), snapshot = await h.row(schema.missionSnapshots, f.report.snapshotId);
    await db.transaction(async tx => {
      // Establish this reader's snapshot before a separate connection commits.
      await tx.select().from(schema.missions).where(eq(schema.missions.id, f.id));
      await db.update(schema.workspaceItems).set({ title: 'Concurrently corrected source title' }).where(eq(schema.workspaceItems.id, f.source.id));
      assert.equal(await h.missions.missionReportIsStale(h.owner, f.workspace, snapshot.input, tx), false);
    }, { isolationLevel: 'repeatable read' });
    assert.equal((await view(f)).report.freshness, 'stale');
  });
  await check('deleted report artifact is not presented as an openable delivery', async () => {
    const f = await finished(); await db.update(schema.workspaceItems).set({ deletedAt: new Date() }).where(eq(schema.workspaceItems.id, f.report.itemId));
    const result = await view(f); assert.equal(result.report.deleted, true); assert.equal(result.report.itemId, null); assert.equal(result.report.freshness, 'not_applicable'); assert.equal(result.nextStep.code, 'report_deleted');
  });
  await check('projection and report freshness reads write nothing and call no executors', async () => {
    const f = await finished(), before = await persisted(f), calls = h.calls.length;
    for (let n = 0; n < 3; n++) { await view(f); await listMissionPresentations(h.owner, f.workspace); }
    assert.equal(await persisted(f), before); assert.equal(h.calls.length, calls);
  });
  await check('authorization excludes other owners, workspaces and runtimes', async () => {
    const f = await h.fixture(), other = await h.fixture();
    await assert.rejects(readMissionPresentation(randomUUID(), f.workspace, f.id), e => e.statusCode === 404);
    await assert.rejects(listMissionPresentations(randomUUID(), f.workspace), e => e.statusCode === 404);
    await assert.rejects(readMissionPresentation(h.owner, other.workspace, f.id), e => e.statusCode === 404);
    const runtime = process.env.PAT_RUNTIME_SCOPE;
    try { process.env.PAT_RUNTIME_SCOPE = `${runtime}-different`; await assert.rejects(view(f), e => e.statusCode === 404); assert.deepEqual((await listMissionPresentations(h.owner, f.workspace)).missions, []); }
    finally { process.env.PAT_RUNTIME_SCOPE = runtime; }
  });
  await check('manual historical mission is not adopted by reading', async () => {
    const f = await h.fixture(); await db.update(schema.missions).set({ controllerVersion: null, lifecycle: null }).where(eq(schema.missions.id, f.id));
    await assert.rejects(view(f), e => e.statusCode === 404); assert.deepEqual((await listMissionPresentations(h.owner, f.workspace)).missions, []);
    assert.equal((await h.row(schema.missions, f.id)).controllerVersion, null);
  });
  await check('known secrets and executor IDs are redacted even when echoed into persisted text', async () => {
    const f = await h.fixture(); const ready = await h.browserReady(f), attempt = ready.attempts.find(a => a.kind === 'browser_tests');
    const secret = `local-secret-${randomUUID()}`, key = 'MISSION_PRESENTATION_TEST_SECRET', previous = process.env[key]; process.env[key] = secret;
    try {
      const mission = await h.row(schema.missions, f.id);
      await db.update(schema.missions).set({ config: { ...mission.config, title: `Title ${secret} ${attempt.id} ${attempt.dispatchId} Bearer ABCDEF` } }).where(eq(schema.missions.id, f.id));
      await db.transaction(async tx => h.control.createMissionWait(tx, mission, { reason: 'clarification', taskIds: [attempt.taskId], question: `Question ${secret} ${attempt.dispatchId}` }));
      const serialized = JSON.stringify(await view(f));
      for (const value of [secret, attempt.id, attempt.dispatchId, 'ABCDEF', 'leaseToken', 'executorResourceId', 'taskIds', 'readReceipts']) assert.equal(serialized.includes(value), false, value);
      assert.match(serialized, /REDACTED/); assert.match(serialized, /intern referens/);
    } finally { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; }
  });
  await check('global admission switch hides resume but preserves cancel control', async () => {
    const f = await h.fixture(); await h.operate(f, 'pause'); const previous = process.env.AUTONOMOUS_MISSIONS_ENABLED;
    try { process.env.AUTONOMOUS_MISSIONS_ENABLED = 'false'; assert.deepEqual((await view(f)).allowedActions, ['cancel']); }
    finally { process.env.AUTONOMOUS_MISSIONS_ENABLED = previous; }
    assert.deepEqual((await view(f)).allowedActions, ['cancel', 'resume']);
  });
  await check('invalid list bounds are rejected before reading', async () => {
    const f = await h.fixture(); for (const limit of [0, 51, 1.5, NaN]) await assert.rejects(listMissionPresentations(h.owner, f.workspace, limit), e => e.statusCode === 400);
  });
} finally { await h.close(); }
console.log(JSON.stringify({ suite: 'mission-presentation', passed: passed.length, failed }, null, 2));
if (failed.length) process.exitCode = 1;
