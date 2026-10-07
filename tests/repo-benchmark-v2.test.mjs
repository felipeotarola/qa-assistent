import test from 'node:test';
import assert from 'node:assert/strict';
import { runChecks } from '../shared/test-run.ts';
import { auditRepoCurrentRuns, auditRepoCompletionV2, freezeRepoRunChecksPolicy } from './helpers/repo-benchmark-audit-v2.mjs';
import { auditRepoCompletion } from './helpers/repo-benchmark-audit.mjs';
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

test('normal chain keeps original exact requirements and current read-byte/report binding', () => {
  const value = example(), original = clone(value.state); assert.equal(auditRepoCompletionV2(value.state, value.context).matched.length, 2); assert.deepEqual(value.state, original);
});
test('one or two typed bounded complements select the latest run without recertifying the older uncertainty', () => {
  for (const count of [1, 2]) { const value = example(); for (let n = 0; n < count; n++) complement(value);
    assert.throws(() => auditRepoCompletion(value.state, value.context), /extra physical rerun/); // v1 remains strict and unchanged
    const result = auditRepoCompletionV2(value.state, value.context); assert.equal(result.complements.length, count);
    assert.equal(result.matched[0].runId, `run-home-complement-${count}`); assert.equal(result.matched[1].runId, 'run-broken');
    assert.equal(result.reviewScope.semanticCoverage, 'independent_review_pending'); assert.equal(value.state.runs.find(run => run.id === 'run-broken').result.outcome, 'failed');
  }
});
for (const [name, mutate] of [
  ['missing typed binding', (v, r) => delete r.task.spec.complement], ['wrong source assessment', (v, r) => r.task.spec.complement.assessmentId = 'other'],
  ['changed source hash', (v, r) => r.task.spec.complement.sourceHash = 'b'.repeat(64)], ['changed source attempt', (v, r) => r.task.spec.complement.sourceAttemptId = 'other'],
  ['different mandate', (v, r) => r.attempt.mandate_revision++], ['different plan epoch', (v, r) => r.task.plan_revision++],
  ['missing event', v => v.state.events.pop()], ['wrong gap', (v, r) => r.task.spec.complement.gapIds = []],
  ['missing original history', v => v.context.history = v.context.history.slice(0, 1)],
  ['overwritten original result', (v, r) => r.oldRun.result.checks[0].actual = 'changed'],
  ['late narrowed selection', v => { v.state.missions[0].config.caseKeys = ['plan:home']; v.state.runs = v.state.runs.filter(r => r.case_id === 'home'); }],
  ['late changed criterion', v => v.state.missions[0].config.criteria[0].delivery.caseKeys = ['plan:home']],
  ['changed plan case', v => v.state.versions[0].content.cases[0].expected = 'Easier requirement'],
  ['changed run requirement', (v, r) => r.run.snapshot.expected = 'Easier requirement'],
  ['truncated reviewer requirement', (v, r) => { r.review.input.requirements[1].requirement = 'Only Help is needed'; r.review.input_hash = auditReviewInputHash(r.review.input); }],
  ['old supported review selected', (v, r) => v.state.reports[0].document.tests[0].runId = r.oldRun.id],
  ['current proof bytes absent', (v, r) => v.context.byteEvidence.delete(`trace-${r.task.id}`)],
  ['supported original incorrectly retested', (v, r) => { r.oldReview.assessment.verdict = 'supported'; for (const f of r.oldReview.assessment.findings) { f.verdict = 'supported'; f.gap = null; f.evidenceIds = [r.oldReview.input.evidence[0].id]; } }],
  ['foreign frozen reviewer', v => v.context.reviewerPolicy.reviewerVersion = '9'],
  ['after original attempt deadline', (v, r) => r.attempt.deadline_at = time(4)],
  ['after original mission deadline', (v, r) => { r.run.finished_at = time(31); r.attempt.deadline_at = time(35); }],
  ['missing original execution deadline', (v, r) => delete r.attempt.deadline_at],
  ['extended mission deadline', v => v.state.missions[0].deadline_at = time(40)],
]) test(`v2 rejects ${name}`, () => { const value = example(), rows = complement(value); mutate(value, rows); assert.throws(() => auditRepoCompletionV2(value.state, value.context)); });
test('a late controller receipt does not reject an execution completed within its original deadline', () => {
  const value = example(), rows = complement(value); rows.attempt.finished_at = time(40);
  assert.equal(auditRepoCompletionV2(value.state, value.context).complements.length, 1);
});
test('run-check projection is frozen against both services and the previous receipt', () => {
  const bytes = Buffer.from('exact frozen source'), other = Buffer.from('changed source');
  const policy = freezeRepoRunChecksPolicy({ authored: bytes, web: bytes, eve: bytes });
  assert.deepEqual(freezeRepoRunChecksPolicy({ authored: bytes, web: bytes, eve: bytes }, policy), policy);
  for (const field of ['authored', 'web', 'eve']) assert.throws(() => freezeRepoRunChecksPolicy({ authored: bytes, web: bytes, eve: bytes, [field]: other }), /differs/);
  assert.throws(() => freezeRepoRunChecksPolicy({ authored: other, web: other, eve: other }, policy), /changed/);
});
test('a third complement and a verified negative checkpoint turning green remain denied', () => {
  const value = example(); complement(value); complement(value); complement(value); assert.throws(() => auditRepoCompletionV2(value.state, value.context), /two bounded complements/);
  const negative = example(), rows = complement(negative, 'broken'); rows.run.result.checks[0].status = 'verified'; rows.run.result.outcome = 'passed'; rows.review.input.reportedResult = clone(rows.run.result); rows.review.input_hash = auditReviewInputHash(rows.review.input); report(negative.state, negative.context);
  assert.throws(() => auditRepoCurrentRuns(negative.state, negative.context), /verified defect was retested until green/);
});
