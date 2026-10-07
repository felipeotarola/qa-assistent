/**
 * Pure off/on observation contract. All effects belong to explicit ports.
 * Ports: now, wait, save; verify (actual immutable build/process receipt),
 * observe (readonly original rows + exclusive=true + scopeExclusions=[]),
 * probe (ordinary rejected request with zero inserts), physical (exact owned
 * browser session/service receipt), schedulerCursor/schedulerSince (readonly
 * successful scheduler receipts), stopWeb/startWeb (same owned web only).
 * The caller owns admission to an exclusive test window and bounded transport.
 * It must validate provider ledger shapes and physical receipt provenance;
 * no self-reported JSON can itself certify a real process or provider call.
 * No SQL, credentials, process library, private path, fixture ID or product
 * imports live here. A synthetic port test never proves a real flag toggle.
 * An observed result always retains gate=false and independentReview=pending.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

export const PROTOCOL = 'syna-admission-toggle-contract-v1';
export const hash = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');
const uuid = value => assert.match(value, /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/);
const digest = value => assert.match(value, /^[a-f0-9]{64}$/);
const time = value => {
  const result = Date.parse(value);
  assert.ok(Number.isFinite(result));
  return result;
};
const exact = (value, keys) => assert.deepEqual(Object.keys(value).sort(), [...keys].sort());
const terminal = new Set(['completed', 'failed', 'cancelled']);

export function validateManifest(m) {
  exact(m, [
    'protocol', 'sourceHash', 'runtime', 'workflowStoreId', 'modelRequestIntervalMs', 'userId', 'browser', 'report', 'features', 'code', 'scopeExclusions'
  ]);
  assert.deepEqual(m.scopeExclusions, [], 'Generic gate does not permit scope exclusions');
  assert.equal(m.protocol, PROTOCOL);
  digest(m.sourceHash);
  uuid(m.workflowStoreId);
  uuid(m.userId);
  assert.match(m.runtime, /^autonomy-test:[a-z0-9-]+$/);
  assert.ok(Number.isSafeInteger(m.modelRequestIntervalMs) && m.modelRequestIntervalMs >= 0 && m.modelRequestIntervalMs <= 60000);
  exact(m.browser, [
    'workspaceId', 'threadId', 'missionId', 'attemptId', 'jobId', 'irisSessionId', 'physicalSessionId'
  ]);
  exact(m.report, [
    'workspaceId', 'threadId', 'missionId', 'attemptId', 'reportId'
  ]);
  for (const [key, value] of Object.entries(m.browser))
    key === 'irisSessionId' ? assert.match(value, /^[\w-]{1,200}$/) : uuid(value);
  Object.values(m.report).forEach(uuid);
  assert.notEqual(m.browser.missionId, m.report.missionId);
  assert.notEqual(m.browser.workspaceId, m.report.workspaceId);
  assert.ok(m.features && typeof m.features === 'object' && !Array.isArray(m.features));
  assert.ok(Object.keys(m.features).length <= 20);
  Object.values(m.features).forEach(value => assert.equal(typeof value, 'boolean'));
  assert.ok(Object.keys(m.code).length >= 6);
  Object.values(m.code).forEach(digest);
  return m;
}
export function assertRuntime(m, built, original) {
  assert.equal(built.sourceSha256, m.sourceHash);
  const r = built.runtime;
  assert.equal(r.mode, 'application');
  assert.equal(r.workflowStore.id, m.workflowStoreId);
  assert.equal(r.workflowStore.sourceSha256, m.sourceHash);
  assert.equal(r.modelRequestIntervalMs, m.modelRequestIntervalMs);
  assert.ok(!r.reportFault && !r.securityContext);
  assert.ok(built.processIdentity.web && built.processIdentity.eve, 'Both actual process identities must be verified');
  assert.deepEqual(r.features, m.features);
  if (original) {
    assert.deepEqual(built.processIdentity.eve, original.processIdentity.eve, 'Eve/scheduler must not restart');
    assert.equal(built.dependencySha256, original.dependencySha256);
    assert.deepEqual(built.services, original.services, 'Compiled build identity changed');
    assert.deepEqual(r.workflowStore, original.runtime.workflowStore);
    assert.deepEqual(r.features, original.runtime.features);
  }
}
// Compare starts/operation admissions, not tokens or tool-call counters. Late
// immutable FINISH/usage receipts are deliberately allowed while admission is off.
export function admissionKeys(state) {
  const keys = state.attempts.flatMap(a => a.tool_call_ids.filter(id => /^[a-f0-9]{64}:[a-f0-9]{64}$/.test(id)
    || id.startsWith('server:iris-model:start:') || id.startsWith('server:queue-model:start:')).map(id => hash([a.id, id])));
  for (const e of state.events.filter(e => e.kind === 'planning_model_started'))
    keys.push(hash([e.mission_id, e.event_key, e.payload]));
  return [...new Set(keys)].sort();
}
export function assertScope(m, state, original) {
  assert.equal(state.exclusive, true, 'Other pending autonomous/legacy work or resource claims exist');
  assert.deepEqual(state.scopeExclusions, [], 'Observer must attest zero scope exclusions');
  assert.equal(state.missions.length, 2);
  for (const subject of [m.browser, m.report]) {
    const mission = state.missions.find(row => row.id === subject.missionId);
    assert.ok(mission);
    assert.equal(mission.user_id, m.userId);
    assert.equal(mission.workspace_id, subject.workspaceId);
    assert.equal(mission.thread_id, subject.threadId);
    assert.equal(mission.runtime, m.runtime);
    assert.equal(mission.controller_version, 1);
    const attempt = state.attempts.find(row => row.id === subject.attemptId);
    assert.ok(attempt);
    assert.equal(attempt.mission_id, mission.id);
    assert.equal(attempt.runtime, m.runtime);
    if (original) {
      const prior = original.missions.find(row => row.id === mission.id), priorAttempt = original.attempts.find(row => row.id === attempt.id);
      for (const field of [
        'mandate_revision', 'plan_revision', 'deadline_at', 'binding_hash', 'report_latest_at'
      ])
        assert.deepEqual(mission[field], prior[field], `Changed mission ${field}`);
      if (prior.report_deadline_at !== null)
        assert.equal(mission.report_deadline_at, prior.report_deadline_at, 'Original queued report deadline changed');
      else if (mission.report_deadline_at !== null)
        assert.ok(time(mission.report_deadline_at) <= time(prior.report_latest_at), 'New final delivery exceeds original mandate');
      for (const field of [
        'task_id', 'operation_id', 'dispatch_id', 'request_hash', 'deadline_at', 'mandate_revision', 'plan_revision'
      ])
        assert.deepEqual(attempt[field], priorAttempt[field], `Changed original attempt ${field}`);
    }
  }
  const job = state.jobs.find(row => row.id === m.browser.jobId);
  assert.ok(job, 'Original browser job must remain observable');
  assert.equal(job.runtime, m.runtime);
  assert.equal(job.thread_id, m.browser.threadId);
  assert.equal(job.session_id, m.browser.irisSessionId);
  assertReportBinding(m, state);
}
function assertReportBinding(m, state) {
  const mission = state.missions.find(row => row.id === m.report.missionId);
  assert.equal(mission?.admission_intent, 'report_only', 'The original second workload must be report-only');
  const attempt = state.attempts.find(row => row.id === m.report.attemptId);
  assert.ok(attempt);
  assert.equal(attempt.kind, 'report');
  assert.equal(attempt.executor_resource_id, m.report.reportId);
  const task = state.tasks.find(row => row.id === attempt.task_id);
  assert.ok(task);
  assert.equal(task.mission_id, m.report.missionId);
  assert.equal(task.kind, 'report');
  assert.equal(task.purpose ?? 'final', 'final', 'An interim cannot stand in for the queued final report');
  const report = state.reports.find(row => row.id === m.report.reportId);
  assert.ok(report);
  assert.equal(report.mission_id, m.report.missionId);
  assert.equal(report.purpose ?? 'final', 'final');
}
export function assertWindow(m, state, now) {
  assertScope(m, state);
  const a = state.attempts.find(row => row.id === m.browser.attemptId), b = state.attempts.find(row => row.id === m.report.attemptId);
  assert.equal(a.kind, 'browser_tests');
  assert.ok(['running', 'dispatch_unknown'].includes(a.status));
  assert.equal(a.dispatch_id, m.browser.jobId);
  assert.equal(b.kind, 'report');
  assert.ok(['running', 'dispatching', 'dispatch_unknown'].includes(b.status));
  assert.equal(b.executor_resource_id, m.report.reportId);
  for (const attempt of [a, b])
    assert.ok(time(attempt.deadline_at) > now + 540000, 'Original attempt needs the entire fixed observation window');
  const job = state.jobs.find(row => row.id === m.browser.jobId);
  assert.ok(job && !terminal.has(job.status));
  assert.equal(job.session_id, m.browser.irisSessionId);
  const assignment = state.browsers.find(row => row.workspace_id === m.browser.workspaceId && row.agent_id === job.session_id);
  assert.equal(assignment?.session_id, m.browser.physicalSessionId);
  assert.equal(assignment.control, 'agent');
  assert.ok(state.claims.some(c => c.attempt_id === a.id && c.executor_resource_id === m.browser.physicalSessionId && c.owner === 'agent'));
  assert.ok(a.tool_call_ids.some(id => id.startsWith('server:iris-model:start:')), 'No original physical Iris admission');
  assertQueued(m, state);
}
export function assertQueued(m, state) {
  assertReportBinding(m, state);
  const report = state.reports.find(row => row.id === m.report.reportId);
  assert.ok(report && report.mission_id === m.report.missionId);
  assert.equal(report.status, 'queued');
  assert.equal(report.attempts, 0);
  assert.equal(report.item_id, null);
  assert.equal(report.finished_at, null);
  const a = state.attempts.find(row => row.id === m.report.attemptId);
  assert.ok(!a.tool_call_ids.some(id => id.startsWith('server:queue-model:start:')), 'Report model already started');
}
export function assertOff(m, baseline, state) {
  assertScope(m, state, baseline);
  assertQueued(m, state);
  assert.deepEqual(admissionKeys(state), admissionKeys(baseline), 'New model/tool admission while off');
  assert.deepEqual(state.attempts.map(a => a.id).sort(), baseline.attempts.map(a => a.id).sort(), 'New logical attempt while off');
  assert.deepEqual(state.jobs.map(j => [j.id, j.session_id]).sort(), baseline.jobs.map(j => [j.id, j.session_id]).sort(), 'New/replaced Iris job');
}
export function cleanupConfirmed(m, state, physical) {
  const job = state.jobs.find(row => row.id === m.browser.jobId);
  return !!job && job.session_id === m.browser.irisSessionId && job.runtime === m.runtime && job.thread_id === m.browser.threadId && terminal.has(job.status)
    && !state.claims.some(c => c.attempt_id === m.browser.attemptId)
    && !state.browsers.some(b => b.session_id === m.browser.physicalSessionId)
    && physical.sessionId === m.browser.physicalSessionId && physical.status === 404
    && physical.health?.ready === true && physical.health.activeSessions === 0 && physical.health.startingSessions === 0;
}
export function reportResumed(m, baseline, state) {
  assertScope(m, state, baseline);
  const report = state.reports.find(row => row.id === m.report.reportId), attempt = state.attempts.find(a => a.id === m.report.attemptId);
  assert.equal(attempt.executor_resource_id, m.report.reportId);
  if (report?.status !== 'completed')
    return false;
  assert.ok(report.item_id && report.item_present === true && report.finished_at && time(report.finished_at) <= time(attempt.deadline_at));
  assert.ok(attempt.tool_call_ids.some(id => id.startsWith(`server:queue-model:start:report:${report.id}:`)), 'No actual writer admission after re-enable');
  assert.ok(attempt.usage?.provider?.providerCalls > 0, 'Missing measured physical writer receipt');
  assert.ok(report.read_receipts.some(r => r.limited === false && r.hash === r.digest), 'No full actual evidence read');
  assert.equal(state.reports.filter(r => r.mission_id === m.report.missionId && r.item_id).length, 1, 'Duplicate final artifacts');
  return state.missions.every(row => row.lifecycle === 'closed') && state.claims.length === 0;
}
// Ports are the reviewed local runtime helpers and read-only observers. This is
// a fixed scenario, not a reusable fault engine: exactly off once and on once.
export async function runToggleWindow(m, p) {
  validateManifest(m);
  const started = p.now(), deadline = started + 540000, originalPorts = p;
  const assertLive = () => assert.ok(p.now() < deadline, 'Frozen observation deadline expired');
  // Check both sides of awaits: a suspended host or slow observer must never
  // turn an expired observation into a successful receipt. Failure restoration
  // uses the original ports so the deadline cannot prevent restoring web on.
  p = { ...p };
  for (const name of [
    'verify', 'observe', 'probe', 'physical', 'stopWeb', 'startWeb', 'wait', 'schedulerCursor', 'schedulerSince'
  ]) {
    p[name] = async (...args) => {
      assertLive();
      const result = await originalPorts[name](...args);
      assertLive();
      return result;
    };
  }
  const before = await p.verify();
  assertRuntime(m, before);
  const initial = await p.observe();
  assertWindow(m, initial, started);
  const initiallyEnabled = await p.probe(true);
  assert.equal(initiallyEnabled.status, 400);
  assert.equal(initiallyEnabled.reason, 'empty_report_selection');
  assert.equal(initiallyEnabled.insertedMissions, 0);
  const originalPhysical = await p.physical();
  assert.equal(originalPhysical.status, 200);
  assert.equal(originalPhysical.sessionId, m.browser.physicalSessionId);
  assert.ok(originalPhysical.serviceIdentity, 'Physical service identity must be observed before toggle');
  let restore = false;
  const proof = {
    protocol: PROTOCOL, startedAt: new Date(started).toISOString(), deadlineAt: new Date(deadline).toISOString(), result: 'running', gate: false, semanticReview: 'not_evaluated', scopeExclusions: m.scopeExclusions, scope: 'Original admissions, queued writer and original browser cleanup; not atomic cancellation of already admitted effects. No scope exclusions are accepted.'
  };
  await p.save('armed', proof);
  try {
    restore = true;
    const stopped = await p.stopWeb();
    assert.ok(stopped.stoppedPids.includes(before.runtime.web.pid));
    const baseline = await p.observe();
    assertWindow(m, baseline, started); // No post-stop repair of a missed window.
    let previous = baseline;
    const observeBound = async () => {
      const next = await p.observe();
      assertScope(m, next, previous);
      previous = next;
      return next;
    };
    await p.save('stopped-baseline', baseline);
    await p.startWeb(false);
    const off = await p.verify();
    assertRuntime(m, off, before);
    assert.notEqual(off.runtime.web.pid, before.runtime.web.pid);
    const probe = await p.probe(false);
    assert.equal(probe.status, 503);
    assert.equal(probe.reason, 'autonomy_disabled');
    assert.equal(probe.insertedMissions, 0);
    await p.save('off-started', {
      runtime: off, probe
    });
    const offUntil = p.now() + 180000;
    assert.ok(offUntil + 120000 < deadline, 'Restart consumed the frozen window');
    const cursor = await p.schedulerCursor();
    let state;
    do {
      state = await observeBound();
      assertOff(m, baseline, state);
      await p.save('off-observation', state);
      await p.wait(5000);
    } while (p.now() < offUntil);
    assert.ok(p.now() < deadline, 'Frozen observation deadline expired during off window');
    state = await observeBound();
    assertOff(m, baseline, state);
    const scheduled = await p.schedulerSince(cursor), physical = await p.physical();
    assert.deepEqual(physical.serviceIdentity, originalPhysical.serviceIdentity, 'Browser service changed; absence is not a cleanup receipt');
    for (const route of ['/api/internal/autonomy/drain', '/api/internal/mission-reports/drain'])
      assert.ok(scheduled.filter(e => e.path === route && e.status === 200).length >= 2, 'Scheduler did not demonstrably run twice while off');
    assert.ok(cleanupConfirmed(m, state, physical), 'Original terminal/physical cleanup is still unconfirmed');
    await p.save('off-complete', {
      state, scheduled, physical
    });
    await p.stopWeb();
    await p.startWeb(true);
    restore = false;
    const on = await p.verify();
    assertRuntime(m, on, before);
    assert.notEqual(on.runtime.web.pid, off.runtime.web.pid);
    const enabled = await p.probe(true);
    assert.equal(enabled.status, 400);
    assert.equal(enabled.reason, 'empty_report_selection');
    assert.equal(enabled.insertedMissions, 0);
    await p.save('on-started', {
      runtime: on, probe: enabled
    });
    let complete = false;
    while (p.now() < deadline) {
      state = await observeBound();
      complete = reportResumed(m, baseline, state);
      await p.save('on-observation', state);
      if (complete)
        break;
      await p.wait(5000);
    }
    assert.ok(complete, 'Both workloads did not close within the original deadline');
    const finalPhysical = await p.physical();
    assert.deepEqual(finalPhysical.serviceIdentity, originalPhysical.serviceIdentity);
    assert.ok(cleanupConfirmed(m, state, finalPhysical), 'Physical resource remains after re-enable');
    await p.save('final-physical', finalPhysical);
    assertLive();
    proof.result = 'observed';
    proof.observedAt = new Date(p.now()).toISOString();
    proof.independentReview = 'pending';
    await p.save('result', proof);
    return proof;
  }
  finally {
    // Restore only the same verified owned web/build, even when the trigger or
    // audit failed. No deadline/mandate/queue repair, new workflow store or retry.
    if (restore) {
      await originalPorts.stopWeb();
      await originalPorts.startWeb(true);
      const restored = await originalPorts.verify();
      assertRuntime(m, restored, before);
      await p.save('restored-after-failure', {
        runtime: restored, result: 'failed'
      });
    }
  }
}
