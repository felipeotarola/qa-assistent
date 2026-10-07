import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { isolatedApp } from './helpers/isolated-app.mjs';
import { readIsolationFixture } from './helpers/autonomy-isolation.mjs';
import { prepareSyntheticRegressionHistory, regressionPlan, regressionPlanTitle, validateRegressionHistory } from './helpers/browser-variants-regression.mjs';

const master = await readIsolationFixture();
assert.equal(process.env.DATABASE_URL, master.databaseUrl); assert.equal(process.env.GRUNDEN_API_TOKEN, '');
process.env.PAT_RUNTIME_SCOPE = `${master.runtimeScope}-regression-prepare-${randomUUID()}`;
const fixture = { ...master, runtimeScope: process.env.PAT_RUNTIME_SCOPE }, app = await isolatedApp(), { db, schema } = app;
const owner = randomUUID(), other = randomUUID(), checks = [], fetchBefore = globalThis.fetch;
globalThis.fetch = () => { throw new Error('Fixture preparation test forbids HTTP and model calls'); };
try {
  await db.insert(schema.user).values([{ id: owner, name: 'Regression fixture preparation', email: `${owner}@example.test` }, { id: other, name: 'Other isolated fixture owner', email: `${other}@example.test` }]);
  const { saveItem } = await import('../server/utils/workspaces.ts');
  const workspaceId = randomUUID(), threadId = randomUUID();
  await db.insert(schema.workspaces).values({ id: workspaceId, userId: owner, name: 'Synthetic WEB04 preparation integration' });
  await db.insert(schema.threads).values({ id: threadId, workspaceId, userId: owner, title: 'Declared synthetic preparation' });
  const beforeContent = regressionPlan(undefined, 'a'), afterContent = regressionPlan(beforeContent.cases.map(row => row.id), 'b');
  const options = { provenance: { version: 1, origin: 'user', producer: 'user-authored', observedAt: null } };
  const old = await saveItem(owner, workspaceId, { title: regressionPlanTitle, content: beforeContent }, db, options);
  const plan = await saveItem(owner, workspaceId, { id: old.id, title: regressionPlanTitle, expectedVersion: 1, content: afterContent }, db, options);
  const input = { fixture, workspaceId, threadId, userId: owner, plan, beforeContent, afterContent, fixtureSourceHash: 'a'.repeat(64) };
  await assert.rejects(prepareSyntheticRegressionHistory({ ...input, userId: other }), /exact owned fresh/); checks.push('Another owner cannot seed history into this workspace');
  const preparation = await prepareSyntheticRegressionHistory(input);
  const stored = [...await app.sql`select id,item_id,case_id,plan_version,snapshot,target,runtime,result,started_at,finished_at,mission_attempt_id from pat_test_runs where workspace_id=${workspaceId} order by case_id`];
  // The test client parses timestamps differently; use the writer's canonical
  // JSON receipt for the immutable-history validator and compare SQL identities.
  assert.deepEqual(stored.map(row => [row.id, row.plan_version, row.runtime, row.mission_attempt_id]), preparation.runs.map(row => [row.id, 1, fixture.runtimeScope, null]));
  assert.equal(validateRegressionHistory({ runs: preparation.runs, captures: [] }, preparation).length, 2);
  assert.equal(preparation.realModelCalls + preparation.realBrowserActions + preparation.fabricatedReviews, 0);
  const counts = await app.sql`select (select count(*) from pat_missions where workspace_id=${workspaceId})::int as missions,
    (select count(*) from pat_result_assessments where workspace_id=${workspaceId})::int as reviews,
    (select count(*) from pat_test_captures c join pat_test_runs r on c.run_id=r.id where r.workspace_id=${workspaceId})::int as captures`;
  assert.deepEqual(counts[0], { missions: 0, reviews: 0, captures: 0 }); checks.push('Actual versioned SQL preparation creates only two explicitly synthetic unreviewed runs');
  await assert.rejects(prepareSyntheticRegressionHistory(input), /precede every mission\/run\/review/); checks.push('Repeated preparation cannot duplicate or overwrite original history');
  assert.equal((await app.sql`select count(*)::int as n from pat_test_runs where workspace_id=${workspaceId}`)[0].n, 2);
} finally {
  await db.delete(schema.user).where(eq(schema.user.id, owner)); await db.delete(schema.user).where(eq(schema.user.id, other));
  globalThis.fetch = fetchBefore; await app.close();
}
console.log(JSON.stringify({ passed: checks.length, checks, database: 'actual isolated PostgreSQL', realProviderCalls: 0, realBrowserActions: 0, fabricatedReviews: 0, acceptanceRun: false }));
