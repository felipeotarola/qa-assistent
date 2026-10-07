import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { auditBrowserVariant, browserVariantProtocol } from './helpers/browser-variants-protocol.mjs';
import { example, clone, time, hash } from './browser-variants-current-fixture.mjs';

const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, canonical(child)])) : value;
const digest = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');

function recovered() {
  const value = example(), { state, context } = value, mission = state.missions[0];
  mission.id = '00000001-0000-4000-8000-000000000000'; mission.workspace_id = '00000002-0000-4000-8000-000000000000';
  mission.thread_id = 'original-thread'; mission.mandate.limits.maxOperationAttempts = 2;
  const source = state.tasks[0], next = state.tasks[1], origin = state.attempts[0], attempt = state.attempts[1];
  source.state = 'blocked'; source.spec.caseKeys = [...mission.config.caseKeys]; source.operation_id = 'browser:1:0';
  next.operation_id = 'browser-remainder:' + source.id; next.created_at = time(4);
  origin.operation_id = source.operation_id; origin.attempt_no = 1;
  attempt.operation_id = next.operation_id; attempt.attempt_no = 1; attempt.created_at = time(5); attempt.finished_at = time(7);
  state.runs[1].started_at = time(5); state.runs[1].finished_at = time(6); state.reviews[1].finished_at = time(7);
  for (const row of [source, next]) row.mission_id = mission.id;
  for (const row of [origin, attempt]) { row.mission_id = mission.id; row.runtime = context.runtime; row.cancel_requested_at = null; }
  for (const row of state.jobs) { row.runtime = context.runtime; row.thread_id = mission.thread_id; }
  const event = { mission_id: mission.id, kind: 'browser_remainder_planned', event_key: next.operation_id, created_at: time(4),
    payload: { version: 1, taskId: next.id, sourceTaskId: source.id, sourceAttemptId: origin.id, sourceSpecHash: digest(source.spec),
      planRevision: 1, mandateRevision: 1, caseKeys: ['plan:broken'] } };
  state.events.push(event);
  context.history = [{ at: time(0), missions: clone(state.missions), tasks: [clone(source)], runs: [] },
    { at: time(3), missions: clone(state.missions), tasks: [clone(source)], runs: [clone(state.runs[0])] }];
  for (const row of state.attempts) row.operation_id ??= row.id;
  state.tasks.push({ id: 'final-task', state: 'completed', plan_revision: 1, spec: { kind: 'report', purpose: 'final' } });
  state.attempts.push({ id: 'final-attempt', task_id: 'final-task', kind: 'report', status: 'completed', operation_id: 'report:final:1',
    executor_resource_id: 'report', mandate_revision: 1, plan_revision: 1, finished_at: time(20), lease_until: null });
  state.reportBindings = [{ id: 'report', mission_id: mission.id, snapshot_id: '00000003-0000-4000-8000-000000000000', snapshot_hash: hash,
    snapshot_mission_id: mission.id, snapshot_workspace_id: mission.workspace_id, purpose: 'final', captured_at: time(19) }];
  state.events.push({ kind: 'report_requested', created_at: time(18) });
  mission.admission = { target: { url: mission.config.target.url } }; state.reportItems = [{ id: 'report-item', version: 1, deleted_at: null }];
  context.protocol = { ...browserVariantProtocol('WEB-03', 'normal'), targetUrl: mission.config.target.url };
  context.runChecksPolicy = { version: 1, sourceSha256: hash };
  const checks = context.oracle.observations.map((check, i) => ({ id: `oracle-${i}`, action: check.action, toPath: check.toPath, status: check.status,
    heading: check.text, visibleText: [check.text], classification: check.status === 404 ? 'known_defect' : 'known_working' }));
  context.oracle = { origin: new URL(mission.config.target.url).origin, tasks: [{ taskId: 'WEB-03', checks }] };
  for (const row of context.traces) { row.trace.observation.headings = [row.trace.observation.text]; row.trace.observation.truncated = false; }
  return { ...value, source, next, origin, attempt, event, mission };
}

test('only an exact unstarted recovery resolves historical blocked state, preserving the failed outcome and semantic gate', () => {
  const value = recovered(), before = clone(value.state), result = auditBrowserVariant(value.state, value.context);
  assert.equal(result.remainders.length, 1); assert.deepEqual(result.remainders[0].caseKeys, ['plan:broken']);
  assert.equal(result.remainders[0].historicalState, 'blocked'); assert.equal(result.remainders[0].semanticCoverage, 'independent_review_pending');
  assert.equal(result.matches.length, 2); assert.equal(result.report.document.partial, false);
  assert.equal(result.report.document.tests.find(row => row.runId === 'run-broken').originalOutcome, 'failed');
  assert.deepEqual(value.state, before);
});

test('historical protocols still fail, with no artifact or original-state rewrite', () => {
  const value = recovered(); delete value.context.protocol.remainderScope;
  assert.throws(() => auditBrowserVariant(value.state, value.context), /Unfulfilled task remains/);
  value.context.protocol.remainderScope = 'future'; assert.throws(() => auditBrowserVariant(value.state, value.context), /Unknown remainder scope/);
});

test('the completed original executor may contain a proved failed test, and a failed original executor may also leave unstarted work', () => {
  const value = recovered(); value.origin.status = 'failed'; value.state.jobs[0].status = 'failed';
  assert.equal(auditBrowserVariant(value.state, value.context).remainders.length, 1);
});

for (const [name, corrupt] of [
  ['missing committed event', v => { v.state.events = v.state.events.filter(e => e !== v.event); }],
  ['duplicate event', v => v.state.events.push(clone(v.event))],
  ['changed original spec', v => { v.source.spec.target.environment = 'changed'; }],
  ['different continuation target', v => { v.next.spec.target.environment = 'changed'; }],
  ['case expansion', v => { v.event.payload.caseKeys.push('plan:extra'); }],
  ['changed plan version', v => { v.next.spec.planVersions[0].version = 2; }],
  ['different mandate', v => { v.event.payload.mandateRevision = 2; }],
  ['different mission', v => { v.event.mission_id = 'other'; }],
  ['foreign original runtime', v => { v.origin.runtime = 'other'; }],
  ['foreign job thread', v => { v.state.jobs[0].thread_id = 'other'; }],
  ['foreign job runtime', v => { v.state.jobs[0].runtime = 'other'; }],
  ['cancelled source', v => { v.origin.cancel_requested_at = time(2); }],
  ['unknown original execution', v => { v.origin.status = 'dispatch_unknown'; }],
  ['unsettled original job', v => { v.state.jobs[0].status = 'cancelling'; }],
  ['retained source resource', v => { v.state.claims.push({ attempt_id: v.origin.id }); }],
  ['family budget exhausted', v => { v.mission.mandate.limits.maxOperationAttempts = 1; }],
  ['late recovery', v => { v.mission.deadline_at = time(4); }],
  ['continued original execution', v => { v.origin.finished_at = time(5); }],
  ['outcome retry as remainder', v => { v.event.payload.caseKeys = ['plan:home']; v.next.spec.caseKeys = ['plan:home']; }],
  ['unrelated blocked task', v => { v.state.tasks.push({ id: 'blocked-other', state: 'blocked', spec: { kind: 'discovery' } }); }],
  ['historical result rewritten', v => { v.context.history[1].runs[0].result.actual = 'old original result'; }],
  ['no prior source observation', v => { for (const snapshot of v.context.history) snapshot.tasks = []; }],
  ['missing current case', v => { v.state.runs.pop(); }],
  ['unread current evidence', v => { v.context.byteEvidence.delete('trace-broken'); }],
  ['narrowed final report', v => { v.state.reports[0].document.tests.pop(); }],
]) test(`remainder rejects ${name}`, () => {
  const value = recovered(); corrupt(value); assert.throws(() => auditBrowserVariant(value.state, value.context));
});
