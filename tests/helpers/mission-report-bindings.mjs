import assert from 'node:assert/strict';

const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value);
const instant = value => typeof value === 'string' && Number.isFinite(Date.parse(value));

/** Identity/accounting only, for one unchanged mission plan. The caller
 * must separately prove why any interim was eligible, its wait/deadline and
 * the workload result. Titles, ordering and "latest" never select a report.
 * reportBindings is an immutable snapshot projection, not a model assertion. */
export function bindMissionReports(state, { workspaceId }) {
  assert.equal(state.missions.length, 1); const mission = state.missions[0];
  assert.ok(uuid(mission.id)); assert.ok(Number.isInteger(mission.plan_revision) && Number.isInteger(mission.mandate_revision));
  const reportTasks = state.tasks.filter(task => task.spec?.kind === 'report');
  const finalTasks = reportTasks.filter(task => (task.spec.purpose ?? 'final') === 'final');
  const interimTasks = reportTasks.filter(task => task.spec.purpose === 'interim');
  assert.equal(finalTasks.length, 1, 'Exactly one original final-report task required');
  assert.equal(reportTasks.length, finalTasks.length + interimTasks.length, 'Unknown report purpose');
  assert.equal(new Set(reportTasks.map(task => task.id)).size, reportTasks.length, 'Duplicate report task');
  assert.ok(interimTasks.length <= 1, 'Only one interim report in this unchanged plan');
  assert.equal(new Set(state.reports.map(report => report.id)).size, state.reports.length);
  assert.equal(state.reportBindings?.length, state.reports.length, 'All report snapshots must have exact bindings');
  const bound = state.reports.map(report => {
    const rows = state.reportBindings.filter(row => row.id === report.id); assert.equal(rows.length, 1);
    const binding = rows[0];
    assert.equal(binding.mission_id, mission.id); assert.equal(binding.snapshot_mission_id, mission.id);
    assert.equal(binding.snapshot_workspace_id, workspaceId); assert.ok(uuid(binding.snapshot_id));
    assert.match(binding.snapshot_hash, /^[a-f0-9]{64}$/); assert.ok(instant(binding.captured_at));
    const attempts = state.attempts.filter(attempt => attempt.executor_resource_id === report.id);
    assert.equal(attempts.length, 1, 'A report must belong to exactly one physical attempt'); const attempt = attempts[0];
    const task = reportTasks.find(task => task.id === attempt.task_id); assert.ok(task && attempt.kind === 'report');
    assert.equal(task.plan_revision, mission.plan_revision); assert.equal(attempt.plan_revision, mission.plan_revision);
    const purpose = task.spec.purpose ?? 'final'; assert.equal(binding.purpose, purpose, 'Snapshot/task purpose mismatch');
    if (purpose === 'final') assert.equal(attempt.mandate_revision, mission.mandate_revision);
    else {
      assert.equal(task.operation_id, `report:interim:${mission.plan_revision}`);
      const proposals = state.events.filter(event => event.kind === 'interim_report_requested' && event.event_key === task.operation_id && event.payload.taskId === task.id);
      assert.equal(proposals.length, 1, 'Interim needs its exact original proposal epoch');
      assert.ok(Number.isInteger(proposals[0].payload.mandateRevision));
      assert.equal(attempt.mandate_revision, proposals[0].payload.mandateRevision);
      // This is not permission to adopt an old epoch. The caller must prove
      // the exact allowed transition and that its old wait remained valid.
    }
    assert.ok(['completed', 'failed', 'cancelled'].includes(attempt.status) && attempt.finished_at && !attempt.lease_until);
    assert.equal(report.lease_until, null); assert.ok(report.finished_at);
    if (purpose === 'final' || report.status === 'completed') {
      assert.equal(report.status, 'completed');
      if (purpose === 'final' || attempt.status === 'completed') { assert.equal(attempt.status, 'completed'); assert.equal(task.state, 'completed'); }
      else { assert.equal(attempt.status, 'cancelled'); assert.equal(task.state, 'cancelled');
        assert.ok(state.events.some(event => event.kind === 'interim_report_abandoned' && event.payload.taskId === task.id)); }
      assert.ok(report.document && report.item_id);
      assert.equal(state.reportItems.filter(item => item.id === report.item_id && item.version > 0 && !item.deleted_at).length, 1, 'Report material is absent/deleted');
    } else {
      assert.equal(report.status, 'failed'); assert.equal(report.document, null); assert.equal(report.item_id, null);
    }
    return { report, binding, attempt, task, purpose };
  });
  const finals = bound.filter(row => row.purpose === 'final'); assert.equal(finals.length, 1, 'Exactly one bound final artifact required');
  const final = finals[0]; assert.equal(final.task.id, finalTasks[0].id);
  const itemIds = bound.filter(row => row.report.status === 'completed').map(row => row.report.item_id);
  assert.equal(new Set(itemIds).size, itemIds.length, 'Reports cannot share a material artifact');
  assert.deepEqual(state.reportItems.map(item => item.id).sort(), [...itemIds].sort(), 'Unaccounted report material');
  return { mission, final, interimTasks, bound };
}
