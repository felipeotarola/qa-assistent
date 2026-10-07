import assert from 'node:assert/strict';
import { auditRepoCurrentRuns, freezeRepoRunChecksPolicy } from './repo-benchmark-audit-v2.mjs';
import { frozenWebReviewerPolicy, sha256 } from './autonomy-web-audit.mjs';

const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, canonical(child)])) : value;
const digest = value => sha256(JSON.stringify(canonical(JSON.parse(JSON.stringify(value)))));
const key = run => `${run.item_id}:${run.case_id}`;
const time = value => { const parsed = value instanceof Date ? value.getTime() : value != null ? Date.parse(value) : NaN; assert.ok(Number.isFinite(parsed), 'Missing saved execution time'); return parsed; };
const currentReview = (state, runId) => state.reviews.filter(row => row.run_id === runId && row.status === 'completed')
  .sort((a, b) => time(b.finished_at) - time(a.finished_at) || b.id.localeCompare(a.id))[0];

export function freezeBrowserReviewPolicy({ reviewer, runChecks }, previous) {
  assert.deepEqual(reviewer.web, reviewer.eve, 'Browser services use different frozen reviewer sources');
  const value = { reviewerPolicy: frozenWebReviewerPolicy(reviewer.web), runChecksPolicy: freezeRepoRunChecksPolicy(runChecks) };
  if (previous) assert.deepEqual(value, previous, 'Browser review/checkpoint policy changed during the trial');
  return value;
}

/** Human return authorizes the saved task to continue; it is not a P3 gap.
 * Excluded older runs remain individually attested here and in the artifact.
 * No source ID, task, review or round is synthesized for the shared P3 audit. */
function returnedHistory(state, { fault, history, protocol }) {
  if (!fault || protocol?.variant !== 'return-in-time') return { excluded: new Set(), resumptions: [] };
  const mission = state.missions[0], old = state.attempts.find(row => row.id === fault.attemptId), wait = state.waits.find(row => row.id === fault.waitId);
  assert.ok(old && wait?.state === 'answered' && fault.answer, 'Missing exact saved human return');
  assert.equal(fault.answer.action, 'answer'); assert.equal(fault.answer.waitId, wait.id); assert.equal(fault.answer.missionId, mission.id);
  assert.equal(fault.answer.expectedMandateRevision, mission.mandate_revision);
  assert.deepEqual(fault.answer.answer, { kind: 'browser_returned', sessionId: fault.sessionId });
  assert.equal(wait.definition.reason, 'human_browser'); assert.deepEqual(wait.definition.taskIds, [old.task_id]);
  assert.equal(wait.definition.planRevision, mission.plan_revision); assert.equal(wait.definition.mandateRevision, mission.mandate_revision);
  const waitCreatedAt = time(wait.created_at), answeredAt = time(wait.answered_at), acknowledgedAt = time(fault.answeredAt);
  assert.ok(answeredAt >= waitCreatedAt && answeredAt < time(wait.deadline_at) && answeredAt <= acknowledgedAt, 'Saved answer escaped the wait/owner acknowledgment window');
  const events = state.events.filter(row => row.kind === 'control_answer' && row.event_key === `control:${fault.answer.requestId}`);
  assert.equal(events.length, 1); assert.equal(events[0].action_hash, digest(fault.answer)); assert.equal(events[0].payload.waitId, wait.id);
  // PostgreSQL defaultNow is the transaction start; answered_at is recorded
  // later inside that same atomic transaction. Both precede the owner API ack.
  const eventAt = time(events[0].created_at);
  assert.ok(eventAt >= waitCreatedAt && eventAt <= acknowledgedAt, 'Control event escaped the wait/owner acknowledgment window');
  const job = state.jobs.find(row => row.id === old.dispatch_id);
  assert.ok(job?.session_id && ['completed', 'failed'].includes(job.status) && ['completed', 'failed'].includes(old.status) && old.finished_at && !old.cancel_requested_at);
  const observed = history.find(row => time(row.at) <= time(wait.answered_at) && row.browsers?.some(browser => browser.session_id === fault.sessionId
    && browser.agent_id === job.session_id) && row.claims?.some(claim => claim.attempt_id === old.id && claim.executor_resource_id === fault.sessionId));
  assert.ok(observed, 'No observation binds the original human browser to its saved claim/job');
  const resumed = state.attempts.filter(row => row.kind === 'browser_tests' && row.task_id === old.task_id && row.id !== old.id && row.attempt_no > old.attempt_no);
  if (!resumed.length) {
    assert.ok(['reserved', 'running', 'dispatching', 'dispatch_unknown'].includes(fault.attemptStatusAtReturn), 'Terminal original needs a new bounded attempt');
    return { excluded: new Set(), resumptions: [] };
  }
  assert.equal(resumed.length, 1, 'Human return must admit exactly one new bounded attempt for this task');
  const next = resumed[0]; assert.equal(next.attempt_no, old.attempt_no + 1);
  assert.equal(next.mandate_revision, old.mandate_revision); assert.equal(next.plan_revision, old.plan_revision);
  assert.equal(next.supplement_round, old.supplement_round); assert.equal(next.operation_id, old.operation_id);
  assert.ok(time(next.created_at) >= Math.max(eventAt, answeredAt), 'Continuation preceded the atomic saved answer');
  const excluded = new Set(), resumptions = [];
  for (const run of state.runs.filter(row => row.mission_attempt_id === old.id)) {
    const later = state.runs.filter(row => row.mission_attempt_id === next.id && key(row) === key(run));
    if (!later.length) continue;
    assert.equal(later.length, 1); const current = later[0];
    assert.ok(run.result && run.finished_at, 'Unfinished original run cannot disappear on return');
    if (time(run.finished_at) > answeredAt) {
      assert.ok(['reserved', 'running', 'dispatching', 'dispatch_unknown'].includes(fault.attemptStatusAtReturn), 'Terminal return cannot settle its original run after the answer');
      assert.ok(time(run.finished_at) <= time(old.finished_at) && time(old.finished_at) <= time(next.created_at), 'Active original must settle before successor creation');
      // Jobs have no finished_at in this observer. Require an exact terminal
      // job observation before successor creation, not an inferred timestamp.
      assert.ok(history.some(row => time(row.at) <= time(next.created_at)
        && row.jobs?.some(saved => saved.id === job.id && digest(saved) === digest(job))), 'Original job was not terminal before successor creation');
    }
    assert.ok(time(run.started_at) >= time(old.created_at) && time(run.finished_at) <= Math.min(time(old.deadline_at), time(mission.deadline_at)), 'Original return history escaped its execution window');
    assert.equal(run.plan_version, current.plan_version); assert.deepEqual(run.snapshot, current.snapshot); assert.deepEqual(run.target, current.target);
    assert.equal(current.browser_entry_receipt?.sessionId, fault.sessionId, 'Return continued in another physical browser');
    // An inserted reservation is not a started replacement run. Polling may
    // first see the immutable original after reservation but before START.
    const prior = history.find(row => time(row.at) <= time(current.started_at) && row.runs?.some(saved => saved.id === run.id && saved.result && saved.finished_at));
    assert.ok(prior, 'Original completed run was not preserved before continuation');
    assert.equal(digest(prior.runs.find(row => row.id === run.id)), digest(run), 'Original human-interrupted history changed');
    const review = currentReview(state, run.id);
    assert.ok(!(review?.assessment?.verdict === 'supported' && run.result.outcome === 'failed'), 'A supported negative result cannot be retested on human return');
    for (const check of run.result.checks.filter(row => row.status === 'mismatch')) {
      assert.equal(current.result?.checks?.find(row => row.id === check.id)?.status, 'mismatch', 'Human return erased an original negative checkpoint');
    }
    if (run.result.outcome === 'failed') assert.equal(current.result?.outcome, 'failed', 'Human return turned a saved defect green');
    excluded.add(run.id); resumptions.push({ originalRunId: run.id, runId: current.id, taskId: old.task_id,
      originalAttemptId: old.id, attemptId: next.id, waitId: wait.id, eventKey: events[0].event_key, originalSha256: digest(run) });
  }
  return { excluded, resumptions, continuation: { originalAttemptId: old.id, attemptId: next.id, taskId: old.task_id, waitId: wait.id, eventKey: events[0].event_key } };
}

export function auditBrowserCurrentRuns(state, context) {
  assert.ok(context.reviewerPolicy && context.runChecksPolicy?.version === 1, 'Frozen current browser policies required');
  assert.match(context.runChecksPolicy.sourceSha256, /^[a-f0-9]{64}$/);
  const returned = returnedHistory(state, context), projection = { ...state, runs: state.runs.filter(run => !returned.excluded.has(run.id)) };
  const operations = new Map();
  for (const attempt of state.attempts.filter(row => row.status === 'completed')) {
    assert.ok(typeof attempt.operation_id === 'string' && attempt.operation_id.length, 'Missing logical operation identity');
    const rows = operations.get(attempt.operation_id) ?? []; rows.push(attempt); operations.set(attempt.operation_id, rows);
  }
  for (const rows of operations.values()) if (rows.length > 1) {
    assert.equal(rows.length, 2, 'Logical operation completed more than once outside the single saved return');
    assert.ok(returned.continuation && rows.every(row => [returned.continuation.originalAttemptId, returned.continuation.attemptId].includes(row.id)), 'Logical operation duplicated without exact human continuation');
  }
  const bounded = auditRepoCurrentRuns(projection, context);
  return { ...bounded, currentReviews: bounded.currentRuns.map(run => currentReview(state, run.id)), humanResumptions: returned.resumptions,
    humanAttemptContinuations: returned.continuation ? [returned.continuation] : [] };
}
