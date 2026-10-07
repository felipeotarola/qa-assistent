import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { registerHooks } from 'node:module';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { eq, sql } from 'drizzle-orm';
import { isolatedApp } from './helpers/isolated-app.mjs';

// Actual report worker + PostgreSQL + persisted bytes. No model is allowed.
process.env.PAT_RUNTIME_SCOPE = `${process.env.PAT_RUNTIME_SCOPE}-fallback-${randomUUID()}`;
const app = await isolatedApp(), { db, schema } = app;
let modelCalls = 0, readCalls = 0;
globalThis.fallbackProbe = {
  model() { modelCalls++; throw new Error('Fallback must not invoke a model'); },
  read() { readCalls++; throw new Error('Fallback must not claim a read'); },
};
const hooks = registerHooks({ resolve(specifier, _context, next) {
  if (/(?:^|\/)mission-reporter(?:\.ts)?$/.test(specifier)) return { url: 'data:text/javascript,export const writeMissionReport = (...args) => globalThis.fallbackProbe.model(...args);', shortCircuit: true };
  if (/(?:^|\/)mission-evidence(?:\.ts)?$/.test(specifier)) return { url: 'data:text/javascript,export const readMissionEvidence = (...args) => globalThis.fallbackProbe.read(...args);', shortCircuit: true };
  return next(specifier, _context);
} });
const { saveItem, saveFile } = await import('../server/utils/workspaces.ts');
const { testRunAction } = await import('../server/utils/test-runs.ts');
const { missionAction, requestMissionReport } = await import('../server/utils/missions.ts');
const { processMissionReport } = await import('../server/utils/mission-reports.ts');
const { del, workspaceStorageToken } = await import('../server/utils/evidence-storage.ts');
const userId = randomUUID(), workspaceId = randomUUID(), threadId = randomUUID(), files = [];
const one = async (table, id) => (await db.select().from(table).where(eq(table.id, id)))[0];
let checks = 0;
async function reportFor(source) {
  const mission = await missionAction(userId, workspaceId, threadId, { action: 'create', requestId: randomUUID(), config: {
    title: 'Fallback fixture', goal: 'Assess saved evidence only', scope: 'No execution', target: null, caseKeys: [], automaticReports: false,
    criteria: [{ id: 'qa', text: 'Redovisa vad underlaget styrker.', ...(source ? { delivery: { kind: 'source', sourceTypes: [source.type], sourceRefs: [source] } } : {}) }],
  } });
  if (source) {
    const task = await missionAction(userId, workspaceId, threadId, { action: 'task', missionId: mission.id, requestId: randomUUID(), task: { title: 'Saved source', actor: 'main', criterionIds: ['qa'], dependsOn: [] } });
    await missionAction(userId, workspaceId, threadId, { action: 'attach', missionId: mission.id, taskId: task.id, sourceType: source.type, sourceId: source.id });
  }
  const request = await requestMissionReport(userId, workspaceId, mission.id);
  await processMissionReport();
  const report = await one(schema.missionReports, request.reportId);
  assert.equal(report.status, 'completed'); assert.equal(report.model, 'deterministic-rules');
  assert.equal(report.document.partial, true); assert.ok(report.document.findings.every(f => f.verdict === 'needs_evidence'));
  assert.deepEqual(report.readIds, []); assert.deepEqual(report.readReceipts, []);
  assert.equal(report.usage.totalTokens, 0); assert.equal(modelCalls, 0); assert.equal(readCalls, 0);
  assert.match(report.document.summary, /0 av \d+ referenser lästes fullständigt/);
  assert.ok(report.document.limitations.includes('Ingen modellbedömning eller läsning av underlag gjordes i detta rapportsteg.'));
  assert.doesNotMatch(report.document.summary, /saknas läsbart|oläsbart|filen saknas/);
  assert.ok(report.document.findings.every(f => !/läsbart underlag|oläsbart|filen saknas/.test(f.conclusion)));
  checks++; return report;
}
try {
  assert.equal(process.env.GRUNDEN_API_TOKEN, '');
  await db.insert(schema.user).values({ id: userId, name: 'Fallback fixture', email: `${userId}@example.test` });
  await db.insert(schema.workspaces).values({ id: workspaceId, userId, name: 'Fallback fixture' });
  await db.insert(schema.threads).values({ id: threadId, userId, workspaceId, title: 'Fallback fixture' });
  await reportFor(null);
  const note = await saveItem(userId, workspaceId, { title: 'Agent claim', content: { kind: 'text', text: 'An agent claims success; not independent proof.' } }, db,
    { provenance: { version: 1, origin: 'agent', producer: 'agent-authored', observedAt: null } });
  await reportFor({ type: 'material', id: note.id });

  const caseId = randomUUID();
  const plan = await saveItem(userId, workspaceId, { title: 'Unknown target fixture', content: { kind: 'test_plan', sources: [], cases: [{ id: caseId, title: 'Saved unknown version', type: 'browser', preconditions: '', steps: 'Observe heading', expected: 'Heading is visible' }] } });
  const run = await testRunAction(userId, workspaceId, threadId, { action: 'start', requestId: randomUUID(), itemId: plan.id, caseId, expectedVersion: plan.version, environment: 'Unknown target fixture' });
  const original = Buffer.from('Synthetic saved observation: heading visible; target version unknown.');
  const file = await saveFile(userId, workspaceId, 'saved-readable.txt', 'text/plain', original, threadId, db,
    { provenance: { version: 1, origin: 'tool', producer: 'test-capture', sourceType: 'test', sourceId: run.id, observedAt: new Date().toISOString() } });
  const item = await one(schema.workspaceItems, file.id); files.push(item.blobPath);
  const localPath = resolve(process.env.SYNA_ISOLATED_STORAGE_ROOT, item.blobPath);
  assert.deepEqual(await readFile(localPath), original);
  await db.insert(schema.testCaptures).values({ id: randomUUID(), runId: run.id, itemId: file.id, title: 'Saved readable bytes', action: 'open', url: 'https://fixture.test/' });
  await testRunAction(userId, workspaceId, threadId, { action: 'finish', runId: run.id, result: {
    outcome: 'inconclusive', actual: 'Heading visible; version unknown', unverified: 'Version unknown', observations: [], evidenceItemIds: [file.id],
    checks: run.checks.map(check => ({ id: check.id, status: 'unverified', actual: 'Version unknown' })),
  } });
  const report = await reportFor({ type: 'test', id: run.id });
  const snapshot = await one(schema.missionSnapshots, report.snapshotId);
  const savedSource = snapshot.input.tasks.flatMap(task => task.sources).find(source => source.sourceId === run.id);
  assert.equal(savedSource.status, 'completed'); assert.equal(savedSource.target, null);
  assert.ok(savedSource.evidence.some(ref => ref.itemId === file.id && ref.unavailable === false));
  for (const limitation of savedSource.limitations) {
    assert.ok(snapshot.input.gaps.includes(`Saved source [test:${run.id}]: ${limitation}`), 'Source-local limits must retain their exact source identity in the actual saved snapshot');
    assert.ok(!snapshot.input.gaps.includes(limitation), 'No unscoped copy may imply every source lacks its target');
  }
  assert.deepEqual(await readFile(localPath), original, 'Policy exclusion must not alter stored bytes');
  console.log(JSON.stringify({ status: 'passed', checks, database: 'actual isolated PostgreSQL', storage: 'actual saved text bytes', modelCalls, readCalls, tested: ['empty evidence', 'agent-authored claim', 'available bytes with policy-excluded unknown target'] }));
} finally {
  for (const file of files) await del(file, { token: workspaceStorageToken() });
  try { await db.delete(schema.testCaptures).where(sql`${schema.testCaptures.runId} in (select id from pat_test_runs where workspace_id = ${workspaceId})`); await db.delete(schema.user).where(eq(schema.user.id, userId)); }
  finally { hooks.deregister(); delete globalThis.fallbackProbe; await app.close(); }
}
