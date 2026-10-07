import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { controllerFixture } from './helpers/mission-controller-fixture.mjs';

// PREPARED, not executed before integration. Actual isolated PG and authored
// module graph; explicitly synthetic history, no browser/model/worker calls.
assert.equal(process.env.GRUNDEN_API_TOKEN, '');
const h = await controllerFixture(), { db, schema } = h;
const { browserReturnContext } = await import('../server/utils/mission-browser-return.ts');
const { missionHash } = await import('../server/utils/mission-sources.ts');
const { buildReviewInput, enqueueReview, hashReview, listAssessments, readCurrentRunAssessment } = await import('../server/utils/result-assessments.ts');
const { REVIEWER_VERSION } = await import('../shared/result-assessment.ts');
const { runChecks } = await import('../shared/test-run.ts');
const passed = [];
async function check(name, fn) { await fn(); passed.push(name); }
try {
  const f = await h.fixture(), runtime = process.env.PAT_RUNTIME_SCOPE;
  const ids = Object.fromEntries(['case', 'task', 'prior', 'next', 'priorDispatch', 'nextDispatch', 'wait', 'assignment', 'session', 'claim', 'run'].map(k => [k, randomUUID()]));
  const origin = Date.now() - 30000, at = ms => new Date(origin + ms);
  const snapshot = { id: ids.case, title: 'Synthetic profile', type: 'browser', preconditions: '', steps: 'Read profile details.', expected: 'Profile details are visible.', entryUrl: 'https://controller.example.test/' };
  const plan = await h.saveItem(h.owner, f.workspace, { title: 'Synthetic history projection', content: { kind: 'test_plan', summary: '', cases: [snapshot], sources: [] } });
  const target = { url: snapshot.entryUrl, revision: 'synthetic-context-fixture', environment: 'isolated synthetic test' };
  const spec = { kind: 'browser_tests', caseKeys: [`${plan.id}:${ids.case}`], planVersions: [{ itemId: plan.id, version: plan.version }], target };
  const requestHash = missionHash({ spec, planRevision: 1, mandateRevision: 1 });
  await db.insert(schema.missionTasks).values({ id: ids.task, missionId: f.id, requestId: randomUUID(), title: 'Synthetic return task', actor: 'iris', criterionIds: [], dependsOn: [], planRevision: 1, state: 'completed', spec });
  const common = { missionId: f.id, taskId: ids.task, runtime, kind: 'browser_tests', operationId: `synthetic-return:${ids.task}`, requestHash, planRevision: 1, mandateRevision: 1, status: 'completed', reservedTokens: 0, reservedToolCalls: 0, deadlineAt: at(20000), leaseToken: null, leaseUntil: null, finishedAt: at(9000) };
  await db.insert(schema.missionAttempts).values([{ ...common, id: ids.prior, dispatchId: ids.priorDispatch, attemptNo: 1, createdAt: at(0) }, { ...common, id: ids.next, dispatchId: ids.nextDispatch, attemptNo: 2, createdAt: at(5000) }]);
  const receipt = { version: 1, waitId: ids.wait, sourceAttemptId: ids.prior, taskId: ids.task, assignmentId: ids.assignment, physicalSessionId: ids.session, claimId: ids.claim, sourceDispatchId: ids.priorDispatch, runtime, planRevision: 1, mandateRevision: 1, requestHash, policyDigest: 'a'.repeat(64), deadlineAt: at(20000).toISOString(), blockedRunId: null };
  await db.insert(schema.missionWaits).values({ id: ids.wait, missionId: f.id, waitKey: `synthetic:${ids.wait}`, definition: { reason: 'human_browser', taskIds: [ids.task], question: 'Synthetic return context', requestedAt: at(1000).toISOString(), deadlineAt: at(20000).toISOString(), planRevision: 1, mandateRevision: 1 }, state: 'answered', answer: { kind: 'browser_returned', sessionId: ids.session }, answerRequestId: randomUUID(), createdAt: at(1000), answeredAt: at(2020), deadlineAt: at(20000) });
  // Fixture-only durable rows; not a claim that an owner or browser actually acted.
  await db.insert(schema.missionEvents).values([
    { id: randomUUID(), missionId: f.id, revision: 1001, kind: 'browser_returned', eventKey: `browser-returned:${ids.wait}`, payload: { receipt }, createdAt: at(2000) },
    { id: randomUUID(), missionId: f.id, revision: 1002, kind: 'browser_return_handoff', eventKey: `browser-return-handoff:${ids.next}`, payload: { receipt, attemptId: ids.next, dispatchId: ids.nextDispatch, caseKeys: spec.caseKeys }, createdAt: at(5000) },
  ]);
  await db.insert(schema.testRuns).values({ id: ids.run, runtime, missionAttemptId: ids.next, workspaceId: f.workspace, itemId: plan.id, caseId: ids.case, planVersion: plan.version, snapshot, browserEntryReceipt: { version: 1, sessionId: ids.session, requestedUrl: snapshot.entryUrl, observedUrl: snapshot.entryUrl, observedAt: at(6500).toISOString(), callId: randomUUID() }, environment: target.environment, target, threadId: f.thread, requestId: randomUUID(), startedAt: at(6000), finishedAt: at(9000), result: { schemaVersion: 2, outcome: 'passed', actual: 'Synthetic profile appeared.', remaining: [], observations: [], evidenceItemIds: [], checks: runChecks(snapshot).map(r => ({ id: r.id, status: 'verified', actual: 'Synthetic profile appeared.' })) } });
  const scope = { workspaceId: f.workspace, threadId: f.thread, userId: h.owner, runtime, attemptId: ids.next }, expected = { version: 1, kind: 'human_returned_session', priorAuthentication: 'unknown' };
  let run = await h.row(schema.testRuns, ids.run), input, current;
  await check('actual module graph and JSONB return history produce only unknown authentication, without live resources', async () => {
    assert.equal(REVIEWER_VERSION, '19'); assert.deepEqual(await project(scope, run), expected);
    assert.deepEqual(await h.rows(schema.missionResourceClaims, f.id), []);
    assert.equal(await project({ ...scope, userId: randomUUID() }, run), undefined);
    assert.equal(await project({ ...scope, attemptId: ids.prior }), undefined);
  });
  await check('queued review JSONB and build/list/current lookup share the exact contextual fingerprint', async () => {
    input = await buildReviewInput(f.workspace, run.id); assert.deepEqual(input.browserSessionContext, expected); assert.deepEqual(input.evidence, []);
    assert.ok(input.ruleFindings.some(r => r.code === 'evidence_missing'));
    await db.transaction(tx => enqueueReview(tx, h.owner, f.workspace, run.id, f.thread));
    current = await readCurrentRunAssessment(f.workspace, run.id); assert.equal(current.status, 'queued'); assert.equal(current.sourceHash, hashReview(input)); assert.equal(hashReview(current.input), current.sourceHash);
    assert.equal((await listAssessments(h.owner, f.workspace, run.id)).find(r => r.id === current.id).stale, false);
  });
  await check('historical context and review stay current after later mission epoch and closed lifecycle', async () => {
    await db.update(schema.missions).set({ mandateRevision: 2, lifecycle: 'closed', phase: 'idle', status: 'closed', closedAt: new Date() }).where(eq(schema.missions.id, f.id));
    assert.deepEqual(await project(scope, run), expected); assert.equal(hashReview(await buildReviewInput(f.workspace, run.id)), current.sourceHash);
    assert.equal((await listAssessments(h.owner, f.workspace, run.id)).find(r => r.id === current.id).stale, false);
  });
  await check('substituted observed session invalidates current lookup without changing the historical input', async () => {
    const original = structuredClone(current.input);
    await db.update(schema.testRuns).set({ browserEntryReceipt: { ...run.browserEntryReceipt, sessionId: randomUUID() } }).where(eq(schema.testRuns.id, run.id));
    run = await h.row(schema.testRuns, run.id); assert.equal(await project(scope, run), undefined);
    assert.equal(await readCurrentRunAssessment(f.workspace, run.id), undefined);
    assert.equal((await listAssessments(h.owner, f.workspace, run.id)).find(r => r.id === current.id).stale, true);
    assert.deepEqual((await h.row(schema.resultAssessments, current.id)).input, original);
  });
  assert.deepEqual(h.calls, [], 'No controller/executor/model invoked by projection regression');
  function project(value, savedRun) { return browserReturnContext(db, value, savedRun); }
} finally { await h.close(); }
console.log(JSON.stringify({ passed: passed.length, checks: passed, database: 'actual isolated PostgreSQL', history: 'explicit synthetic rows', browserCalls: 0, modelCalls: 0 }));
