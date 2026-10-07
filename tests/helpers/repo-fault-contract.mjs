import assert from 'node:assert/strict';
import { auditRepoCompletion } from './repo-benchmark-audit.mjs';
import { auditReviewInputHash } from './autonomy-web-audit.mjs';
import { runChecks } from '../../shared/test-run.ts';
import { bindMissionReports } from './mission-report-bindings.mjs';

export const REPO_FAULT_PROTOCOL = 'syna-repository-fault-v3';

export const repoVariants = Object.freeze({ 'REPO-10': ['normal', 'runner_ack_lost'], 'REPO-11': ['normal', 'app_stops_after_ready'], 'REPO-12': ['normal', 'missing_key_no_answer', 'consent_revoked_before_release'] });
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value);
const instant = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const dbInstant = value => (typeof value === 'string' || value instanceof Date) && Number.isFinite(new Date(value).getTime());
const time = value => dbInstant(value) ? new Date(value).getTime() : NaN;

export function validateRepoVariant(scenario, variant) { assert.ok(repoVariants[scenario]?.includes(variant), 'Unknown frozen repository fault variant'); return variant; }
export function validateRepoFaultArm(value) {
  assert.equal(value?.version, 1); assert.ok(['runner_ack_lost', 'app_stops_after_ready', 'consent_revoked_before_release'].includes(value.variant));
  for (const name of ['id', 'workspaceId']) assert.ok(uuid(value[name]));
  assert.match(value.runtime, /^autonomy-test:[a-z0-9-]+$/); assert.match(value.repoUrl, /^https:\/\/github\.com\/syna-autonomy-fixture\/(?:library|keyless|configured)$/);
  assert.ok(instant(value.armedAt) && instant(value.expiresAt) && Date.parse(value.expiresAt) > Date.parse(value.armedAt));
  assert.ok(Date.parse(value.expiresAt) - Date.parse(value.armedAt) <= 75 * 60_000);
  return value;
}

/** A missing fault point never passes merely because a partial report exists.
 * Prose is still independently reviewed; this checks saved structured facts. */
export function auditRepoFaultCompletion(state, context) {
  const { variant, fault, runtime, repo, savedConsent } = context;
  validateRepoVariant(context.scenario, variant);
  assert.ok(fault && fault.applied === true, 'Fault not reached/applied; do not count as an acceptance pass');
  assert.equal(fault.runtime, runtime); assert.equal(fault.workspaceId, context.workspaceId);
  assert.equal(fault.variant, variant); assert.ok(instant(fault.appliedAt));
  if (variant === 'runner_ack_lost') {
    const result = auditRepoCompletion(state, context);
    const check = state.repositories.find(row => row.config.mode === 'test');
    assert.equal(fault.jobId, check.job.id); assert.equal(fault.attemptId, check.job.execution.attemptId);
    assert.equal(fault.dispatchId, check.job.execution.dispatchId); assert.equal(fault.fingerprint, check.job.fingerprint);
    assert.ok(fault.upstreamAccepted === true && fault.clientReceiptDropped === true);
    assert.equal(state.repositories.filter(row => row.config.mode === 'test').length, 1);
    return { ...result, matched: [...result.matched, { fault: variant, jobId: fault.jobId, sameAcceptedJob: true }] };
  }
  assert.equal(state.missions.length, 1); const mission = state.missions[0];
  assert.equal(mission.runtime, runtime); assert.equal(mission.lifecycle, 'closed'); assert.equal(mission.lease_until, null);
  assert.ok(['blocked', 'deadline', 'investigated', 'criteria_satisfied'].includes(mission.closure_reason));
  assert.equal(state.claims.length, 0); assert.ok(state.attempts.every(row => ['completed', 'failed', 'cancelled'].includes(row.status) && row.finished_at && !row.lease_until));
  assert.equal(state.reports.length, 1); const report = state.reports[0];
  assert.equal(report.status, 'completed'); assert.equal(report.lease_until, null); assert.ok(report.item_id && report.finished_at); assert.equal(report.document.partial, true);
  assert.ok(!state.runs.some(run => run.result?.outcome === 'passed'), 'An unavailable app cannot inherit earlier functional approval');
  assert.ok(!report.document.tests?.some(run => run.status === 'passed' || run.originalOutcome === 'passed'));
  assert.ok(state.repositories.every(row => row.job?.commit === repo.commit && row.job.cleanup?.confirmed === true));
  assert.ok(state.setups.every(row => row.result?.cleanup === 'confirmed' && row.result.executorStopped === true));
  const applies = state.setups.filter(row => row.autonomy?.environmentExecution?.phase === 'apply');
  if (variant === 'app_stops_after_ready') {
    assert.equal(applies.length, 1); const apply = applies[0];
    assert.equal(fault.jobId, apply.id); assert.equal(fault.resourceId, apply.autonomy.resourceId);
    assert.equal(fault.processId, apply.result.environment.processId); assert.equal(fault.commit, repo.commit);
    assert.ok(Date.parse(fault.readyAt) <= Date.parse(fault.appliedAt)); assert.equal(fault.httpReachableAfter, false); assert.equal(fault.processGroupEmpty, true);
    assert.ok(state.attempts.filter(row => ['preview_discovery', 'browser_tests'].includes(row.kind)).every(row => Date.parse(row.created_at) >= Date.parse(fault.appliedAt)), 'Fault must precede the first browser attempt');
    assert.ok(state.events.some(event => ['task.failed', 'attempt.failed', 'environment.unavailable', 'environment.preview_failed'].includes(event.kind))
      || state.attempts.some(row => row.kind === 'preview_discovery' && row.status === 'failed'), 'Physical stop did not become a saved execution limitation');
  } else {
    assert.equal(state.events.filter(event => event.kind === 'environment.released').length, 0, 'Credentials were already released; the intended before-release fault was not reached');
    assert.ok(applies.every(row => !row.autonomy.release?.releasedAt));
    assert.equal(state.runs.length, 0, 'No test execution is authorized without required configuration');
    if (variant === 'missing_key_no_answer') {
      assert.equal(fault.missingName, 'SERVICE_ACCESS_TOKEN'); assert.equal(fault.userAnswers, 0);
      assert.equal(state.waits.length, 1, 'The same unresolved prerequisite must not create an unbounded question loop');
      assert.equal(state.waits[0].state, 'expired'); assert.ok(Date.parse(state.waits[0].deadline_at) <= Date.parse(mission.closed_at));
      assert.equal(applies.length, 0);
    } else {
      assert.ok(savedConsent); assert.equal(fault.consentId, savedConsent.consentId); assert.equal(fault.revision, savedConsent.revision + 1);
      assert.equal(applies.length, 1); assert.equal(fault.jobId, applies[0].id);
      const attempt = state.attempts.find(row => row.id === fault.attemptId);
      assert.ok(attempt && attempt.kind === 'environment_setup' && Date.parse(attempt.created_at) <= Date.parse(fault.appliedAt));
      assert.equal(applies[0].autonomy.execution.attemptId, fault.attemptId);
      assert.ok(fault.forwardedAfterRevocation === true);
    }
  }
  return { report, matched: [{ fault: variant, boundedPartialReport: true }], limitations: ['The injected failure and conservative structured report are checked; report prose still requires independent reading.'] };
}

/** Every report is accounted for by its immutable snapshot and original attempt.
 * Titles, timestamps and "latest report" are never purpose selectors. */
export function auditRepoFaultReports(state, context) {
  const { mission, final, interimTasks, bound } = bindMissionReports(state, context);
  const finalEvents = state.events.filter(event => event.kind === 'report_requested'); assert.equal(finalEvents.length, 1);
  const finalEvent = finalEvents[0];
  assert.ok(time(finalEvent.created_at) <= time(final.binding.captured_at), 'Final phase receipt is missing');
  for (const task of interimTasks) {
    assert.equal(task.operation_id, `report:interim:${mission.plan_revision}`);
    const proposal = state.events.filter(event => event.kind === 'interim_report_requested' && event.event_key === task.operation_id);
    assert.equal(proposal.length, 1); const event = proposal[0];
    assert.equal(event.payload.taskId, task.id); assert.equal(event.payload.mandateRevision, mission.mandate_revision);
    const ids = event.payload.waitIds; assert.ok(Array.isArray(ids) && ids.length && new Set(ids).size === ids.length);
    const waits = ids.map(id => { const wait = state.waits.find(row => row.id === id); assert.ok(wait); return wait; });
    const proposalAt = time(event.created_at); assert.ok(Number.isFinite(proposalAt));
    const deadline = Math.min(time(mission.deadline_at), ...waits.map(wait => {
      assert.equal(wait.definition.planRevision, mission.plan_revision); assert.equal(wait.definition.mandateRevision, mission.mandate_revision);
      assert.ok(time(wait.definition.requestedAt) <= proposalAt && proposalAt < time(wait.deadline_at));
      // These fault scenarios never authorize an answer. A replacement/answered
      // question cannot retrospectively justify an old progress report.
      assert.equal(wait.state, 'expired'); return time(wait.deadline_at);
    }));
    assert.ok(proposalAt < deadline && proposalAt < time(finalEvent.created_at));
    const interimAttempts = state.attempts.filter(row => row.task_id === task.id); assert.ok(interimAttempts.length <= 1);
    const rows = bound.filter(row => row.task.id === task.id); assert.ok(rows.length <= 1);
    if (!rows.length) { assert.ok(['cancelled', 'blocked'].includes(task.state)); assert.ok(interimAttempts.every(row => !row.executor_resource_id)); continue; }
    const row = rows[0], captured = time(row.binding.captured_at);
    assert.ok(captured >= proposalAt && captured < deadline && captured < time(finalEvent.created_at));
    const waitingTasks = new Set(waits.flatMap(wait => wait.definition.taskIds));
    assert.ok(row.binding.completed_sources?.some(source => !waitingTasks.has(source.taskId)
      && state.tasks.some(other => other.id === source.taskId && other.spec?.kind !== 'report')
      && source.evidenceCount > 0), 'Interim snapshot has no completed independent source');
    if (row.report.status === 'completed') {
      assert.equal(row.report.document.partial, true);
      assert.ok(time(row.report.finished_at) < deadline, 'Interim completed after its original wait/deadline');
    }
  }
  return { final: final.report, interim: bound.filter(row => row.purpose === 'interim').map(row => ({ reportId: row.report.id, status: row.report.status, taskId: row.task.id })) };
}

/** Explicit v3 only; historical v2 keeps auditRepoFaultCompletion unchanged. */
export function auditRepoFaultCompletionV3(state, context) {
  assert.equal(context.protocol, REPO_FAULT_PROTOCOL);
  assert.match(context.reviewerPolicy?.reviewerVersion ?? '', /^[0-9]+$/);
  assert.equal(context.reviewerPolicy?.hashVersion, 2); assert.match(context.reviewerPolicy?.sourceSha256 ?? '', /^[a-f0-9]{64}$/);
  assert.equal(context.runChecksPolicy?.version, 1); assert.match(context.runChecksPolicy?.sourceSha256 ?? '', /^[a-f0-9]{64}$/);
  for (const review of state.reviews.filter(row => row.status === 'completed')) {
    const run = state.runs.find(row => row.id === review.run_id); assert.ok(run);
    assert.equal(review.reviewer_version, context.reviewerPolicy.reviewerVersion);
    assert.equal(review.input_hash, auditReviewInputHash(review.input));
    assert.deepEqual(review.input.reportedResult, run.result); assert.deepEqual(review.input.target, run.target);
    assert.equal(review.input.planVersion, run.plan_version); assert.deepEqual(review.input.requirements, runChecks(run.snapshot));
  }
  const reports = auditRepoFaultReports(state, context);
  if (context.variant === 'consent_revoked_before_release') {
    const fault = context.fault, apply = state.setups.find(row => row.id === fault?.jobId);
    assert.equal(fault?.version, 2); assert.equal(fault?.downstream?.accepted, true, 'Revoke intent is not a worker receipt');
    assert.ok(fault.downstream.status >= 200 && fault.downstream.status < 300);
    assert.ok(instant(fault.downstream.receivedAt) && time(fault.downstream.receivedAt) >= time(fault.appliedAt));
    assert.equal(fault.downstream.jobId, fault.jobId); assert.equal(fault.downstream.resourceId, apply?.autonomy?.resourceId);
    assert.equal(fault.downstream.attemptId, fault.attemptId); assert.equal(fault.downstream.dispatchId, fault.dispatchId);
    assert.equal(fault.downstream.fingerprint, apply?.result?.fingerprint); assert.match(fault.downstream.fingerprint, /^[a-f0-9]{64}$/);
    assert.match(fault.downstream.responseSha256, /^[a-f0-9]{64}$/); assert.match(fault.requestSha256, /^[a-f0-9]{64}$/);
  }
  const result = auditRepoFaultCompletion({ ...state, reports: [reports.final] }, context);
  return { ...result, reportScope: { finalReportId: reports.final.id, interim: reports.interim, immutablePurposeBinding: true }, semanticProse: 'independent_review_pending' };
}
