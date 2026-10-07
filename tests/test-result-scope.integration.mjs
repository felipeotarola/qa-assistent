import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { isolatedApp } from './helpers/isolated-app.mjs';
import { runChecks } from '../shared/test-run.ts';
import original from './fixtures/run-checks-inline-parenthesis.mjs';

// Actual PostgreSQL + authored persistence/read/review-input services. No browser
// or model executes; these observations are explicitly synthetic test fixtures.
process.env.PAT_RUNTIME_SCOPE = `${process.env.PAT_RUNTIME_SCOPE}-result-scope-${randomUUID()}`;
process.env.RESULT_REVIEW_ENABLED = 'false';
const app = await isolatedApp(), { db, schema } = app;
const { saveItem } = await import('../server/utils/workspaces.ts');
const { testRunAction } = await import('../server/utils/test-runs.ts');
const { readMissionSource } = await import('../server/utils/mission-sources.ts');
const { buildReviewInput } = await import('../server/utils/result-assessments.ts');
const owner = randomUUID(), workspace = randomUUID(), thread = randomUUID();
const passed = [], failed = [];
async function check(name, fn) { try { await fn(); passed.push(name); } catch (error) { failed.push({ name, message: error.message }); console.error(error); } }
const row = async id => (await db.select().from(schema.testRuns).where(eq(schema.testRuns.id, id)))[0];
const call = action => testRunAction(owner, workspace, thread, action);
const finish = (run, result) => call({ action: 'finish', runId: run.id, result });
const reject = (promise, code = 400) => assert.rejects(promise, error => error.statusCode === code);
let plan;
const target = { environment: 'QA fixture', url: 'https://result-scope.example.test/', revision: 'fixture-commit' };
const start = () => call({ action: 'start', itemId: plan.id, caseId: plan.content.cases[0].id, expectedVersion: plan.version, requestId: randomUUID(), environment: target.environment, target });
function complete(run) { return { schemaVersion: 2, outcome: 'passed', actual: 'Synthetic observations: all original checks covered.', checks: runChecks(run.snapshot).map(check => ({ id: check.id, status: 'verified', actual: 'Synthetic observed check.' })), remaining: [], observations: [], evidenceItemIds: [] }; }
try {
  await db.insert(schema.user).values({ id: owner, name: 'Result scope fixture', email: `${owner}@example.test` });
  await db.insert(schema.workspaces).values({ id: workspace, userId: owner, name: 'Result scope fixture' });
  await db.insert(schema.threads).values({ id: thread, userId: owner, workspaceId: workspace, title: 'Result scope fixture' });
  plan = await saveItem(owner, workspace, { title: 'Fixture plan', content: { kind: 'test_plan', sources: [], cases: [{ id: randomUUID(), title: 'Search flow', type: 'browser', preconditions: 'At home', steps: '1. Open search.\n2. Search.\n3. Open result.', expected: 'The selected result is shown.' }] } });

  assert.equal(plan.content.cases[0].checksVersion, 2);
  assert.deepEqual(runChecks(plan.content.cases[0]).map(check => check.id), ['preconditions', 'step-1', 'step-2', 'step-3', 'expected']);
  assert.equal(runChecks(plan.content.cases[0])[2].requirement, '2. Search.');

  await check('raw legacy START remains frozen while ordinary save creates a line-parser version', async () => {
    // Reuse exact saved requirement text; all results below are synthetic and
    // belong to this suite's temporary workspace, never the original QA run.
    const itemId = randomUUID(), legacy = { kind: 'test_plan', summary: 'Legacy parser fixture', sources: [], cases: [structuredClone(original.snapshot)] };
    const callerBefore = structuredClone(legacy);
    await db.insert(schema.workspaceItems).values({ id: itemId, workspaceId: workspace, title: 'Legacy parser fixture', content: legacy });
    await db.insert(schema.workspaceItemVersions).values({ id: randomUUID(), itemId, version: 1, title: 'Legacy parser fixture', content: legacy });
    const action = { action: 'start', itemId, caseId: legacy.cases[0].id, expectedVersion: 1, requestId: randomUUID(), environment: target.environment, target };
    const oldRun = await call(action);
    assert.deepEqual(oldRun.snapshot, original.snapshot);
    assert.equal(Object.hasOwn(oldRun.snapshot, 'checksVersion'), false);
    assert.deepEqual(oldRun.checks, [...original.legacySteps.map((requirement, index) => ({ id: 'step-' + (index + 1), requirement })), { id: 'expected', requirement: original.snapshot.expected }]);
    const oldResult = complete(oldRun);
    await finish(oldRun, oldResult);
    const oldSaved = await row(oldRun.id);
    const updated = await saveItem(owner, workspace, { id: itemId, expectedVersion: 1, title: 'Legacy parser fixture', content: legacy });
    assert.equal(updated.version, 2);
    assert.deepEqual(updated.content, { ...legacy, cases: [{ ...original.snapshot, checksVersion: 2 }] });
    assert.deepEqual(legacy, callerBefore, 'Saving must not change caller text or stamp its old case');
    const versions = await db.select().from(schema.workspaceItemVersions).where(eq(schema.workspaceItemVersions.itemId, itemId));
    assert.deepEqual(versions.find(version => version.version === 1).content, callerBefore);
    assert.deepEqual(versions.find(version => version.version === 2).content, updated.content);
    const newRun = await call({ ...action, expectedVersion: 2, requestId: randomUUID() });
    assert.deepEqual(newRun.snapshot, updated.content.cases[0]);
    assert.deepEqual(newRun.checks, [...original.snapshot.steps.split('\n').map((requirement, index) => ({ id: 'step-' + (index + 1), requirement })), { id: 'expected', requirement: original.snapshot.expected }]);
    assert.equal(newRun.checks.length, 6);
    assert.equal(newRun.checks[4].requirement, original.snapshot.steps.split('\n')[4]);
    const newResult = complete(newRun);
    newResult.checks.push({ id: 'step-6', status: 'verified', actual: 'A legacy-only split must not enter the new receipt.' });
    await reject(finish(newRun, newResult));
    assert.equal((await row(newRun.id)).result, null);
    await finish(newRun, complete(newRun));
    assert.equal((await call(action)).id, oldRun.id);
    assert.deepEqual((await call(action)).snapshot, original.snapshot);
    assert.deepEqual(await row(oldRun.id), oldSaved, 'New save/START/FINISH must not rewrite the old immutable run');
    assert.deepEqual((await buildReviewInput(workspace, oldRun.id, db)).requirements, oldRun.checks);
    assert.deepEqual((await buildReviewInput(workspace, newRun.id, db)).requirements, newRun.checks);
    assert.equal((await db.select().from(schema.resultAssessments).where(eq(schema.resultAssessments.workspaceId, workspace))).length, 0);
  });

  await check('v2 persists and serialized FINISH replays the identical immutable receipt', async () => {
    const run = await start(), result = { ...complete(run), suggestedFollowUps: ['A separate accessibility test may be useful.'] };
    const first = await finish(run, result), replay = await finish(run, JSON.stringify(result));
    assert.deepEqual(first, replay); assert.deepEqual((await row(run.id)).result, result);
    assert.ok(!('unverified' in first.result));
    await reject(finish(run, { ...result, suggestedFollowUps: ['Changed later'] }), 409);
  });
  await check('missing original checks cannot persist as complete despite remaining empty', async () => {
    const run = await start(), result = complete(run); result.outcome = 'failed'; result.checks.splice(2, 1);
    result.suggestedFollowUps = ['Do the missing search later.'];
    await reject(finish(run, result)); assert.equal((await row(run.id)).result, null);
  });
  await check('typed incomplete scope persists as a source limitation while optional ideas create no work', async () => {
    const run = await start(), result = complete(run); result.outcome = 'inconclusive'; result.checks[2].status = 'blocked';
    result.remaining = [{ checkId: result.checks[2].id, reason: 'Search interaction was not observed.' }];
    result.suggestedFollowUps = ['A separate mobile test may be useful.'];
    await finish(run, result);
    const source = await readMissionSource(db, workspace, 'test', run.id);
    assert.ok(source.limitations.includes(`${result.checks[2].id}: Search interaction was not observed.`));
    assert.ok(!JSON.stringify(source).includes('separate mobile'));
    assert.equal((await db.select().from(schema.missionTasks)).filter(task => task.title.includes('mobile')).length, 0);
    assert.equal((await db.select().from(schema.resultAssessments).where(eq(schema.resultAssessments.workspaceId, workspace))).length, 0);
    const review = await buildReviewInput(workspace, run.id, db);
    assert.deepEqual(review.reportedResult, result);
    assert.ok(review.ruleFindings.some(finding => finding.code === 'coverage_incomplete' && finding.requirementId === result.checks[2].id));
  });
  await check('remaining/check mismatch and mixed legacy-v2 payloads never write a result', async () => {
    for (const mutate of [result => { result.checks[1].status = 'unverified'; }, result => { result.unverified = 'Inget. Alla fem steg verifierades.'; }, result => { result.remaining = [{ checkId: 'invented', reason: 'None' }]; }]) {
      const run = await start(), result = complete(run); mutate(result);
      await reject(finish(run, result)); assert.equal((await row(run.id)).result, null);
    }
  });
  await check('a reported defect is persistable but still has no independent review proof', async () => {
    const run = await start(), result = complete(run); result.outcome = 'failed'; result.checks.at(-1).status = 'mismatch';
    result.observations = [{ title: 'Wrong result', detail: 'Synthetic mismatching detail.', kind: 'defect' }];
    await finish(run, result);
    const review = await buildReviewInput(workspace, run.id, db);
    assert.ok(!review.ruleFindings.some(finding => finding.code === 'coverage_incomplete'));
    assert.ok(review.ruleFindings.some(finding => finding.code === 'evidence_missing'));
    assert.equal((await row(run.id)).result.outcome, 'failed');
  });
  await check('historical prose is preserved verbatim without optimistic language classification', async () => {
    const run = await start(), legacy = { outcome: 'inconclusive', actual: 'Legacy saved observation.', unverified: 'Inget. Alla fem steg verifierades.', observations: [], evidenceItemIds: [] };
    await finish(run, legacy); await finish(run, JSON.stringify(legacy));
    assert.deepEqual((await row(run.id)).result, legacy);
    const source = await readMissionSource(db, workspace, 'test', run.id);
    assert.ok(source.limitations.includes(legacy.unverified));
    assert.equal('schemaVersion' in (await row(run.id)).result, false);
  });
} finally {
  await db.delete(schema.user).where(eq(schema.user.id, owner)); await app.close();
}
console.log(JSON.stringify({ passed, failed }, null, 2));
if (failed.length) process.exitCode = 1;
