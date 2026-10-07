import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { auditRepoFaultCompletion, auditRepoFaultCompletionV3, REPO_FAULT_PROTOCOL } from './helpers/repo-fault-contract.mjs';
import { freezeRepoRunChecksPolicy } from './helpers/repo-benchmark-audit-v2.mjs';
import { frozenWebReviewerPolicy } from './helpers/autonomy-web-audit.mjs';
import { bindMissionReports } from './helpers/mission-report-bindings.mjs';

const runtime = 'autonomy-test:fault-v3-unit', at = minute => `2026-10-06T12:${String(minute).padStart(2, '0')}:00.000Z`;
function sample({ interim = false } = {}) {
  const missionId = randomUUID(), workspaceId = randomUUID(), finalId = randomUUID(), finalTaskId = randomUUID();
  const waitId = randomUUID(), waitingTaskId = randomUUID(), sourceTaskId = randomUUID();
  const report = id => ({ id, status: 'completed', lease_until: null, item_id: randomUUID(), finished_at: at(12), document: { partial: true, tests: [] } });
  const binding = (id, purpose) => ({ id, mission_id: missionId, snapshot_id: randomUUID(), snapshot_hash: 'a'.repeat(64), snapshot_mission_id: missionId,
    snapshot_workspace_id: workspaceId, purpose, captured_at: at(11), completed_sources: [{ taskId: sourceTaskId, evidenceCount: 1 }] });
  const state = {
    missions: [{ id: missionId, runtime, lifecycle: 'closed', closure_reason: 'deadline', lease_until: null, closed_at: at(12), deadline_at: at(10), plan_revision: 1, mandate_revision: 1 }],
    tasks: [{ id: finalTaskId, state: 'completed', spec: { kind: 'report' }, operation_id: 'report:1', plan_revision: 1 },
      { id: sourceTaskId, state: 'completed', spec: { kind: 'discovery' }, plan_revision: 1 }, { id: waitingTaskId, state: 'blocked', spec: { kind: 'environment_setup' }, plan_revision: 1 }],
    attempts: [{ id: randomUUID(), task_id: finalTaskId, kind: 'report', status: 'completed', executor_resource_id: finalId, plan_revision: 1, mandate_revision: 1, created_at: at(10), finished_at: at(12), lease_until: null }],
    claims: [], repositories: [], setups: [], runs: [], reviews: [],
    reports: [report(finalId)], reportBindings: [binding(finalId, 'final')],
    events: [{ kind: 'report_requested', created_at: at(10), payload: {} }],
    waits: [{ id: waitId, state: 'expired', deadline_at: at(10), definition: { requestedAt: at(0), deadlineAt: at(10), planRevision: 1, mandateRevision: 1, taskIds: [waitingTaskId] } }],
  };
  if (interim) {
    const id = randomUUID(), taskId = randomUUID();
    state.tasks.push({ id: taskId, spec: { kind: 'report', purpose: 'interim' }, state: 'completed', plan_revision: 1, operation_id: 'report:interim:1' });
    state.attempts.push({ id: randomUUID(), task_id: taskId, kind: 'report', status: 'completed', executor_resource_id: id, plan_revision: 1, mandate_revision: 1, created_at: at(1), finished_at: at(3), lease_until: null });
    state.reports.push({ ...report(id), finished_at: at(3) }); state.reportBindings.push({ ...binding(id, 'interim'), captured_at: at(2) });
    state.events.push({ kind: 'interim_report_requested', event_key: 'report:interim:1', created_at: at(1), payload: { taskId, waitIds: [waitId], mandateRevision: 1 } });
  }
  state.reportItems = state.reports.map(row => ({ id: row.item_id, version: 1, deleted_at: null }));
  const context = { protocol: REPO_FAULT_PROTOCOL, scenario: 'REPO-12', variant: 'missing_key_no_answer', runtime, workspaceId,
    repo: { url: 'https://github.com/syna-autonomy-fixture/configured', commit: 'b'.repeat(40) },
    reviewerPolicy: { reviewerVersion: '9', hashVersion: 2, sourceSha256: 'c'.repeat(64) }, runChecksPolicy: { version: 1, sourceSha256: 'd'.repeat(64) },
    fault: { runtime, workspaceId, variant: 'missing_key_no_answer', applied: true, appliedAt: at(0), missingName: 'SERVICE_ACCESS_TOKEN', userAnswers: 0 } };
  return { state, context, finalId };
}
const audit = value => auditRepoFaultCompletionV3(value.state, value.context);

test('v3 accounts for exact final plus legitimate interim while historical v2 still rejects extra reports', () => {
  const value = sample({ interim: true });
  const result = audit(value); assert.equal(result.report.id, value.finalId); assert.equal(result.reportScope.interim.length, 1);
  assert.equal(result.semanticProse, 'independent_review_pending'); assert.equal(value.state.reports.length, 2);
  assert.throws(() => auditRepoFaultCompletion(value.state, value.context), /2 !== 1/);
  assert.equal(audit(sample()).reportScope.interim.length, 0);
});

test('selection is independent of ordering/title/latest-time and cannot hide an unbound or duplicate report', () => {
  const value = sample({ interim: true }); value.state.reports.reverse(); value.state.reportBindings.reverse();
  value.state.reports[0].document.title = 'Final report'; value.state.reports[1].document.title = 'Delrapport';
  assert.equal(audit(value).report.id, value.finalId);
  for (const mutate of [
    s => s.reports.push({ ...s.reports[0], id: randomUUID() }), s => s.reports.push(s.reports[0]),
    s => s.reportBindings[1].purpose = 'final', s => s.reportBindings[0].snapshot_mission_id = randomUUID(),
    s => s.reportBindings[0].snapshot_workspace_id = randomUUID(), s => s.attempts[0].executor_resource_id = randomUUID(),
    s => s.attempts[0].mandate_revision++, s => s.reportBindings[0].purpose = null,
    s => s.reportItems[0].deleted_at = at(13), s => s.tasks[0].spec.purpose = 'unknown',
    s => s.reportItems.push({ id: randomUUID(), version: 1, deleted_at: null }),
    s => s.attempts.push({ ...s.attempts[0], id: randomUUID() }),
  ]) { const bad = sample({ interim: true }); mutate(bad.state); assert.throws(() => audit(bad)); }
});

test('interim requires exact original wait, plan, independent completed evidence and pre-expiry completion', () => {
  for (const mutate of [
    s => s.events[1].payload.waitIds = [randomUUID()], s => s.events[1].payload.waitIds.push(s.waits[0].id),
    s => s.events[1].payload.taskId = randomUUID(), s => s.events[1].payload.mandateRevision++,
    s => s.waits[0].state = 'answered', s => s.waits[0].definition.planRevision++,
    s => s.events[1].created_at = at(10), s => s.reportBindings[1].captured_at = at(10),
    s => s.reports[1].finished_at = at(10), s => s.reports[1].document.partial = false,
    s => s.reportBindings[1].completed_sources[0].evidenceCount = 0,
    s => s.reportBindings[1].completed_sources[0].taskId = s.waits[0].definition.taskIds[0],
    s => s.tasks.push({ ...s.tasks[3], id: randomUUID() }),
  ]) { const bad = sample({ interim: true }); mutate(bad.state); assert.throws(() => audit(bad)); }
});

test('failed/abandoned interim never substitutes for final and does not fail otherwise valid cleanup', () => {
  const value = sample({ interim: true }), interim = value.state.reports[1];
  Object.assign(interim, { status: 'failed', document: null, item_id: null, finished_at: at(10) });
  value.state.reportItems = value.state.reportItems.slice(0, 1);
  value.state.attempts[1].status = 'cancelled'; value.state.tasks[3].state = 'cancelled';
  assert.equal(audit(value).report.id, value.finalId);
  value.state.reports[0].status = 'failed'; assert.throws(() => audit(value));
});

test('completed interim preserved by an expiry race requires its explicit abandonment receipt', () => {
  const value = sample({ interim: true }); value.state.attempts[1].status = 'cancelled'; value.state.tasks[3].state = 'cancelled';
  assert.throws(() => audit(value));
  value.state.events.push({ kind: 'interim_report_abandoned', payload: { taskId: value.state.tasks[3].id } });
  assert.equal(audit(value).report.id, value.finalId);
});

test('database Date timestamps are accepted without timezone-dependent string assumptions', () => {
  const value = sample({ interim: true }); value.state.events.forEach(row => { row.created_at = new Date(row.created_at); });
  assert.equal(audit(value).report.id, value.finalId);
  value.state.waits[0].deadline_at = new Date('2026-10-06T12:03:00.100Z');
  value.state.reports[1].finished_at = new Date('2026-10-06T12:03:00.101Z');
  assert.throws(() => audit(value), /Interim completed after/);
});

test('shared identity binds an older interim to its exact proposal; repo caller still denies epoch changes', () => {
  const value = sample({ interim: true }); value.state.missions[0].mandate_revision = 2; value.state.attempts[0].mandate_revision = 2;
  assert.equal(bindMissionReports(value.state, value.context).bound.find(row => row.purpose === 'interim').attempt.mandate_revision, 1);
  assert.throws(() => audit(value), 'Repo workload has no approved epoch transition');
  value.state.events[1].payload.mandateRevision = 2;
  assert.throws(() => bindMissionReports(value.state, value.context), 'Changing proposal cannot adopt the original attempt');
  value.state.events = value.state.events.filter(row => row.kind !== 'interim_report_requested');
  assert.throws(() => bindMissionReports(value.state, value.context));
});

function revoked() {
  const value = sample(), { state, context } = value, id = randomUUID(), attemptId = randomUUID(), resourceId = randomUUID();
  context.variant = 'consent_revoked_before_release'; context.savedConsent = { consentId: randomUUID(), revision: 2 };
  state.waits = []; state.attempts.push({ id: attemptId, kind: 'environment_setup', status: 'failed', created_at: at(0), finished_at: at(4), lease_until: null });
  state.setups.push({ id, autonomy: { resourceId, execution: { attemptId }, environmentExecution: { phase: 'apply' } }, result: { cleanup: 'confirmed', executorStopped: true, fingerprint: 'e'.repeat(64) } });
  context.fault = { runtime, workspaceId: context.workspaceId, version: 2, variant: context.variant, applied: true, appliedAt: at(1), jobId: id,
    attemptId, dispatchId: id, consentId: context.savedConsent.consentId, revision: 3, forwardedAfterRevocation: true, requestSha256: 'f'.repeat(64),
    downstream: { accepted: true, status: 200, receivedAt: at(2), jobId: id, resourceId, attemptId, dispatchId: id, fingerprint: 'e'.repeat(64), responseSha256: 'a'.repeat(64) } };
  return value;
}

test('revoked oracle requires actual exact worker acknowledgement, never a pre-forward intent or generic HTTP response', () => {
  assert.equal(audit(revoked()).reportScope.interim.length, 0);
  for (const mutate of [
    (s, c) => c.fault.downstream = undefined, (s, c) => c.fault.version = 1,
    (s, c) => c.fault.downstream.accepted = false, (s, c) => c.fault.downstream.status = 409,
    (s, c) => c.fault.downstream.receivedAt = at(0), (s, c) => c.fault.downstream.resourceId = randomUUID(),
    (s, c) => c.fault.downstream.attemptId = randomUUID(), (s, c) => c.fault.downstream.fingerprint = '9'.repeat(64),
    (s, c) => c.fault.downstream.responseSha256 = null, s => s.events.push({ kind: 'environment.released' }),
    s => s.claims.push({ state: 'uncertain' }),
  ]) { const bad = revoked(); mutate(bad.state, bad.context); assert.throws(() => audit(bad)); }
});

test('new fault protocol freezes explicit reviewer and run-check policies, old/missing identity fails closed', () => {
  const bytes = Buffer.from("export const REVIEWER_VERSION = '9';\nexport const REVIEW_HASH_VERSION = 2;\n");
  const value = sample(); value.context.reviewerPolicy = frozenWebReviewerPolicy(bytes);
  value.context.runChecksPolicy = freezeRepoRunChecksPolicy({ authored: bytes, web: bytes, eve: bytes });
  audit(value);
  assert.throws(() => freezeRepoRunChecksPolicy({ authored: bytes, web: bytes, eve: Buffer.from('changed') }));
  for (const mutate of [c => c.protocol = 'syna-repository-fault-v2', c => c.runChecksPolicy = null, c => c.reviewerPolicy = null,
    c => c.reviewerPolicy.hashVersion = 1, c => c.reviewerPolicy.sourceSha256 = 'unknown']) {
    const bad = sample(); mutate(bad.context); assert.throws(() => audit(bad));
  }
});

test('ACK loss still requires one exact failing command and a complete report of that negative result', () => {
  function library() {
    const value = sample(), { state, context } = value;
    state.missions[0].closure_reason = 'investigated'; state.tasks = [state.tasks[0]]; state.waits = [];
    context.scenario = 'REPO-10'; context.variant = 'runner_ack_lost'; context.repo.url = 'https://github.com/syna-autonomy-fixture/library';
    context.oracle = { requiresBrowser: false, script: 'test', directory: '.', command: ['npm', 'test'], expectedExitCode: 1, requiredLogText: ['expected 4, actual 5'] };
    state.jobs = [];
    for (const mode of ['inspect', 'test']) {
      const id = randomUUID(), jobId = randomUUID(), attemptId = randomUUID();
      state.repositories.push({ id, runtime, config: { mode, url: context.repo.url, expectedCommit: context.repo.commit, script: 'test', directory: '.' },
        job: { id: jobId, commit: context.repo.commit, status: mode === 'test' ? 'failed' : 'review', finishedAt: at(5), cleanup: { confirmed: true },
          execution: { dispatchId: jobId, attemptId }, fingerprint: 'e'.repeat(64), plan: { command: ['npm', 'test'] }, testExitCode: 1, logs: 'expected 4, actual 5' } });
      state.attempts.push({ id: attemptId, dispatch_id: jobId, status: 'completed', finished_at: at(5), lease_until: null });
    }
    const check = state.repositories[1], evidenceId = `repo:${check.id}`;
    state.reports[0].document = { partial: false, tests: [], findings: [{ verdict: 'supported', evidenceIds: [evidenceId] }], evidence: [{ id: evidenceId, read: true }] };
    state.reports[0].read_receipts = [{ id: evidenceId, limited: false, digest: 'f'.repeat(64) }];
    context.fault = { ...context.fault, variant: context.variant, jobId: check.job.id, attemptId: check.job.execution.attemptId,
      dispatchId: check.job.execution.dispatchId, fingerprint: check.job.fingerprint, upstreamAccepted: true, clientReceiptDropped: true };
    return value;
  }
  const good = library(); assert.equal(audit(good).report.document.partial, false);
  for (const mutate of [s => s.repositories.push(s.repositories[1]), (s, c) => c.fault.jobId = randomUUID(),
    s => s.repositories[1].job.testExitCode = 0, s => s.reports[0].read_receipts[0].limited = true]) {
    const bad = library(); mutate(bad.state, bad.context); assert.throws(() => audit(bad));
  }
});
