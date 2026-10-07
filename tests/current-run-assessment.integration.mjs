import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { controllerFixture } from './helpers/mission-controller-fixture.mjs';

// Real isolated SQL and authored lookup/controller. Executor/model fixtures are
// synthetic; this proves lookup and continuation, not a live reviewer verdict.
const h = await controllerFixture(), { db, schema } = h;
const { readCurrentRunAssessment, listAssessments } = await import('../server/utils/result-assessments.ts');
const checks = [];
try {
  const f = await h.fixture(); await h.browserReady(f);
  const [run] = await h.finishBrowser(f); await h.pass(f); await h.workers(f);
  const exact = await readCurrentRunAssessment(f.workspace, run.id);
  assert.equal(exact.status, 'completed'); checks.push('exact current completed assessment');
  await db.update(schema.resultAssessments).set({ createdAt: new Date(0) }).where(eq(schema.resultAssessments.id, exact.id));
  await db.insert(schema.resultAssessments).values(Array.from({ length: 105 }, (_, index) => ({
    ...exact, id: randomUUID(), reviewerVersion: `historic-${index}`, createdAt: new Date(),
  })));
  const page = await listAssessments(h.owner, f.workspace);
  assert.equal(page.length, 100); assert.equal(page.some(row => row.id === exact.id), false);
  assert.equal((await readCurrentRunAssessment(f.workspace, run.id)).id, exact.id);
  const { readMissionSource } = await import('../server/utils/mission-sources.ts');
  assert.equal((await readMissionSource(db, f.workspace, 'test', run.id)).assessment.id, exact.id);
  checks.push('UI pagination cannot hide current run from controller lookup');
  const other = await h.fixture();
  assert.equal(await readCurrentRunAssessment(other.workspace, run.id), undefined);
  assert.equal(await readCurrentRunAssessment(f.workspace, randomUUID()), undefined);
  checks.push('foreign workspace and missing run excluded');
  await h.pass(f); await h.pass(f);
  const state = await h.state(f);
  assert.equal(state.attempts.find(a => a.kind === 'review').status, 'completed');
  checks.push('authored controller settles exact review despite over 100 newer historical rows');
  await db.update(schema.resultAssessments).set({ sourceHash: 'changed' }).where(eq(schema.resultAssessments.id, exact.id));
  assert.equal(await readCurrentRunAssessment(f.workspace, run.id), undefined);
  checks.push('stale source fingerprint never substitutes historical review');
} finally { await h.close(); }
console.log(JSON.stringify({ passed: checks.length, checks }));
