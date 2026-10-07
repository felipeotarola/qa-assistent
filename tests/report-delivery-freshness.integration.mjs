import { reportFixtureObservations } from './helpers/report-check-fixture.mjs';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { registerHooks } from 'node:module';
import { writeFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { eq, sql } from 'drizzle-orm';
import { isolatedApp } from './helpers/isolated-app.mjs';

// Real SQL, queue code, content locks and file reads. Only model responses are
// deterministic fixtures. These checks are not autonomous-model acceptance.
process.env.PAT_RUNTIME_SCOPE = `${process.env.PAT_RUNTIME_SCOPE}-proof-${randomUUID()}`;
const app = await isolatedApp(), { db, schema } = app;
const hooks = registerHooks({ resolve(specifier, _context, next) {
  if (/(?:^|\/)result-reviewer(?:\.ts)?$/.test(specifier)) return { url: 'data:text/javascript,export const assessResult = (...args) => globalThis.proofModels.review(...args);', shortCircuit: true };
  if (/(?:^|\/)mission-reporter(?:\.ts)?$/.test(specifier)) return { url: 'data:text/javascript,export const writeMissionReport = (...args) => globalThis.proofModels.report(...args);', shortCircuit: true };
  return next(specifier, _context);
} });
const { saveItem, saveFile } = await import('../server/utils/workspaces.ts');
const { testRunAction, reviewTestRun } = await import('../server/utils/test-runs.ts');
const { processReviewQueue } = await import('../server/utils/result-review-worker.ts');
const { missionAction, requestMissionReport, bindMissionSource } = await import('../server/utils/missions.ts');
const { processMissionReport } = await import('../server/utils/mission-reports.ts');
const { del, workspaceStorageToken } = await import('../server/utils/evidence-storage.ts');
const userId = randomUUID(), workspaceId = randomUUID(), threadId = randomUUID();
const target = { environment: 'isolated freshness fixture', url: 'https://example.test', revision: 'fixture-v1' };
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
const files = [], pending = [], releases = new Set();
const one = async (table, id) => (await db.select().from(table).where(eq(table.id, id)))[0];
let modelBarrier = null, modelReadIds = [], modelVerdict = 'supported', checks = 0;
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
async function waitFor(predicate, label) { await bounded((async () => { while (!await predicate()) await delay(10); })(), label); }
globalThis.proofModels = {
  async review(input) {
    return { verdict: 'supported', summary: 'Synthetic per-checkpoint image review', findings: input.requirements.map(requirement => {
      const evidence = input.evidence.filter(e => e.title.startsWith(`proof-${requirement.id}.`) || e.title.startsWith(`proof-${requirement.id}-backup.`));
      assert.ok(evidence.length && evidence.every(e => e.readStatus === 'read'));
      return { requirementId: requirement.id, verdict: 'supported', explanation: 'Fixture evidence matches', evidenceIds: evidence.map(e => e.id), suggestedNextStep: '', gap: null };
    }) };
  },
  async report(snapshot, read) {
    const refs = snapshot.tasks.flatMap(task => task.sources.filter(source => source.sourceType === 'test').map(source => source.evidence.find(e => e.title === 'proof-step-1.png'))).filter(Boolean);
    modelReadIds = [];
    const reads = new Map();
    for (const ref of refs) { const value = await read(ref.id); reads.set(ref.id, value); assert.ok(value.image); modelReadIds.push(ref.id); }
    if (modelBarrier) await modelBarrier.wait();
    return { draft: { summary: 'Synthetic report from previously reviewed checkpoints', findings: snapshot.config.criteria.map(criterion => ({ criterionId: criterion.id, verdict: snapshot.delivery.criteria.find(delivery => delivery.criterionId === criterion.id).complete ? modelVerdict : 'needs_evidence', conclusion: 'Saved fixture observations', evidenceIds: refs.map(ref => ref.id), observations: reportFixtureObservations(snapshot, criterion.id, refs.map(ref => ref.id), 'The read saved fixture observations belong to the cited original sources.', reads), nextStep: '' })), limitations: [] }, usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, steps: 1 } };
  },
};
async function fixture(count = 1, backup = false) {
  const cases = Array.from({ length: count }, () => ({ id: randomUUID(), title: 'Checkpoint proof', type: 'browser', preconditions: '', steps: 'Click navigation', expected: 'Destination opens' }));
  const plan = await saveItem(userId, workspaceId, { title: 'Freshness fixture', content: { kind: 'test_plan', sources: [], cases } });
  const caseKeys = cases.map(test => `${plan.id}:${test.id}`);
  const mission = await missionAction(userId, workspaceId, threadId, { action: 'create', requestId: randomUUID(), config: { title: 'Freshness', goal: 'Verify checkpoint proof', scope: 'Fixture only', criteria: [{ id: 'navigation', text: 'All checkpoints reviewed', delivery: { kind: 'test_cases', caseKeys } }], caseKeys, target, automaticReports: false } });
  const task = await missionAction(userId, workspaceId, threadId, { action: 'task', missionId: mission.id, requestId: randomUUID(), task: { title: 'Fixture run', actor: 'browser', criterionIds: ['navigation'], dependsOn: [] } });
  const runs = [];
  for (const testCase of cases) {
    const run = await testRunAction(userId, workspaceId, threadId, { action: 'start', requestId: randomUUID(), itemId: plan.id, caseId: testCase.id, expectedVersion: plan.version, target, environment: target.environment });
    await bindMissionSource(userId, workspaceId, threadId, { missionId: mission.id, taskId: task.id }, 'test', run.id);
    const evidence = [];
    for (const check of [...run.checks.map(check => check.id), ...(backup ? ['expected-backup'] : [])]) {
      const item = await saveFile(userId, workspaceId, `proof-${check}.png`, 'image/png', png, threadId, db, { provenance: { version: 1, origin: 'tool', producer: 'test-capture', sourceType: 'test', sourceId: run.id, observedAt: new Date().toISOString(), url: target.url } });
      const saved = await one(schema.workspaceItems, item.id); files.push(saved.blobPath); evidence.push(saved);
      await db.insert(schema.testCaptures).values({ id: randomUUID(), runId: run.id, itemId: item.id, title: `Checkpoint ${check}`, url: target.url, action: 'click' });
    }
    await testRunAction(userId, workspaceId, threadId, { action: 'finish', runId: run.id, result: { outcome: 'passed', actual: 'Synthetic observed result', unverified: '', observations: [], evidenceItemIds: evidence.map(item => item.id), checks: run.checks.map(check => ({ id: check.id, status: 'verified', actual: 'Synthetic saved observation' })) } });
    await processReviewQueue(); runs.push({ run, evidence });
  }
  const queued = await requestMissionReport(userId, workspaceId, mission.id);
  const report = await one(schema.missionReports, queued.reportId);
  assert.equal((await one(schema.missionSnapshots, report.snapshotId)).input.delivery.complete, true);
  return { mission, report, plan, cases, runs, required: runs[0].evidence.find(item => item.title === 'proof-expected.png') };
}
async function rowAfterReporting(fixture) { await processMissionReport(); return one(schema.missionReports, fixture.report.id); }
async function rejectReport(fixture, action, withLock = false) {
  modelBarrier = barrier();
  const reporting = processMissionReport(); pending.push(reporting);
  await bounded(modelBarrier.entered, 'report model consumed its one proof per run');
  assert.ok(!modelReadIds.includes(`item:${fixture.required.id}`), 'Required checkpoint image was not sent to report model');
  if (withLock) {
    const entered = deferred(), released = deferred(); releases.add(released.resolve);
    const mutation = db.transaction(async tx => { await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`workspace-content:${workspaceId}`},0))`); await action(tx); entered.resolve(); await released.promise; });
    pending.push(mutation); await bounded(entered.promise, 'mutation holds actual workspace lock');
    modelBarrier.release();
    await waitFor(async () => (await app.sql`select 1 from pg_locks where locktype='advisory' and not granted and classid::bigint=((hashtextextended(${`workspace-content:${workspaceId}`},0)>>32)&4294967295) and objid::bigint=(hashtextextended(${`workspace-content:${workspaceId}`},0)&4294967295)`).length > 0, 'report waits on actual content lock');
    released.resolve(); releases.delete(released.resolve); await mutation;
  } else { await action(db); modelBarrier.release(); }
  await bounded(reporting, 'report refuses stale proof'); modelBarrier = null;
  const row = await one(schema.missionReports, fixture.report.id);
  assert.equal(row.status, 'queued'); assert.equal(row.document, null); assert.equal(row.itemId, null);
  await db.update(schema.missionReports).set({ status: 'failed', leaseToken: null, leaseUntil: null }).where(eq(schema.missionReports.id, row.id));
  return row;
}
async function corrupt(item) {
  const root = resolve(process.env.SYNA_ISOLATED_STORAGE_ROOT), file = resolve(root, item.blobPath), child = relative(root, file);
  assert.ok(child && !isAbsolute(child) && child !== '..' && !child.startsWith(`..${sep}`));
  await writeFile(file, Buffer.from('corrupted fixture bytes'));
}
try {
  assert.equal(process.env.GRUNDEN_API_TOKEN, '', 'No live model calls');
  await db.insert(schema.user).values({ id: userId, name: 'Proof fixture', email: `${userId}@example.test` });
  await db.insert(schema.workspaces).values({ id: workspaceId, userId, name: 'Proof fixture' });
  await db.insert(schema.threads).values({ id: threadId, userId, workspaceId, title: 'Proof fixture' });

  const many = await fixture(4), complete = await rowAfterReporting(many);
  assert.equal(complete.status, 'completed'); assert.equal(complete.document.partial, false);
  assert.equal(complete.readIds.length, 4); assert.equal(complete.readReceipts.length, 4);
  assert.equal(many.runs.flatMap(run => run.evidence).length, 8, 'Server checks more than the six-image model budget without extra model reads'); checks++;

  const deleting = await fixture();
  await rejectReport(deleting, tx => tx.update(schema.workspaceItems).set({ deletedAt: new Date() }).where(eq(schema.workspaceItems.id, deleting.required.id)), true); checks++;
  const next = await requestMissionReport(userId, workspaceId, deleting.mission.id);
  const partial = await rowAfterReporting({ report: { id: next.reportId } });
  assert.equal(partial.status, 'completed'); assert.equal(partial.document.partial, true); assert.equal(partial.document.findings[0].verdict, 'needs_evidence'); checks++;

  const missingBytes = await fixture();
  await rejectReport(missingBytes, () => del(missingBytes.required.blobPath, { token: workspaceStorageToken() })); checks++;
  const changedBytes = await fixture();
  await rejectReport(changedBytes, () => corrupt(changedBytes.required)); checks++;
  const contradicted = await fixture(); modelVerdict = 'contradicted';
  await rejectReport(contradicted, () => del(contradicted.required.blobPath, { token: workspaceStorageToken() })); modelVerdict = 'supported'; checks++;
  const missingBefore = await fixture();
  await del(missingBefore.required.blobPath, { token: workspaceStorageToken() });
  const unavailable = await rowAfterReporting(missingBefore);
  assert.equal(unavailable.status, 'queued'); assert.equal(unavailable.document, null);
  await db.update(schema.missionReports).set({ status: 'failed' }).where(eq(schema.missionReports.id, unavailable.id)); checks++;

  const alternative = await fixture(1, true);
  await corrupt(alternative.required);
  const fallback = await rowAfterReporting(alternative);
  assert.equal(fallback.status, 'completed'); assert.equal(fallback.document.partial, false); assert.equal(fallback.readIds.length, 1); checks++;

  const unrelated = await fixture();
  const extra = await saveFile(userId, workspaceId, 'unrelated.png', 'image/png', png, threadId);
  const extraFile = (await one(schema.workspaceItems, extra.id)).blobPath; files.push(extraFile);
  await del(extraFile, { token: workspaceStorageToken() });
  const unaffected = await rowAfterReporting(unrelated);
  assert.equal(unaffected.status, 'completed'); assert.equal(unaffected.document.partial, false); checks++;

  const reserved = await fixture();
  await rejectReport(reserved, () => reviewTestRun(userId, workspaceId, { runId: reserved.runs[0].run.id, requestId: randomUUID(), outcome: 'inconclusive', reason: 'Synthetic manual reservation during report writing' })); checks++;
  const changedPlan = await fixture();
  await rejectReport(changedPlan, () => saveItem(userId, workspaceId, { id: changedPlan.plan.id, expectedVersion: changedPlan.plan.version, title: changedPlan.plan.title, content: { kind: 'test_plan', sources: [], cases: changedPlan.cases.map(test => ({ ...test, expected: 'New requirement after snapshot' })) } })); checks++;

  console.log(JSON.stringify({ status: 'passed', checks, database: 'actual isolated PostgreSQL', storage: 'actual isolated file bytes', models: 'deterministic barriers only', tested: ['per-checkpoint proof beyond model image budget', 'delete unread required proof under final content lock', 'fresh partial report after deletion', 'missing/corrupt bytes rejected', 'preexisting file loss rejected', 'valid cited alternative accepted', 'unrelated attachments ignored', 'manual reservation and changed case invalidate frozen coverage'] }));
} finally {
  for (const release of releases) release();
  await Promise.allSettled(pending);
  for (const file of files) await del(file, { token: workspaceStorageToken() });
  try { await db.delete(schema.testCaptures).where(sql`${schema.testCaptures.runId} in (select id from pat_test_runs where workspace_id = ${workspaceId})`); await db.delete(schema.user).where(eq(schema.user.id, userId)); }
  finally { hooks.deregister(); delete globalThis.proofModels; await app.close(); }
}
