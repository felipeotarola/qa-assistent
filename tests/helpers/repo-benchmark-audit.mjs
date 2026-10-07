import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';

const key = run => `${run.item_id}:${run.case_id}`;
const terminal = new Set(['completed', 'failed', 'cancelled']);
const path = url => { try { return new URL(url).pathname; } catch { return null; } };
const cited = (report, id) => report.document.evidence.some(e => e.id === id && e.read)
  && report.read_receipts.some(r => r.id === id && !r.limited && /^[a-f0-9]{64}$/.test(r.digest));

function reviewedTrace(state, report, candidate, expected) {
  const { trace, capture } = candidate, run = state.runs.find(r => r.id === capture.run_id);
  if (!run || !['passed', 'failed'].includes(run.result?.outcome) || expected.outcome === 'failed' && run.result.outcome !== 'failed'
    || trace.outcome !== 'observed' || trace.action !== expected.action || path(trace.toUrl) !== expected.toPath
    || expected.fromPath && path(trace.fromUrl) !== expected.fromPath || trace.observation?.text?.includes(expected.text) !== true) return false;
  if (expected.fromPaths && !expected.fromPaths.includes(path(trace.fromUrl))) return false;
  if (new URL(trace.toUrl).origin !== new URL(run.target.url).origin) return false;
  const status = trace.httpStatus;
  // Status is mandatory: rendered "not found" text alone cannot distinguish a soft 404.
  if (status !== expected.status) return false;
  const review = state.reviews.find(r => r.run_id === run.id && r.status === 'completed' && r.assessment?.verdict === 'supported');
  if (!review || !isDeepStrictEqual(review.input.reportedResult, run.result)
    || !isDeepStrictEqual(review.input.target, run.target) || review.input.planVersion !== run.plan_version) return false;
  const needed = expected.outcome === 'failed' ? ['mismatch'] : ['verified', 'mismatch'];
  if (!review || !run.result.checks?.some(c => needed.includes(c.status) && review.assessment.findings.some(f => f.requirementId === c.id && f.verdict === 'supported'
    && f.evidenceIds.some(id => review.input.evidence.some(e => e.id === id && e.itemId === capture.item_id && e.readStatus === 'read'))))) return false;
  const reportTest = report.document.tests.find(t => t.runId === run.id);
  if (!reportTest || reportTest.originalOutcome !== run.result.outcome || reportTest.review !== 'supported') return false;
  return state.missions[0].config.criteria.some(c => c.delivery?.kind === 'test_cases' && c.delivery.caseKeys.includes(key(run))
    && report.document.findings.some(f => f.criterionId === c.id && f.verdict === 'supported' && f.evidenceIds.some(id => cited(report, id)
      && report.document.evidence.some(e => e.id === id && e.itemId === capture.item_id)
      && report.read_receipts.some(r => r.id === id && r.digest === capture.provenance.sha256))));
}

/** Product failure can be a complete QA delivery. Never infer correctness
 * from free text alone, and never silently turn a missing measurement into 0. */
export function auditRepoCompletion(state, { runtime, repo, oracle, traces = [], byteEvidence = new Set(), savedConsent = null }) {
  assert.equal(state.missions.length, 1, 'One measured request must create one mission');
  const mission = state.missions[0]; assert.equal(mission.runtime, runtime); assert.equal(mission.lifecycle, 'closed');
  assert.ok(['investigated', 'criteria_satisfied'].includes(mission.closure_reason)); assert.equal(mission.lease_until, null);
  assert.equal(state.claims.length, 0, 'Physical resource claim remains; logical closure is not cleanup');
  assert.ok(state.tasks.length && state.tasks.every(t => t.state === 'completed'), 'Incomplete task remains');
  assert.ok(state.attempts.length && state.attempts.every(a => terminal.has(a.status) && a.finished_at && !a.lease_until));
  assert.equal(state.reports.length, 1, 'Exactly one immutable final report is expected');
  const report = state.reports[0]; assert.equal(report.status, 'completed'); assert.ok(report.item_id && report.finished_at);
  assert.equal(report.lease_until, null);
  assert.equal(report.document.partial, false);
  assert.ok(report.document.findings.length && report.document.findings.every(f => f.verdict === 'supported'));
  const inspections = state.repositories.filter(r => r.config.mode === 'inspect');
  assert.equal(inspections.length, 1, 'Exactly one inventory operation expected');
  const inspection = inspections[0]; assert.equal(inspection.config.url, repo.url); assert.equal(inspection.job?.commit, repo.commit);
  assert.equal(inspection.job?.status, 'review'); assert.equal(inspection.job?.cleanup?.confirmed, true);
  for (const source of state.repositories) {
    assert.equal(source.runtime, runtime); assert.equal(source.config.url, repo.url); assert.equal(source.job?.commit, repo.commit);
    assert.ok(source.job?.finishedAt); assert.equal(source.job.cleanup?.confirmed, true);
    const attempt = state.attempts.find(a => a.dispatch_id === source.job.execution?.dispatchId);
    assert.ok(attempt && source.job.execution?.attemptId === attempt.id, 'Repository receipt is not bound to its physical attempt');
  }
  if (!oracle.requiresBrowser) {
    assert.equal(state.jobs.length + state.runs.length + state.setups.length, 0, 'Pure library QA must not invent browser/setup work');
    const checks = state.repositories.filter(r => r.config.mode === 'test'); assert.equal(checks.length, 1, 'Regression must not retry until green');
    const check = checks[0]; assert.equal(check.config.expectedCommit, repo.commit); assert.equal(check.config.script, oracle.script);
    assert.equal(check.config.directory, oracle.directory); assert.deepEqual(check.job.plan?.command, oracle.command);
    assert.equal(check.job.testExitCode, oracle.expectedExitCode); assert.equal(check.job.status, 'failed');
    for (const text of oracle.requiredLogText) assert.ok(check.job.logs.includes(text), 'Expected independently identified regression is missing from actual command log');
    const evidenceId = `repo:${check.id}`;
    assert.ok(report.document.findings.some(f => f.evidenceIds.includes(evidenceId) && cited(report, evidenceId)), 'Report did not read/cite the failing command');
    return { report, matched: [{ repositoryRunId: check.id, exitCode: check.job.testExitCode }], limitations: ['Structured command failure and citation verified; exact prose meaning still requires independent reading.'] };
  }
  const prepare = state.setups.filter(s => s.autonomy?.environmentExecution.phase === 'prepare'), apply = state.setups.filter(s => s.autonomy?.environmentExecution.phase === 'apply');
  assert.equal(prepare.length, 1); assert.equal(apply.length, 1);
  for (const job of [...prepare, ...apply]) {
    assert.equal(job.result?.environment?.repoUrl, repo.url); assert.equal(job.result.environment.commit, repo.commit);
    assert.equal(job.result.executorStopped, true); assert.equal(job.result.cleanup, 'confirmed');
    assert.equal(job.result.environment.executionProfile.imageDigest, repo.executionImage);
    assert.equal(job.result.environment.executionProfile.lockfileSha256, repo.lockfileSha256);
    assert.equal(job.result.environment.executionProfile.ignoreScripts, true);
  }
  assert.equal(prepare[0].result.environment.probeKind, 'identity');
  assert.equal(apply[0].result.environment.probeKind, 'http'); assert.ok(apply[0].result.environment.httpStatus >= 200 && apply[0].result.environment.httpStatus < 400);
  assert.ok(apply[0].result.environment.observedAt); assert.equal(apply[0].autonomy.environmentExecution.sourceSetupJobId, prepare[0].id);
  assert.equal(apply[0].autonomy.environmentExecution.plan.commit, repo.commit);
  assert.ok(state.events.some(e => e.kind === 'environment.ready' && e.payload.setupJobId === apply[0].id));
  assert.ok(state.attempts.some(a => a.kind === 'preview_discovery' && a.status === 'completed'));
  assert.ok(state.jobs.length > 0 && state.jobs.every(j => j.status === 'completed' && !j.dispatch_lease_until));
  assert.ok(state.browsers.every(b => !b.session_id));
  assert.ok(state.runs.length > 0 && state.runs.every(r => r.finished_at && r.target?.revision === repo.commit));
  const selected = new Set(mission.config.caseKeys); assert.ok(selected.size > 0);
  assert.equal(report.document.tests.length, selected.size, 'Test totals cannot omit or duplicate selected cases');
  assert.ok([...selected].every(caseKey => state.runs.some(run => key(run) === caseKey)), 'Selected case was never tested');
  for (const caseKey of selected) {
    const runs = state.runs.filter(run => key(run) === caseKey);
    assert.equal(runs.length, 1, 'Normal fixture acceptance expects no extra physical rerun');
    const run = runs[0], review = state.reviews.find(r => r.run_id === run.id && r.status === 'completed' && r.assessment?.verdict === 'supported');
    const reported = report.document.tests.filter(t => t.runId === run.id); assert.equal(reported.length, 1);
    assert.equal(reported[0].originalOutcome, run.result.outcome); assert.equal(reported[0].status, run.result.outcome); assert.equal(reported[0].review, 'supported');
    assert.ok(review, 'Selected test lacks completed review');
    assert.deepEqual(review.input.reportedResult, run.result); assert.deepEqual(review.input.target, run.target); assert.equal(review.input.planVersion, run.plan_version);
    assert.deepEqual(review.assessment.findings.map(f => f.requirementId).sort(), review.input.requirements.map(r => r.id).sort());
    assert.ok(review.assessment.findings.every(f => f.verdict === 'supported' && f.evidenceIds.some(id => review.input.evidence.some(e => e.id === id && e.readStatus === 'read'
      && byteEvidence.has(e.itemId) && state.captures.some(c => c.item_id === e.itemId && c.run_id === run.id && c.provenance?.sha256 === e.sha256)))), 'Review is not bound to actual read bytes for every checkpoint');
    assert.ok(state.captures.some(c => c.run_id === runs[0].id && c.provenance?.producer === 'test-capture' && byteEvidence.has(c.item_id)), 'Selected test lacks actual screenshot bytes');
  }
  const matched = oracle.observations.map(expected => {
    const candidate = traces.find(value => reviewedTrace(state, report, value, expected));
    assert.ok(candidate, `Missing verified ${expected.action} ${expected.toPath} (${expected.status})`);
    return { path: expected.toPath, runId: candidate.capture.run_id, itemId: candidate.capture.item_id, outcome: expected.outcome };
  });
  if (oracle.requiresConfiguration) {
    assert.ok(savedConsent); assert.deepEqual(apply[0].autonomy.environmentExecution.consent, { id: savedConsent.consentId, revision: savedConsent.revision, vaultRevision: savedConsent.vaultRevision });
    assert.equal(apply[0].autonomy.environmentExecution.planHash, savedConsent.planHash);
    const releases = state.events.filter(e => e.kind === 'environment.released' && e.payload.jobId === apply[0].id);
    assert.equal(releases.length, 1); assert.deepEqual([...releases[0].payload.names].sort(), [...oracle.requiredNames].sort());
    assert.ok(apply[0].autonomy.release?.releasedAt); assert.equal(apply[0].autonomy.release.releaseId, releases[0].payload.releaseId);
    assert.equal(state.waits.length, 0, 'A still-valid saved grant must not require user babysitting');
  } else assert.equal(apply[0].autonomy.environmentExecution.consent, null);
  return { report, matched, limitations: ['Saved probe, authenticated trace bytes, exact source binding and report citations verified; independent prose and physical worker cleanup audit remain separate.'] };
}
