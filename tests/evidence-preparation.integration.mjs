import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { isolatedApp } from './helpers/isolated-app.mjs';
import { prepareGoldenEvidence } from './helpers/evidence-prepare.mjs';
import { validateGoldenArtifact, GOLDEN_LABEL } from './helpers/evidence-golden.mjs';
import { fingerprint } from './helpers/evidence-acceptance.mjs';
import { REVIEWER_VERSION } from '../shared/result-assessment.ts';

// Separate runtime and fresh synthetic user: cannot be seen by the running
// acceptance scheduler. Actual PG/files/worker, zero browser/provider calls.
const baseRuntime = process.env.PAT_RUNTIME_SCOPE;
process.env.PAT_RUNTIME_SCOPE = `${baseRuntime}-golden-${randomUUID()}`;
const runtime = process.env.PAT_RUNTIME_SCOPE, app = await isolatedApp(), { db, schema } = app, owner = randomUUID();
const checks = [], workspaces = [], filePaths = [];
async function check(name, action) { await action(); checks.push(name); }
try {
  await db.insert(schema.user).values({ id: owner, name: 'Synthetic golden preparation integration', email: `${owner}@example.test` });
  for (const taskId of ['REP-05', 'REP-06', 'REP-07']) {
    await check(`${taskId}: authored start/finish + actual bytes + reviewer6 worker + declared immutable preparation receipt`, async () => {
      const artifact = await prepareGoldenEvidence({ app, userId: owner, runtime, taskId, assertExclusive: async () => { assert.notEqual(runtime, baseRuntime); },
        onProgress: async value => { for (const trial of value.trials) if (!workspaces.includes(trial.workspaceId)) workspaces.push(trial.workspaceId); } });
      assert.equal(artifact.realProviderCalls, 0); assert.equal(artifact.realBrowserActions, 0); assert.equal(artifact.reviewerVersion, REVIEWER_VERSION);
      const trial = artifact.trials[0]; validateGoldenArtifact(artifact, { taskId, runtime, workspaceId: trial.workspaceId, seed: trial.seed, reviews: trial.reviews, reviewerVersion: REVIEWER_VERSION });
      assert.equal(trial.seedHash, fingerprint(trial.seed)); assert.ok(trial.reviews.every(r => r.input_hash && r.source_hash && ['synthetic-golden-reviewer', 'deterministic-rules'].includes(r.model)));
      const files = await db.select().from(schema.workspaceItems).where(and(eq(schema.workspaceItems.workspaceId, trial.workspaceId), sql`${schema.workspaceItems.blobPath} is not null`));
      const { get, workspaceStorageToken } = await import('../server/utils/evidence-storage.ts');
      for (const file of files) {
        filePaths.push(file.blobPath); const stored = await get(file.blobPath, { access: 'private', token: workspaceStorageToken() });
        assert.equal(stored.statusCode, 200); const text = await new Response(stored.stream).text(); assert.ok(text.includes(GOLDEN_LABEL));
      }
      assert.equal((await app.sql`select count(*)::int as n from pat_result_assessments where runtime=${runtime} and status in ('queued','running')`)[0].n, 0);
      assert.equal((await app.sql`select count(*)::int as n from pat_result_assessments where runtime=${runtime} and notification <> 'recorded'`)[0].n, 0);
    });
  }
} finally {
  const { del, workspaceStorageToken } = await import('../server/utils/evidence-storage.ts');
  // Exact new fixture owner only; preserve every ordinary acceptance workspace.
  const files = await app.sql`select i.blob_path from pat_workspace_items i join pat_workspaces w on w.id=i.workspace_id where w.user_id=${owner} and i.blob_path is not null`;
  for (const path of new Set([...filePaths, ...files.map(f => f.blob_path)])) await del(path, { token: workspaceStorageToken() });
  await app.sql`delete from pat_test_captures where run_id in (select id from pat_test_runs where workspace_id in (select id from pat_workspaces where user_id=${owner}))`;
  await db.delete(schema.user).where(eq(schema.user.id, owner)); await app.close();
}
console.log(JSON.stringify({ passed: checks.length, checks, model: 'deterministic preparation double', providerCalls: 0, database: 'actual isolated PostgreSQL', persistedAcceptanceInputs: false }));
