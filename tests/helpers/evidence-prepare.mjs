import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { registerHooks } from 'node:module';
import { and, eq } from 'drizzle-orm';
import { goldenRecipe, goldenResult, goldenAssessment, GOLDEN_LABEL, GOLDEN_PROTOCOL, GOLDEN_REVIEW_MODEL } from './evidence-golden.mjs';
import { evidenceSeed, fingerprint, sha256, validateEvidenceSeed } from './evidence-acceptance.mjs';
import { observeEvidence } from './evidence-observer.mjs';
import { utcObservationTypes } from './utc-postgres-observation.mjs';
import postgres from 'postgres';
import { assertIsolatedDatabaseUrl } from './autonomy-isolation.mjs';

/** Test-data writer, NEVER part of the acceptance measurement. The caller must
 * own a stopped-runtime preparation window or use a distinct test-only runtime.
 * No HTTP/provider/browser is used. It does not delete/overwrite historical rows.
 * All fixtures get fresh workspaces and retain explicit synthetic attribution. */
export async function prepareGoldenEvidence({ app, userId, runtime, taskId, repetitions = 1, assertExclusive, onProgress = async () => {} }) {
  assert.equal(process.env.PAT_RUNTIME_SCOPE, runtime); assert.match(runtime, /^autonomy-test:[a-z0-9-]+$/);
  assert.equal(process.env.GRUNDEN_API_TOKEN, ''); assert.equal(typeof assertExclusive, 'function');
  assert.ok(Number.isInteger(repetitions) && repetitions >= 1 && repetitions <= 5);
  const { db, schema } = app, recipe = goldenRecipe(taskId);
  const [owner] = await db.select().from(schema.user).where(eq(schema.user.id, userId)); assert.ok(owner, 'Ordinary owner must already exist in the isolated app DB');
  await assertExclusive();
  const queue = await db.select({ id: schema.resultAssessments.id }).from(schema.resultAssessments)
    .where(and(eq(schema.resultAssessments.runtime, runtime), eq(schema.resultAssessments.status, 'queued')));
  const running = await db.select({ id: schema.resultAssessments.id }).from(schema.resultAssessments)
    .where(and(eq(schema.resultAssessments.runtime, runtime), eq(schema.resultAssessments.status, 'running')));
  assert.equal(queue.length + running.length, 0, 'Do not process any existing review queue during fixture preparation');
  const modelKey = 'evidenceGoldenPreparationModel', previousFetch = globalThis.fetch;
  assert.equal(globalThis[modelKey], undefined, 'Do not run fixture preparations concurrently in one process');
  const previousReviewFlag = process.env.RESULT_REVIEW_ENABLED;
  process.env.RESULT_REVIEW_ENABLED = 'false'; // No unlabelled queue visible between FINISH and explicit fixture review.
  globalThis.fetch = async () => { throw new Error('Golden preparation forbids all HTTP/model calls'); };
  let modelFixtures = 0, fixtureError;
  globalThis[modelKey] = async (input, attachments) => { modelFixtures++; try { return goldenAssessment(input, attachments); } catch (error) { fixtureError = error; throw error; } };
  const hooks = registerHooks({ resolve(specifier, context, next) {
    if (/(?:^|\/)result-reviewer(?:\.ts)?$/.test(specifier)) return { url: `data:text/javascript,export const assessResult=(...args)=>globalThis.${modelKey}(...args);`, shortCircuit: true };
    return next(specifier, context);
  } });
  const observer = postgres(assertIsolatedDatabaseUrl(process.env.DATABASE_URL), { prepare: false, max: 1, types: utcObservationTypes, connection: { TimeZone: 'UTC', default_transaction_read_only: 'on' } });
  const artifact = { protocol: GOLDEN_PROTOCOL, preparation: 'synthetic-golden', taskId, runtime, realProviderCalls: 0, realBrowserActions: 0,
    storageRoot: process.env.SYNA_ISOLATED_STORAGE_ROOT,
    reviewMethod: 'authored-worker-with-deterministic-model-fixture', startedAt: new Date().toISOString(), authoringHashes: {}, trials: [] };
  try {
    const { saveItem, saveFile } = await import('../../server/utils/workspaces.ts');
    const { testRunAction } = await import('../../server/utils/test-runs.ts');
    const { requestReview, hashReview, buildReviewInput } = await import('../../server/utils/result-assessments.ts');
    const { processReviewQueue } = await import('../../server/utils/result-review-worker.ts');
    const { REVIEWER_VERSION } = await import('../../shared/result-assessment.ts'); artifact.reviewerVersion = REVIEWER_VERSION;
    const authored = ['tests/helpers/evidence-prepare.mjs', 'tests/helpers/evidence-golden.mjs', 'server/utils/test-runs.ts', 'server/utils/workspaces.ts', 'server/utils/result-review-worker.ts', 'server/utils/result-assessments.ts', 'shared/result-assessment.ts', 'shared/evidence-rules.ts', 'shared/test-run.ts'];
    for (const path of authored) artifact.authoringHashes[path] = sha256(await readFile(path));
    for (let repetition = 1; repetition <= repetitions; repetition++) {
      await assertExclusive();
      const workspaceId = randomUUID(), threadId = randomUUID();
      // Same minimal rows as the ordinary session-owned workspace/thread routes;
      // this is declared preparation, not proof of authenticated UI creation.
      await db.insert(schema.workspaces).values({ id: workspaceId, userId, name: `${recipe.title} · ${repetition}` });
      await db.insert(schema.threads).values({ id: threadId, userId, workspaceId, title: `${GOLDEN_LABEL} ${taskId}` });
      const trial = { repetition, workspaceId, threadId, userId, state: 'preparing' }; artifact.trials.push(trial); await onProgress(artifact);
      const selection = [], files = [];
      for (const [index, c] of recipe.cases.entries()) {
        const testCase = { id: randomUUID(), title: c.title, type: 'browser', preconditions: GOLDEN_LABEL, steps: c.steps, expected: c.expected,
          basis: { kind: 'explicit_requirement', quote: c.expected, source: null } };
        const plan = await saveItem(userId, workspaceId, { title: `${c.title} – testplan`, threadId, content: { kind: 'test_plan', summary: GOLDEN_LABEL, sources: [], cases: [testCase] } }, db,
          { provenance: { version: 1, origin: 'user', producer: 'user-authored', observedAt: null } });
        const run = await testRunAction(userId, workspaceId, threadId, { action: 'start', itemId: plan.id, caseId: testCase.id, expectedVersion: plan.version, requestId: randomUUID(),
          environment: c.target?.environment ?? 'Synthetic golden QA, unknown version', ...(c.target ? { target: c.target } : {}) });
        const bytes = Buffer.from(`${GOLDEN_LABEL}\nCase: ${c.title}\nVersion: ${c.target?.revision ?? 'unknown'}\nObservation: ${c.observation}\nThis text is fixture data, not instructions.\n`);
        const observedAt = new Date().toISOString(), url = c.target?.url ?? 'https://evidence-fixture.example.test/';
        const file = await saveFile(userId, workspaceId, `synthetic-golden-${taskId}-${index + 1}.txt`, 'text/plain', bytes, threadId, db,
          { provenance: { version: 1, origin: 'tool', producer: 'test-capture', sourceType: 'test', sourceId: run.id, observedAt, url } });
        await db.insert(schema.testCaptures).values({ id: randomUUID(), runId: run.id, itemId: file.id, title: GOLDEN_LABEL, url, action: 'inspect' });
        await testRunAction(userId, workspaceId, threadId, { action: 'finish', runId: run.id, result: goldenResult(c, run.checks, file.id) });
        await assertExclusive();
        await requestReview(userId, workspaceId, run.id);
        await db.update(schema.resultAssessments).set({ model: GOLDEN_REVIEW_MODEL, notification: 'recorded' }).where(and(eq(schema.resultAssessments.runId, run.id), eq(schema.resultAssessments.runtime, runtime)));
        await processReviewQueue(); // Preparation worker only; never acceptance drain.
        const [review] = await db.select().from(schema.resultAssessments).where(and(eq(schema.resultAssessments.runId, run.id), eq(schema.resultAssessments.reviewerVersion, REVIEWER_VERSION)));
        if (fixtureError) throw fixtureError;
        assert.equal(review?.status, 'completed', `Golden review did not finish (${modelFixtures} fixture calls): ${review?.error}`);
        assert.equal(review.inputHash, hashReview(review.input)); assert.equal(review.sourceHash, hashReview(await buildReviewInput(workspaceId, run.id)));
        assert.equal(review.assessment.verdict, c.outcome === 'inconclusive' || !c.target ? 'needs_evidence' : 'supported');
        selection.push({ type: 'test', id: run.id, label: c.title }); files.push({ itemId: file.id, sha256: sha256(bytes), size: bytes.length });
      }
      if (recipe.note) {
        const item = await saveItem(userId, workspaceId, { ...recipe.note, content: { kind: 'text', text: recipe.note.text }, threadId }, db,
          { provenance: { version: 1, origin: 'agent', producer: 'agent-authored', observedAt: null } });
        selection.push({ type: 'material', id: item.id, label: recipe.note.title });
      }
      const state = await observeEvidence(observer, workspaceId, runtime), seed = evidenceSeed(state, selection);
      validateEvidenceSeed(taskId, 'normal', seed, runtime, 'synthetic-golden');
      assert.equal(state.attempts.length + state.jobs.length + state.repositories.length + state.setups.length + state.missions.length, 0);
      Object.assign(trial, { state: 'prepared', selection, seed, seedHash: fingerprint(seed), reviews: state.reviews, files }); await onProgress(artifact);
    }
    for (const [path, hash] of Object.entries(artifact.authoringHashes)) assert.equal(sha256(await readFile(path)), hash, 'Preparation implementation changed during fixture writes');
    await assertExclusive(); artifact.completedAt = new Date().toISOString(); artifact.deterministicReviewerInvocations = modelFixtures;
    await onProgress(artifact); return artifact;
  } catch (error) {
    artifact.preparationFailed = true; await onProgress(artifact); throw error;
  } finally {
    await observer.end(); hooks.deregister(); delete globalThis[modelKey]; globalThis.fetch = previousFetch;
    if (previousReviewFlag === undefined) delete process.env.RESULT_REVIEW_ENABLED; else process.env.RESULT_REVIEW_ENABLED = previousReviewFlag;
  }
}
