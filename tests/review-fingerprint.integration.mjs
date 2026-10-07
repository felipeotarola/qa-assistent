import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import { controllerFixture } from './helpers/mission-controller-fixture.mjs';

// Authored worker, actual private evidence bytes, PostgreSQL JSONB roundtrip,
// current assessment lookup and controller. Only the browser/model are doubles.
// No live models, no mutation of any existing acceptance workspace or runtime.
const h = await controllerFixture(), { db, schema } = h;
const { testRunAction } = await import('../server/utils/test-runs.ts');
const { runChecks } = await import('../shared/test-run.ts');
const { saveFile } = await import('../server/utils/workspaces.ts');
const { del, workspaceStorageToken } = await import('../server/utils/evidence-storage.ts');
const { hashReview, readCurrentRunAssessment, listAssessments, enqueueReview } = await import('../server/utils/result-assessments.ts');
const { REVIEWER_VERSION, REVIEW_HASH_VERSION } = await import('../shared/result-assessment.ts');
const { validateMissionComplement } = await import('../server/utils/mission-complements.ts');
const rawHash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const scripts = globalThis.missionControllerFixtureExecutors, previousModel = scripts.assessResult;
const files = [], captureIds = [], invoked = new Map(), checks = [];
const row = h.row;
scripts.assessResult = async (input, attachments, _signal, onUsage) => {
  assert.ok(attachments.length > 0, 'Actual saved bytes must be read before model double');
  const proof = input.evidence.find(e => e.itemId && e.readStatus === 'read'); assert.ok(proof);
  invoked.set(input.runId, { hash: hashReview(input), rawHash: rawHash(input) });
  onUsage?.(12, { providerCalls: 1, unknownCalls: 0, inputTokens: 10, outputTokens: 2, totalTokens: 12, cacheReadTokens: 0, cacheWriteTokens: null, durationMs: 1 });
  return { verdict: 'needs_evidence', summary: 'Synthetic model sees one original observation gap.', findings: input.requirements.map(requirement => ({
    requirementId: requirement.id, verdict: requirement.id === 'step-1' ? 'needs_evidence' : 'supported',
    explanation: 'Synthetic model output over actual stored fixture bytes.', evidenceIds: [proof.id], suggestedNextStep: '',
    gap: requirement.id === 'step-1' ? { kind: 'missing_observation', capability: 'browser', wantedEvidence: 'Independent observation of the original step.' } : null,
  })) };
};
async function check(name, fn) { try { await fn(); checks.push(name); } catch (error) { console.error('FAILED', name, error); throw error; } }
async function prepared() {
  const f = await h.fixture(), ready = await h.browserReady(f), attempt = ready.attempts.find(a => a.kind === 'browser_tests'), task = ready.tasks.find(t => t.id === attempt.taskId);
  const [itemId, caseId] = task.spec.caseKeys[0].split(':'), execution = { execution: { attemptId: attempt.id, dispatchId: attempt.dispatchId } };
  const run = await testRunAction(h.owner, f.workspace, f.thread, { action: 'start', itemId, caseId, expectedVersion: task.spec.planVersions[0].version,
    requestId: randomUUID(), environment: task.spec.target.environment, target: task.spec.target, mission: { missionId: f.id, taskId: task.id } }, execution);
  const evidence = await saveFile(h.owner, f.workspace, 'fingerprint-trace.txt', 'text/plain', Buffer.from('Synthetic independent observation; one step remains unclear to reviewer.'), f.thread, db,
    { provenance: { version: 1, origin: 'tool', producer: 'test-capture', sourceType: 'test', sourceId: run.id, observedAt: new Date().toISOString(), url: run.target.url } });
  files.push((await row(schema.workspaceItems, evidence.id)).blobPath);
  const captureId = randomUUID(); captureIds.push(captureId);
  await db.insert(schema.testCaptures).values({ id: captureId, runId: run.id, itemId: evidence.id, title: 'Synthetic trace', action: 'inspect', url: run.target.url });
  // This is a model/persistence test, not a genuine browser-entry receipt.
  await testRunAction(h.owner, f.workspace, f.thread, { action: 'finish', runId: run.id, result: { schemaVersion: 2, outcome: 'inconclusive', actual: 'Synthetic executor claim; model requests proof of one step.', remaining: [],
    observations: [], evidenceItemIds: [evidence.id], checks: runChecks(run.snapshot).map(point => ({ id: point.id, status: 'verified', actual: 'Synthetic executor observation.' })) } }, execution);
  await db.update(schema.missionAttempts).set({ usage: { tokens: 100, toolCalls: 2, durationMs: 1 } }).where(eq(schema.missionAttempts.id, attempt.id));
  await db.update(schema.browserJobs).set({ status: 'completed', updatedAt: new Date() }).where(eq(schema.browserJobs.id, attempt.dispatchId));
  await h.pass(f); await h.workers(f);
  return { f, run: await row(schema.testRuns, run.id), evidence };
}
async function claimed(f, callback) {
  await db.update(schema.missions).set({ nextWakeAt: new Date(0) }).where(eq(schema.missions.id, f.id));
  const identity = h.attempts.leaseIdentity(await h.attempts.claimMission(f.id));
  try { return await db.transaction(async tx => callback(tx, await h.attempts.claimedMission(tx, identity))); }
  finally { await h.attempts.releaseMissionLease(identity, 0); }
}
try {
  await check('canonical format survives actual nested JSONB reordering, preserves array identity and rejects old raw format', async () => {
    assert.equal(REVIEW_HASH_VERSION, 2); assert.equal(REVIEWER_VERSION, '19');
    const value = { zebra: { longestKey: 'x', a: 2 }, a: [{ long: 'first', a: 1 }, { b: 2 }], ignored: undefined };
    const [stored] = await h.sql`select ${JSON.stringify(value)}::jsonb as value`;
    assert.notEqual(rawHash(value), rawHash(stored.value)); assert.equal(hashReview(value), hashReview(stored.value)); assert.notEqual(hashReview(value), rawHash(value));
    assert.notEqual(hashReview(value), hashReview({ ...value, a: [...value.a].reverse() }));
    assert.notEqual(hashReview(value), hashReview({ ...value, zebra: { ...value.zebra, a: 3 } }));
  });
  const { f, run, evidence } = await prepared(); let review, complement;
  await check('real worker reads bytes then persists an input fingerprint stable through JSONB', async () => {
    review = await readCurrentRunAssessment(f.workspace, run.id); assert.equal(review.status, 'completed'); assert.equal(review.model, 'glm-5.3'); assert.equal(review.assessment.verdict, 'needs_evidence');
    assert.equal(review.inputHash, hashReview(review.input)); assert.equal(review.inputHash, invoked.get(run.id).hash);
    assert.notEqual(rawHash(review.input), invoked.get(run.id).rawHash, 'Fixture must actually exercise PostgreSQL key reordering');
  });
  await check('controller creates exactly one bounded complement after that model review, without injected assessment hashes', async () => {
    await h.pass(f); await h.pass(f);
    const state = await h.state(f); complement = state.tasks.find(task => task.spec.complement);
    assert.ok(complement); assert.equal(complement.supplementRound, 1); assert.equal(complement.spec.complement.assessmentId, review.id);
    assert.equal(complement.spec.complement.inputHash, review.inputHash); assert.equal(complement.spec.complement.sourceHash, review.sourceHash);
    assert.equal(state.tasks.filter(task => task.spec.complement).length, 1); assert.ok(!state.tasks.some(task => task.spec.kind === 'report'));
  });
  await check('current read and report projection mark raw-format v5 history stale without rewriting it', async () => {
    const id = randomUUID(), historical = { ...review, id, reviewerVersion: '5', sourceHash: rawHash(review.input), inputHash: rawHash(review.input) };
    await db.insert(schema.resultAssessments).values(historical);
    const before = await row(schema.resultAssessments, id), views = await listAssessments(h.owner, f.workspace, run.id);
    assert.equal(views.find(view => view.id === id).stale, true); assert.equal((await readCurrentRunAssessment(f.workspace, run.id)).id, review.id);
    assert.deepEqual(await row(schema.resultAssessments, id), before);
  });
  await check('previous Flash reviewer12 remains historical despite identical canonical input bytes', async () => {
    const id = randomUUID(), historical = { ...review, id, reviewerVersion: '12', model: 'glm-5.3-flash' };
    await db.insert(schema.resultAssessments).values(historical);
    const before = await row(schema.resultAssessments, id), views = await listAssessments(h.owner, f.workspace, run.id);
    assert.equal(views.find(view => view.id === id).stale, true);
    assert.equal((await readCurrentRunAssessment(f.workspace, run.id)).id, review.id);
    assert.equal(before.sourceHash, review.sourceHash, 'Input hash format is unchanged; generation version separates the model');
    assert.deepEqual(await row(schema.resultAssessments, id), before);
  });
  await check('changed input, bytes metadata, target and plan still revoke complement authority', async () => {
    const deny = error => error.statusCode === 409;
    await db.update(schema.resultAssessments).set({ input: { ...review.input, environment: 'Changed' } }).where(eq(schema.resultAssessments.id, review.id));
    await assert.rejects(claimed(f, (tx, mission) => validateMissionComplement(tx, mission, complement)), deny);
    await db.update(schema.resultAssessments).set({ input: review.input }).where(eq(schema.resultAssessments.id, review.id));
    const saved = await row(schema.testRuns, run.id);
    await db.update(schema.testRuns).set({ target: { ...saved.target, url: 'https://elsewhere.example.test/' } }).where(eq(schema.testRuns.id, run.id));
    assert.equal(await readCurrentRunAssessment(f.workspace, run.id), undefined);
    await assert.rejects(claimed(f, (tx, mission) => validateMissionComplement(tx, mission, complement)), deny);
    await db.update(schema.testRuns).set({ target: saved.target }).where(eq(schema.testRuns.id, run.id));
    const item = await row(schema.workspaceItems, evidence.id);
    await db.update(schema.workspaceItems).set({ provenance: { ...item.provenance, sha256: 'f'.repeat(64) } }).where(eq(schema.workspaceItems.id, item.id));
    assert.equal(await readCurrentRunAssessment(f.workspace, run.id), undefined);
    await assert.rejects(claimed(f, (tx, mission) => validateMissionComplement(tx, mission, complement)), deny);
    await db.update(schema.workspaceItems).set({ provenance: item.provenance }).where(eq(schema.workspaceItems.id, item.id));
    const plan = await row(schema.workspaceItems, run.itemId);
    await db.update(schema.workspaceItems).set({ version: plan.version + 1 }).where(eq(schema.workspaceItems.id, plan.id));
    await assert.rejects(claimed(f, (tx, mission) => validateMissionComplement(tx, mission, complement)), deny);
    await db.update(schema.workspaceItems).set({ version: plan.version }).where(eq(schema.workspaceItems.id, plan.id));
  });
  await check('pending old-format queue is retired and current-format queue identity remains deduplicated', async () => {
    const id = randomUUID(); await db.insert(schema.resultAssessments).values({ ...review, id, reviewerVersion: '4', sourceHash: 'e'.repeat(64), inputHash: rawHash(review.input), status: 'queued', assessment: null, finishedAt: null });
    await h.workers(f);
    const old = await row(schema.resultAssessments, id); assert.equal(old.status, 'failed'); assert.equal(old.reviewerVersion, '4'); assert.equal(old.sourceHash, 'e'.repeat(64));
    await db.transaction(tx => enqueueReview(tx, h.owner, f.workspace, run.id, f.thread));
    const current = await db.select().from(schema.resultAssessments).where(and(eq(schema.resultAssessments.runId, run.id), eq(schema.resultAssessments.reviewerVersion, REVIEWER_VERSION)));
    assert.equal(current.length, 1); assert.equal(current[0].id, review.id);
  });
} finally {
  scripts.assessResult = previousModel;
  for (const file of files) await del(file, { token: workspaceStorageToken() });
  if (captureIds.length) await db.delete(schema.testCaptures).where(inArray(schema.testCaptures.id, captureIds));
  await h.close();
}
console.log(JSON.stringify({ passed: checks.length, checks, models: 'synthetic', database: 'actual isolated PostgreSQL', evidence: 'actual private fixture bytes' }));
