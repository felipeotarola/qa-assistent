import assert from 'node:assert/strict';
import { bindMissionReports } from './mission-report-bindings.mjs';
import { cancelledExecutionBaseline } from './browser-variants-effects.mjs';

const time = value => { const n = value instanceof Date ? value.getTime() : value != null ? Date.parse(value) : NaN; assert.ok(Number.isFinite(n), 'Missing report/wait instant'); return n; };

/** Account every artifact, then select by immutable report purpose and exact
 * attempt. An interim also needs a still-open original wait and completed
 * independent source; its existence never replaces the final delivery. */
export function auditBrowserReports(state, { fault } = {}) {
  const { mission, final, interimTasks, bound } = bindMissionReports(state, { workspaceId: state.missions[0]?.workspace_id });
  const requests = state.events.filter(event => event.kind === 'report_requested'); assert.equal(requests.length, 1);
  const finalAt = time(requests[0].created_at); assert.ok(finalAt <= time(final.binding.captured_at));
  for (const task of interimTasks) {
    assert.equal(task.operation_id, `report:interim:${mission.plan_revision}`);
    const proposals = state.events.filter(event => event.kind === 'interim_report_requested' && event.event_key === task.operation_id);
    assert.equal(proposals.length, 1); const event = proposals[0], proposedAt = time(event.created_at);
    assert.equal(event.payload.taskId, task.id);
    const epoch = event.payload.mandateRevision;
    let revokedAt = Infinity;
    if (epoch !== mission.mandate_revision) {
      assert.ok(fault?.command && fault.postCancelObservation, 'An old interim epoch needs the exact original cancellation');
      const cancellation = cancelledExecutionBaseline(state, fault, mission.closed_at);
      assert.equal(epoch, fault.command.expectedMandateRevision); assert.equal(mission.mandate_revision, epoch + 1);
      assert.equal(cancellation.revokedAt, fault.postCancelObservation.revokedAt); revokedAt = time(cancellation.revokedAt);
    }
    const ids = event.payload.waitIds; assert.ok(Array.isArray(ids) && ids.length && new Set(ids).size === ids.length);
    const waits = ids.map(id => { const wait = state.waits.find(row => row.id === id); assert.ok(wait); return wait; });
    const deadline = Math.min(revokedAt, time(mission.deadline_at), ...waits.map(wait => {
      assert.equal(wait.definition.planRevision, mission.plan_revision); assert.equal(wait.definition.mandateRevision, epoch);
      assert.ok(time(wait.definition.requestedAt) <= proposedAt && proposedAt < time(wait.deadline_at));
      assert.ok(['answered', 'expired'].includes(wait.state) || Number.isFinite(revokedAt) && wait.state === 'cancelled', 'The original question has no observed terminal resolution');
      return wait.state === 'answered' ? Math.min(time(wait.answered_at), time(wait.deadline_at)) : time(wait.deadline_at);
    }));
    assert.ok(proposedAt < deadline && proposedAt < finalAt);
    const attempts = state.attempts.filter(row => row.task_id === task.id), rows = bound.filter(row => row.task.id === task.id);
    assert.ok(attempts.length <= 1 && rows.length <= 1, 'Interim work was duplicated');
    if (!rows.length) { assert.ok(['cancelled', 'blocked'].includes(task.state)); assert.ok(attempts.every(row => !row.executor_resource_id)); continue; }
    const row = rows[0], capturedAt = time(row.binding.captured_at);
    assert.ok(capturedAt >= proposedAt && capturedAt < deadline && capturedAt < finalAt, 'Interim captured after its wait was no longer open');
    const waiting = new Set(waits.flatMap(wait => wait.definition.taskIds));
    assert.ok(row.binding.completed_sources?.some(source => !waiting.has(source.taskId)
      && state.tasks.some(other => other.id === source.taskId && other.spec?.kind !== 'report') && source.evidenceCount > 0), 'Interim has no completed independent source');
    if (row.report.status === 'completed') {
      assert.equal(row.report.document.partial, true);
      // Physical publication must occur while the original wait is open. A
      // later controller attempt/abandon receipt does not move publication.
      assert.ok(time(row.report.finished_at) <= Math.min(deadline, time(row.attempt.deadline_at)), 'Interim completed after its execution deadline');
    }
  }
  return { final: final.report, receipt: { version: 1, finalReportId: final.report.id, finalSnapshotHash: final.binding.snapshot_hash,
    interim: bound.filter(row => row.purpose === 'interim').map(row => ({ reportId: row.report.id, status: row.report.status, snapshotHash: row.binding.snapshot_hash })),
    semanticCoverage: 'independent_review_pending' } };
}
