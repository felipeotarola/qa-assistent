// Pure negative-control tests for the external oracle, not model acceptance.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { auditReviewInputHash, auditSearchObservation, auditTrace, auditWebCompletion, auditWebFault, sha256, webFaultReady, frozenWebReviewerPolicy } from './autonomy-web-audit.mjs';

const oracle = JSON.parse(await readFile(new URL('../fixtures/autonomy-site/oracle.json', import.meta.url)));
const start = '2026-10-05T15:00:00.000Z', finish = '2026-10-05T15:01:00.000Z';
function example() {
  const target = { environment: 'fixture', url: oracle.origin, revision: 'fixture-v1' };
  const state = { missions: [{ lifecycle: 'closed', closure_reason: 'investigated', lease_until: null, plan_revision: 1, mandate_revision: 1, mandate: { limits: { maxSupplementRounds: 2 } }, config: { target, caseKeys: [], criteria: [] } }], tasks: [], attempts: [], jobs: [], runs: [], reviews: [], captures: [], versions: [], browsers: [], claims: [], reports: [], reportItems: [], events: [] };
  const context = { runtime: 'autonomy-test:unit-oracle', oracle, traces: [], byteEvidence: new Set() };
  for (const check of oracle.expected) {
    const index = check.id, caseKey = `plan:${index}`, runId = `run-${index}`, traceId = `trace-${index}`, screenshotId = `png-${index}`;
    state.missions[0].config.caseKeys.push(caseKey);
    state.missions[0].config.criteria.push({ id: index, delivery: { kind: 'test_cases', caseKeys: [caseKey] } });
    state.tasks.push({ id: index, state: 'completed', plan_revision: 1, supplement_round: 0, created_at: start, spec: { kind: 'browser_tests', caseKeys: [caseKey], planVersions: [{ itemId: 'plan', version: 1 }] } });
    state.attempts.push({ id: index, task_id: index, kind: 'browser_tests', status: 'completed', dispatch_id: index, operation_id: index, finished_at: finish, lease_until: null,
      created_at: start, plan_revision: 1, mandate_revision: 1, supplement_round: 0 });
    state.jobs.push({ id: index, status: 'completed', dispatch_lease_until: null });
    const result = { schemaVersion: 2, outcome: check.classification === 'known_defect' ? 'failed' : 'passed', checks: [{ id: 'step1', status: check.classification === 'known_defect' ? 'mismatch' : 'verified', actual: 'Observed fixture outcome' }] };
    state.runs.push({ id: runId, item_id: 'plan', case_id: index, plan_version: 1, snapshot: { id: index, type: 'browser', steps: ['step1'], expected: 'Original expectation' }, mission_attempt_id: index, runtime: context.runtime, target, started_at: start, finished_at: finish, result });
    state.reviews.push({ id: `review-${runId}`, run_id: runId, status: 'completed', reviewer_version: '6', source_hash: sha256(`source-${runId}`), finished_at: finish,
      assessment: { verdict: 'supported', findings: [{ requirementId: 'step1', verdict: 'supported', evidenceIds: [traceId], gap: null }] }, input: { schemaVersion: 2, runId, reportedResult: result, target, planVersion: 1, requirements: [{ id: 'step1' }], evidence: [{ id: traceId, itemId: traceId, readStatus: 'read' }] } });
    const url = new URL(check.path || '/', oracle.origin);
    for (const name of [...url.searchParams.keys()]) url.searchParams.set(name, '[REDACTED]');
    const action = check.id === 'home' ? 'open' : 'click';
    const trace = { version: 1, browserJobId: index, callId: index, execution: { attemptId: index, dispatchId: index }, action, toUrl: url.href, startedAt: start, finishedAt: finish, outcome: 'observed', httpStatus: check.status,
      observation: { headings: [check.heading || (check.id === 'search' ? 'Brygg[REDACTED]' : '')], text: check.id === 'search' ? '1 produkter för ”[REDACTED]”\nBrygg[REDACTED]\nMellanrostat [REDACTED], 500 g\n79 kr' : check.productCount ? `${check.productCount} produkter` : '' } };
    const bytes = Buffer.from(JSON.stringify(trace));
    state.reviews.at(-1).input.evidence[0].sha256 = sha256(bytes);
    state.reviews.at(-1).input_hash = auditReviewInputHash(state.reviews.at(-1).input);
    const capture = { run_id: runId, item_id: traceId, url: url.href, action: `trace:${action}`, provenance: { origin: 'tool', producer: 'browser-action', sourceType: 'test', sourceId: runId, sha256: sha256(bytes) } };
    state.captures.push(capture, { run_id: runId, item_id: screenshotId, provenance: { producer: 'test-capture' } });
    context.traces.push({ capture, trace }); context.byteEvidence.add(traceId); context.byteEvidence.add(screenshotId);
  }
  state.versions.push({ item_id: 'plan', version: 1, created_at: '2026-10-05T14:59:00.000Z' });
  state.reports.push({ id: 'report', status: 'completed', item_id: 'report-item', lease_until: null,
    document: { partial: false, limitations: [],
      findings: oracle.expected.map(check => ({ criterionId: check.id, verdict: 'supported', conclusion: check.id === 'broken_returns' ? 'Returer gav HTTP 404 efter klick.' : 'Kontrollen utfördes.', evidenceIds: [`item:trace-${check.id}`] })),
      tests: state.runs.map(run => ({ runId: run.id, status: run.result.outcome, originalOutcome: run.result.outcome, review: 'supported' })),
      evidence: context.traces.map(({ capture }) => ({ id: `item:${capture.item_id}`, itemId: capture.item_id, read: true })),
    },
    read_receipts: context.traces.map(({ capture }) => ({ id: `item:${capture.item_id}`, hash: '1'.repeat(64), digest: capture.provenance.sha256, limited: false })),
  });
  state.reportItems.push({ id: 'report-item', version: 1 });
  return { state, context };
}
test('all five actual, reviewed oracle checks pass, including privacy-redacted search', () => {
  const { state, context } = example();
  assert.equal(auditWebCompletion(state, context).matched.length, 5);
  for (const { capture, trace } of context.traces) auditTrace(capture, Buffer.from(JSON.stringify(trace)), state);
});

test('v6 binds the actual frozen reviewer without accepting another version or changing historical v5', () => {
  const bytes = Buffer.from("export const REVIEWER_VERSION = '9';\nexport const REVIEW_HASH_VERSION = 2;\n");
  const reviewerPolicy = frozenWebReviewerPolicy(bytes);
  assert.deepEqual(reviewerPolicy, { reviewerVersion: '9', hashVersion: 2, sourceSha256: sha256(bytes) });
  const { state, context } = example();
  assert.throws(() => auditWebCompletion(state, { ...context, reviewerPolicy }), /frozen reviewer policy/);
  for (const review of state.reviews) review.reviewer_version = '9';
  assert.equal(auditWebCompletion(state, { ...context, reviewerPolicy }).matched.length, 5);
  assert.throws(() => auditWebCompletion(state, context), /frozen reviewer policy/);
  for (const invalid of ["export const REVIEWER_VERSION = getVersion();\nexport const REVIEW_HASH_VERSION = 2;\n", bytes.toString().replace('= 2;', '= 3;'), bytes.toString() + bytes.toString()]) assert.throws(() => frozenWebReviewerPolicy(Buffer.from(invalid)));
});

function addComplement(value, caseId = 'search', { preserveMismatch = false } = {}) {
  const { state, context } = value;
  const source = state.runs.filter(run => run.case_id === caseId).at(-1), oldTask = state.tasks.find(task => task.id === source.mission_attempt_id);
  const oldAttempt = state.attempts.find(row => row.id === source.mission_attempt_id), oldReview = state.reviews.find(row => row.run_id === source.id);
  const round = oldTask.supplement_round + 1, caseKey = `plan:${caseId}`, id = `${caseId}-complement-${round}`;
  const newStart = `2026-10-05T15:${String(round * 2).padStart(2, '0')}:00.000Z`, newFinish = `2026-10-05T15:${String(round * 2 + 1).padStart(2, '0')}:00.000Z`;
  const newRunId = `run-${id}`, traceId = `trace-${id}`, screenshotId = `png-${id}`;
  let gapCheck = 'step1';
  if (preserveMismatch) {
    gapCheck = 'step2'; source.snapshot.steps.push(gapCheck);
    source.result.checks.push({ id: gapCheck, status: 'unverified', actual: 'No observation yet' });
    oldReview.input.requirements.push({ id: gapCheck });
    oldReview.assessment.findings.push({ requirementId: gapCheck, verdict: 'needs_evidence', evidenceIds: [], gap: { kind: 'unverified_step', capability: 'browser', wantedEvidence: 'Observe this original step.' } });
  } else {
    source.result.outcome = 'inconclusive'; source.result.checks[0].status = 'unverified';
    Object.assign(oldReview.assessment.findings[0], { verdict: 'needs_evidence', evidenceIds: [], gap: { kind: 'unverified_step', capability: 'browser', wantedEvidence: 'Observe this original step.' } });
  }
  source.result.remaining = [{ checkId: gapCheck, reason: 'Not observed' }];
  oldReview.assessment.verdict = 'needs_evidence'; oldReview.input_hash = auditReviewInputHash(oldReview.input);
  const gapId = sha256(JSON.stringify({ caseKey, checkId: gapCheck, kind: 'unverified_step', planRevision: 1 }));
  const binding = { version: 1, sourceTaskId: oldTask.id, sourceAttemptId: oldAttempt.id, runId: source.id, assessmentId: oldReview.id,
    inputHash: oldReview.input_hash, sourceHash: oldReview.source_hash, reviewerVersion: '6', planRevision: 1, caseKey, gapIds: [gapId] };
  const reviewTask = { id: `review-task-${id}`, state: 'completed', plan_revision: 1, spec: { kind: 'review', runIds: [source.id] } };
  const task = { id, state: 'completed', plan_revision: 1, supplement_round: round, operation_id: `complement:1:${caseKey}:${round}`, created_at: newStart,
    depends_on: [reviewTask.id], spec: { kind: 'browser_tests', caseKeys: [caseKey], planVersions: [{ itemId: 'plan', version: 1 }], target: source.target, complement: binding } };
  const attempt = { ...oldAttempt, id, task_id: id, dispatch_id: id, operation_id: task.operation_id, supplement_round: round, created_at: newStart, finished_at: newFinish };
  const run = { ...structuredClone(source), id: newRunId, mission_attempt_id: id, started_at: newStart, finished_at: newFinish };
  run.result.checks.forEach(check => { if (check.status !== 'mismatch') check.status = 'verified'; }); run.result.remaining = [];
  run.result.outcome = run.result.checks.some(check => check.status === 'mismatch') ? 'failed' : 'passed';
  const sourceTrace = context.traces.find(row => row.capture.run_id === source.id);
  const trace = { ...structuredClone(sourceTrace.trace), browserJobId: id, callId: id, execution: { attemptId: id, dispatchId: id }, startedAt: newStart, finishedAt: newFinish };
  const capture = { ...structuredClone(sourceTrace.capture), run_id: newRunId, item_id: traceId,
    provenance: { ...sourceTrace.capture.provenance, sourceId: newRunId, sha256: sha256(Buffer.from(JSON.stringify(trace))) } };
  const review = { id: `review-${newRunId}`, run_id: newRunId, status: 'completed', reviewer_version: '6', source_hash: sha256(`source-${newRunId}`), finished_at: newFinish,
    input: { ...structuredClone(oldReview.input), runId: newRunId, reportedResult: run.result, evidence: [{ id: traceId, itemId: traceId, sha256: capture.provenance.sha256, readStatus: 'read' }] },
    assessment: { verdict: 'supported', findings: run.result.checks.map(check => ({ requirementId: check.id, verdict: 'supported', evidenceIds: [traceId], gap: null })) } };
  review.input_hash = auditReviewInputHash(review.input);
  context.history ||= [];
  context.history.push({ at: new Date(Date.parse(source.finished_at) + 1000).toISOString(), runs: structuredClone(state.runs) });
  state.tasks.push(reviewTask, task); state.attempts.push(attempt); state.jobs.push({ id, status: 'completed', dispatch_lease_until: null });
  state.runs.push(run); state.reviews.push(review);
  state.captures.push(capture, { run_id: newRunId, item_id: screenshotId, provenance: { producer: 'test-capture' } });
  context.traces.push({ capture, trace }); context.byteEvidence.add(traceId); context.byteEvidence.add(screenshotId);
  state.events.push({ kind: 'complement_planned', event_key: `complement-considered:${oldReview.id}:${oldReview.input_hash}`, created_at: newStart,
    payload: { runId: source.id, assessmentId: oldReview.id, caseKey, round, reason: null, taskId: id, gapIds: [gapId], gapKinds: ['unverified_step'] } });
  const report = state.reports[0]; report.document.tests = report.document.tests.filter(row => row.runId !== source.id);
  report.document.tests.push({ runId: newRunId, originalOutcome: run.result.outcome, status: run.result.outcome, review: 'supported' });
  report.document.findings.find(row => row.criterionId === caseId).evidenceIds = [`item:${traceId}`];
  report.document.evidence.push({ id: `item:${traceId}`, itemId: traceId, read: true });
  report.read_receipts.push({ id: `item:${traceId}`, hash: '1'.repeat(64), digest: capture.provenance.sha256, limited: false });
  report.document.limitations.push(`Tidigare körning ${source.id}: ${source.result.outcome}. Originalresultatet finns kvar.`);
  return { source, oldTask, oldAttempt, oldReview, task, attempt, run, review, event: state.events.at(-1) };
}

test('one and two explicit server-bound complements resolve an evidence gap without treating historical uncertainty as success', () => {
  for (const count of [1, 2]) {
    const value = example(); for (let n = 0; n < count; n++) addComplement(value);
    const result = auditWebCompletion(value.state, value.context);
    assert.equal(result.matched.length, 5); assert.equal(result.complements.length, count);
    assert.equal(result.matched.find(row => row.oracleId === 'search').runId, `run-search-complement-${count}`);
    for (const { capture, trace } of value.context.traces) auditTrace(capture, Buffer.from(JSON.stringify(trace)), value.state);
  }
});

test('a separate missing checkpoint may be complemented while an independently verified defect remains failed', () => {
  const value = example(); addComplement(value, 'broken_returns', { preserveMismatch: true });
  const result = auditWebCompletion(value.state, value.context);
  assert.ok(result.verifiedDefects.some(row => row.runId === 'run-broken_returns' && row.checkId === 'step1'));
  assert.equal(result.matched.find(row => row.oracleId === 'broken_returns').runId, 'run-broken_returns-complement-1');
});

test('a settled failed original executor may be recovered only by the separately authorized complement', () => {
  const value = example(), rows = addComplement(value);
  rows.oldAttempt.status = 'failed'; value.state.jobs.find(job => job.id === rows.oldAttempt.dispatch_id).status = 'failed';
  assert.equal(auditWebCompletion(value.state, value.context).complements.length, 1);
  value.state.jobs.find(job => job.id === rows.attempt.dispatch_id).status = 'failed';
  assert.throws(() => auditWebCompletion(value.state, value.context), /not fully recovered/);
});

test('a historical supported review cannot stand in for an uncited trace in the current assessment', () => {
  const value = example(), oldReview = value.state.reviews.find(review => review.run_id === 'run-broken_returns');
  const next = structuredClone(oldReview); next.id += '-new'; next.finished_at = '2026-10-05T15:02:00.000Z';
  next.input.evidence[0].itemId = 'replacement-screenshot'; next.input.evidence[0].sha256 = '2'.repeat(64);
  next.input_hash = auditReviewInputHash(next.input);
  value.state.captures.push({ item_id: 'replacement-screenshot', run_id: oldReview.run_id, provenance: { sha256: '2'.repeat(64) } });
  value.context.byteEvidence.add('replacement-screenshot'); value.state.reviews.push(next);
  assert.throws(() => auditWebCompletion(value.state, value.context), /not actually executed and reviewed/);
});

for (const [name, corrupt] of [
  ['missing typed binding', (_value, rows) => { delete rows.task.spec.complement; }],
  ['forged source run', (_value, rows) => { rows.task.spec.complement.runId = 'other-run'; }],
  ['forged source task', (_value, rows) => { rows.task.spec.complement.sourceTaskId = 'other-task'; }],
  ['forged source attempt', (_value, rows) => { rows.task.spec.complement.sourceAttemptId = 'other-attempt'; }],
  ['another assessment', (_value, rows) => { rows.task.spec.complement.assessmentId = 'other-assessment'; }],
  ['changed source hash', (_value, rows) => { rows.task.spec.complement.sourceHash = '0'.repeat(64); }],
  ['changed input hash', (_value, rows) => { rows.task.spec.complement.inputHash = '0'.repeat(64); }],
  ['historical reviewer version', (_value, rows) => { rows.oldReview.reviewer_version = '5'; rows.task.spec.complement.reviewerVersion = '5'; }],
  ['untyped next-step prose', (_value, rows) => { delete rows.oldReview.assessment.findings[0].gap; rows.oldReview.assessment.findings[0].suggestedNextStep = 'Try again'; }],
  ['review-only gap', (_value, rows) => { rows.oldReview.assessment.findings[0].gap.capability = 'review'; }],
  ['unrelated gap identity', (_value, rows) => { rows.task.spec.complement.gapIds = ['0'.repeat(64)]; }],
  ['changed requirement', (_value, rows) => { rows.run.snapshot.expected = 'A different goal'; }],
  ['changed target', (_value, rows) => { rows.task.spec.target = { ...rows.run.target, revision: 'changed' }; }],
  ['changed plan epoch', (_value, rows) => { rows.attempt.plan_revision = 2; }],
  ['changed mandate epoch', (_value, rows) => { rows.attempt.mandate_revision = 2; }],
  ['missing round', (_value, rows) => { rows.task.supplement_round = 0; }],
  ['mismatched attempt round', (_value, rows) => { rows.attempt.supplement_round = 2; }],
  ['no remaining round allowance', (value) => { value.state.missions[0].mandate.limits.maxSupplementRounds = 0; }],
  ['same task reused', (_value, rows) => { rows.attempt.task_id = rows.oldTask.id; }],
  ['no committed server event', (value) => { value.state.events = []; }],
  ['wrong event round', (_value, rows) => { rows.event.payload.round = 2; }],
  ['duplicated event', (value, rows) => { value.state.events.push(structuredClone(rows.event)); }],
  ['no completed review dependency', (_value, rows) => { rows.task.depends_on = []; }],
  ['execution predates review', (_value, rows) => { rows.oldReview.finished_at = rows.run.finished_at; }],
  ['cancelled original attempt', (_value, rows) => { rows.oldAttempt.cancel_requested_at = finish; }],
  ['unsupported original history disappeared', (value, rows) => { value.state.runs = value.state.runs.filter(row => row.id !== rows.source.id); }],
  ['no independent prior observation', (value) => { value.context.history = []; }],
  ['report omits earlier uncertainty', (value) => { value.state.reports[0].document.limitations = []; }],
  ['report shows obsolete result', (value, rows) => { value.state.reports[0].document.tests.find(row => row.runId === rows.run.id).runId = rows.source.id; }],
  ['latest result remains unverified', (_value, rows) => { rows.run.result.checks[0].status = 'unverified'; rows.review.input_hash = auditReviewInputHash(rows.review.input); }],
  ['latest read bytes are absent', (value, rows) => { value.context.byteEvidence.delete(`trace-${rows.task.id}`); }],
  ['conclusive checkpoint contains a new gap', (_value, rows) => { rows.review.assessment.findings[0].gap = rows.oldReview.assessment.findings[0].gap; }],
  ['summary hides unresolved checkpoint', (_value, rows) => { rows.review.assessment.findings[0].verdict = 'needs_evidence'; }],
  ['final assessment predates execution', (_value, rows) => { rows.review.finished_at = start; }],
]) test(`complement oracle refuses ${name}`, () => {
  const value = example(), rows = addComplement(value); corrupt(value, rows);
  assert.throws(() => auditWebCompletion(value.state, value.context));
});

test('third round, alternate branch and a verified defect made green are rejected', () => {
  const three = example(); addComplement(three); addComplement(three); addComplement(three);
  assert.throws(() => auditWebCompletion(three.state, three.context), /two bounded complements/);
  const branch = example(), first = addComplement(branch), second = addComplement(branch);
  second.task.spec.complement.sourceAttemptId = first.oldAttempt.id;
  assert.throws(() => auditWebCompletion(branch.state, branch.context));
  const green = example(), rows = addComplement(green, 'broken_returns', { preserveMismatch: true });
  rows.run.result.checks[0].status = 'verified'; rows.run.result.outcome = 'passed'; rows.review.input_hash = auditReviewInputHash(rows.review.input);
  assert.throws(() => auditWebCompletion(green.state, green.context), /verified defect was retested until green/);
});

test('a claimed verified original defect without its actual read bytes cannot authorize a complement', () => {
  const value = example(); addComplement(value, 'broken_returns', { preserveMismatch: true });
  value.context.byteEvidence.delete('trace-broken_returns');
  assert.throws(() => auditWebCompletion(value.state, value.context), /Conclusive checkpoint lacks actual saved evidence/);
});

test('rewriting original data cannot be hidden by recomputing the current input hash', () => {
  const value = example(), rows = addComplement(value);
  rows.source.result.checks[0].actual = 'Rewritten original'; rows.oldReview.input_hash = auditReviewInputHash(rows.oldReview.input);
  rows.task.spec.complement.inputHash = rows.oldReview.input_hash; rows.event.event_key = `complement-considered:${rows.oldReview.id}:${rows.oldReview.input_hash}`;
  assert.throws(() => auditWebCompletion(value.state, value.context), /history was overwritten/);
});

test('canonical reviewer fingerprint survives JSONB property reordering but binds values and array order', () => {
  assert.equal(auditReviewInputHash({ b: { y: 2, x: 1 }, a: 0 }), auditReviewInputHash({ a: 0, b: { x: 1, y: 2 } }));
  assert.notEqual(auditReviewInputHash({ checks: ['one', 'two'] }), auditReviewInputHash({ checks: ['two', 'one'] }));
  assert.notEqual(auditReviewInputHash({ a: 1 }), auditReviewInputHash({ a: 2 }));
});
for (const [name, corrupt] of [
  ['404 mentioned in text without click evidence', ({ context }) => { context.traces = context.traces.filter(value => value.capture.run_id !== 'run-broken_returns'); }],
  ['direct URL substitutes for broken navigation click', ({ context }) => { context.traces.at(-1).trace.action = 'open'; }],
  ['working search was not performed', ({ context }) => { context.traces = context.traces.filter(value => value.capture.run_id !== 'run-search'); }],
  ['search returns the wrong product', ({ context }) => { context.traces.find(value => value.capture.run_id === 'run-search').trace.observation.headings = ['Frukostmugg']; }],
  ['known defect is green', ({ state }) => { state.runs.at(-1).result.outcome = 'passed'; }],
  ['known defect is hidden in report test outcomes', ({ state }) => { state.reports[0].document.tests.pop(); }],
  ['report silently changes the defect to passed', ({ state }) => { state.reports[0].document.tests.at(-1).status = 'passed'; }],
  ['report changes the original defect outcome', ({ state }) => { state.reports[0].document.tests.at(-1).originalOutcome = 'passed'; }],
  ['report cites another case for the defect', ({ state }) => { state.reports[0].document.findings.at(-1).evidenceIds = ['item:trace-home']; }],
  ['defect finding refers to another criterion', ({ state }) => { state.reports[0].document.findings.at(-1).criterionId = 'home'; }],
  ['defect read receipt covers other bytes', ({ state }) => { state.reports[0].read_receipts.at(-1).digest = '0'.repeat(64); }],
  ['defect is not a mismatch in any reviewed checkpoint', ({ state }) => { state.runs.at(-1).result.checks[0].status = 'verified'; }],
  ['404 prose replaces a structured defect outcome', ({ state }) => { state.reports[0].document.tests = []; state.reports[0].document.findings.at(-1).conclusion = 'Returer HTTP 404'; }],
  ['Klara did not actually read the cited trace', ({ state }) => { state.reviews[0].input.evidence[0].readStatus = 'unread'; }],
  ['Klara read an older evidence byte version', ({ state }) => { state.reviews[0].input.evidence[0].sha256 = '0'.repeat(64); }],
  ['missing review checkpoint', ({ state }) => { state.reviews[0].input.requirements.push({ id: 'step2' }); }],
  ['partial report', ({ state }) => { state.reports[0].document.partial = true; }],
  ['duplicate logical completed operation', ({ state }) => { state.attempts[1].operation_id = state.attempts[0].operation_id; }],
  ['duplicate selected test execution', ({ state }) => { state.runs.push(structuredClone(state.runs[0])); }],
  ['duplicate saved report', ({ state }) => { state.reports.push(structuredClone(state.reports[0])); }],
  ['wrong plan version', ({ state }) => { state.runs[0].plan_version = 2; }],
  ['plan persisted after test began', ({ state }) => { state.versions[0].created_at = finish; }],
  ['wrong target revision', ({ state }) => { state.runs[0].target = { ...state.runs[0].target, revision: 'other' }; }],
  ['active resource leaked', ({ state }) => { state.claims.push({ id: 'claim' }); }],
  ['browser session leaked', ({ state }) => { state.browsers.push({ session_id: 'still-open' }); }],
  ['report has only limited read receipt', ({ state }) => { state.reports[0].read_receipts[0].limited = true; }],
]) test(`oracle refuses ${name}`, () => { const value = example(); corrupt(value); assert.throws(() => auditWebCompletion(value.state, value.context)); });

test('search oracle accepts independently chosen tea, full product name and multi-result searches', () => {
  for (const observation of [
    { headings: ['Våra produkter', 'Havre[REDACTED]'], text: '1 produkter för ”[REDACTED]”\nHavre[REDACTED]\nRostat ört[REDACTED], 100 g\n49 kr' },
    { headings: ['Våra produkter', '[REDACTED]'], text: '1 produkter för ”[REDACTED]”\n[REDACTED]\nMellanrostat kaffe, 500 g\n79 kr' },
    { headings: ['Våra produkter', 'Bryggkaffe', 'Havrete'], text: '2 produkter för ”[REDACTED]”\nBryggkaffe\nMellanrostat kaffe, 500 [REDACTED]\n79 kr\nHavrete\nRostat örtte, 100 [REDACTED]\n49 kr' },
  ]) {
    const result = auditSearchObservation(observation);
    assert.ok(result); assert.equal(result.queryValueVerified, false);
    const { state, context } = example();
    context.traces.find(value => value.capture.run_id === 'run-search').trace.observation = observation;
    assert.equal(auditWebCompletion(state, context).matched.find(value => value.oracleId === 'search').search.count, result.count);
  }
});

test('search oracle requires a nonempty search and actual identifiable catalogue output', () => {
  for (const observation of [
    { headings: ['Bryggkaffe'], text: '1 produkter\nMellanrostat kaffe, 500 g\n79 kr' },
    { headings: ['Bryggkaffe'], text: '1 produkter för ”[REDACTED]”\nA made up description\n79 kr' },
    { headings: ['Bryggkaffe'], text: '2 produkter för ”[REDACTED]”\nMellanrostat kaffe, 500 g\n79 kr' },
    { headings: ['Unknown item'], text: '1 produkter för ”[REDACTED]”\nMellanrostat kaffe, 500 g\n79 kr' },
    { headings: [], text: '0 produkter för ”[REDACTED]”' },
    { headings: ['Bryggkaffe'], text: '1 produkter för ”[REDACTED]”\nMellanrostat kaffe, 500 g\n79 kr', truncated: true },
  ]) assert.equal(auditSearchObservation(observation), null);
});

test('free-text wording is not an oracle for the structured defect chain', () => {
  const { state, context } = example();
  state.reports[0].document.findings.at(-1).conclusion = 'Returinformationen gick inte att öppna.';
  assert.equal(auditWebCompletion(state, context).matched.length, 5);
  // This limitation is explicit in protocol v3: prose must still be read before
  // the overall gate. A regex must not pretend to understand a negated sentence.
  state.reports[0].document.findings.at(-1).conclusion = 'Returer gav inte HTTP 404.';
  assert.equal(auditWebCompletion(state, context).matched.length, 5);
});

test('trace hash, exact attempt and timestamps must match actual execution', () => {
  const { state, context } = example(), { capture, trace } = context.traces[0];
  assert.throws(() => auditTrace(capture, Buffer.from('{}'), state));
  for (const changed of [{ ...trace, browserJobId: 'other' }, { ...trace, execution: { attemptId: 'other', dispatchId: 'other' } }, { ...trace, startedAt: '2026-10-05T14:00:00.000Z' }]) {
    const bytes = Buffer.from(JSON.stringify(changed));
    assert.throws(() => auditTrace({ ...capture, provenance: { ...capture.provenance, sha256: sha256(bytes) } }, bytes, state));
  }
});

test('unfinished test traces fail explicitly without interpreting a missing end as epoch time', () => {
  for (const missing of [null, undefined]) {
    const { state, context } = example(), { capture, trace } = context.traces[0];
    state.runs[0].finished_at = missing;
    assert.throws(() => auditTrace(capture, Buffer.from(JSON.stringify(trace)), state), /unfinished test run/);
  }
  const { state, context } = example(), { capture, trace } = context.traces[0];
  state.runs[0].result = null;
  assert.throws(() => auditTrace(capture, Buffer.from(JSON.stringify(trace)), state), /unfinished test run/);
});

test('invalid or reversed trace timestamps remain failures', () => {
  for (const change of [{ startedAt: null }, { finishedAt: 'invalid' }, { startedAt: finish, finishedAt: start }]) {
    const { state, context } = example(), { capture, trace } = context.traces[0];
    const bytes = Buffer.from(JSON.stringify({ ...trace, ...change }));
    assert.throws(() => auditTrace({ ...capture, provenance: { ...capture.provenance, sha256: sha256(bytes) } }, bytes, state), /invalid timestamp|outside the test interval/);
  }
});
test('controller fault requires committed discovery and no planning dispatch before actual stop', () => {
  const state = { attempts: [{ kind: 'discovery', status: 'completed', finished_at: finish }], reports: [] };
  const beforeRuntime = { sourceSha256: 'source', web: { pid: 101 }, eve: { pid: 202 } }, afterRuntime = { ...beforeRuntime, web: { pid: 303 } };
  assert.ok(webFaultReady('controller-restart', state));
  auditWebFault('controller-restart', state, structuredClone(state), afterRuntime, beforeRuntime);
  const late = { ...state, attempts: [...state.attempts, { kind: 'planning', status: 'reserved' }] };
  assert.throws(() => auditWebFault('controller-restart', state, late, afterRuntime, beforeRuntime));
  assert.throws(() => auditWebFault('controller-restart', state, state, beforeRuntime, beforeRuntime));
});
test('report fault requires same claimed lease and no commit after actual stop', () => {
  const state = { attempts: [], reports: [{ id: 'report', status: 'running', item_id: null, finished_at: null, lease_until: finish }] };
  const beforeRuntime = { sourceSha256: 'source', web: { pid: 101 }, eve: { pid: 202 } }, afterRuntime = { ...beforeRuntime, web: { pid: 303 } };
  auditWebFault('report-restart', state, structuredClone(state), afterRuntime, beforeRuntime);
  assert.throws(() => auditWebFault('report-restart', state, { ...state, reports: [{ ...state.reports[0], item_id: 'committed' }] }, afterRuntime, beforeRuntime));
  assert.throws(() => auditWebFault('report-restart', state, state, { ...afterRuntime, sourceSha256: 'changed' }, beforeRuntime));
});

// Protocol 7 is explicit opt-in. Historical v6/mismatch tests above are unchanged.
function reviewedDefectExample() {
  const value = example(); value.context.defectPolicy = 'reviewed-known-defect-v1';
  const run = value.state.runs.find(row => row.case_id === 'broken_returns');
  run.result.checks[0].status = 'verified';
  run.result.observations = [{ kind: 'defect', title: 'Known navigation destination fails', detail: 'Click opened the missing-page response.' }];
  const review = value.state.reviews.find(row => row.run_id === run.id); review.input_hash = auditReviewInputHash(review.input);
  attestTraces(value); return value;
}
function attestTraces(value) {
  value.context.traces = value.context.traces.map(({ capture, trace }) => {
    trace.fromUrl ??= oracle.origin + '/';
    const bytes = Buffer.from(JSON.stringify(trace)); capture.provenance.sha256 = sha256(bytes);
    for (const review of value.state.reviews.filter(row => row.run_id === capture.run_id)) {
      for (const evidence of review.input.evidence.filter(row => row.itemId === capture.item_id)) evidence.sha256 = sha256(bytes);
      review.input_hash = auditReviewInputHash(review.input);
    }
    for (const receipt of value.state.reports[0].read_receipts.filter(row => row.id === `item:${capture.item_id}`)) receipt.digest = sha256(bytes);
    return auditTrace(capture, bytes, value.state);
  });
}
test('v7 allows the reviewed typed known defect only with actual trace binding and preserves source product failure', () => {
  const value = reviewedDefectExample(), before = JSON.stringify(value.state);
  const audited = auditWebCompletion(value.state, value.context);
  assert.equal(audited.matched.length, 5); assert.equal(audited.knownDefectObservations.length, 1);
  assert.equal(audited.knownDefectObservations[0].sourceOutcome, 'failed');
  assert.equal(audited.knownDefectObservations[0].checkpointStatus, 'verified');
  assert.equal(audited.knownDefectObservations[0].semanticReview, 'independent_review_pending');
  assert.equal(JSON.stringify(value.state), before);
  const old = { ...value.context }; delete old.defectPolicy;
  assert.throws(() => auditWebCompletion(value.state, old), /reviewed mismatch/);
});
test('v7 retains the old mismatch path and rejects unknown policy names', () => {
  const value = example(); value.context.defectPolicy = 'reviewed-known-defect-v1';
  assert.equal(auditWebCompletion(value.state, value.context).matched.length, 5);
  assert.throws(() => auditWebCompletion(value.state, { ...value.context, defectPolicy: 'any-failure' }), /Unsupported defect/);
});
for (const [name, corrupt] of [
  ['metadata without actual bytes', value => { value.context.traces = value.context.traces.map(row => structuredClone(row)); }],
  ['changed trace after byte verification', value => { value.context.traces.at(-1).trace.observation.text = 'replaced'; }],
  ['missing actual trace bytes', value => { value.context.byteEvidence.delete('trace-broken_returns'); }],
  ['only a note', value => { value.state.runs.at(-1).result.observations[0].kind = 'note'; value.state.reviews.at(-1).input_hash = auditReviewInputHash(value.state.reviews.at(-1).input); }],
  ['no typed observation', value => { delete value.state.runs.at(-1).result.observations; value.state.reviews.at(-1).input_hash = auditReviewInputHash(value.state.reviews.at(-1).input); }],
  ['wrong actual destination', value => { value.context.traces.at(-1).trace.toUrl = oracle.origin + '/elsewhere'; }],
  ['direct open instead of click', value => { value.context.traces.at(-1).trace.action = 'open'; }],
  ['access failure instead of known 404', value => { value.context.traces.at(-1).trace.httpStatus = 403; }],
  ['unread current review evidence', value => { value.state.reviews.at(-1).input.evidence[0].readStatus = 'unread'; value.state.reviews.at(-1).input_hash = auditReviewInputHash(value.state.reviews.at(-1).input); }],
  ['another result in review', value => { value.state.reviews.at(-1).input.reportedResult = { ...value.state.runs.at(-1).result, actual: 'different' }; value.state.reviews.at(-1).input_hash = auditReviewInputHash(value.state.reviews.at(-1).input); }],
  ['report cites other bytes', value => { value.state.reports[0].read_receipts.at(-1).digest = '0'.repeat(64); }],
  ['report changes source failed to passed', value => { value.state.reports[0].document.tests.at(-1).status = 'passed'; }],
]) test(`v7 alternate defect refuses ${name}`, () => {
  const value = reviewedDefectExample(); corrupt(value); assert.throws(() => auditWebCompletion(value.state, value.context));
});
test('a typed defect label about something else never certifies prose semantics', () => {
  const value = reviewedDefectExample(); value.state.runs.at(-1).result.observations[0].detail = 'Unrelated typography complaint';
  value.state.reviews.at(-1).input_hash = auditReviewInputHash(value.state.reviews.at(-1).input);
  const result = auditWebCompletion(value.state, value.context);
  assert.equal(result.knownDefectObservations[0].semanticReview, 'independent_review_pending');
  assert.equal(result.gate, undefined, 'Deterministic binding does not infer a full semantic acceptance gate');
});
test('a separately authorized complement cannot discard an already reviewed typed negative observation', () => {
  const value = reviewedDefectExample();
  const rows = addComplement(value, 'broken_returns', { preserveMismatch: true });
  rows.run.result.outcome = 'failed'; value.state.reports[0].document.tests.at(-1).originalOutcome = 'failed'; value.state.reports[0].document.tests.at(-1).status = 'failed';
  rows.review.input_hash = auditReviewInputHash(rows.review.input); attestTraces(value);
  assert.equal(auditWebCompletion(value.state, value.context).complements.length, 1);
  delete rows.run.result.observations; rows.review.input_hash = auditReviewInputHash(rows.review.input);
  assert.throws(() => auditWebCompletion(value.state, value.context), /dropped the reviewed typed defect/);
});
