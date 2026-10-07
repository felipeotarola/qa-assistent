import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { isolatedApp } from './helpers/isolated-app.mjs';

process.env.PAT_RUNTIME_SCOPE += `-context-${randomUUID()}`;
const app = await isolatedApp(), { db, schema } = app;
const { workspaceContext } = await import('../server/utils/workspace-context.ts');
const { saveItem } = await import('../server/utils/workspaces.ts');
const { testRunAction } = await import('../server/utils/test-runs.ts');
const owner = randomUUID(), outsider = randomUUID(), workspaceId = randomUUID(), threadId = randomUUID(), otherWorkspaceId = randomUUID(), otherThreadId = randomUUID();
const checks = [];
try {
  await db.insert(schema.user).values([owner, outsider].map(id => ({ id, name: 'Context test', email: `${id}@example.test` })));
  await db.insert(schema.workspaces).values([{ id: workspaceId, userId: owner, name: 'Own context' }, { id: otherWorkspaceId, userId: outsider, name: 'Other context' }]);
  await db.insert(schema.threads).values([{ id: threadId, workspaceId, userId: owner, title: 'Own' }, { id: otherThreadId, workspaceId: otherWorkspaceId, userId: outsider, title: 'Other' }]);
  const testCase = { id: randomUUID(), title: 'Saved check', type: 'browser', steps: 'Read the heading', expected: 'Heading appears' };
  const plan = await saveItem(owner, workspaceId, { title: 'Plan', content: { kind: 'test_plan', cases: [testCase], sources: [] } });
  const foreign = await saveItem(outsider, otherWorkspaceId, { title: 'Private plan', content: { kind: 'test_plan', cases: [testCase], sources: [] } });
  const make = (offset, extra = {}) => ({ id: randomUUID(), workspaceId, threadId, itemId: plan.id, caseId: testCase.id, planVersion: 1, snapshot: testCase, environment: 'fixture', runtime: process.env.PAT_RUNTIME_SCOPE,
    requestId: randomUUID(), startedAt: new Date(Date.now() + offset * 1000), ...extra });
  const rows = Array.from({ length: 12 }, (_, i) => make(i, i % 2 ? { finishedAt: new Date(Date.now() + i * 1000 + 500), result: { schemaVersion: 2, outcome: 'passed', actual: 'PRIVATE RESULT BODY', checks: [], remaining: [], observations: [], evidenceItemIds: [] } } : {}));
  await db.insert(schema.testRuns).values([...rows, make(100, { runtime: 'other-runtime' }), make(101, { runtime: null }), make(102, { workspaceId: otherWorkspaceId, threadId: otherThreadId, itemId: foreign.id })]);
  const before = await app.sql`select count(*)::integer as count from pat_test_runs where workspace_id=${workspaceId}`;
  const context = await workspaceContext(owner, threadId);
  assert.equal(context.recentTestRuns.length, 10); assert.equal(context.testRunsTruncated, true);
  assert.deepEqual(context.recentTestRuns.map(row => row.id), rows.slice(2).reverse().map(row => row.id));
  checks.push('bounded newest-first discovery excludes foreign workspace, runtime and unscoped legacy rows');
  assert.equal(context.recentTestRuns[0].reportedOutcome, 'passed'); assert.equal(context.recentTestRuns[1].reportedOutcome, null);
  assert.ok(!JSON.stringify(context).includes('PRIVATE RESULT BODY'));
  assert.deepEqual(Object.keys(context.recentTestRuns[0]).sort(), ['id', 'itemId', 'caseId', 'planVersion', 'reportedOutcome', 'startedAt', 'finishedAt', 'reportSource', 'snapshotTitle'].sort());
  checks.push('index exposes reported outcome only; no result body, assessment or invented verification');
  await saveItem(owner, workspaceId, { id: plan.id, expectedVersion: plan.version, title: 'Renamed plan', content: { kind: 'test_plan', cases: [{ ...testCase, title: 'Changed current definition' }], sources: [] } });
  const afterRename = await workspaceContext(owner, threadId);
  assert.deepEqual(afterRename.recentTestRuns.map(run => run.snapshotTitle), Array(10).fill('Saved check'));
  assert.equal(new Set(afterRename.recentTestRuns.map(run => run.reportSource.id)).size, 10);
  assert.deepEqual(afterRename.recentTestRuns.map(run => run.reportSource), context.recentTestRuns.map(run => run.reportSource));
  checks.push('duplicate frozen case titles remain separate exact run identities after a current plan rename');
  for (const title of [123, { value: 'PRIVATE OBJECT' }, '', undefined, 'x'.repeat(301)]) {
    await db.update(schema.testRuns).set({ snapshot: { ...testCase, title } }).where(eq(schema.testRuns.id, rows.at(-1).id));
    assert.equal((await workspaceContext(owner, threadId)).recentTestRuns[0].snapshotTitle, null);
  }
  await db.update(schema.testRuns).set({ snapshot: testCase }).where(eq(schema.testRuns.id, rows.at(-1).id));
  checks.push('invalid or oversized legacy titles stay unresolved instead of coerced or truncated to a match');
  await assert.rejects(workspaceContext(outsider, threadId), e => e.statusCode === 404);
  await assert.rejects(workspaceContext(owner, otherThreadId), e => e.statusCode === 404);
  checks.push('cross-owner thread lookup denied');
  const listed = await testRunAction(owner, workspaceId, threadId, { action: 'list', itemId: plan.id });
  assert.equal(listed.length, 13);
  assert.equal(listed.filter(row => row.runtime === null).length, 1);
  assert.equal(listed.filter(row => row.runtime === process.env.PAT_RUNTIME_SCOPE).length, 12);
  checks.push('tool discovery excludes foreign runtime and preserves explicit unscoped historical results');
  assert.deepEqual(await app.sql`select count(*)::integer as count from pat_test_runs where workspace_id=${workspaceId}`, before);
  checks.push('context read does not start runs or change saved results');
  console.log(JSON.stringify({ checks, count: checks.length, proofLevel: 'actual isolated PostgreSQL; synthetic saved runs; no model' }));
} finally {
  try {
    for (const id of [workspaceId, otherWorkspaceId]) {
      await db.delete(schema.testRuns).where(eq(schema.testRuns.workspaceId, id));
      await db.delete(schema.threads).where(eq(schema.threads.workspaceId, id));
      await db.delete(schema.workspaces).where(eq(schema.workspaces.id, id));
    }
    await db.delete(schema.user).where(eq(schema.user.id, owner));
    await db.delete(schema.user).where(eq(schema.user.id, outsider));
  } finally { await app.close(); }
}
