import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { registerHooks } from 'node:module';
import { and, eq, sql } from 'drizzle-orm';
import { isolatedApp } from './helpers/isolated-app.mjs';
import { reportObservationText, reportText, MISSION_REPORT_VERSION } from '../shared/mission-report.ts';
import { missionReportCheckRef } from '../shared/mission-report-context.ts';

// Actual isolated SQL, Vault encryption, saved file reads and report persistence.
// Only the reporter is substituted. No provider/browser/HTTP service is invoked.
assert.equal(process.env.GRUNDEN_API_TOKEN, '', 'Use the isolated launcher with no provider credential');
assert.match(process.env.PAT_RUNTIME_SCOPE ?? '', /^autonomy-test:[a-z0-9-]+$/);
assert.match(MISSION_REPORT_VERSION, /:judgement-8:/, 'Integrate the reviewed check-subject product first');
process.env.PAT_RUNTIME_SCOPE += `-report-subject-${randomUUID()}`;
process.env.MISSION_REPORTS_ENABLED = 'true';
const previousVaultKey = process.env.ENV_VAULT_KEY;
process.env.ENV_VAULT_KEY = `isolated-report-subject-${randomUUID()}`;
const app = await isolatedApp(), { db, schema } = app;
const originalFetch = globalThis.fetch;
const userId = randomUUID(), workspaceId = randomUUID(), threadId = randomUUID();
const secret = `synthetic-workspace-value-${randomUUID()}`;
const target = { environment: 'Report subject SQL fixture', url: 'https://report-subject.example.test/', revision: 'fixture-v1' };
const files = [], checks = [], reporterCalls = [];
const modes = new Map();
let sourceRun, capture;
const one = async (table, id) => (await db.select().from(table).where(eq(table.id, id)))[0];
const reporterUrl = new URL('../server/utils/mission-reports.ts', import.meta.url).href;
const hooks = registerHooks({ resolve(specifier, context, next) {
  if (context.parentURL === reporterUrl && specifier === '../../agent/lib/mission-reporter') return {
    url: 'data:text/javascript,export const writeMissionReport = (...args) => globalThis.reportSubjectSqlWriter(...args);', shortCircuit: true,
  };
  return next(specifier, context);
} });
globalThis.fetch = () => { throw new Error('Network forbidden in report subject SQL integration'); };

try {
  const { saveItem, saveFile, publicItem } = await import('../server/utils/workspaces.ts');
  const { testRunAction } = await import('../server/utils/test-runs.ts');
  const { saveVaultEntry } = await import('../server/utils/project-vault.ts');
  const { missionAction, requestMissionReport } = await import('../server/utils/missions.ts');
  const { processMissionReport, readOwnedReport } = await import('../server/utils/mission-reports.ts');
  const { del, workspaceStorageToken } = await import('../server/utils/evidence-storage.ts');
  // Save the actual storage cleanup operation before any fixture files exist.
  app.deleteFixtureFile = path => del(path, { token: workspaceStorageToken() });
  await db.insert(schema.user).values({ id: userId, name: 'Report subject integration', email: `${userId}@example.test` });
  await db.insert(schema.workspaces).values({ id: workspaceId, userId, name: 'Report subject integration' });
  await db.insert(schema.threads).values({ id: threadId, userId, workspaceId, title: 'Report subject integration' });
  const testCase = { id: randomUUID(), title: 'Saved negative fixture', type: 'browser', preconditions: '',
    steps: 'Click Update', expected: `The status becomes Complete. ${'Original requirement. '.repeat(130)}Reference value ${secret}` };
  const plan = await saveItem(userId, workspaceId, { title: 'Report subject fixture plan', content: { kind: 'test_plan', sources: [], cases: [testCase] } });
  sourceRun = await testRunAction(userId, workspaceId, threadId, { action: 'start', requestId: randomUUID(), itemId: plan.id, caseId: testCase.id, expectedVersion: plan.version, target, environment: target.environment });
  capture = await saveFile(userId, workspaceId, 'report-subject.txt', 'text/plain', Buffer.from('The Update action completed; status remained Pending.'), threadId, db,
    { provenance: { version: 1, origin: 'tool', producer: 'test-capture', sourceType: 'test', sourceId: sourceRun.id, observedAt: new Date().toISOString(), url: target.url } });
  files.push((await one(schema.workspaceItems, capture.id)).blobPath);
  await db.insert(schema.testCaptures).values({ id: randomUUID(), runId: sourceRun.id, itemId: capture.id, title: 'Saved fixture action', url: target.url, action: 'click' });
  await testRunAction(userId, workspaceId, threadId, { action: 'finish', runId: sourceRun.id, result: {
    outcome: 'failed', actual: 'Status remained Pending.', unverified: '', observations: [], evidenceItemIds: [capture.id],
    checks: sourceRun.checks.map(check => ({ id: check.id, status: 'mismatch', actual: 'Status remained Pending.' })),
  } });
  const unchangedRun = JSON.stringify(await one(schema.testRuns, sourceRun.id));

  globalThis.reportSubjectSqlWriter = async (snapshot, read, _signal, options) => {
    const mode = modes.get(snapshot.missionId); assert.ok(mode, 'Reporter must only process this fixture');
    reporterCalls.push(mode);
    const source = snapshot.tasks.flatMap(task => task.sources).find(source => source.sourceType === 'test' && source.sourceId === sourceRun.id);
    assert.ok(source);
    const check = source.claims.find(check => check.id === 'expected'); assert.ok(check);
    const ref = source.evidence.find(ref => ref.itemId === capture.id); assert.ok(ref);
    const bytes = await read(ref.id); assert.equal(bytes.unavailable, undefined); assert.equal(bytes.limited, false);
    assert.equal(bytes.text, 'The Update action completed; status remained Pending.');
    if (mode !== 'known-zero') await options.beforeModel();
    const observation = { text: mode === 'legacy' ? 'Legacy factual observation without a subject.' : `The saved status stayed Pending. ${secret}`, evidenceIds: [ref.id] };
    const observations = mode === 'legacy' ? [observation] : source.claims.map(check => ({ ...observation, subject: { checkRef: mode === 'forged' ? 'invented-check-ref' : missionReportCheckRef(source, check.id), relation: 'unresolved' } }));
    // Synthetic metering cases exercise persisted model metadata, not model behaviour.
    const provider = mode === 'known-zero' ? { providerCalls: 0, unknownCalls: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, durationMs: 0 }
      : ['unknown-usage', 'zero-unknown', 'zero-null'].includes(mode) ? { providerCalls: mode === 'unknown-usage' ? 1 : 0, unknownCalls: mode === 'zero-null' ? null : 1, inputTokens: null, outputTokens: null, totalTokens: null, cacheReadTokens: null, cacheWriteTokens: null, durationMs: null } : undefined;
    return { draft: { summary: 'Synthetic saved-result report', findings: [{ criterionId: 'saved', verdict: 'needs_evidence', conclusion: 'Original review remains incomplete.',
      evidenceIds: [ref.id], observations, nextStep: '' }], limitations: [] },
    usage: { inputTokens: provider ? provider.inputTokens : 0, outputTokens: provider ? provider.outputTokens : 0, totalTokens: provider ? provider.totalTokens : 0,
      steps: mode === 'known-zero' ? 0 : 1, toolCalls: 1, ...(provider ? { provider } : {}) } };
  };

  async function queue(mode) {
    const mission = await missionAction(userId, workspaceId, threadId, { action: 'create', requestId: randomUUID(), config: { title: 'Report subject persistence', goal: 'Summarize the saved source', scope: 'No execution',
      criteria: [{ id: 'saved', text: 'Review this exact saved result', delivery: { kind: 'source', sourceTypes: ['test'], sourceRefs: [{ type: 'test', id: sourceRun.id }] } }], caseKeys: [], target, automaticReports: false } });
    const task = await missionAction(userId, workspaceId, threadId, { action: 'task', missionId: mission.id, requestId: randomUUID(), task: { title: 'Saved source', actor: 'main', criterionIds: ['saved'], dependsOn: [] } });
    await missionAction(userId, workspaceId, threadId, { action: 'attach', missionId: mission.id, taskId: task.id, sourceType: 'test', sourceId: sourceRun.id });
    modes.set(mission.id, mode);
    const queued = await requestMissionReport(userId, workspaceId, mission.id);
    assert.ok(queued.reportId);
    return one(schema.missionReports, queued.reportId);
  }

  const typed = await queue('typed'), snapshotBefore = await one(schema.missionSnapshots, typed.snapshotId);
  const originalRequirement = snapshotBefore.input.tasks.flatMap(task => task.sources).find(source => source.sourceId === sourceRun.id).claims.find(check => check.id === 'expected').requirement;
  assert.ok(originalRequirement.length > 2000 && originalRequirement.includes(secret), 'The frozen original must actually exercise the new redaction boundary');
  // The secret becomes known after the immutable report input was captured.
  await saveVaultEntry(userId, workspaceId, { repoUrl: 'https://github.com/fixture/report-subject', expectedRevision: 0, values: { API_KEY: secret }, forget: [] });
  await processMissionReport();
  const persisted = await one(schema.missionReports, typed.id);
  assert.equal(persisted.status, 'completed'); assert.equal(persisted.model, 'glm-5.3'); assert.ok(persisted.itemId);
  assert.equal(persisted.attempts, 1); assert.equal(persisted.readReceipts.length, 1);
  const observation = persisted.document.findings[0].observations.find(value => value.subject?.requirement === originalRequirement.replaceAll(secret, '[REDACTED]'));
  assert.ok(observation);
  assert.equal(persisted.document.findings[0].observations.length, snapshotBefore.input.tasks[0].sources[0].claims.length);
  assert.deepEqual(observation.subject, { requirement: originalRequirement.replaceAll(secret, '[REDACTED]'), relation: 'unresolved' });
  assert.ok(!JSON.stringify(persisted.document).includes(secret));
  assert.equal(observation.text, 'The saved status stayed Pending. [REDACTED]');
  assert.equal(persisted.document.tests[0].originalOutcome, 'failed');
  assert.equal(persisted.document.partial, true, 'This test does not manufacture a current supported review');
  const [{ storageType }] = await db.select({ storageType: sql`pg_typeof(${schema.missionReports.document})::text` }).from(schema.missionReports).where(eq(schema.missionReports.id, typed.id));
  assert.equal(storageType, 'jsonb');
  checks.push('actual JSONB subject uses full immutable requirement and current workspace secret redaction');

  const view = await readOwnedReport(userId, workspaceId, typed.id);
  assert.deepEqual(view.report.document, persisted.document);
  assert.ok(reportText(view.report.document).includes(reportObservationText(observation)));
  const material = publicItem(await one(schema.workspaceItems, persisted.itemId));
  const block = material.content.blocks.find(block => block.kind === 'text' && block.text.includes(reportObservationText(observation)));
  assert.ok(block); assert.ok(block.text.includes(reportObservationText(observation)));
  assert.ok(!JSON.stringify(material.content).includes(secret));
  assert.deepEqual((await one(schema.missionSnapshots, typed.snapshotId)).input, snapshotBefore.input);
  checks.push('owned report view and saved Material retain the same sanitized full subject without rewriting input');

  for (const [mode, expectedModel] of [['known-zero', 'deterministic-rules'], ['unknown-usage', 'glm-5.3'], ['zero-unknown', 'glm-5.3'], ['zero-null', 'glm-5.3']]) {
    const queued = await queue(mode); await processMissionReport();
    const saved = await one(schema.missionReports, queued.id);
    assert.equal(saved.status, 'completed'); assert.equal(saved.model, expectedModel);
    assert.equal(saved.usage.provider.providerCalls, mode === 'unknown-usage' ? 1 : 0);
    assert.equal(saved.usage.provider.unknownCalls, mode === 'known-zero' ? 0 : mode === 'zero-null' ? null : 1);
    assert.equal(saved.usage.totalTokens, mode === 'known-zero' ? 0 : null);
    assert.equal(saved.document.partial, true); assert.equal(saved.document.tests[0].originalOutcome, 'failed');
    assert.equal(JSON.stringify(await one(schema.testRuns, sourceRun.id)), unchangedRun);
  }
  assert.equal(persisted.usage.provider, undefined, 'Missing metering is not known zero');
  assert.equal(persisted.model, 'glm-5.3');
  checks.push('model metadata distinguishes explicit zero calls from missing and unknown provider usage');

  const legacy = await queue('legacy'); await processMissionReport();
  const legacyView = await readOwnedReport(userId, workspaceId, legacy.id);
  assert.equal(legacyView.report.status, 'queued');
  assert.equal(legacyView.report.document, null);
  assert.equal(legacyView.report.itemId, null);
  assert.equal(legacyView.report.attempts, 1);
  assert.equal(legacyView.report.readReceipts.length, 1);
  const typedBytes = JSON.stringify(persisted.document);
  checks.push('new subject-free assessment draft cannot bypass exact check coverage');

  const forged = await queue('forged');
  const beforeItems = await db.select({ id: schema.workspaceItems.id }).from(schema.workspaceItems).where(eq(schema.workspaceItems.workspaceId, workspaceId));
  await processMissionReport();
  const denied = await one(schema.missionReports, forged.id);
  assert.equal(denied.status, 'queued'); assert.equal(denied.attempts, 1); assert.equal(denied.document, null); assert.equal(denied.itemId, null);
  assert.equal(denied.readReceipts.length, 1, 'The real source was read before the forged draft was rejected');
  const afterItems = await db.select({ id: schema.workspaceItems.id }).from(schema.workspaceItems).where(eq(schema.workspaceItems.workspaceId, workspaceId));
  assert.deepEqual(afterItems.map(row => row.id).sort(), beforeItems.map(row => row.id).sort());
  assert.equal(JSON.stringify((await readOwnedReport(userId, workspaceId, typed.id)).report.document), typedBytes);
  assert.equal(JSON.stringify(await one(schema.testRuns, sourceRun.id)), unchangedRun);
  assert.deepEqual(reporterCalls, ['typed', 'known-zero', 'unknown-usage', 'zero-unknown', 'zero-null', 'legacy', 'forged']);
  checks.push('forged subject is rejected before document/Material commit; no retry or original run mutation');
  console.log(JSON.stringify({ status: 'passed', checks: checks.length, tested: checks, database: 'actual isolated PostgreSQL', storage: 'actual isolated file bytes', reporter: 'seven synthetic drafts', actualProviderCalls: 0, browserActions: 0, semanticAcceptance: 'not_evaluated' }));
} finally {
  try {
    for (const path of files) await app.deleteFixtureFile(path);
  } finally {
    try {
      await db.transaction(async tx => {
        if (sourceRun) await tx.delete(schema.testCaptures).where(eq(schema.testCaptures.runId, sourceRun.id));
        await tx.delete(schema.threads).where(and(eq(schema.threads.id, threadId), eq(schema.threads.userId, userId)));
        await tx.delete(schema.workspaces).where(and(eq(schema.workspaces.id, workspaceId), eq(schema.workspaces.userId, userId)));
        await tx.delete(schema.user).where(eq(schema.user.id, userId));
      });
    } finally {
      hooks.deregister(); delete globalThis.reportSubjectSqlWriter; globalThis.fetch = originalFetch;
      if (previousVaultKey === undefined) delete process.env.ENV_VAULT_KEY; else process.env.ENV_VAULT_KEY = previousVaultKey;
      await app.close();
    }
  }
}
