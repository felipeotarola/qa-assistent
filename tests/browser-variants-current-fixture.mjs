import assert from 'node:assert/strict';
import { runChecks } from '../shared/test-run.ts';
import { auditReviewInputHash, sha256 } from './helpers/autonomy-web-audit.mjs';

const clone = value => structuredClone(value), time = minute => `2026-10-06T10:${String(minute).padStart(2, '0')}:00.000Z`, hash = 'a'.repeat(64);
function example() {
  const runtime = 'autonomy-test:repo-v2', target = { url: 'http://172.30.0.2:3000/', revision: 'a'.repeat(40), environment: 'isolated' };
  const repo = { url: 'https://github.com/syna-autonomy-fixture/keyless', commit: target.revision, executionImage: 'sha256:' + hash, lockfileSha256: hash };
  const cases = ['home', 'broken'].map(id => ({ id, type: 'browser', title: id, preconditions: '', steps: '1. Open the named link.', expected: id === 'home' ? 'Home points to / and Help points to /help.' : 'Contact opens a page.' }));
  const mission = { id: 'mission', runtime, lifecycle: 'closed', closure_reason: 'investigated', lease_until: null, deadline_at: time(30), plan_revision: 1, mandate_revision: 1, mandate: { limits: { maxSupplementRounds: 2 } }, config: { target, caseKeys: ['plan:home', 'plan:broken'], criteria: [{ id: 'qa', delivery: { kind: 'test_cases', caseKeys: ['plan:home', 'plan:broken'] } }] } };
  const state = { missions: [mission], versions: [{ item_id: 'plan', version: 1, created_at: time(0), content: { kind: 'test_plan', cases } }], tasks: [], attempts: [], runs: [], reviews: [], captures: [], jobs: [], claims: [], browsers: [], events: [], reports: [], repositories: [], setups: [] };
  const context = { runtime, repo, reviewerPolicy: { reviewerVersion: '10', hashVersion: 2, sourceSha256: hash }, byteEvidence: new Set(), traces: [], history: [], oracle: { requiresBrowser: true, requiresConfiguration: false, observations: [] } };
  for (const c of cases) {
    const id = `run-${c.id}`, tid = `task-${c.id}`, aid = `attempt-${c.id}`, evidence = `trace-${c.id}`, requirements = runChecks(c), negative = c.id === 'broken';
    const run = { id, item_id: 'plan', case_id: c.id, plan_version: 1, snapshot: clone(c), runtime, target: clone(target), mission_attempt_id: aid, started_at: time(1), finished_at: time(2), result: { schemaVersion: 2, outcome: negative ? 'failed' : 'passed', remaining: [], checks: requirements.map(r => ({ id: r.id, status: negative ? 'mismatch' : 'verified', actual: negative ? 'The link returned 404.' : 'Named targets observed.' })) } };
    state.runs.push(run);
    state.tasks.push({ id: tid, state: 'completed', created_at: time(0), plan_revision: 1, supplement_round: 0, spec: { kind: 'browser_tests', caseKeys: [`plan:${c.id}`], planVersions: [{ itemId: 'plan', version: 1 }], target: clone(target) } });
    state.attempts.push({ id: aid, task_id: tid, status: 'completed', kind: 'browser_tests', dispatch_id: aid, operation_id: tid, plan_revision: 1, mandate_revision: 1, supplement_round: 0, created_at: time(0), finished_at: time(2), deadline_at: time(25), lease_until: null });
    const review = { id: `review-${c.id}`, run_id: id, status: 'completed', reviewer_version: '10', source_hash: sha256(id), finished_at: time(3), input: { schemaVersion: 2, runId: id, planVersion: 1, target: clone(target), requirements, reportedResult: clone(run.result), evidence: [{ id: evidence, itemId: evidence, readStatus: 'read', sha256: hash }] }, assessment: { verdict: 'supported', findings: requirements.map(r => ({ requirementId: r.id, verdict: 'supported', evidenceIds: [evidence], gap: null })) } };
    review.input_hash = auditReviewInputHash(review.input); state.reviews.push(review);
    const capture = { item_id: evidence, run_id: id, provenance: { producer: 'browser-action', sha256: hash } };
    state.captures.push(capture, { run_id: id, item_id: `png-${id}`, provenance: { producer: 'test-capture', sha256: hash } }); context.byteEvidence.add(evidence); context.byteEvidence.add(`png-${id}`);
    const trace = { action: negative ? 'click' : 'open', outcome: 'observed', fromUrl: target.url, toUrl: target.url + (negative ? 'contact-old' : ''), httpStatus: negative ? 404 : 200, observation: { text: negative ? 'Not found' : 'Home' } };
    context.traces.push({ capture, trace }); context.oracle.observations.push({ action: trace.action, toPath: negative ? '/contact-old' : '/', status: trace.httpStatus, text: trace.observation.text, outcome: run.result.outcome });
    state.jobs.push({ id: aid, status: 'completed', dispatch_lease_until: null });
  }
  const env = { repoUrl: repo.url, commit: repo.commit, observedAt: time(0), executionProfile: { imageDigest: repo.executionImage, lockfileSha256: hash, ignoreScripts: true } };
  state.setups = [{ id: 'prepare', autonomy: { environmentExecution: { phase: 'prepare' } }, result: { environment: { ...env, probeKind: 'identity' }, executorStopped: true, cleanup: 'confirmed' } }, { id: 'apply', autonomy: { environmentExecution: { phase: 'apply', sourceSetupJobId: 'prepare', plan: { commit: repo.commit }, consent: null } }, result: { environment: { ...env, probeKind: 'http', httpStatus: 200 }, executorStopped: true, cleanup: 'confirmed' } }];
  state.events.push({ kind: 'environment.ready', payload: { setupJobId: 'apply' } });
  state.attempts.push({ id: 'inspect', dispatch_id: 'inspect', kind: 'discovery', status: 'completed', finished_at: time(0), lease_until: null });
  state.attempts.push({ id: 'preview', dispatch_id: 'preview', kind: 'preview_discovery', status: 'completed', finished_at: time(0), lease_until: null });
  state.repositories = [{ id: 'repository', runtime, config: { mode: 'inspect', url: repo.url }, job: { status: 'review', commit: repo.commit, cleanup: { confirmed: true }, finishedAt: time(0), execution: { attemptId: 'inspect', dispatchId: 'inspect' } } }];
  context.history.push({ at: time(0), missions: clone(state.missions), runs: [] });
  report(state, context); return { state, context };
}
function report(state, context) {
  const runs = state.runs.filter((run, i, all) => !all.slice(i + 1).some(other => other.case_id === run.case_id));
  state.reports = [{ id: 'report', status: 'completed', item_id: 'report-item', finished_at: time(20), lease_until: null, document: { partial: false, tests: runs.map(run => ({ runId: run.id, originalOutcome: run.result.outcome, status: run.result.outcome, review: 'supported' })), findings: [], evidence: [] }, read_receipts: [] }];
  for (const run of runs) {
    const capture = state.captures.find(c => c.run_id === run.id && c.provenance.producer === 'browser-action'), id = 'item:' + capture.item_id;
    state.reports[0].document.findings.push({ criterionId: 'qa', verdict: 'supported', evidenceIds: [id] });
    state.reports[0].document.evidence.push({ id, itemId: capture.item_id, read: true }); state.reports[0].read_receipts.push({ id, digest: hash, limited: false });
    assert.ok(context.byteEvidence.has(capture.item_id));
  }
}
function complement(value, caseId = 'home') {
  const { state, context } = value, oldRun = state.runs.filter(run => run.case_id === caseId).at(-1), oldAttempt = state.attempts.find(a => a.id === oldRun.mission_attempt_id), oldTask = state.tasks.find(t => t.id === oldAttempt.task_id), oldReview = state.reviews.find(r => r.run_id === oldRun.id);
  const round = oldAttempt.supplement_round + 1, caseKey = `plan:${caseId}`, id = `${caseId}-complement-${round}`, created = time(round * 4), finish = time(round * 4 + 1), reviewed = time(round * 4 + 2);
  oldReview.assessment.verdict = 'needs_evidence'; const finding = oldReview.assessment.findings.find(f => f.requirementId === 'expected'); finding.verdict = 'needs_evidence'; finding.evidenceIds = []; finding.gap = { kind: 'missing_observation', capability: 'browser', wantedEvidence: 'Observe the original missing link destination.' };
  const gapId = sha256(JSON.stringify({ caseKey, checkId: 'expected', kind: 'missing_observation', planRevision: 1 }));
  const binding = { version: 1, sourceTaskId: oldTask.id, sourceAttemptId: oldAttempt.id, runId: oldRun.id, assessmentId: oldReview.id, inputHash: oldReview.input_hash, sourceHash: oldReview.source_hash, reviewerVersion: '10', planRevision: 1, caseKey, gapIds: [gapId] };
  const reviewTask = { id: `review-task-${id}`, state: 'completed', plan_revision: 1, spec: { kind: 'review', runIds: [oldRun.id] } };
  const task = { id, state: 'completed', plan_revision: 1, supplement_round: round, operation_id: `complement:1:${caseKey}:${round}`, created_at: created, depends_on: [reviewTask.id], spec: { kind: 'browser_tests', caseKeys: [caseKey], planVersions: [{ itemId: 'plan', version: 1 }], target: clone(oldRun.target), complement: binding } };
  const attempt = { id, task_id: id, kind: 'browser_tests', status: 'completed', dispatch_id: id, operation_id: task.operation_id, plan_revision: 1, mandate_revision: 1, supplement_round: round, created_at: created, finished_at: finish, deadline_at: time(25), lease_until: null };
  const run = { ...clone(oldRun), id: `run-${id}`, mission_attempt_id: id, started_at: created, finished_at: finish };
  const evidence = `trace-${id}`, capture = { item_id: evidence, run_id: run.id, provenance: { producer: 'browser-action', sha256: hash } };
  const review = { ...clone(oldReview), id: `review-${id}`, run_id: run.id, source_hash: sha256(run.id), finished_at: reviewed, input: { ...clone(oldReview.input), runId: run.id, evidence: [{ id: evidence, itemId: evidence, readStatus: 'read', sha256: hash }] }, assessment: { verdict: 'supported', findings: oldReview.input.requirements.map(req => ({ requirementId: req.id, verdict: 'supported', evidenceIds: [evidence], gap: null })) } }; review.input_hash = auditReviewInputHash(review.input);
  context.history.push({ at: oldReview.finished_at, missions: clone(state.missions), runs: clone(state.runs) });
  state.tasks.push(reviewTask, task); state.attempts.push(attempt); state.runs.push(run); state.reviews.push(review); state.jobs.push({ id, status: 'completed', dispatch_lease_until: null });
  state.captures.push(capture, { item_id: `png-${run.id}`, run_id: run.id, provenance: { producer: 'test-capture', sha256: hash } }); context.byteEvidence.add(evidence); context.byteEvidence.add(`png-${run.id}`);
  context.traces.push({ capture, trace: clone(context.traces.find(t => t.capture.run_id === oldRun.id).trace) });
  const event = { kind: 'complement_planned', event_key: `complement-considered:${oldReview.id}:${oldReview.input_hash}`, created_at: created, payload: { taskId: id, runId: oldRun.id, assessmentId: oldReview.id, caseKey, round, reason: null, gapIds: [gapId] } }; state.events.push(event);
  report(state, context); return { oldRun, oldReview, task, attempt, run, review, event };
}

export { example, complement, report, clone, time, hash };
