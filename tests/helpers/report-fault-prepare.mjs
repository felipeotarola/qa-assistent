import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import postgres from 'postgres';
import { and, eq } from 'drizzle-orm';
import { prepareGoldenEvidence } from './evidence-prepare.mjs';
import { GOLDEN_LABEL, goldenResult } from './evidence-golden.mjs';
import { REPORT_FAULT_PREPARATION, reportFaultVariants } from './report-fault-contract.mjs';
import { evidenceSeed, fingerprint, sha256 } from './evidence-acceptance.mjs';
import { observeEvidence } from './evidence-observer.mjs';
import { assertIsolatedDatabaseUrl } from './autonomy-isolation.mjs';
import { utcObservationTypes } from './utc-postgres-observation.mjs';

/** Explicit synthetic preparation only. Needs an externally owned stopped
 * runtime window. Never changes preserved evidence, invokes a provider or runs
 * the acceptance controller. Every added fault datum gets a fresh identity. */
export async function prepareReportFaultEvidence(options) {
  const { app, userId, runtime, taskId, assertExclusive, onProgress = async () => {} } = options;
  assert.ok(reportFaultVariants[taskId]); assert.equal(options.repetitions, 3);
  const artifact = await prepareGoldenEvidence({ ...options, onProgress: async () => {} });
  artifact.protocol = REPORT_FAULT_PREPARATION; artifact.variant = reportFaultVariants[taskId];
  artifact.basePreparationCompletedAt = artifact.completedAt; delete artifact.completedAt;
  artifact.authoringHashes['tests/helpers/report-fault-prepare.mjs'] = sha256(await readFile('tests/helpers/report-fault-prepare.mjs'));
  const sql = postgres(assertIsolatedDatabaseUrl(process.env.DATABASE_URL), { prepare: false, max: 1, types: utcObservationTypes, connection: { TimeZone: 'UTC', default_transaction_read_only: 'on' } });
  const { db, schema } = app;
  const oldFetch = globalThis.fetch, oldReview = process.env.RESULT_REVIEW_ENABLED;
  globalThis.fetch = async () => { throw new Error('Report fault preparation forbids HTTP/model calls'); };
  process.env.RESULT_REVIEW_ENABLED = 'false';
  try {
    const { saveItem, saveFile } = await import('../../server/utils/workspaces.ts');
    const { testRunAction } = await import('../../server/utils/test-runs.ts');
    const { requestReview } = await import('../../server/utils/result-assessments.ts');
    const { processReviewQueue } = await import('../../server/utils/result-review-worker.ts');
    for (const trial of artifact.trials) {
      await assertExclusive();
      const { workspaceId, threadId } = trial;
      if (taskId === 'REP-06') {
        const item = await saveItem(userId, workspaceId, { title: 'Sparad versionsanteckning – separat sidobservation', threadId,
          content: { kind: 'text', text: `${GOLDEN_LABEL}\nSeparat syntetisk sidobservation: version B visar huvudrubriken. Den styrker inte att äldre navigation eller okänd version gäller B.` } }, db,
        { provenance: { version: 1, origin: 'tool', producer: 'research-page', sourceType: 'research', observedAt: new Date().toISOString(), url: 'https://evidence-fixture.example.test/version' } });
        trial.selection.push({ type: 'material', id: item.id, label: item.title });
        trial.mutation = { itemId: item.id, version: item.version, contentHash: fingerprint(item.content), replacementText: 'SYNTHETIC FAULT SOURCE EDIT: Ägaren ändrade versionsanteckningen efter rapportens läsning. Den gamla observationen får inte redovisas som aktuell.' };
      }
      if (taskId === 'REP-07') {
        const donorId = trial.selection.find(ref => ref.type === 'test').id;
        const c = { title: 'Inloggning – observation med avsiktligt fel körningskoppling', outcome: 'failed', observation: 'Navigation stannade på startsidan. Ingen inloggning är verifierad.' };
        const testCase = { id: randomUUID(), title: c.title, type: 'browser', preconditions: GOLDEN_LABEL, steps: 'Klicka på Logga in.', expected: 'Inloggningssidan öppnas.' };
        const plan = await saveItem(userId, workspaceId, { title: `${c.title} – testplan`, content: { kind: 'test_plan', sources: [], cases: [testCase] } });
        const target = trial.seed.runs[0].target;
        const run = await testRunAction(userId, workspaceId, threadId, { action: 'start', requestId: randomUUID(), itemId: plan.id, caseId: testCase.id, expectedVersion: plan.version, target, environment: target.environment });
        const bytes = Buffer.from(`${GOLDEN_LABEL}\n${c.observation}\nAvsiktligt fel runId i fixtureproveniens, ingen faktisk webbkörning.`);
        const file = await saveFile(userId, workspaceId, 'synthetic-wrong-run.txt', 'text/plain', bytes, threadId, db,
          { provenance: { version: 1, origin: 'tool', producer: 'test-capture', sourceType: 'test', sourceId: donorId, observedAt: new Date().toISOString(), url: target.url } });
        await db.insert(schema.testCaptures).values({ id: randomUUID(), runId: run.id, itemId: file.id, title: `${GOLDEN_LABEL} wrong-run`, url: target.url, action: 'inspect' });
        await testRunAction(userId, workspaceId, threadId, { action: 'finish', runId: run.id, result: goldenResult(c, run.checks, file.id) });
        await requestReview(userId, workspaceId, run.id); await processReviewQueue(); // Structural no-independent-evidence path; network is forbidden above.
        const [review] = await db.select().from(schema.resultAssessments).where(and(eq(schema.resultAssessments.runId, run.id), eq(schema.resultAssessments.runtime, runtime)));
        assert.equal(review?.status, 'completed'); assert.equal(review.model, 'deterministic-rules'); assert.equal(review.assessment.verdict, 'needs_evidence');
        trial.selection.push({ type: 'test', id: run.id, label: c.title });
        trial.files.push({ itemId: file.id, sha256: sha256(bytes), size: bytes.length });
        trial.wrongRun = { itemId: file.id, registeredRunId: run.id, claimedRunId: donorId, contentHash: fingerprint(file.content) };
      }
      const state = await observeEvidence(sql, workspaceId, runtime);
      trial.seed = evidenceSeed(state, trial.selection); trial.seedHash = fingerprint(trial.seed); trial.reviews = state.reviews;
      await onProgress(artifact);
    }
    await assertExclusive(); artifact.completedAt = new Date().toISOString(); await onProgress(artifact); return artifact;
  } catch (error) { artifact.preparationFailed = true; await onProgress(artifact); throw error; }
  finally { globalThis.fetch = oldFetch; if (oldReview === undefined) delete process.env.RESULT_REVIEW_ENABLED; else process.env.RESULT_REVIEW_ENABLED = oldReview; await sql.end(); }
}
