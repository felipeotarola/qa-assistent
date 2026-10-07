import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { hash } from './browser-variants-protocol.mjs';
import { assertIsolatedDatabaseUrl, isolatedProcessEnvironment } from './autonomy-isolation.mjs';
import { utcObservationTypes } from './utc-postgres-observation.mjs';
import { testPlanSchema } from '../../shared/test-plan.ts';
import { runChecks, runResultV2Schema } from '../../shared/test-run.ts';

export const regressionHistoryLabel = 'SYNTHETIC WEB04 HISTORY — fixture preparation only; no browser, agent or reviewer executed';
export const regressionPlanTitle = 'Besöksinformation – valt regressionsurval';
export const regressionOrigin = 'http://qa-regression.test';
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, canonical(child)])) : value;
export const regressionFingerprint = value => hash(JSON.stringify(canonical(JSON.parse(JSON.stringify(value)))));
const historyRow = row => Object.fromEntries(['id', 'item_id', 'case_id', 'plan_version', 'snapshot', 'target', 'runtime', 'result', 'started_at', 'finished_at', 'mission_attempt_id'].map(key => [key, row[key]]));

export function regressionPlan(caseIds = [randomUUID(), randomUUID()], version = 'b') {
  assert.ok(['a', 'b'].includes(version)); assert.equal(caseIds.length, 2);
  return testPlanSchema.parse({ kind: 'test_plan', summary: `Två valda ursprungliga krav. Webbversion ${version.toUpperCase()}. Tidigare resultat är separat markerad syntetisk fixturehistorik, inte körbevis.`, cases: [
    { id: caseIds[0], title: 'Tillbaka från låneinformationen', type: 'browser', entryUrl: `${regressionOrigin}/regression/${version}`, preconditions: '',
      steps: '1. Öppna Låna böcker från Besöksinformation.\n2. Klicka på Tillbaka till besöksinformation.', expected: 'Låneinformationen visar fyra veckors lånetid. Returlänken visar Besöksinformation med länkarna Låna böcker och Kontakt.' },
    { id: caseIds[1], title: 'Kontaktuppgifter', type: 'browser', entryUrl: `${regressionOrigin}/regression/${version}`, preconditions: '',
      steps: '1. Klicka på Kontakt från Besöksinformation.', expected: 'Kontaktsidan visar besok@linden.example.test.' },
  ], sources: [] });
}

export function syntheticRegressionResult(testCase, index) {
  assert.ok([0, 1].includes(index));
  const actual = index === 0 ? 'Version A: lånesidan visades, men returlänken gav 404.' : 'Version A: kontaktsidan visade besok@linden.example.test.';
  return runResultV2Schema.parse({ schemaVersion: 2, outcome: index === 0 ? 'failed' : 'passed', actual: `${regressionHistoryLabel}\n${actual}`,
    observations: [{ title: 'Syntetisk förberedelse', detail: regressionHistoryLabel, kind: 'note' }], evidenceItemIds: [],
    checks: runChecks(testCase).map(check => ({ id: check.id, status: index === 0 && check.id !== 'step-1' ? 'mismatch' : 'verified', actual: `${regressionHistoryLabel}\n${actual}` })), remaining: [] });
}

/** The ONLY DB-writing path in this family. Explicit preparation before any
 * mission; it is never an owner API receipt or historical agent execution.
 * Plan A/B are created through the real owner API by the caller first. */
export async function prepareSyntheticRegressionHistory({ fixture, workspaceId, threadId, userId, plan, beforeContent, afterContent, fixtureSourceHash }) {
  const databaseUrl = assertIsolatedDatabaseUrl(fixture.databaseUrl); isolatedProcessEnvironment(fixture);
  for (const value of [workspaceId, threadId, userId, plan.id]) assert.match(value, /^[a-f0-9-]{36}$/i);
  assert.match(fixtureSourceHash, /^[a-f0-9]{64}$/); assert.equal(plan.version, 2);
  assert.deepEqual(beforeContent, regressionPlan(beforeContent.cases.map(row => row.id), 'a'));
  assert.deepEqual(afterContent, regressionPlan(beforeContent.cases.map(row => row.id), 'b'));
  const { default: postgres } = await import('postgres');
  const sql = postgres(databaseUrl, { prepare: false, max: 1, types: utcObservationTypes, connection: { TimeZone: 'UTC' } });
  try {
    return await sql.begin('isolation level serializable', async db => {
      await db`select pg_advisory_xact_lock(hashtextextended(${`workspace-content:${workspaceId}`},0))`;
      const owners = await db`select w.id from pat_workspaces w join pat_threads t on t.workspace_id=w.id where w.id=${workspaceId} and w.user_id=${userId} and t.id=${threadId} and t.user_id=${userId}`;
      assert.equal(owners.length, 1, 'Synthetic history requires the exact owned fresh workspace/thread');
      for (const table of ['pat_missions', 'pat_test_runs', 'pat_result_assessments']) {
        const existing = await db`select count(*)::int as count from ${db(table)} where workspace_id=${workspaceId}`;
        assert.equal(existing[0].count, 0, 'History preparation must precede every mission/run/review');
      }
      const items = await db`select id,title,content,version,provenance from pat_workspace_items where workspace_id=${workspaceId} and deleted_at is null`;
      assert.equal(items.length, 1, 'Undeclared material exists before preparation');
      assert.equal(items[0].id, plan.id); assert.equal(items[0].title, regressionPlanTitle); assert.equal(items[0].version, 2);
      assert.deepEqual(items[0].content, afterContent); assert.equal(items[0].provenance.origin, 'user');
      const versions = [...await db`select version,content from pat_workspace_item_versions where item_id=${plan.id} order by version`];
      assert.deepEqual(versions, [{ version: 1, content: beforeContent }, { version: 2, content: afterContent }]);
      const [clock] = await db`select clock_timestamp()::text as at`;
      const target = { environment: 'Synthetic fixture history', url: `${regressionOrigin}/regression/a`, revision: `fixture-${fixtureSourceHash}-A` };
      for (const [index, testCase] of beforeContent.cases.entries()) {
        await db`insert into pat_test_runs(id,workspace_id,item_id,case_id,plan_version,snapshot,environment,target,thread_id,request_id,result,runtime,started_at,finished_at)
          values(${randomUUID()},${workspaceId},${plan.id},${testCase.id},1,${db.json(testCase)},${target.environment},${db.json(target)},${threadId},${randomUUID()},${db.json(syntheticRegressionResult(testCase,index))},${fixture.runtimeScope},${clock.at}::timestamptz,${clock.at}::timestamptz)`;
      }
      const runs = [...await db`select id,item_id,case_id,plan_version,snapshot,target,runtime,result,started_at,finished_at,mission_attempt_id from pat_test_runs where workspace_id=${workspaceId} order by case_id`];
      return { protocol: 'browser-variants-synthetic-regression-v1', preparation: 'synthetic-unreviewed-history', label: regressionHistoryLabel,
        workspaceId, threadId, userId, planId: plan.id, caseKeys: afterContent.cases.map(row => `${plan.id}:${row.id}`), currentPlanVersion: 2,
        beforeContent, afterContent, runs, historySha256: regressionFingerprint(runs), fixtureSourceHash, preparedAt: new Date(clock.at).toISOString(), realBrowserActions: 0, realModelCalls: 0, fabricatedReviews: 0 };
    });
  } finally { await sql.end(); }
}

export function validateRegressionHistory(state, preparation) {
  assert.equal(preparation.protocol, 'browser-variants-synthetic-regression-v1'); assert.equal(preparation.preparation, 'synthetic-unreviewed-history');
  assert.equal(preparation.realBrowserActions + preparation.realModelCalls + preparation.fabricatedReviews, 0);
  const old = state.runs.filter(run => preparation.runs.some(previous => previous.id === run.id));
  assert.equal(regressionFingerprint(old.map(historyRow).sort((a, b) => a.case_id.localeCompare(b.case_id))), preparation.historySha256, 'Original fixture history was changed/deleted');
  assert.ok(old.every(run => run.plan_version === 1 && run.mission_attempt_id === null && run.result.actual.includes(regressionHistoryLabel)
    && run.result.evidenceItemIds.length === 0), 'Synthetic preparation was upgraded into execution proof');
  assert.ok(!state.captures.some(row => old.some(run => row.run_id === run.id)), 'Synthetic history acquired fabricated physical evidence');
  return old;
}

export function regressionEditCandidate(state, preparation) {
  const mission = state.missions[0];
  if (state.missions.length !== 1 || mission.lifecycle === 'closed' || state.attempts.some(row => row.kind === 'browser_tests')) return null;
  const task = state.tasks.find(row => row.spec?.kind === 'browser_tests' && row.state === 'pending'
    && regressionFingerprint(row.spec.caseKeys.slice().sort()) === regressionFingerprint(preparation.caseKeys.slice().sort())
    && row.spec.planVersions?.some(plan => plan.itemId === preparation.planId && plan.version === 2));
  return task ? { missionId: mission.id, taskId: task.id, mandateRevision: mission.mandate_revision, planRevision: mission.plan_revision } : null;
}

export function auditRegression(state, preparation, { variant, fault, independent, reportBinding }) {
  const old = validateRegressionHistory(state, preparation), current = state.runs.filter(run => !old.some(previous => previous.id === run.id));
  const mission = state.missions[0]; assert.equal(state.missions.length, 1); assert.equal(mission.admission.intent, 'regression');
  assert.deepEqual([...mission.admission.caseKeys].sort(), [...preparation.caseKeys].sort(), 'The natural request did not select the declared original plan');
  const version = state.versions.find(row => row.item_id === preparation.planId && row.version === 2);
  assert.ok(version); assert.deepEqual(version.content, preparation.afterContent);
  assert.equal(mission.lifecycle, 'closed'); assert.equal(mission.lease_until, null);
  assert.ok(state.attempts.every(row => ['completed', 'failed', 'cancelled'].includes(row.status) && row.finished_at && !row.lease_until), 'An attempt is still live');
  assert.ok(state.jobs.every(row => ['completed', 'failed', 'cancelled'].includes(row.status) && !row.dispatch_lease_until), 'A browser job is still live');
  const report = reportBinding?.final ?? state.reports[0];
  if (!reportBinding) assert.equal(state.reports.length, 1);
  assert.equal(report.status, 'completed'); assert.equal(report.lease_until, null);
  if (!reportBinding) assert.deepEqual(state.reportItems.map(row => [row.id, row.version, row.deleted_at]), [[report.item_id, 1, null]]);
  assert.equal(state.claims.length, 0, 'Regression left physical resources claimed');
  if (variant === 'normal') {
    assert.ok(current.length && current.every(run => run.plan_version === 2 && run.mission_attempt_id && run.target.url === `${regressionOrigin}/regression/b`), 'New QA did not use plan B and its own bounded attempts');
    for (const run of current) assert.deepEqual(run.snapshot, preparation.afterContent.cases.find(row => row.id === run.case_id), 'Original selected requirement changed');
    assert.ok(report?.document);
    const prose = JSON.stringify(report.document);
    assert.ok(/synteti/i.test(prose), 'Report failed to disclose synthetic historical input');
    assert.ok(old.every(run => prose.includes(run.id)), 'Report did not identify the historical results used for comparison');
  } else if (variant === 'plan-changed') {
    assert.ok(fault?.planEditedAt && fault.expectedVersion === 2 && fault.savedVersion === 3, 'Required ordinary plan edit did not occur');
    assert.equal(current.length, 0, 'Changed selected plan was executed after the frozen edit boundary');
    const changed = state.versions.find(row => row.item_id === preparation.planId && row.version === 3);
    assert.ok(changed && regressionFingerprint(changed.content) === fault.savedContentSha256, 'The declared owner edit was not saved as version 3');
    assert.ok(report?.document.partial, 'Changed plan must be an explicit incomplete delivery');
    assert.ok(['blocked', 'deadline', 'budget_exhausted'].includes(mission.closure_reason));
  } else if (variant === 'stop-independent') {
    assert.ok(fault?.cancelledAt && fault.command?.action === 'cancel', 'Required normal owner cancellation was not observed');
    assert.equal(mission.closure_reason, 'cancelled');
    assert.ok(!state.attempts.some(row => row.kind !== 'report' && Date.parse(row.created_at) > Date.parse(fault.cancelledAt)), 'New logical attempt reserved after cancellation');
    assert.ok(independent?.verified && independent.userId !== preparation.userId && independent.workspaceId !== preparation.workspaceId && Date.parse(independent.closedAt) > Date.parse(fault.cancelledAt), 'Independent other-owner mission did not continue to completion');
    assert.equal(state.claims.length, 0, 'Cancelled owned resources were not physically settled');
  } else assert.fail('Unknown regression variant');
  return { historicalBaseline: preparation.preparation, historicalRunIds: old.map(row => row.id), newRunIds: current.map(row => row.id), fullRealHistoricalRegression: false };
}
