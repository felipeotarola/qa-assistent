import assert from 'node:assert/strict';
import test from 'node:test';
import { auditBrowserReports } from './helpers/browser-variants-reports.mjs';
import { cancelledExecutionBaseline } from './helpers/browser-variants-effects.mjs';
import { regressionFingerprint } from './helpers/browser-variants-regression.mjs';

const id = n => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`;
const at = n => `2026-10-06T10:${String(n).padStart(2, '0')}:00.000Z`;
function fixture(answered = false) {
  const mission = { id: id(1), workspace_id: id(2), plan_revision: 1, mandate_revision: 1, deadline_at: at(55) };
  const state = { missions: [mission], tasks: [{ id: 'source', spec: { kind: 'research' } }], attempts: [], reports: [], reportBindings: [], reportItems: [], events: [], waits: [] };
  for (const [purpose, minute] of [['interim', 10], ['final', 30]]) {
    const task = { id: purpose, spec: { kind: 'report', purpose }, operation_id: `report:${purpose}:1`, plan_revision: 1, state: 'completed' };
    state.tasks.push(task);
    state.attempts.push({ id: purpose, task_id: purpose, kind: 'report', executor_resource_id: purpose, plan_revision: 1, mandate_revision: 1,
      status: 'completed', finished_at: at(minute + 1), deadline_at: at(purpose === 'interim' ? 25 : 50), lease_until: null });
    state.reports.push({ id: purpose, status: 'completed', item_id: `item-${purpose}`, finished_at: at(minute + 1), lease_until: null, document: { partial: purpose === 'interim' } });
    state.reportItems.push({ id: `item-${purpose}`, version: 1, deleted_at: null });
    state.reportBindings.push({ id: purpose, mission_id: mission.id, snapshot_id: id(minute), snapshot_hash: 'a'.repeat(64), snapshot_mission_id: mission.id,
      snapshot_workspace_id: mission.workspace_id, purpose, captured_at: at(minute), completed_sources: [{ taskId: 'source', evidenceCount: 1 }] });
  }
  state.events.push({ kind: 'report_requested', created_at: at(29) }, { kind: 'interim_report_requested', event_key: 'report:interim:1',
    created_at: at(9), payload: { taskId: 'interim', mandateRevision: 1, waitIds: ['wait'] } });
  state.waits.push({ id: 'wait', state: answered ? 'answered' : 'expired', deadline_at: at(25), answered_at: answered ? at(20) : null,
    definition: { taskIds: ['browser'], planRevision: 1, mandateRevision: 1, requestedAt: at(5) } });
  return state;
}

for (const answered of [false, true]) test(`browser interim/final binds original ${answered ? 'answered' : 'expired'} wait without choosing by order`, () => {
  const state = fixture(answered); state.reports.reverse(); const before = structuredClone(state), result = auditBrowserReports(state);
  assert.equal(result.final.id, 'final'); assert.equal(result.receipt.interim.length, 1); assert.deepEqual(state, before);
});
test('a committed interim may receive a later abandon receipt but still cannot exceed the original physical deadline', () => {
  const state = fixture(true); state.attempts[0].status = 'cancelled'; state.tasks[1].state = 'cancelled';
  state.events.push({ kind: 'interim_report_abandoned', payload: { taskId: 'interim' } }); state.reports[0].finished_at = at(19); state.attempts[0].finished_at = at(21);
  assert.equal(auditBrowserReports(state).receipt.interim[0].status, 'completed');
});
test('an unstarted cancelled interim has a real proposal but no manufactured report', () => {
  const state = fixture(); state.reports.shift(); state.reportItems.shift(); state.reportBindings.shift(); state.attempts.shift(); state.tasks[1].state = 'cancelled';
  assert.equal(auditBrowserReports(state).receipt.interim.length, 0);
});
for (const [label, change] of [
  ['extra material', s => s.reportItems.push({ id: 'unowned', version: 1, deleted_at: null })],
  ['snapshot mission mismatch', s => { s.reportBindings[0].snapshot_mission_id = id(9); }],
  ['snapshot purpose mismatch', s => { s.reportBindings[0].purpose = 'final'; }],
  ['unbound report', s => { s.attempts[0].executor_resource_id = 'other'; }],
  ['foreign epoch', s => { s.attempts[0].mandate_revision = 2; }],
  ['captured after answer', s => { s.waits[0].state = 'answered'; s.waits[0].answered_at = at(10); }],
  ['captured after expiry', s => { s.reportBindings[0].captured_at = at(25); }],
  ['completion after deadline', s => { s.reports[0].finished_at = at(26); }],
  ['physical publication after answer', s => { s.waits[0].state = 'answered'; s.waits[0].answered_at = at(20); s.reports[0].finished_at = at(21); }],
  ['no independent source', s => { s.reportBindings[0].completed_sources[0].taskId = 'browser'; }],
  ['source has no bytes', s => { s.reportBindings[0].completed_sources[0].evidenceCount = 0; }],
  ['interim falsely complete', s => { s.reports[0].document.partial = false; }],
  ['duplicate final', s => { s.reports.push(structuredClone(s.reports[1])); }],
  ['unknown report snapshot', s => { s.reportBindings.pop(); }],
  ['missing original wait', s => { s.waits = []; }],
]) test(`browser reports reject ${label}`, () => { const state = fixture(); change(state); assert.throws(() => auditBrowserReports(state)); });

function cancelled() {
  const state = fixture(), mission = state.missions[0]; mission.mandate_revision = 2; mission.closed_at = at(40);
  state.attempts[1].mandate_revision = 2; state.waits[0].state = 'cancelled';
  const fault = { attemptId: 'browser-attempt', command: { action: 'cancel', missionId: mission.id, requestId: id(90), expectedMandateRevision: 1 } };
  state.attempts.push({ id: fault.attemptId, kind: 'browser_tests', dispatch_id: 'browser-job', cancel_requested_at: at(20) });
  for (const attempt of state.attempts) attempt.model_starts = [];
  state.events.push({ kind: 'control_cancel', event_key: `control:${fault.command.requestId}`, action_hash: regressionFingerprint(fault.command), created_at: at(20) });
  fault.postCancelObservation = cancelledExecutionBaseline(state, fault, at(21));
  return { state, fault };
}
test('S1 may account a completed original-epoch interim only through its exact committed cancellation', () => {
  const { state, fault } = cancelled(); assert.equal(auditBrowserReports(state, { fault }).receipt.interim.length, 1);
});
for (const [label, corrupt] of [
  ['unknown transition', v => { v.state.missions[0].mandate_revision = 3; }],
  ['other cancel command', v => { v.fault.command.requestId = id(91); }],
  ['forged action hash', v => { v.state.events.at(-1).action_hash = 'b'.repeat(64); }],
  ['old interim commits after revocation', v => { v.state.reports[0].finished_at = at(21); }],
  ['cancelled wait without cancellation evidence', v => { delete v.fault.postCancelObservation; }],
]) test(`S1 old interim rejects ${label}`, () => { const v = cancelled(); corrupt(v); assert.throws(() => auditBrowserReports(v.state, v)); });
