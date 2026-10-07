import assert from 'node:assert/strict';
import { runChecks } from '../../shared/test-run.ts';
import { auditBoundedWebRuns, sha256 } from './autonomy-web-audit.mjs';
import { auditRepoCompletion } from './repo-benchmark-audit.mjs';

const key = run => `${run.item_id}:${run.case_id}`;
const currentReview = (state, id) => state.reviews.filter(row => row.run_id === id && row.status === 'completed')
  .sort((a, b) => Date.parse(b.finished_at) - Date.parse(a.finished_at) || b.id.localeCompare(a.id))[0];
const selection = mission => ({ caseKeys: [...mission.config.caseKeys].sort(), criteria: mission.config.criteria,
  target: mission.config.target, planRevision: mission.plan_revision, mandateRevision: mission.mandate_revision, deadlineAt: mission.deadline_at });

/** Bind the imported check projection to the same source as both running
 * services; a later authored edit cannot silently change the test oracle. */
export function freezeRepoRunChecksPolicy({ authored, web, eve }, previous) {
  assert.ok(Buffer.isBuffer(authored) && authored.length && Buffer.isBuffer(web) && Buffer.isBuffer(eve));
  assert.ok(authored.equals(web) && web.equals(eve), 'Run-check policy differs from frozen services');
  const policy = { version: 1, sourceSha256: sha256(authored) };
  if (previous) assert.deepEqual(policy, previous, 'Run-check policy changed during the trial');
  return policy;
}

/** External oracle only: prove authorization/history before choosing a later
 * result. Nothing here permits or drives an executor or changes stored data. */
export function auditRepoCurrentRuns(state, context) {
  const mission = state.missions[0]; assert.ok(context.reviewerPolicy, 'Explicit frozen reviewer policy required');
  assert.ok(state.runs.length && context.history?.length, 'Original selection history is required');
  const firstStart = Math.min(...state.runs.map(run => Date.parse(run.started_at))); assert.ok(Number.isFinite(firstStart));
  const frozen = context.history.filter(snapshot => Number.isFinite(Date.parse(snapshot.at)) && Date.parse(snapshot.at) <= firstStart)
    .map(snapshot => ({ at: snapshot.at, mission: snapshot.missions?.find(row => row.id === mission.id) }))
    .filter(row => row.mission?.config?.caseKeys?.length).sort((a, b) => Date.parse(a.at) - Date.parse(b.at))[0];
  assert.ok(frozen, 'No observed original selection predates first execution');
  assert.deepEqual(selection(mission), selection(frozen.mission), 'Original case/criterion/target/epoch selection changed after authorization');
  for (const run of state.runs) {
    const attempt = state.attempts.find(row => row.id === run.mission_attempt_id);
    assert.ok(attempt?.kind === 'browser_tests', 'Run is not bound to its browser attempt');
    const times = [run.started_at, run.finished_at, attempt.created_at, attempt.deadline_at, mission.deadline_at];
    assert.ok(times.every(value => value && Number.isFinite(Date.parse(value))), 'Run/attempt/mission timing is incomplete');
    const [start, finish, created, attemptDeadline, missionDeadline] = times.map(value => Date.parse(value));
    assert.ok(start >= created && start <= finish && finish <= Math.min(attemptDeadline, missionDeadline), 'Run escaped its original execution deadline');
    const version = state.versions?.find(row => row.item_id === run.item_id && row.version === run.plan_version);
    assert.ok(version?.content?.kind === 'test_plan');
    const cases = version.content.cases.filter(row => row.id === run.case_id); assert.equal(cases.length, 1, 'Ambiguous or absent frozen plan case');
    assert.deepEqual(run.snapshot, cases[0], 'Run snapshot differs from original persisted plan case');
    const review = currentReview(state, run.id); assert.ok(review, 'Original/current run lacks review');
    assert.deepEqual(review.input.requirements, runChecks(run.snapshot), 'Review omitted or changed original requirement text');
  }
  const bounded = auditBoundedWebRuns(state, context);
  assert.equal(bounded.currentRuns.length, mission.config.caseKeys.length);
  return { ...bounded, selectionObservedAt: frozen.at };
}

/** v1 remains unchanged. Its final source/HTTP/probe/oracle checks run only on
 * the current exact runs after the v2 full history/typed-complement proof. */
export function auditRepoCompletionV2(state, context) {
  if (!context.oracle.requiresBrowser) return auditRepoCompletion(state, context);
  const bounded = auditRepoCurrentRuns(state, context), ids = new Set(bounded.currentRuns.map(run => run.id));
  const latestReviews = bounded.currentRuns.map(run => currentReview(state, run.id));
  const projection = { ...state, runs: bounded.currentRuns, reviews: latestReviews };
  const result = auditRepoCompletion(projection, { ...context, traces: context.traces.filter(value => ids.has(value.capture.run_id)) });
  assert.deepEqual(result.report.document.tests.map(row => row.runId).sort(), [...ids].sort(), 'Final report must bind the exact latest selected runs');
  return { ...result, complements: bounded.complements, verifiedDefects: bounded.verifiedDefects,
    reviewScope: { originalSelectionObservedAt: bounded.selectionObservedAt, originalRequirementsExact: true,
      currentRunByCase: bounded.currentRuns.map(run => ({ caseKey: key(run), runId: run.id })),
      semanticCoverage: 'independent_review_pending', limitation: 'Structural identity and byte reads do not establish the semantic completeness of every natural-language subcondition. Independent prose/evidence review remains mandatory; original failed trials are never recertified.' } };
}
